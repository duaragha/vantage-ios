/**
 * Alert dispatch worker.
 *
 * Sweeps unprocessed MarketEvent rows, builds an Alert Insight for each
 * (delegating to @vantage/core's buildAlertFromEvent), then ships the
 * rendered message to the durable Telegram outbox.
 *
 * Deterministic pre-LLM gates (see ../lib/alertGates.ts for rationale):
 *   - catalyst kinds are excluded entirely — the hourly catalyst engine owns
 *     them (previously this sweep consumed them within 30s of creation and
 *     starved the engine)
 *   - kind-aware freshness: dead signal is bulk-marked processed without an
 *     LLM call (IntradayMove after 24h, filings after 72h, 7d ceiling)
 *   - ticker+kind dedup: one alert judgment per ticker per event kind per 6h
 *     window, regardless of article-cluster id
 *   - daily cap on alert-purpose LLM calls: when reached, events DEFER (stay
 *     queued) rather than suppress, so delivery resumes next ET day
 *
 * Failure policy:
 *   - buildAlertFromEvent throws only on "event not found" / programmer
 *     errors. Operational failures (LLM error, spend cap, kill switch) log
 *     and return null, leaving the event unprocessed so the next tick picks
 *     it up.
 *   - Insight creation and outbox enqueue happen in one database transaction.
 *     The separate telegram.dispatch job owns delivery retries.
 *
 * Re-entrancy is owned by runJob(), which wraps the sole Croner schedule in
 * cron.ts. Keeping one scheduler path prevents two workers from selecting the
 * same unprocessed event before either has marked it complete.
 */

import { prisma, InsightKind, startOfZonedDay, EventKind } from '@vantage/db';
import { buildAlertFromEvent, CATALYST_KINDS } from '@vantage/core';
import type { FastifyBaseLogger } from 'fastify';
import {
  alertDailyLlmCap,
  freshnessCutoff,
  TICKER_KIND_DEDUP_MS,
} from '../lib/alertGates.js';

export interface AlertDispatchResult {
  eventsScanned: number;
  insightsCreated: number;
  insightsSuppressed: number;
  telegramQueued: number;
  staleSkipped: number;
  dedupSkipped: number;
  deferredByCap: boolean;
}

// Caps events processed per fire so a backlog drain doesn't burn an entire
// daily LLM budget. At default 5 events/fire × every-30s cron = 600/hr ceiling
// before the daily LLM cap kicks in; realistic steady-state is 1-2 events/fire.
const DEFAULT_LIMIT = 5;

/** Event kinds this dispatcher owns (everything except the catalyst kinds). */
const ALERT_KINDS: EventKind[] = Object.values(EventKind).filter(
  (kind) => !CATALYST_KINDS.includes(kind),
);

/**
 * Bulk-mark events past their kind's freshness window as processed — they're
 * dead signal, and each one avoided is an LLM call not spent.
 */
async function drainStaleEvents(
  now: Date,
  logger: FastifyBaseLogger | Console,
): Promise<number> {
  const res = await prisma.marketEvent.updateMany({
    where: {
      processedAt: null,
      OR: ALERT_KINDS.map((kind) => ({
        kind,
        occurredAt: { lt: freshnessCutoff(kind, now) },
      })),
    },
    data: { processedAt: now },
  });
  if (res.count > 0) {
    logger.info?.({ skipped: res.count }, 'alert.dispatch: bulk-skipped stale events');
  }
  return res.count;
}

/** Alert-purpose LLM calls left in today's budget (never negative). */
async function remainingDailyLlmBudget(now: Date): Promise<number> {
  const cap = alertDailyLlmCap();
  const settings = await prisma.userSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true },
  });
  const todayStart = startOfZonedDay(now, settings?.timezone ?? undefined);
  const used = await prisma.llmCall.count({
    where: { purpose: 'alert', createdAt: { gte: todayStart } },
  });
  return Math.max(0, cap - used);
}

