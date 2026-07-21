/**
 * Backfill Finnhub profiles for rows missing sector / market-cap metadata.
 *
 * POST /jobs/backfill/profiles
 *
 * Two cohorts are backfilled in a single pass:
 *   1. Open Positions with a null `sector`.
 *   2. TickerUniverse rows with a null `marketCapUsd`.
 *
 * Both resolve to the same Finnhub /stock/profile2 endpoint per symbol. We
 * dedup across cohorts so AAPL held + AAPL-in-universe only costs one call.
 *
 * Rate limit: Finnhub's documented free-tier limit is 60/min but the profile
 * endpoint has been observed to throttle tighter in practice, so we cap at
 * 30/min here. The adapter's own RateLimiter is a 60/min token bucket shared
 * across endpoints; our paced loop sleeps between calls to stay safely under
 * the profile-specific throttle.
 *
 * Idempotent: after a successful run, symbols already have sector +
 * marketCap populated, so a re-run is a no-op for those rows.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma, upsertFromFinnhubProfile, updatePosition } from '@vantage/db';
import { getFinnhub } from '../lib/adapters.js';

const PROFILES_PER_MINUTE = 30;
const MIN_CALL_INTERVAL_MS = Math.ceil(60_000 / PROFILES_PER_MINUTE);

/**
 * Free-tier Finnhub has no profile for most micro-caps, warrants and units —
 * ~13.8k universe rows churned through 500 predictable-empty calls nightly.
 * After this many consecutive no-yield attempts a symbol drops to a monthly
 * retry; any attempt that yields a market cap resets the counter, and thrown
 * (network/throttle) attempts never count as strikes.
 */
export const PROFILE_UNSUPPORTED_STRIKES = 3;
export const PROFILE_UNSUPPORTED_RETRY_DAYS = 30;

export interface BackfillProfilesOptions {
  /** Cap the number of unique symbols processed. Useful for dry runs. */
  limit?: number;
}

export interface BackfillProfilesResult {
  uniqueSymbols: number;
  profilesFetched: number;
  positionsUpdated: number;
  universeUpserted: number;
  failedLookups: number;
  /** Universe rows parked by the strike gate (retry monthly). */
  parkedUnsupported: number;
  runtimeMs: number;
}

