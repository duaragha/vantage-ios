/**
 * Thesis batch evaluator.
 *
 * Walks every open Position with a Thesis and runs evaluateThesis() against
 * each. Two modes:
 *   - full (default): every thesis, regardless of age.
 *   - staleOnly=true: only theses where lastValidatedAt is older than 30 days.
 *
 * Called from the weekly deep-dive digest and from the manual
 * POST /jobs/thesis/batch endpoint.
 */

import { prisma } from '@vantage/db';
import {
  evaluateThesis,
  type EvaluateThesisOptions,
  type ThesisEvalLogger,
} from './thesis.js';

export interface EvaluateAllThesesOptions {
  staleOnly?: boolean;
  /** Forwarded to evaluateThesis. */
  windowHours?: number;
  log?: ThesisEvalLogger;
  /** Default true; pass-through to evaluateThesis. */
  sendTelegram?: boolean;
}

export interface EvaluateAllThesesResult {
  evaluated: number;
  statusChanges: number;
  skipped: number;
  errors: number;
}

const STALE_MS = 30 * 24 * 3600 * 1000;

export async function evaluateAllTheses(
  opts: EvaluateAllThesesOptions = {},
): Promise<EvaluateAllThesesResult> {
  const log = (opts.log ?? console) as ThesisEvalLogger;
  const staleOnly = opts.staleOnly ?? false;
  const staleCutoff = new Date(Date.now() - STALE_MS);

  const positions = await prisma.position.findMany({
    where: {
      closedAt: null,
      thesis: staleOnly
        ? { is: { lastValidatedAt: { lt: staleCutoff } } }
        : { isNot: null },
    },
    include: { thesis: true },
    orderBy: { ticker: 'asc' },
  });

  const result: EvaluateAllThesesResult = {
    evaluated: 0,
    statusChanges: 0,
    skipped: 0,
    errors: 0,
  };

  for (const pos of positions) {
    if (!pos.thesis) {
      result.skipped++;
      continue;
    }
    const prevStatus = pos.thesis.status;
    try {
      const evaluationOpts: EvaluateThesisOptions = { log };
      if (opts.windowHours !== undefined) {
        evaluationOpts.windowHours = opts.windowHours;
      }
      if (opts.sendTelegram !== undefined) {
        evaluationOpts.sendTelegram = opts.sendTelegram;
      }
      const evalRow = await evaluateThesis(pos.id, evaluationOpts);
      if (!evalRow) {
        result.skipped++;
        continue;
      }
      result.evaluated++;
      if (evalRow.newStatus !== prevStatus) {
        result.statusChanges++;
      }
    } catch (err) {
      result.errors++;
      log.error?.(
        {
          positionId: pos.id,
          ticker: pos.ticker,
          err: err instanceof Error ? err.message : err,
        },
        '[core/thesisBatch] evaluate failed for position',
      );
    }
  }

  log.info?.(
    {
      totalPositions: positions.length,
      evaluated: result.evaluated,
      statusChanges: result.statusChanges,
      skipped: result.skipped,
      errors: result.errors,
      staleOnly,
    },
    '[core/thesisBatch] batch complete',
  );

  return result;
}
