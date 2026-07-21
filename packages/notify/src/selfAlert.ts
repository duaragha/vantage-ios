/**
 * Self-alert — operational pings over Telegram for the agent's own failures.
 *
 * Contract:
 *   sendSelfAlert(level, message, context?) persists a formatted Telegram
 *   message to the durable delivery queue. If the database itself is down, it
 *   falls back to a direct send so a database outage can still reach Telegram.
 *
 * Debounce:
 *   Same (level, message) won't be re-sent within DEBOUNCE_MS (default 30 min)
 *   to avoid Telegram spam on tight retry loops. Keyed by a SHA-256 hash of
 *   `${level}:${message}` so we don't leak context into the dedup key.
 *
 * Rate limit:
 *   Hard ceiling of MAX_PER_MINUTE total self-alerts per rolling 60s window.
 *   If exceeded, we drop additional sends and log the overflow at warn.
 *
 * Design notes:
 *   - Lives in @vantage/notify so @vantage/llm can call it from the
 *     spend-cap path without introducing a dep cycle against core.
 *   - Uses parser-free plain text so arbitrary error/context strings cannot
 *     make Telegram reject the operational alert.
 */

import { createHash } from 'node:crypto';
import { queueTelegramDelivery, type QueueTelegramDeliveryInput } from '@vantage/db';
import { sendMessage, type TelegramResult } from './telegram.js';
import { logError, logWarn } from './logger.js';

export type SelfAlertLevel = 'warn' | 'error' | 'critical';

export interface SendSelfAlertResult {
  ok: boolean;
  reason?: 'not-configured' | 'debounced' | 'rate-limited' | 'send-failed';
  messageId?: number;
  queued?: boolean;
  deliveryId?: number;
  error?: string;
}

export interface SendSelfAlertDependencies {
  queueDelivery?: (input: QueueTelegramDeliveryInput) => Promise<{ id: number }>;
  sendDirect?: typeof sendMessage;
  now?: () => number;
}

const DEBOUNCE_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_PER_MINUTE = 10;

const LEVEL_EMOJI: Record<SelfAlertLevel, string> = {
  warn: '\u26A0\uFE0F', // ⚠️
  error: '\uD83D\uDD25', // 🔥
  critical: '\uD83D\uDEA8\uD83D\uDEA8\uD83D\uDEA8', // 🚨🚨🚨
};

// ---------------------------------------------------------------------------
// Dedup + rate-limit state (in-memory, per-process)
// ---------------------------------------------------------------------------

const _lastSentAt = new Map<string, number>();
const _recentSends: number[] = [];

function hashKey(level: SelfAlertLevel, message: string): string {
  return createHash('sha256').update(`${level}:${message}`).digest('hex');
}

export function selfAlertDedupeKey(
  level: SelfAlertLevel,
  message: string,
  nowMs = Date.now(),
): string {
  const window = Math.floor(nowMs / DEBOUNCE_MS);
  return `self-alert:${hashKey(level, message)}:${window}`;
}

function isDebounced(level: SelfAlertLevel, message: string): boolean {
  const key = hashKey(level, message);
  const last = _lastSentAt.get(key);
  if (!last) return false;
  return Date.now() - last < DEBOUNCE_MS;
}

function markSent(level: SelfAlertLevel, message: string): void {
  const key = hashKey(level, message);
  _lastSentAt.set(key, Date.now());
  _recentSends.push(Date.now());
  // Evict stale map entries occasionally to keep memory bounded.
  if (_lastSentAt.size > 256) {
    const cutoff = Date.now() - DEBOUNCE_MS;
    for (const [k, ts] of _lastSentAt.entries()) {
      if (ts < cutoff) _lastSentAt.delete(k);
    }
  }
}

function isRateLimited(): boolean {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  // Trim old entries in place.
  while (_recentSends.length > 0 && (_recentSends[0] ?? 0) < cutoff) {
    _recentSends.shift();
  }
  return _recentSends.length >= MAX_PER_MINUTE;
}

/** Test hook — clear all dedup/rate-limit state. */
export function __resetSelfAlertState(): void {
  _lastSentAt.clear();
  _recentSends.length = 0;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSelfAlertBody(
  level: SelfAlertLevel,
  message: string,
  context?: Record<string, unknown>,
): string {
  const emoji = LEVEL_EMOJI[level];
  const badge = level.toUpperCase();
  const parts: string[] = [`${emoji} ${badge}`, '', message];
  if (context && Object.keys(context).length > 0) {
    parts.push('');
    let json: string;
    try {
      json = JSON.stringify(context, null, 2);
    } catch {
      json = '[non-serializable context]';
    }
    parts.push(json);
  }
  parts.push('', 'vantage self-alert');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendSelfAlert(
  level: SelfAlertLevel,
  message: string,
  context?: Record<string, unknown>,
  deps: SendSelfAlertDependencies = {},
): Promise<SendSelfAlertResult> {
  if (isDebounced(level, message)) {
    return { ok: false, reason: 'debounced' };
  }
  if (isRateLimited()) {
    logWarn('self-alert rate limit reached — dropping', {
      level,
      messagePreview: message.slice(0, 120),
    });
    return { ok: false, reason: 'rate-limited' };
  }

  const body = formatSelfAlertBody(level, message, context);
  const nowMs = deps.now?.() ?? Date.now();
  const queueDelivery = deps.queueDelivery ?? queueTelegramDelivery;
  try {
    const delivery = await queueDelivery({
      dedupeKey: selfAlertDedupeKey(level, message, nowMs),
      text: body,
      disableWebPagePreview: true,
    });
    markSent(level, message);
    return { ok: true, queued: true, deliveryId: delivery.id };
  } catch (err) {
    logError('self-alert queue failed; trying direct Telegram delivery', {
      level,
      message: message.slice(0, 240),
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let result: TelegramResult;
  try {
    result = await (deps.sendDirect ?? sendMessage)(body, {
      disableWebPagePreview: true,
    });
  } catch (err) {
    logError('self-alert send threw', err instanceof Error ? err : { err });
    return {
      ok: false,
      reason: 'send-failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.ok) {
    markSent(level, message);
    return { ok: true, messageId: result.messageId };
  }

  if (result.reason === 'not-configured') {
    // Graceful degradation — log at error so operators see it, don't throw.
    logError('self-alert skipped — Telegram not configured', {
      level,
      message: message.slice(0, 240),
      context,
    });
    return { ok: false, reason: 'not-configured' };
  }

  logError('self-alert Telegram delivery failed', {
    level,
    reason: result.reason,
    status: result.status,
    description: result.description,
  });
  return {
    ok: false,
    reason: 'send-failed',
    error: result.description ?? result.reason,
  };
}
