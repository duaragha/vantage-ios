/**
 * Telegram Bot API adapter.
 *
 * Exposes:
 *   - sendMessage(text, opts?) — plain sendMessage wrapper with Markdown/HTML
 *     support, retry on 429/5xx, and graceful "not-configured" fallback.
 *   - sendInsight({ title, body, url? }) — structured message used by the
 *     alert/digest pipelines when they don't need the custom formatter.
 *   - verifyChatId() — calls getMe + getChat to validate the bot token and
 *     chat_id without sending a message.
 *
 * Config:
 *   - TELEGRAM_BOT_TOKEN (required)
 *   - TELEGRAM_CHAT_ID   (required)
 *
 * Design notes:
 *   - If either env var is missing, every function returns `{ ok: false,
 *     reason: 'not-configured' }` and logs a warning ONCE per process. We
 *     deliberately DO NOT throw — the alert pipeline must survive a fresh
 *     install where the user hasn't pasted their token yet.
 *   - We use the global `fetch` (Node 18+). No axios dependency added.
 *   - Retry policy:
 *       * HTTP 429 → honor the `Retry-After` header (seconds) or
 *         parameters.retry_after from the JSON body; up to 3 attempts total.
 *       * HTTP 5xx → exponential backoff (500ms, 1500ms, 3500ms); up to 3
 *         attempts.
 *       * Other 4xx → fail immediately (configuration error, not transient).
 */

export interface TelegramSuccess {
  ok: true;
  messageId: number;
}

export interface TelegramFailure {
  ok: false;
  reason: TelegramFailureReason;
  /** Bot API error description, if available. */
  description?: string;
  /** HTTP status from the last attempt. */
  status?: number;
}

export type TelegramFailureReason =
  | 'not-configured'
  | 'network'
  | 'rate-limited'
  | 'server-error'
  | 'client-error'
  | 'invalid-response';

export type TelegramResult = TelegramSuccess | TelegramFailure;

export interface SendMessageOptions {
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableNotification?: boolean;
  /** Disables link previews. Defaults to true to keep alert cards tidy. */
  disableWebPagePreview?: boolean;
}

export interface InsightPayload {
  title: string;
  body: string;
  url?: string;
}

interface Config {
  token: string;
  chatId: string;
}

interface TelegramLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _warnedNotConfigured = false;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
export const TELEGRAM_TEXT_MAX_LENGTH = 4096;
const TRUNCATION_SUFFIX = '\n\n[message truncated; open Vantage for full details]';

const logger: TelegramLogger = {
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  info: (obj, msg) => console.info(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function readConfig(): Config | null {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];
  if (!token || !chatId) {
    if (!_warnedNotConfigured) {
      logger.warn(
        {
          hasToken: Boolean(token),
          hasChatId: Boolean(chatId),
        },
        '[notify/telegram] TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID missing — Telegram delivery disabled',
      );
      _warnedNotConfigured = true;
    }
    return null;
  }
  return { token, chatId };
}

function notConfigured(): TelegramFailure {
  return { ok: false, reason: 'not-configured' };
}

/**
 * Cheap config presence probe (no network, no logging). Lets callers avoid
 * per-row work they know will end in `not-configured` — e.g. the outbox
 * dispatcher defers its whole queue in one write instead of claiming rows
 * one by one.
 */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env['TELEGRAM_BOT_TOKEN'] && process.env['TELEGRAM_CHAT_ID']);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface MessageResult {
  message_id: number;
  chat: { id: number };
}