/**
 * One judgment per ticker per event kind per window: if an Alert insight for
 * this ticker+kind already exists inside the dedup window, the event is
 * duplicate signal — suppress it without an LLM call. Complements the
 * cluster-id dedup inside buildAlertFromEvent, which only catches events
 * sharing an article cluster.
 */
async function isTickerKindDuplicate(
  event: { kind: EventKind; ticker: string | null },
  now: Date,
): Promise<boolean> {
  if (!event.ticker) return false;
  const since = new Date(now.getTime() - TICKER_KIND_DEDUP_MS);
  const prior = await prisma.insight.findFirst({
    where: {
      kind: InsightKind.Alert,
      triggeredBy: `event:${event.kind}`,
      createdAt: { gte: since },
      actionJson: { path: ['ticker'], equals: event.ticker },
    },
    select: { id: true },
  });
  return prior !== null;
}

export async function dispatchAlerts(
  logger: FastifyBaseLogger | Console = console,
  limit = DEFAULT_LIMIT,
): Promise<AlertDispatchResult> {
  const now = new Date();
  const result: AlertDispatchResult = {
    eventsScanned: 0,
    insightsCreated: 0,
    insightsSuppressed: 0,
    telegramQueued: 0,
    staleSkipped: 0,
    dedupSkipped: 0,
    deferredByCap: false,
  };

  result.staleSkipped = await drainStaleEvents(now, logger);

  const candidates = await prisma.marketEvent.findMany({
    where: { kind: { in: ALERT_KINDS }, processedAt: null },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });
  result.eventsScanned = candidates.length;
  if (candidates.length === 0) return result;

  // Each processed event burns at most one alert LLM call, so bounding the
  // batch to the remaining budget makes the daily cap exact — no per-tick
  // overshoot of up to limit-1 calls.
  const remainingBudget = await remainingDailyLlmBudget(now);
  if (remainingBudget === 0) {
    result.deferredByCap = true;
    logger.warn?.(
      { pending: candidates.length, cap: alertDailyLlmCap() },
      'alert.dispatch: daily alert LLM cap reached — deferring events to tomorrow',
    );
    return result;
  }
  const events = candidates.slice(0, remainingBudget);
  if (events.length < candidates.length) {
    result.deferredByCap = true;
    logger.warn?.(
      { pending: candidates.length, processing: events.length, cap: alertDailyLlmCap() },
      'alert.dispatch: nearing the daily alert LLM cap — processing a reduced batch',
    );
  }

  for (const event of events) {
    if (await isTickerKindDuplicate(event, now)) {
      await prisma.marketEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      result.dedupSkipped++;
      logger.info?.(
        { eventId: event.id, ticker: event.ticker, kind: event.kind },
        'alert.dispatch: ticker+kind dedup — suppressed without LLM call',
      );
      continue;
    }

    const insight = await buildAlertFromEvent(event.id, { log: logger });
    if (!insight) {
      result.insightsSuppressed++;
      continue;
    }
    result.insightsCreated++;
    result.telegramQueued++;
    logger.info?.(
      { eventId: event.id, insightId: insight.id },
      'alert queued for Telegram delivery',
    );
  }

  return result;
}

/**
 * Cron precheck: any work for this dispatcher? True when at least one
 * non-catalyst event is unprocessed. Kept alongside dispatchAlerts so the
 * kind scope cannot drift from the sweep query above.
 */
export async function hasPendingAlertWork(): Promise<boolean> {
  const pending = await prisma.marketEvent.findFirst({
    where: { kind: { in: ALERT_KINDS }, processedAt: null },
    select: { id: true },
  });
  return pending !== null;
}

/**
 * Cron-compatible entry point. Matches the (log) => Promise<unknown> shape
 * used by other poll jobs in cron.ts.
 */
export async function runAlertDispatch(
  logger: FastifyBaseLogger | Console,
): Promise<AlertDispatchResult> {
  return dispatchAlerts(logger);
}
