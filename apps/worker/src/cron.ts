/**
 * Croner registration for every scheduled worker job.
 *
 * All times use America/Toronto. README.md carries the operator-facing table;
 * CRON_SPECS below is the executable source of truth.
 *
 * Each cron tick invokes the handler directly through runJob() — no HTTP
 * hop. Cheaper, and simpler to reason about (handlers are pure functions).
 */

import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import { sendSelfAlert } from '@vantage/notify';
import { runJob } from './lib/runJob.js';
import {
  OVERNIGHT_EVERY_30M,
  OVERNIGHT_HOURLY,
  offPeakPollDue,
  pricePollDue,
} from './lib/pollCadence.js';
import { pollNews } from './jobs/pollNews.js';
import { pollFilings } from './jobs/pollFilings.js';
import { pollPrices } from './jobs/pollPrices.js';
import { pollEarnings } from './jobs/pollEarnings.js';
import { pollEodHistory } from './jobs/pollEodHistory.js';
import { pollMacro } from './jobs/pollMacro.js';
import { pollTickerUniverse } from './jobs/pollTickerUniverse.js';
import { pollMarketNews } from './jobs/pollMarketNews.js';
import { computeDiscovery } from './jobs/computeDiscovery.js';
import { hasPendingAlertWork, runAlertDispatch } from './jobs/eventDispatch.js';
import { runDigest } from './jobs/digestDispatch.js';
import { runDiscoveryDigest } from './jobs/digestDiscovery.js';
import { pollInsiders } from './jobs/pollInsiders.js';
import { pollAnalysts } from './jobs/pollAnalysts.js';
import { pollFundamentals } from './jobs/pollFundamentals.js';
import { hasPendingCatalystWork, runCatalystEngine } from './jobs/runCatalystEngine.js';
import { snapshotGoals } from './jobs/snapshotGoals.js';
import { updateLotteryFlags } from './jobs/updateLotteryFlags.js';
import { backfillProfiles } from './jobs/backfillProfiles.js';
import { hasPendingTelegramWork, runTelegramDispatch } from './jobs/dispatchTelegram.js';
import { retentionSweep } from './jobs/retentionSweep.js';
import { evaluateAllTheses } from '@vantage/core';
import { prisma } from '@vantage/db';
import type { ExchangeOption } from './jobs/pollTickerUniverse.js';

/**
 * Pull the user's configured exchanges from UserSettings.exchangesEnabled.
 * Defaults to ['US','TO'] on any read error so the Canadian user's universe
 * refresh keeps firing even if the settings row is missing.
 */
async function readEnabledExchanges(
  log: FastifyBaseLogger | Console,
): Promise<ReadonlyArray<ExchangeOption>> {
  const DEFAULT: ReadonlyArray<ExchangeOption> = ['US', 'TO'];
  try {
    const row = await prisma.userSettings.findUnique({
      where: { id: 1 },
      select: { exchangesEnabled: true },
    });
    const raw = row?.exchangesEnabled;
    if (!Array.isArray(raw)) return DEFAULT;
    const filtered = raw.filter(
      (x): x is ExchangeOption => x === 'US' || x === 'TO' || x === 'NE' || x === 'V',
    );
    return filtered.length > 0 ? filtered : DEFAULT;
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      'poll.tickerUniverse: settings read failed; using US + TO defaults',
    );
    return DEFAULT;
  }
}

export interface CronSpec {
  expr: string;
  name: string;
  bucketSeconds: number;
  run: (log: FastifyBaseLogger | Console) => Promise<unknown>;
  /**
   * Optional cheap gate (see runJob). Ticks it declines skip without a JobRun
   * row; the in-process tick registry keeps the watchdog and deep health
   * accurate. Work-queue gates get runJob's 15-minute forced heartbeat;
   * cadence gates set heartbeatMs 0 because they fire by clock construction
   * and a heartbeat would defeat their off-peak thinning.
   */
  precheck?: () => Promise<boolean>;
  /** Heartbeat override passed through to runJob (0 disables). */
  heartbeatMs?: number;
}