interface ChatResult {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface GetMeResult {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function telegramBackoffMs(attempt: number): number {
  // attempt is 1-indexed. Returns 500, 1500, 3500.
  return 500 * (Math.pow(2, attempt) - 1);
}

function parseRetryAfter(response: Response, body: BotApiResponse<unknown> | null): number {
  const headerVal = response.headers.get('retry-after');
  if (headerVal) {
    const n = Number.parseInt(headerVal, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  const ra = body?.parameters?.retry_after;
  if (typeof ra === 'number' && ra >= 0) return ra * 1000;
  return 1000;
}

async function readJsonBody<T>(response: Response): Promise<BotApiResponse<T> | null> {
  try {
    return (await response.json()) as BotApiResponse<T>;
  } catch {
    return null;
  }
}

/**
 * POST to a Bot API method with retry logic. Generic over the `result` shape.
 */
async function callBotApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; result: T }
  | {
      ok: false;
      reason: TelegramFailureReason;
      description?: string;
      status?: number;
    }
> {
  const url = `https://api.telegram.org/bot${token}/${method}`;

  let lastDescription: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await timedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastDescription = err instanceof Error ? err.message : String(err);
      logger.warn(
        { method, attempt, err: lastDescription },
        '[notify/telegram] network error — retrying',
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(telegramBackoffMs(attempt));
        continue;
      }
      return {
        ok: false,
        reason: 'network',
        ...(lastDescription !== undefined ? { description: lastDescription } : {}),
      };
    }

    lastStatus = response.status;
    const parsed = await readJsonBody<T>(response);

    if (response.ok && parsed && parsed.ok && parsed.result !== undefined) {
      return { ok: true, result: parsed.result };
    }

    lastDescription = parsed?.description ?? response.statusText;

    // Rate limited: honor Retry-After, retry.
    if (response.status === 429) {
      if (attempt < MAX_ATTEMPTS) {
        const wait = parseRetryAfter(response, parsed);
        logger.warn(
          { method, attempt, waitMs: wait, description: lastDescription },
          '[notify/telegram] 429 rate limited — waiting',
        );
        await sleep(wait);
        continue;
      }
      return {
        ok: false,
        reason: 'rate-limited',
        status: response.status,
        ...(lastDescription !== undefined ? { description: lastDescription } : {}),
      };
    }

    // Transient server errors: backoff + retry.
    if (response.status >= 500 && response.status < 600) {
      if (attempt < MAX_ATTEMPTS) {
        const wait = telegramBackoffMs(attempt);
        logger.warn(
          { method, attempt, status: response.status, waitMs: wait },
          '[notify/telegram] 5xx — backing off',
        );
        await sleep(wait);
        continue;
      }
      return {
        ok: false,
        reason: 'server-error',
        status: response.status,
        ...(lastDescription !== undefined ? { description: lastDescription } : {}),
      };
    }

    // Other 4xx (401 invalid token, 400 bad chat_id, etc) — no retry.
    return {
      ok: false,
      reason: 'client-error',
      status: response.status,
      ...(lastDescription !== undefined ? { description: lastDescription } : {}),
    };
  }

