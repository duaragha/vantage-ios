/**
 * Deterministic pre-LLM gates for the alert dispatcher.
 *
 * Every gate here runs before buildAlertFromEvent spends an LLM call. July's
 * ledger showed 1,458 alert-purpose calls producing 34 alerts — almost all of
 * the waste was backlog drains re-judging dead signal (a 500-call day after a
 * scheduler restart) and catalyst-kind events being consumed by the alert
 * path before the catalyst engine could see them.
 *
 * Gates:
 *   - kind-aware freshness: an IntradayMove is dead signal after a day; a
 *     filing alert after three. Anything older is bulk-marked processed with
 *     zero LLM cost. The old flat window (7d) remains the ceiling.
 *   - catalyst-kind exclusion: InsiderCluster/EarningsBeat/Material8K/
 *     AnalystUpgrade belong to the hourly catalyst engine (per
 *     docs/CATALYST_ENGINE.md). The 30s alert sweep must not consume them.
 *   - daily LLM call cap: a hard ceiling on alert-purpose calls per ET day.
 *     When reached, events stay queued (not suppressed) — they either process
 *     tomorrow or age out via the freshness gate.
 */

import { EventKind } from '@vantage/db';

/** Ceiling shared with the previous flat stale window. */
export const MAX_EVENT_AGE_HOURS = 7 * 24;

/**
 * Max age (hours from occurredAt) at which an event is still worth an LLM
 * judgment. Unlisted kinds fall back to the 7-day ceiling.
 */
export const EVENT_FRESHNESS_HOURS: Partial<Record<EventKind, number>> = {
  [EventKind.IntradayMove]: 24,
  [EventKind.SentimentSpike]: 24,
  [EventKind.BreakingNews]: 48,
  [EventKind.SectorNews]: 48,
  [EventKind.Macro]: 48,
  [EventKind.Earnings]: 72,
  [EventKind.Filing8K]: 72,
};

export function freshnessCutoff(kind: EventKind, now: Date): Date {
  const hours = EVENT_FRESHNESS_HOURS[kind] ?? MAX_EVENT_AGE_HOURS;
  return new Date(now.getTime() - hours * 3600 * 1000);
}

export function isEventFresh(kind: EventKind, occurredAt: Date, now: Date): boolean {
  return occurredAt.getTime() >= freshnessCutoff(kind, now).getTime();
}

/**
 * Hard daily ceiling on alert-purpose LLM calls. Steady state is ~12/day, so
 * 40 leaves ample headroom for a busy news day while capping a backlog-drain
 * burn at less than a tenth of July 17th's 510 calls.
 */
export const DEFAULT_ALERT_DAILY_LLM_CAP = 40;

export function alertDailyLlmCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ALERT_DAILY_LLM_CAP'];
  if (!raw) return DEFAULT_ALERT_DAILY_LLM_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_ALERT_DAILY_LLM_CAP;
  return parsed;
}

/** Dedup window for the ticker+kind gate (matches the cluster dedup window). */
export const TICKER_KIND_DEDUP_MS = 6 * 60 * 60 * 1000;