export async function backfillProfiles(
  log: FastifyBaseLogger | Console = console,
  opts: BackfillProfilesOptions = {},
): Promise<BackfillProfilesResult> {
  const started = Date.now();
  const fn = getFinnhub();

  log.info?.({ event: 'backfill.profiles.start', opts }, 'profile backfill starting');

  const retryCutoff = new Date(Date.now() - PROFILE_UNSUPPORTED_RETRY_DAYS * 24 * 3600 * 1000);
  const eligibleUniverseWhere = {
    marketCapUsd: null,
    currency: 'USD',
    OR: [
      { profileAttemptCount: { lt: PROFILE_UNSUPPORTED_STRIKES } },
      { profileAttemptedAt: null },
      { profileAttemptedAt: { lt: retryCutoff } },
    ],
  };
  const [positionsNeedingSector, universeNeedingMcap, parkedUnsupported] = await Promise.all([
    prisma.position.findMany({
      where: {
        closedAt: null,
        currency: 'USD',
        OR: [{ sector: null }, { sector: '' }],
      },
      select: { id: true, ticker: true },
    }),
    prisma.tickerUniverse.findMany({
      where: eligibleUniverseWhere,
      select: { symbol: true, name: true, profileAttemptedAt: true },
    }),
    prisma.tickerUniverse.count({
      where: {
        marketCapUsd: null,
        currency: 'USD',
        profileAttemptCount: { gte: PROFILE_UNSUPPORTED_STRIKES },
        profileAttemptedAt: { gte: retryCutoff },
      },
    }),
  ]);

  // Build one unique work list keyed by symbol, remembering the position ids
  // that need a sector write. Ticker is now unique-per-account (composite key
  // accountId+ticker), so the same symbol may map to multiple Position rows;
  // we update each by id.
  type WorkItem = {
    symbol: string;
    positionIds: number[];
    fallbackName: string;
    profileAttemptedAt: Date | null;
  };
  const byTicker = new Map<string, WorkItem>();
  for (const p of positionsNeedingSector) {
    const key = p.ticker.toUpperCase();
    const existing = byTicker.get(key);
    if (existing) {
      existing.positionIds.push(p.id);
    } else {
      byTicker.set(key, {
        symbol: key,
        positionIds: [p.id],
        fallbackName: key,
        profileAttemptedAt: null,
      });
    }
  }
  for (const u of universeNeedingMcap) {
    const key = u.symbol.toUpperCase();
    const existing = byTicker.get(key);
    if (existing) {
      existing.profileAttemptedAt = u.profileAttemptedAt;
      if (!existing.fallbackName || existing.fallbackName === key) {
        existing.fallbackName = u.name || key;
      }
    } else {
      byTicker.set(key, {
        symbol: key,
        positionIds: [],
        fallbackName: u.name || key,
        profileAttemptedAt: u.profileAttemptedAt,
      });
    }
  }

  const work = Array.from(byTicker.values()).sort((a, b) => {
    const heldPriority = Number(b.positionIds.length > 0) - Number(a.positionIds.length > 0);
    if (heldPriority !== 0) return heldPriority;
    const aAttempt = a.profileAttemptedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bAttempt = b.profileAttemptedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (aAttempt !== bAttempt) return aAttempt - bAttempt;
    return a.symbol.localeCompare(b.symbol);
  });
  const working = opts.limit ? work.slice(0, opts.limit) : work;

  const result: BackfillProfilesResult = {
    uniqueSymbols: working.length,
    profilesFetched: 0,
    positionsUpdated: 0,
    universeUpserted: 0,
    failedLookups: 0,
    parkedUnsupported,
    runtimeMs: 0,
  };

  log.info?.(
    {
      uniqueSymbols: working.length,
      positionSymbols: positionsNeedingSector.length,
      universeSymbols: universeNeedingMcap.length,
    },
    'backfill.profiles: resolved cohorts',
  );

  let lastCallAt = 0;
  for (const item of working) {
    // Paced loop — enforce ≥ MIN_CALL_INTERVAL_MS between actual fetches so
    // we stay under 30/min regardless of what the adapter's bucket lets
    // through.
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (lastCallAt > 0 && elapsed < MIN_CALL_INTERVAL_MS) {
      await sleep(MIN_CALL_INTERVAL_MS - elapsed);
    }
    lastCallAt = Date.now();

    try {
      await prisma.tickerUniverse.updateMany({
        where: { symbol: item.symbol },
        data: { profileAttemptedAt: new Date() },
      });
    } catch (err) {
      log.warn?.(
        { symbol: item.symbol, err: err instanceof Error ? err.message : err },
        'backfill.profiles: could not record profile attempt',
      );
    }

    let profile;
    try {
      profile = await fn.getCompanyProfile(item.symbol);
    } catch (err) {
      // Thrown lookups are transient (network/throttle) — never a strike.
      result.failedLookups++;
      log.warn?.(
        { symbol: item.symbol, err: err instanceof Error ? err.message : err },
        'backfill.profiles: profile lookup threw',
      );
      continue;
    }
    const yieldedMarketCap =
      profile != null &&
      typeof profile.marketCapitalization === 'number' &&
      profile.marketCapitalization > 0;
    try {
      await prisma.tickerUniverse.updateMany({
        where: { symbol: item.symbol },
        data: yieldedMarketCap
          ? { profileAttemptCount: 0 }
          : { profileAttemptCount: { increment: 1 } },
      });
    } catch (err) {
      log.warn?.(
        { symbol: item.symbol, err: err instanceof Error ? err.message : err },
        'backfill.profiles: could not record attempt outcome',
      );
    }
    if (!profile) {
      result.failedLookups++;
      continue;
    }
    result.profilesFetched++;

    // Upsert TickerUniverse.
    try {
      await upsertFromFinnhubProfile({
        symbol: item.symbol,
        profile,
        fallbackName: item.fallbackName,
      });
      result.universeUpserted++;
    } catch (err) {
      log.warn?.(
        { symbol: item.symbol, err: err instanceof Error ? err.message : err },
        'backfill.profiles: universe upsert failed',
      );
    }

    // Write sector onto any Positions missing it.
    if (item.positionIds.length > 0 && profile.finnhubIndustry) {
      for (const pid of item.positionIds) {
        try {
          await updatePosition(pid, { sector: profile.finnhubIndustry });
          result.positionsUpdated++;
        } catch (err) {
          log.warn?.(
            { positionId: pid, err: err instanceof Error ? err.message : err },
            'backfill.profiles: position update failed',
          );
        }
      }
    }
  }

  result.runtimeMs = Date.now() - started;
  log.info?.(result, 'backfill.profiles: done');
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