export const CRON_SPECS: readonly CronSpec[] = [
  {
    expr: '*/5 * * * 1-5',
    name: 'poll.news',
    bucketSeconds: 5 * 60,
    run: pollNews,
    // Newsrooms sleep: 30-min cadence 22:00-06:00 ET.
    precheck: async () => offPeakPollDue(new Date(), OVERNIGHT_EVERY_30M),
    heartbeatMs: 0,
  },
  {
    expr: '*/5 * * * 1-5',
    name: 'poll.filings',
    bucketSeconds: 5 * 60,
    run: pollFilings,
    // EDGAR stops accepting filings at 22:00 ET: 30-min overnight safety poll.
    precheck: async () => offPeakPollDue(new Date(), OVERNIGHT_EVERY_30M),
    heartbeatMs: 0,
  },
  {
    // Per-minute across pre-market → after-hours (04:00-20:00 ET, weekdays) so
    // the freshest price stays current into the evening, not just during the
    // 9:30-16:00 regular session. Cron runs in TZ=America/Toronto (== ET clock,
    // same DST offset), so the 4-19 hour range is the ET window 04:00-19:59;
    // 20:00 itself is excluded, matching the after-hours close. The IntradayMove
    // EVENT logic inside pollPrices stays gated to regular hours — only the
    // LivePrice WRITE extends to pre/after-hours. Held tickers stay well under
    // Finnhub's 60/min; held + the scanner universe (~40-50 names) stay under
    // Alpaca's 200/min. Drives the LivePrice table that /portfolio + /compare +
    // the day-trade scanner read first (with DailyBar fallback when stale).
    expr: '* 4-19 * * 1-5',
    name: 'poll.prices',
    bucketSeconds: 60,
    run: pollPrices,
    // Per-minute only in the regular session; 5-min pre/after-hours, 15-min
    // on US market holidays (TSX names keep a pulse via yfinance).
    precheck: async () => pricePollDue(new Date()),
    heartbeatMs: 0,
  },
  {
    expr: '*/15 * * * 1-5',
    name: 'poll.earnings',
    bucketSeconds: 15 * 60,
    run: pollEarnings,
    // Nothing announces at 3am: hourly cadence 22:00-06:00 ET.
    precheck: async () => offPeakPollDue(new Date(), OVERNIGHT_HOURLY),
    heartbeatMs: 0,
  },
  {
    expr: '0 17 * * 1-5',
    name: 'poll.eodHistory',
    bucketSeconds: 24 * 3600,
    run: pollEodHistory,
  },
  {
    expr: '0 6 * * 1-5',
    name: 'poll.macro',
    bucketSeconds: 24 * 3600,
    run: pollMacro,
  },
  // Ticker universe refresh. Sunday 6am.
  //
  // Post-Phase-16 rewrite sources the universe from Tiingo (US) +
  // Twelve Data (TO/NE/V) — a single zip download plus one JSON call per
  // Canadian exchange, so the full refresh runs in under a minute.
  // `opts.backfillProfiles` is deliberately left false on the cron: profile
  // (sector + marketCap) backfill is scheduled separately to respect
  // Finnhub's throttle.
  //
  // Exchanges come from UserSettings.exchangesEnabled — defaults to
  // ['US','TO'] so the user's Canadian universe refreshes alongside the US.
  {
    expr: '0 6 * * 0',
    name: 'poll.tickerUniverse',
    bucketSeconds: 24 * 3600,
    run: async (log) => {
      const exchanges = await readEnabledExchanges(log);
      return pollTickerUniverse(log, { exchanges });
    },
  },
  // Phase 15 — market-wide news poll every 15min on weekdays.
  {
    expr: '*/15 * * * 1-5',
    name: 'poll.marketNews',
    bucketSeconds: 15 * 60,
    run: (log) => pollMarketNews(log),
    precheck: async () => offPeakPollDue(new Date(), OVERNIGHT_HOURLY),
    heartbeatMs: 0,
  },
  // Phase 15 — cheap intraday discovery refreshes. These score the full
  // universe but reuse cached DailyBar + InsiderTransaction rows, so the
  // latest /discovery surface picks up new articles/events without running the
  // expensive per-ticker external API sweep.
  {
    expr: '30 10,13 * * 1-5',
    name: 'discover.compute.cached',
    bucketSeconds: 60 * 60,
    run: (log) => computeDiscovery(log, { useCachedMarketData: true }),
  },
  // Phase 15 — full discovery compute at 6pm ET on weekdays. This is the
  // external-data refresh pass.
  {
    expr: '0 18 * * 1-5',
    name: 'discover.compute',
    bucketSeconds: 6 * 3600,
    run: (log) => computeDiscovery(log),
  },
  {
    // Every 30 seconds — timezone-independent. bucketSeconds=30 means each
    // runJob call lands in its own idempotency bucket, so two cron ticks in
    // the same second (shouldn't happen) still dedup cleanly.
    expr: '*/30 * * * * *',
    name: 'alert.dispatch',
    bucketSeconds: 30,
    run: runAlertDispatch,
    // One indexed lookup replaces the full sweep on the (vast majority of)
    // ticks with an empty event queue.
    precheck: hasPendingAlertWork,
  },
  {
    // Offset from alert.dispatch so newly-created outbox rows are usually
    // available before the delivery sweep starts.
    expr: '15,45 * * * * *',
    name: 'telegram.dispatch',
    bucketSeconds: 30,
    run: runTelegramDispatch,
    precheck: hasPendingTelegramWork,
  },
  // Digests — times in America/Toronto per spec ### Scheduling.
  {
    expr: '0 7 * * 1-5',
    name: 'digest.morning',
    bucketSeconds: 60 * 60,
    run: (log) => runDigest('morning', log),
  },
  {
    expr: '30 16 * * 1-5',
    name: 'digest.evening',
    bucketSeconds: 60 * 60,
    run: (log) => runDigest('evening', log),
  },
  {
    expr: '0 9 1 * *',
    name: 'digest.monthlyAllocation',
    bucketSeconds: 24 * 3600,
    run: (log) => runDigest('monthly', log),
  },
  {
    expr: '0 20 * * 0',
    name: 'digest.weeklyDeepDive',
    bucketSeconds: 24 * 3600,
    run: (log) => runDigest('weekly', log),
  },
  // Phase 15 — Saturday 10am America/Toronto discovery digest.
  {
    expr: '0 10 * * 6',
    name: 'digest.discovery',
    bucketSeconds: 24 * 3600,
    run: (log) => runDiscoveryDigest(log),
  },
  // Phase 17 — Insider transactions polled every 30 minutes during market
  // hours (9-16 ET, weekdays). Cluster detector fires inline.
  {
    expr: '*/30 9-16 * * 1-5',
    name: 'poll.insiders',
    bucketSeconds: 30 * 60,
    run: (log) => pollInsiders(log),
  },
  // Phase 17 — Analyst recommendation trends polled once per day at 7am ET
  // (pre-market). Detector fires inline; AnalystUpgrade events are deduped
  // by ticker + month.
  {
    expr: '0 7 * * 1-5',
    name: 'poll.analysts',
    bucketSeconds: 24 * 3600,
    run: (log) => pollAnalysts(log),
  },
  // Fundamentals refresh — SEC EDGAR XBRL + Finnhub ratios. Runs nightly at
  // 2am ET. Default mode (force=false) only re-polls tickers whose
  // TickerMetrics row is older than 7 days, so the cron tops up gradually
  // rather than burning the full Finnhub budget every night.
  {
    expr: '0 2 * * *',
    name: 'poll.fundamentals',
    bucketSeconds: 24 * 3600,
    run: (log) => pollFundamentals({ log, force: false }),
  },
  // Bounded profile enrichment for newly seeded US listings. The queue keeps
  // its own attempt timestamp, so unsupported symbols move to the back instead
  // of blocking every later ticker. Scheduled before price polling begins.
  {
    expr: '15 3 * * *',
    name: 'backfill.profiles',
    bucketSeconds: 24 * 3600,
    run: (log) => backfillProfiles(log, { limit: 500 }),
  },
  // Nightly lottery gate. Uses the latest 20 stored closes to flag sub-$5
  // tickers with annualized realized volatility above 100 percent.
  {
    expr: '30 1 * * *',
    name: 'quality.lottery',
    bucketSeconds: 24 * 3600,
    run: (log) => updateLotteryFlags(log),
  },
  // Nightly goal progress snapshot — 3am America/Toronto. Sequenced after
  // poll.eodHistory (17:00 ET) and poll.fundamentals (02:00 ET) so today's
  // closes + room figures are settled before we write the snapshot row.
  // bucketSeconds=24h means a manual same-day trigger no-ops against the
  // cron's run (the upsert would just overwrite anyway).
  {
    expr: '0 3 * * *',
    name: 'goals.snapshot',
    bucketSeconds: 24 * 3600,
    run: (log) => snapshotGoals(log),
  },
  // Phase 17.5 — The exceptional-opportunity fast lane checks every five
  // minutes during US market hours. An indexed precheck makes empty ticks
  // cheap; real catalyst events still pass the full quality, cap, cooldown,
  // and citation gates before any phone notification is queued.
  {
    expr: '*/5 9-16 * * 1-5',
    name: 'catalyst.run',
    bucketSeconds: 5 * 60,
    run: (log) => runCatalystEngine(log),
    precheck: hasPendingCatalystWork,
  },
  // Daily thesis re-eval. Runs 4:45pm ET weekdays — 15 min after the evening
  // poll window closes, so the thesis engine has the freshest 24h of articles
  // + events to work with. staleOnly=false → re-evaluates every open thesis,
  // regardless of last-validated-at. Status flips (Intact→Strengthening etc.)
  // are written into Insight rows + fire Telegram via the evaluator's
  // existing hook, so you see thesis changes by ~5pm each trading day.
  {
    expr: '45 16 * * 1-5',
    name: 'thesis.batch',
    bucketSeconds: 60 * 60,
    run: (log) => evaluateAllTheses({ staleOnly: false, sendTelegram: true, log }),
  },
  // Nightly bounded retention for operational tables (JobRun, sent/dead
  // Telegram deliveries, old LLM ledger rows, processed events, stale tier-3
  // social articles). Windows + safety rules in lib/retentionPolicy.ts.
  // 03:30 ET — after the 2am fundamentals and 3am goals snapshot, before the
  // 3:15am profile backfill window ends.
  {
    expr: '30 3 * * *',
    name: 'db.retention',
    bucketSeconds: 24 * 3600,
    run: (log) => retentionSweep(log),
  },
];

