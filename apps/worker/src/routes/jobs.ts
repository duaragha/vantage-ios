/**
 * /jobs/* — manual trigger endpoints for every ingestion job.
 *
 * All handlers are thin: verify auth (via preHandler), delegate to runJob(),
 * return the handler summary. No business logic lives here.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireWorkerSecret } from '../lib/auth.js';
import { runJob } from '../lib/runJob.js';
import { pollNews } from '../jobs/pollNews.js';
import { pollFilings } from '../jobs/pollFilings.js';
import { pollPrices } from '../jobs/pollPrices.js';
import { pollEarnings } from '../jobs/pollEarnings.js';
import { pollEodHistory } from '../jobs/pollEodHistory.js';
import { pollMacro } from '../jobs/pollMacro.js';
import { pollTickerUniverse } from '../jobs/pollTickerUniverse.js';
import { pollMarketNews } from '../jobs/pollMarketNews.js';
import { computeDiscovery } from '../jobs/computeDiscovery.js';
import { runAlertDispatch } from '../jobs/eventDispatch.js';
import { runDigest } from '../jobs/digestDispatch.js';
import { runDiscoveryDigest } from '../jobs/digestDiscovery.js';
import { pollInsiders } from '../jobs/pollInsiders.js';
import { pollAnalysts } from '../jobs/pollAnalysts.js';
import { pollFundamentals } from '../jobs/pollFundamentals.js';
import { runCatalystEngine } from '../jobs/runCatalystEngine.js';
import { snapshotGoals } from '../jobs/snapshotGoals.js';
import { updateLotteryFlags } from '../jobs/updateLotteryFlags.js';
import {
  evaluateThesis,
  evaluateAllTheses,
  suggestRebalance,
  runBacktest,
  type RebalanceTrigger,
} from '@vantage/core';
import { bootstrapTicker } from '../jobs/bootstrap.js';
import { backfillProfiles } from '../jobs/backfillProfiles.js';
import { seedEtfUniverse } from '../jobs/seedEtfUniverse.js';
import { runTelegramDispatch } from '../jobs/dispatchTelegram.js';
import { parseBacktestRequest } from '../lib/backtestRequest.js';
import { randomUUID } from 'node:crypto';
import { sendMessage, verifyChatId } from '@vantage/notify';

export const jobsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireWorkerSecret);

  fastify.post('/jobs/poll/news', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.news',
      bucketSeconds: 5 * 60,
      log: fastify.log,
      handler: () => pollNews(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/poll/filings', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.filings',
      bucketSeconds: 5 * 60,
      log: fastify.log,
      handler: () => pollFilings(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/poll/prices', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.prices',
      bucketSeconds: 60,
      log: fastify.log,
      handler: () => pollPrices(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/poll/earnings', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.earnings',
      bucketSeconds: 15 * 60,
      log: fastify.log,
      handler: () => pollEarnings(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post<{
    Body?: { tickers?: string[] };
  }>('/jobs/poll/eodHistory', async (req, reply) => {
    const tickers = Array.isArray(req.body?.tickers)
      ? req.body.tickers.map((ticker) => String(ticker))
      : [];
    const targeted = tickers.length > 0;
    const outcome = await runJob({
      name: targeted ? 'poll.eodHistory.targeted' : 'poll.eodHistory',
      bucketSeconds: targeted ? 60 : 24 * 3600,
      log: fastify.log,
      handler: () => pollEodHistory(fastify.log, targeted ? { tickers } : {}),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/poll/macro', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.macro',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => pollMacro(fastify.log),
    });
    return reply.send(outcome);
  });

  // ------------------------------------------------------------------------
  // Phase 17 — Catalyst foundations
  // ------------------------------------------------------------------------

  fastify.post('/jobs/poll/insiders', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.insiders',
      bucketSeconds: 30 * 60,
      log: fastify.log,
      handler: () => pollInsiders(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/poll/analysts', async (_req, reply) => {
    const outcome = await runJob({
      name: 'poll.analysts',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => pollAnalysts(fastify.log),
    });
    return reply.send(outcome);
  });

  // Fundamentals refresh manual trigger. Body accepts { force?: boolean,
  // tickers?: string[] } so a backfill or a smoke run on a curated list can
  // bypass the 7-day staleness gate.
  fastify.post<{
    Body?: { force?: boolean; tickers?: string[] };
  }>('/jobs/poll/fundamentals', async (req, reply) => {
    const body = req.body ?? {};
    const opts: Parameters<typeof pollFundamentals>[0] = { log: fastify.log };
    if (body.force === true) opts.force = true;
    if (Array.isArray(body.tickers) && body.tickers.length > 0) {
      opts.tickers = body.tickers.map((t) => String(t).toUpperCase());
    }
    const outcome = await runJob({
      name: 'poll.fundamentals',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => pollFundamentals(opts),
    });
    return reply.send(outcome);
  });

  // Phase 17.5 — Catalyst engine manual trigger. Same 1h idempotency bucket
  // as the cron registration so a manual poke during the same hour gets
  // deduped against the scheduled run.
  fastify.post('/jobs/catalyst/run', async (_req, reply) => {
    const outcome = await runJob({
      name: 'catalyst.run',
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: () => runCatalystEngine(fastify.log),
    });
    return reply.send(outcome);
  });

  // Goals snapshot — manual trigger for the nightly progress writer. Same
  // 24h idempotency bucket as the cron registration so a same-day poke after
  // the 3am run deduplicates cleanly (the underlying upsert would just
  // overwrite anyway).
  fastify.post('/jobs/goals/snapshot', async (_req, reply) => {
    const outcome = await runJob({
      name: 'goals.snapshot',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => snapshotGoals(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post<{
    Body?: { tickers?: string[] };
  }>('/jobs/quality/lottery', async (req, reply) => {
    const tickers = Array.isArray(req.body?.tickers)
      ? req.body.tickers.map((ticker) => String(ticker))
      : [];
    const targeted = tickers.length > 0;
    const outcome = await runJob({
      name: targeted ? 'quality.lottery.targeted' : 'quality.lottery',
      bucketSeconds: targeted ? 60 : 24 * 3600,
      log: fastify.log,
      handler: () => updateLotteryFlags(fastify.log, targeted ? { tickers } : {}),
    });
    return reply.send(outcome);
  });

  // ------------------------------------------------------------------------
  // Phase 15 — discovery foundations
  // ------------------------------------------------------------------------

  fastify.post<{
    Body?: {
      limit?: number;
      backfillProfiles?: boolean;
      exchanges?: ReadonlyArray<'US' | 'TO' | 'NE' | 'V'>;
    };
  }>('/jobs/poll/tickerUniverse', async (req, reply) => {
    const body = req.body ?? {};
    const opts: Parameters<typeof pollTickerUniverse>[1] = {};
    if (typeof body.limit === 'number' && body.limit > 0) opts.limit = body.limit;
    if (body.backfillProfiles === true) opts.backfillProfiles = true;
    if (Array.isArray(body.exchanges) && body.exchanges.length > 0) {
      const filtered = body.exchanges.filter(
        (x): x is 'US' | 'TO' | 'NE' | 'V' => x === 'US' || x === 'TO' || x === 'NE' || x === 'V',
      );
      if (filtered.length > 0) opts.exchanges = filtered;
    }
    const outcome = await runJob({
      name: 'poll.tickerUniverse',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => pollTickerUniverse(fastify.log, opts),
    });
    return reply.send(outcome);
  });

  fastify.post<{
    Body?: { categories?: string[]; disableHaiku?: boolean };
  }>('/jobs/poll/marketNews', async (req, reply) => {
    const body = req.body ?? {};
    const opts: Parameters<typeof pollMarketNews>[1] = {};
    if (Array.isArray(body.categories) && body.categories.length > 0) {
      opts.categories = body.categories.map((c) => String(c));
    }
    if (body.disableHaiku === true) opts.disableHaiku = true;
    const outcome = await runJob({
      name: 'poll.marketNews',
      bucketSeconds: 15 * 60,
      log: fastify.log,
      handler: () => pollMarketNews(fastify.log, opts),
    });
    return reply.send(outcome);
  });

  fastify.post<{
    Body?: { tickers?: string[]; limit?: number; useCachedMarketData?: boolean };
  }>('/jobs/discover/compute', async (req, reply) => {
    const body = req.body ?? {};
    const opts: Parameters<typeof computeDiscovery>[1] = {};
    if (Array.isArray(body.tickers) && body.tickers.length > 0) {
      opts.tickers = body.tickers.map((t) => String(t).toUpperCase());
    }
    if (typeof body.limit === 'number' && body.limit > 0) opts.limit = body.limit;
    if (body.useCachedMarketData === true) opts.useCachedMarketData = true;
    const outcome = await runJob({
      name: opts.useCachedMarketData ? 'discover.compute.cached' : 'discover.compute',
      bucketSeconds: opts.useCachedMarketData ? 60 * 60 : 6 * 3600,
      log: fastify.log,
      handler: () => computeDiscovery(fastify.log, opts),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/alert/dispatch', async (_req, reply) => {
    const outcome = await runJob({
      name: 'alert.dispatch',
      bucketSeconds: 30,
      log: fastify.log,
      handler: () => runAlertDispatch(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/telegram/dispatch', async (_req, reply) => {
    const outcome = await runJob({
      name: 'telegram.dispatch',
      bucketSeconds: 30,
      log: fastify.log,
      handler: () => runTelegramDispatch(fastify.log),
    });
    return reply.send(outcome);
  });

  // Deterministic end-to-end smoke for initial BotFather setup. This bypasses
  // the durable queue intentionally so old pending alerts cannot hide whether
  // the newly supplied token and chat id work right now.
  fastify.post('/jobs/telegram/test', async (_req, reply) => {
    const verified = await verifyChatId();
    if (!verified) {
      fastify.log.warn('Telegram test rejected: bot or chat id verification failed');
      return reply.code(502).send({
        ok: false,
        error: 'Telegram bot or chat id verification failed',
      });
    }

    const result = await sendMessage(
      `Vantage Telegram test\nDelivery verified at ${new Date().toISOString()}`,
      { disableNotification: false, disableWebPagePreview: true },
    );
    if (!result.ok) {
      fastify.log.warn(
        { reason: result.reason, status: result.status },
        'Telegram test delivery failed',
      );
      return reply.code(502).send({ ok: false, error: 'Telegram test delivery failed' });
    }

    return reply.send({ ok: true, messageId: result.messageId });
  });

  // Digests — one idempotency bucket per natural cadence. Morning/evening
  // run intraday so we use a 1h bucket (cron fires once at the scheduled
  // minute; a same-hour retry dedups). Monthly + weekly use 1d buckets.
  fastify.post('/jobs/digest/morning', async (_req, reply) => {
    const outcome = await runJob({
      name: 'digest.morning',
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: () => runDigest('morning', fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/digest/evening', async (_req, reply) => {
    const outcome = await runJob({
      name: 'digest.evening',
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: () => runDigest('evening', fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/digest/monthly-allocation', async (_req, reply) => {
    const outcome = await runJob({
      name: 'digest.monthlyAllocation',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => runDigest('monthly', fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post('/jobs/digest/weekly-deepdive', async (_req, reply) => {
    const outcome = await runJob({
      name: 'digest.weeklyDeepDive',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => runDigest('weekly', fastify.log),
    });
    return reply.send(outcome);
  });

  // Phase 15 — weekly market-discovery digest (Saturday 10am ET).
  fastify.post('/jobs/digest/discovery', async (_req, reply) => {
    const outcome = await runJob({
      name: 'digest.discovery',
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => runDiscoveryDigest(fastify.log),
    });
    return reply.send(outcome);
  });

  // ------------------------------------------------------------------------
  // Thesis engine
  // ------------------------------------------------------------------------

  fastify.post<{ Params: { positionId: string } }>(
    '/jobs/thesis/evaluate/:positionId',
    async (req, reply) => {
      const positionId = Number(req.params.positionId);
      if (!Number.isInteger(positionId) || positionId <= 0) {
        return reply.code(400).send({ error: 'invalid positionId' });
      }
      const outcome = await runJob({
        name: `thesis.evaluate.${positionId}`,
        bucketSeconds: 60 * 60,
        log: fastify.log,
        handler: () =>
          evaluateThesis(positionId, { log: fastify.log }).then((evalRow) =>
            evalRow
              ? {
                  evaluationId: evalRow.id,
                  prevStatus: evalRow.prevStatus,
                  newStatus: evalRow.newStatus,
                }
              : { skipped: true },
          ),
      });
      return reply.send(outcome);
    },
  );

  fastify.post<{ Body: { staleOnly?: boolean; sendTelegram?: boolean } }>(
    '/jobs/thesis/batch',
    async (req, reply) => {
      const body = req.body ?? {};
      const outcome = await runJob({
        name: 'thesis.batch',
        bucketSeconds: 60 * 60,
        log: fastify.log,
        handler: () =>
          evaluateAllTheses({
            staleOnly: body.staleOnly === true,
            sendTelegram: body.sendTelegram,
            log: fastify.log,
          }),
      });
      return reply.send(outcome);
    },
  );

  // ------------------------------------------------------------------------
  // Rebalance engine
  // ------------------------------------------------------------------------

  fastify.post<{
    Body?: { trigger?: RebalanceTrigger; requireViolation?: boolean };
  }>('/jobs/rebalance/suggest', async (req, reply) => {
    const body = req.body ?? {};
    const trigger: RebalanceTrigger = body.trigger ?? 'manual';
    const outcome = await runJob({
      name: `rebalance.suggest.${trigger}`,
      // One-hour idempotency bucket — a rapid retry of the same trigger
      // within the hour is treated as a dup. Matches the digest cadence.
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: async () => {
        const result = await suggestRebalance({
          trigger,
          log: fastify.log,
          ...(body.requireViolation !== undefined
            ? { requireViolation: body.requireViolation }
            : {}),
        });
        return {
          insightsCreated: result.insights.length,
          insightIds: result.insights.map((i) => i.id),
          violations: result.violations.length,
          candidates: result.candidates.length,
          skipped: result.skipped,
          skipReason: result.skipReason ?? null,
          tokens: result.tokens,
          llmCallIds: result.llmCallIds,
        };
      },
    });
    return reply.send(outcome);
  });

  // ------------------------------------------------------------------------
  // Backtest
  // ------------------------------------------------------------------------

  // Backtests are freely re-runnable. The spec explicitly calls out looser
  // idempotency here — we give every run a random bucket so the 10-min
  // in-flight dedup never fires.
  fastify.post<{ Body: unknown }>('/jobs/backtest/run', async (req, reply) => {
    const parsed = parseBacktestRequest(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const config = parsed.value;

    const outcome = await runJob({
      name: `backtest.run.${randomUUID()}`,
      bucketSeconds: 60,
      log: fastify.log,
      handler: async () => {
        const result = await runBacktest(config, { log: fastify.log });
        return {
          backtestRunId: result.backtestRunId,
          finalValueUsd: result.finalValueUsd,
          totalReturnPct: result.totalReturnPct,
          spyReturnPct: result.spyReturnPct,
          cagr: result.cagr,
          maxDrawdownPct: result.maxDrawdownPct,
          sharpeApprox: result.sharpeApprox ?? 0,
          entriesCount: result.entries.length,
          exitsCount: result.exits.length,
          snapshotsCount: result.monthlySnapshots.length,
          equityCurveCount: result.equityCurve.length,
          result,
        };
      },
    });
    return reply.send(outcome);
  });

  fastify.get<{ Params: { id: string } }>('/jobs/backtest/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const { prisma } = await import('@vantage/db');
    const row = await prisma.backtestRun.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'not found' });
    return reply.send(row);
  });

  // ------------------------------------------------------------------------
  // Bootstrap (cold-start per ticker)
  // ------------------------------------------------------------------------

  // Manual backfill of Finnhub profile data for Positions + TickerUniverse
  // rows missing sector / marketCap. Respects a 30/min pace internally —
  // safe to run once after deploys. No cron attached.
  fastify.post<{
    Body?: { limit?: number };
  }>('/jobs/backfill/profiles', async (req, reply) => {
    const body = req.body ?? {};
    const opts: Parameters<typeof backfillProfiles>[1] = {};
    if (typeof body.limit === 'number' && body.limit > 0) opts.limit = body.limit;
    const outcome = await runJob({
      name: 'backfill.profiles',
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: () => backfillProfiles(fastify.log, opts),
    });
    return reply.send(outcome);
  });

  // One-shot seed of curated CA + US ETFs into TickerUniverse. Idempotent —
  // corrects category/exchange/currency and preserves scraped marketCap.
  fastify.post('/jobs/seed/etfs', async (_req, reply) => {
    const outcome = await runJob({
      name: 'seed.etfs',
      bucketSeconds: 60 * 60,
      log: fastify.log,
      handler: () => seedEtfUniverse(fastify.log),
    });
    return reply.send(outcome);
  });

  fastify.post<{ Params: { ticker: string } }>('/jobs/bootstrap/:ticker', async (req, reply) => {
    const ticker = (req.params.ticker ?? '').trim().toUpperCase();
    if (!ticker) {
      return reply.code(400).send({ error: 'missing ticker' });
    }
    const outcome = await runJob({
      name: `bootstrap.${ticker}`,
      bucketSeconds: 24 * 3600,
      log: fastify.log,
      handler: () => bootstrapTicker(ticker, { log: fastify.log }),
    });
    return reply.send(outcome);
  });
};