  // Shouldn't reach here — loop always returns — but TS needs it.
  return {
    ok: false,
    reason: 'network',
    ...(lastDescription !== undefined ? { description: lastDescription } : {}),
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PreparedTelegramMessage {
  text: string;
  parseMode?: SendMessageOptions['parseMode'];
  truncated: boolean;
}

/**
 * Keep every send inside Telegram's text limit. Oversized formatted payloads
 * fall back to plain text because clipping arbitrary Markdown can leave an
 * unmatched entity and turn a useful alert into a permanent HTTP 400.
 */
export function prepareTelegramMessage(
  text: string,
  parseMode?: SendMessageOptions['parseMode'],
): PreparedTelegramMessage {
  const characters = Array.from(text);
  if (characters.length <= TELEGRAM_TEXT_MAX_LENGTH) {
    return {
      text,
      ...(parseMode ? { parseMode } : {}),
      truncated: false,
    };
  }

  const suffixLength = Array.from(TRUNCATION_SUFFIX).length;
  const bodyLimit = TELEGRAM_TEXT_MAX_LENGTH - suffixLength;
  let body = characters.slice(0, bodyLimit).join('');

  // Prefer a nearby natural boundary without throwing away a large tail.
  const boundary = Math.max(
    body.lastIndexOf('\n\n'),
    body.lastIndexOf('\n'),
    body.lastIndexOf(' '),
  );
  if (boundary >= Math.floor(bodyLimit * 0.8)) {
    body = body.slice(0, boundary).trimEnd();
  }

  return {
    text: `${body}${TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a plain text message to the configured chat.
 */
export async function sendMessage(
  text: string,
  opts: SendMessageOptions = {},
): Promise<TelegramResult> {
  const cfg = readConfig();
  if (!cfg) return notConfigured();

  const prepared = prepareTelegramMessage(text, opts.parseMode);
  if (prepared.truncated) {
    logger.warn(
      {
        originalCharacters: Array.from(text).length,
        sentCharacters: Array.from(prepared.text).length,
      },
      '[notify/telegram] oversized message truncated and sent as plain text',
    );
  }

  const body: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text: prepared.text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (prepared.parseMode) body['parse_mode'] = prepared.parseMode;
  if (opts.disableNotification !== undefined) {
    body['disable_notification'] = opts.disableNotification;
  }

  const res = await callBotApi<MessageResult>(cfg.token, 'sendMessage', body);
  if (!res.ok) {
    logger.error(
      {
        reason: res.reason,
        status: res.status,
        description: res.description,
      },
      '[notify/telegram] sendMessage failed',
    );
    return res;
  }
  if (!res.result || typeof res.result.message_id !== 'number') {
    return { ok: false, reason: 'invalid-response' };
  }
  return { ok: true, messageId: res.result.message_id };
}

/**
 * Send a lightly-formatted insight payload. Used by the digest pipeline.
 * For the alert pipeline, the formatter builds richer Markdown via
 * formatAlertForTelegram() — pass that to sendMessage() directly.
 */
export async function sendInsight(
  insight: InsightPayload,
  opts: SendMessageOptions = {},
): Promise<TelegramResult> {
  const parseMode = opts.parseMode ?? 'Markdown';
  const parts: string[] = [`*${escapeForParseMode(insight.title, parseMode)}*`, ''];
  parts.push(insight.body);
  if (insight.url) {
    parts.push('', `[Open](${insight.url})`);
  }
  return sendMessage(parts.join('\n'), { ...opts, parseMode });
}

/**
 * Validate bot token + chat id. Calls getMe (to confirm token) and getChat (to
 * confirm the bot can address that chat). Does not send a message.
 */
export async function verifyChatId(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;

  const me = await callBotApi<GetMeResult>(cfg.token, 'getMe', {});
  if (!me.ok) {
    logger.error(
      { reason: me.reason, description: me.description },
      '[notify/telegram] verifyChatId: getMe failed',
    );
    return false;
  }

  const chat = await callBotApi<ChatResult>(cfg.token, 'getChat', {
    chat_id: cfg.chatId,
  });
  if (!chat.ok) {
    logger.error(
      { reason: chat.reason, description: chat.description },
      '[notify/telegram] verifyChatId: getChat failed',
    );
    return false;
  }

  logger.info(
    {
      bot: me.result.username ?? me.result.first_name,
      chatId: chat.result.id,
      chatType: chat.result.type,
    },
    '[notify/telegram] verifyChatId: ok',
  );
  return true;
}

/**
 * Test hook — reset the one-shot "not configured" warning so a test can
 * observe it firing. Intended for unit tests only.
 */
export function __resetNotifyWarningFlag(): void {
  _warnedNotConfigured = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape user-controlled text for Markdown/MarkdownV2/HTML parse modes.
 * For Markdown (legacy), we strip the small set of characters that can break
 * bold/italic/link. For HTML, we escape `<`, `>`, `&`.
 */
export function escapeForParseMode(
  text: string,
  mode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown',
): string {
  if (mode === 'HTML') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (mode === 'MarkdownV2') {
    // MarkdownV2 reserved characters per Telegram spec.
    return text.replace(/([_*\u005b\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }
  // Legacy Markdown: only the four inline markers can break formatting.
  return text.replace(/([_*`\u005b])/g, '\\$1');
}