export interface StartCronOptions {
  /** If true, don't actually schedule tasks — only log what would be scheduled. */
  dryRun?: boolean;
}

export function startCron(log: FastifyBaseLogger, opts: StartCronOptions = {}): Cron[] {
  const timezone = process.env['TZ'] ?? 'America/Toronto';
  log.info(
    {
      timezone,
      dryRun: opts.dryRun ?? false,
      schedules: CRON_SPECS.map((s) => ({ name: s.name, expr: s.expr })),
    },
    'cron: registering ingestion jobs',
  );

  if (opts.dryRun) return [];

  const tasks: Cron[] = [];
  for (const spec of CRON_SPECS) {
    const task = new Cron(
      spec.expr,
      {
        timezone,
        name: spec.name,
        catch: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ job: spec.name, err: message }, 'scheduler callback failed');
          void sendSelfAlert('error', `scheduler callback failed: ${spec.name}`, {
            job: spec.name,
            expression: spec.expr,
            timezone,
            error: message,
          });
        },
      },
      async () => {
        await runJob({
          name: spec.name,
          bucketSeconds: spec.bucketSeconds,
          log,
          handler: () => spec.run(log),
          ...(spec.precheck ? { precheck: spec.precheck } : {}),
          ...(spec.heartbeatMs !== undefined ? { heartbeatMs: spec.heartbeatMs } : {}),
        });
      },
    );
    tasks.push(task);
  }
  return tasks;
}
