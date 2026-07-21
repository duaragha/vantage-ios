/**
 * Compare server actions.
 *
 * - refreshCompareAction: proxies to the worker's /jobs/discover/compute with
 *   the held tickers + top 50 unheld candidates, so a page refresh doesn't
 *   wait for the nightly cron.
 * - acceptSwapAction: persists a rotation Insight that the user can later
 *   accept / pass from the Insights feed.
 */

'use server';

import { prisma, createInsight, InsightKind, Confidence } from '@vantage/db';
import { callWorker } from '@/lib/worker';
import { buildRotationActionJson } from '@/lib/insightActions';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/actions/compare');

export interface RefreshResult {
  ok: boolean;
  holdingsScored?: number;
  universeScored?: number;
  error?: string;
}

export async function refreshCompareAction(): Promise<RefreshResult> {
  try {
    // Send both held tickers + the latest top-50 candidate cohort so a manual
    // refresh updates both sides of the comparison in one worker call.
    const [heldPositions, latestBatch] = await Promise.all([
      prisma.position.findMany({
        where: { closedAt: null },
        select: { ticker: true },
      }),
      prisma.discoveryScore.aggregate({ _max: { computedAt: true } }),
    ]);
    const heldTickers = heldPositions.map((p) => p.ticker.toUpperCase());

    let latestUnheld: string[] = [];
    if (latestBatch._max.computedAt) {
      const top = await prisma.discoveryScore.findMany({
        where: { computedAt: latestBatch._max.computedAt },
        orderBy: { score: 'desc' },
        take: 50,
        select: { ticker: true },
      });
      const heldSet = new Set(heldTickers);
      latestUnheld = top.map((r) => r.ticker.toUpperCase()).filter((t) => !heldSet.has(t));
    }

    const tickers = Array.from(new Set([...heldTickers, ...latestUnheld]));

    const res = await callWorker<{
      result?: {
        scored?: number;
        holdingsScored?: number;
      };
    }>('/jobs/discover/compute', {
      method: 'POST',
      body: tickers.length > 0 ? { tickers } : {},
    });

    if (!res.ok) {
      log.warn({ status: res.status, workerError: res.error }, 'compare refresh rejected');
      return { ok: false, error: 'compare refresh unavailable' };
    }

    const out: RefreshResult = { ok: true };
    const scored = res.data?.result?.scored;
    const holdings = res.data?.result?.holdingsScored;
    if (typeof scored === 'number') out.universeScored = scored;
    if (typeof holdings === 'number') out.holdingsScored = holdings;
    return out;
  } catch (err) {
    log.error({ err }, 'compare refresh failed');
    return { ok: false, error: 'compare refresh unavailable' };
  }
}

export interface AcceptSwapInput {
  trimTicker: string;
  buyTicker: string;
  scoreDelta: number;
  why: string;
}

export interface AcceptSwapResult {
  ok: boolean;
  insightId?: number;
  error?: string;
}

export async function acceptSwapAction(input: AcceptSwapInput): Promise<AcceptSwapResult> {
  const trim = input.trimTicker.trim().toUpperCase();
  const buy = input.buyTicker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(trim) || !/^[A-Z.-]{1,8}$/.test(buy)) {
    return { ok: false, error: 'invalid ticker' };
  }
  if (!Number.isFinite(input.scoreDelta)) {
    return { ok: false, error: 'invalid scoreDelta' };
  }

  const title = `Rotate ${trim} → ${buy}`;
  try {
    const insight = await createInsight({
      kind: InsightKind.Rebalance,
      title,
      body: input.why.slice(0, 2000),
      reasoning:
        `User-initiated rotation from /compare. Score delta ` +
        `${input.scoreDelta.toFixed(2)}. Dollar-neutral swap candidate — ` +
        `confirm exact share sizing before acting.`,
      citations: [],
      actionJson: buildRotationActionJson({
        trimTicker: trim,
        buyTicker: buy,
        scoreDelta: input.scoreDelta,
        source: 'compare-ui',
      }),
      confidence: Confidence.Medium,
      triggeredBy: 'compare:ui',
    });
    return { ok: true, insightId: insight.id };
  } catch (err) {
    log.error({ err, trimTicker: trim, buyTicker: buy }, 'accept swap failed');
    return { ok: false, error: 'rotation insight could not be created' };
  }
}
