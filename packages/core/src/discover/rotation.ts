/**
 * Rotation scorer — Phase 15.
 *
 * Scans open Positions against the top of the nightly DiscoveryScore table and
 * returns dollar-neutral rotation candidates where the market says a candidate
 * dominates a held ticker whose thesis is weakening.
 *
 * Pure function of DB state — no LLM call. The LLM step (picking specific
 * shares, writing prose, citing articles) lives in the digest flow.
 *
 * Scoring model:
 *   - Held position "health" = base status score + price-performance adjust:
 *       Broken         → -1.0
 *       Weakening      → -0.3
 *       Intact         →  0.0
 *       Strengthening  →  0.5
 *       (+ 20-day price adj ∈ [-0.2, 0.2], saturated at ±10% return)
 *   - Candidate signal = raw DiscoveryScore.score / 10, clamped to [-1, 1]
 *   - delta = normalized candidate signal minus held health
 *   - Emit iff delta ≥ threshold (default 0.6) AND held thesis status is
 *     Weakening or Broken.
 *
 * Filters before emission:
 *   - Candidate must not be currently held or watchlisted (actually: not
 *     held; watchlist tickers are eligible rotation targets since they're an
 *     explicit user bet)
 *   - Candidate market-cap ≥ UserSettings.discoveryMinMcapUsd
 *   - Neither side has an active PassCooldown for 'trim' (held) or 'buy'
 *     (candidate)
 *   - Post-rotation, portfolio caps still respected (dollar-neutral swap
 *     generally keeps totals stable but single-position cap on the buy side
 *     can still trip)
 *
 * Returns top-N (default 5) sorted by delta desc.
 */

import {
  prisma,
  getSettings,
  isPassCooldownActive,
  ThesisStatus,
  latestTopN,
  type Position,
  type Thesis,
  type UserSettings,
} from '@vantage/db';

// Re-alias the enum as a type for field annotations; the runtime symbol is
// `ThesisStatus` so switch statements / comparisons still work.
type ThesisStatusValue = ThesisStatus;

import {
  getPriceOracle,
  type PriceCurrency,
  type PriceOracle,
  type PriceResult,
} from '../rebalance/priceOracle.js';
import { computeConcentration, type ConcentrationResult } from '../rebalance/metrics.js';
import { getUsdCadRate } from '../fx.js';
import {
  currenciesByTicker,
  nativeAmountToUsd,
  portfolioCurrency,
  type PortfolioCurrency,
} from '../portfolio/valuation.js';
import {
  decidePlacement,
  type AccountType,
  type PlacementDecision,
} from '../accounts/placement.js';
import { loadAccountSummaries, loadStockProfile } from '../accounts/loaders.js';
import { discoveryScoreToRotationSignal } from './signals.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RotationLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface ScoreRotationsOptions {
  /** Minimum normalized delta before a pair is emitted. Default 0.6. */
  threshold?: number;
  /** Max candidates returned. Default 5. */
  maxCandidates?: number;
  /** Optional snapshot override for tests. */
  priceOracle?: PriceOracle;
  /** Optional settings override for tests. */
  settings?: UserSettings;
  /** Skip PassCooldown checks (tests). */
  skipCooldownFilter?: boolean;
  /**
   * Cap-driven rebalance runs may rotate an otherwise Intact position. Tickers
   * listed here bypass the Weakening/Broken thesis gate, while every cooldown,
   * sizing, placement, and cap check still applies.
   */
  eligibleTrimTickers?: readonly string[];
  /**
   * Minimum standalone Discovery score for a cap-driven replacement. The
   * forced trim does not need the candidate-vs-held delta used by thesis
   * rotations; the buy leg still has to be attractive on its own merits.
   */
  capDrivenCandidateFloor?: number;
  /** Buy sectors forbidden for a specific trim ticker, keyed by uppercase ticker. */
  forbiddenBuySectorsByTrim?: Readonly<Record<string, readonly string[]>>;
  log?: RotationLogger;
}

export interface RotationCandidate {
  trimTicker: string;
  buyTicker: string;
  /** Normalized candidate signal minus held health. Positive favors rotation. */
  scoreDelta: number;
  /** Blended position-health score for the held ticker. [-1.2, 0.7]. */
  trimHealth: number;
  /** Raw DiscoveryScore composite for the candidate, roughly 0-10. */
  candidateScore: number;
  /** Current thesis status on the held side. */
  trimThesisStatus: ThesisStatus;
  /** Latest price for both sides (null when no oracle hit). */
  priceSnapshots: { trim: number | null; buy: number | null };
  priceCurrencies: { trim: PriceCurrency | null; buy: PriceCurrency | null };
  /** USD-equivalent prices used for dollar-neutral sizing and cap math. */
  priceSnapshotsUsd: { trim: number | null; buy: number | null };
  /** Brief machine-generated rationale — the LLM gets richer context. */
  rationale: string;
  /**
   * Tax-aware placement for the BUY side. Null when no TickerMetrics row is
   * available for the candidate or when the loader fails — caller treats null
   * as "skip placement footer".
   */
  buyPlacement: PlacementDecision | null;
  /**
   * The single account that holds the TRIM ticker, when the held side lives
   * in exactly one account. Null when the ticker straddles multiple accounts
   * (caller has to ask the user) or when account metadata is unavailable.
   */
  trimAccount: {
    id: number;
    name: string;
    type: AccountType;
  } | null;
}

export function passesRotationSignalGate(input: {
  candidateScore: number;
  heldHealth: number;
  capDriven: boolean;
  threshold?: number;
  capDrivenCandidateFloor?: number;
}): boolean {
  if (!Number.isFinite(input.candidateScore) || !Number.isFinite(input.heldHealth)) return false;
  return input.capDriven
    ? input.candidateScore >= (input.capDrivenCandidateFloor ?? DEFAULT_CAP_DRIVEN_CANDIDATE_FLOOR)
    : input.candidateScore - input.heldHealth >= (input.threshold ?? DEFAULT_THRESHOLD);
}

export function formatRotationPrice(candidate: RotationCandidate, side: 'trim' | 'buy'): string {
  const nativePrice = candidate.priceSnapshots[side];
  const currency = candidate.priceCurrencies[side];
  const priceUsd = candidate.priceSnapshotsUsd[side];
  if (nativePrice === null || currency === null) return 'price unavailable';
  if (currency === 'CAD') {
    return `C$${nativePrice.toFixed(2)} CAD${priceUsd === null ? '' : ` ($${priceUsd.toFixed(2)} USD equiv)`}`;
  }
  return `$${nativePrice.toFixed(2)} USD`;
}

export interface RotationCapInput {
  concentration: ConcentrationResult;
  buyTicker: string;
  buySector: string | null;
  trimSector: string | null;
  trimValueUsd: number;
  singlePositionCapPct: number;
  sectorCapPct: number;
}

export type RotationCapResult =
  | { ok: true; newBuyPct: number; newSectorPct: number | null }
  | {
      ok: false;
      reason: 'single-position-cap' | 'sector-cap';
      newBuyPct: number;
      newSectorPct: number | null;
    };

export function evaluateRotationCaps(input: RotationCapInput): RotationCapResult {
  const totalValueUsd = input.concentration.totalValue;
  if (totalValueUsd <= 0) {
    return { ok: true, newBuyPct: 0, newSectorPct: null };
  }

  const buyPosition = input.concentration.positionPcts.find(
    (position) => position.ticker === input.buyTicker,
  );
  const newBuyPct = (((buyPosition?.value ?? 0) + input.trimValueUsd) / totalValueUsd) * 100;
  if (newBuyPct > input.singlePositionCapPct + 1e-6) {
    return {
      ok: false,
      reason: 'single-position-cap',
      newBuyPct,
      newSectorPct: null,
    };
  }

  if (input.buySector && input.buySector !== input.trimSector) {
    const sectorValueUsd =
      input.concentration.sectorPcts.find((sector) => sector.sector === input.buySector)?.value ??
      0;
    const newSectorPct = ((sectorValueUsd + input.trimValueUsd) / totalValueUsd) * 100;
    if (newSectorPct > input.sectorCapPct + 1e-6) {
      return {
        ok: false,
        reason: 'sector-cap',
        newBuyPct,
        newSectorPct,
      };
    }
    return { ok: true, newBuyPct, newSectorPct };
  }

  return { ok: true, newBuyPct, newSectorPct: null };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_CAP_DRIVEN_CANDIDATE_FLOOR = 0.25;

/** Status-to-base-health mapping per spec Phase 15 brief. */
const STATUS_HEALTH: Record<ThesisStatusValue, number> = {
  [ThesisStatus.Broken]: -1.0,
  [ThesisStatus.Weakening]: -0.3,
  [ThesisStatus.Intact]: 0.0,
  [ThesisStatus.Strengthening]: 0.5,
};

/** Which thesis statuses are eligible to be rotated OUT of. */
const ROTATABLE_STATUSES: ReadonlySet<ThesisStatusValue> = new Set<ThesisStatusValue>([
  ThesisStatus.Broken,
  ThesisStatus.Weakening,
]);

export async function scoreRotations(
  opts: ScoreRotationsOptions = {},
): Promise<RotationCandidate[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = opts.log;
  const skipCooldown = opts.skipCooldownFilter === true;
  const capDrivenCandidateFloor =
    opts.capDrivenCandidateFloor ?? DEFAULT_CAP_DRIVEN_CANDIDATE_FLOOR;
  const capDrivenTrimTickers = new Set(
    (opts.eligibleTrimTickers ?? []).map((ticker) => ticker.toUpperCase()),
  );
  const forbiddenBuySectorsByTrim = new Map(
    Object.entries(opts.forbiddenBuySectorsByTrim ?? {}).map(([ticker, sectors]) => [
      ticker.toUpperCase(),
      new Set(sectors),
    ]),
  );

  // ---- 1. Snapshot -------------------------------------------------------
  const [settings, positions, watchlist] = await Promise.all([
    opts.settings ? Promise.resolve(opts.settings) : getSettings(),
    prisma.position.findMany({
      where: { closedAt: null },
      include: { thesis: true },
    }),
    prisma.watchlist.findMany(),
  ]);
  if (!settings) {
    log?.warn?.({}, '[rotation] UserSettings(id=1) missing — skipping rotation scorer');
    return [];
  }
  if (positions.length === 0) {
    log?.info?.({}, '[rotation] no open positions — nothing to rotate');
    return [];
  }

  const heldTickers = new Set(positions.map((p) => p.ticker.toUpperCase()));
  const watchlistTickers = new Set(watchlist.map((w) => w.ticker.toUpperCase()));

  // ---- 2. Load DiscoveryScore top-N, filter to eligible candidates ------
  const minMcap = Number(settings.discoveryMinMcapUsd);
  // Pull top-20 above score=0 (we need positively-positioned candidates; a
  // candidate with a negative score trivially won't dominate a held Intact
  // position anyway).
  const topDiscovery = await latestTopN(20, {
    excludeTickers: [...heldTickers],
    minScore: 0,
  });
  if (topDiscovery.length === 0) {
    log?.info?.({}, '[rotation] DiscoveryScore table empty or no candidates with score ≥ 0');
    return [];
  }

  // Map candidate tickers -> TickerUniverse so we can filter by market cap.
  const candidateTickers = topDiscovery.map((d) => d.ticker);
  const universeRows = await prisma.tickerUniverse.findMany({
    where: { symbol: { in: candidateTickers } },
    select: {
      symbol: true,
      marketCapUsd: true,
      sector: true,
      currency: true,
    },
  });
  const universeBySymbol = new Map<
    string,
    {
      marketCapUsd: number | null;
      sector: string | null;
      currency: PortfolioCurrency;
    }
  >();
  for (const row of universeRows) {
    universeBySymbol.set(row.symbol.toUpperCase(), {
      marketCapUsd:
        row.marketCapUsd === null || row.marketCapUsd === undefined
          ? null
          : Number(row.marketCapUsd),
      sector: row.sector,
      currency: portfolioCurrency(row.currency, row.symbol),
    });
  }

  const eligibleCandidates = topDiscovery.filter((d) => {
    const meta = universeBySymbol.get(d.ticker.toUpperCase());
    if (!meta) {
      // TickerUniverse not seeded for this ticker — apply the floor anyway.
      return false;
    }
    if (meta.marketCapUsd === null) return false;
    return meta.marketCapUsd >= minMcap;
  });

  if (eligibleCandidates.length === 0) {
    log?.info?.(
      { rawCandidates: topDiscovery.length, minMcap },
      '[rotation] no discovery candidates passed the market-cap floor',
    );
    return [];
  }

  // ---- 3. Compute held health using thesis status + 20d price perf ------
  const oracle = opts.priceOracle ?? getPriceOracle();
  const allTickers = [...heldTickers, ...eligibleCandidates.map((c) => c.ticker)];
  const [priceMap, momentumByTicker, usdCadRate] = await Promise.all([
    loadPrices(oracle, allTickers),
    loadMomentum([...heldTickers], log),
    getUsdCadRate(),
  ]);

  const heldHealthByTicker = new Map<string, number>();
  const heldSideByTicker = new Map<
    string,
    { position: Position & { thesis: Thesis | null }; status: ThesisStatusValue }
  >();
  for (const p of positions) {
    const upper = p.ticker.toUpperCase();
    const status: ThesisStatusValue = p.thesis?.status ?? ThesisStatus.Intact;
    const base = STATUS_HEALTH[status] ?? 0;
    const momentum = momentumByTicker.get(upper) ?? 0;
    // 20-day return, saturated at ±10% → ±0.2 adjustment.
    const adj = Math.max(-0.2, Math.min(0.2, (momentum / 0.1) * 0.2));
    heldHealthByTicker.set(upper, base + adj);
    heldSideByTicker.set(upper, { position: p, status });
  }

  // ---- 4. Build pairs, enforce status gate, build candidates ------------
  const concentration = computeConcentration({
    positions,
    prices: toPriceRecord(priceMap),
    currencies: currenciesByTicker(positions),
    usdCadRate,
  });

  const raw: RotationCandidate[] = [];
  // Iterate by unique ticker — same ticker held in multiple accounts must not
  // generate duplicate rotation candidates. heldSideByTicker already holds one
  // entry per uppercase ticker.
  for (const [trimUpper, side] of heldSideByTicker) {
    const capDriven = capDrivenTrimTickers.has(trimUpper);
    if (!ROTATABLE_STATUSES.has(side.status) && !capDriven) continue;

    const health = heldHealthByTicker.get(trimUpper) ?? 0;

    for (const disc of eligibleCandidates) {
      const buyUpper = disc.ticker.toUpperCase();
      const buySector = universeBySymbol.get(buyUpper)?.sector ?? null;
      if (buySector && forbiddenBuySectorsByTrim.get(trimUpper)?.has(buySector)) {
        continue;
      }
      // Watchlist tickers are eligible rotation targets (explicit user interest).
      // Held tickers are already filtered out above via excludeTickers.
      void watchlistTickers; // kept for clarity / future filtering knobs
      // Discovery composites moved from the legacy -1..1 scale to roughly
      // 0..10 when fundamentals were added. Normalize before comparing with
      // thesis health so the original 0.6 gate keeps its intended meaning.
      const candidateSignal = discoveryScoreToRotationSignal(disc.score);
      const delta = candidateSignal - health;
      if (
        !passesRotationSignalGate({
          candidateScore: candidateSignal,
          heldHealth: health,
          capDriven,
          threshold,
          capDrivenCandidateFloor,
        })
      ) {
        continue;
      }

      const trimPriceResult = priceMap.get(trimUpper);
      const buyPriceResult = priceMap.get(buyUpper);
      const trimPrice = trimPriceResult?.price ?? null;
      const buyPrice = buyPriceResult?.price ?? null;
      const trimCurrency =
        trimPriceResult?.currency ?? portfolioCurrency(side.position.currency, trimUpper);
      const buyCurrency =
        buyPriceResult?.currency ??
        universeBySymbol.get(buyUpper)?.currency ??
        portfolioCurrency(null, buyUpper);

      raw.push({
        trimTicker: trimUpper,
        buyTicker: buyUpper,
        scoreDelta: round3(delta),
        trimHealth: round3(health),
        candidateScore: round3(disc.score),
        trimThesisStatus: side.status,
        priceSnapshots: { trim: trimPrice, buy: buyPrice },
        priceCurrencies: { trim: trimCurrency, buy: buyCurrency },
        priceSnapshotsUsd: {
          trim: trimPrice === null ? null : nativeAmountToUsd(trimPrice, trimCurrency, usdCadRate),
          buy: buyPrice === null ? null : nativeAmountToUsd(buyPrice, buyCurrency, usdCadRate),
        },
        rationale: buildRationale({
          trimTicker: trimUpper,
          buyTicker: buyUpper,
          delta,
          status: side.status,
          candidateScore: disc.score,
        }),
        // Placement + trim-account are annotated after dedup/sort so the
        // expensive lookups only run for emitted pairs.
        buyPlacement: null,
        trimAccount: null,
      });
    }
  }

  if (raw.length === 0) {
    log?.info?.(
      { heldCount: positions.length, candidates: eligibleCandidates.length, threshold },
      '[rotation] no held↔candidate pair crossed the delta threshold',
    );
    return [];
  }

  // ---- 5. Cap-aware filter (dollar-neutral swap simulation) --------------
  // Simulate a 25%-of-held-position trim (a sensible default size the LLM can
  // refine) and reject only when the POST-swap buy-side position exceeds the
  // single-position cap or the buy-side sector exceeds the sector cap. A
  // dollar-neutral rotation keeps the portfolio total constant, so only the
  // two affected buckets change.
  const validated: RotationCandidate[] = [];
  for (const cand of raw) {
    // Sum shares across all lots for this ticker — the cap simulation needs
    // total holding size, not just the first matching lot.
    const trimLots = positions.filter((p) => p.ticker.toUpperCase() === cand.trimTicker);
    if (trimLots.length === 0) continue;
    const trimShares = trimLots.reduce((sum, p) => sum + Number(p.shares), 0);
    const fallbackAvgCost = (() => {
      const totalShares = trimShares;
      if (totalShares <= 0) return 0;
      const notional = trimLots.reduce((sum, p) => sum + Number(p.shares) * Number(p.avgCost), 0);
      return notional / totalShares;
    })();
    const trimPrice = cand.priceSnapshots.trim ?? fallbackAvgCost;
    const buyPrice = cand.priceSnapshots.buy ?? 0;
    if (!Number.isFinite(trimShares) || trimShares <= 0) continue;

    if (trimPrice <= 0 || buyPrice <= 0) {
      log?.debug?.(
        { pair: `${cand.trimTicker}->${cand.buyTicker}`, trimPrice, buyPrice },
        '[rotation] skipped pair — missing price snapshot for cap simulation',
      );
      continue;
    }

    // 25% default trim — the cap check is a "would a modest swap violate
    // caps?" sanity gate, not a prescription of exact size. The LLM picks
    // actual shares in the digest step.
    const trimNativeValue = 0.25 * trimShares * trimPrice;
    const totalValue = concentration.totalValue;
    if (totalValue <= 0) {
      // Empty book — nothing to cap-check against; allow the pair.
      validated.push(cand);
      continue;
    }

    const trimPositionPct = concentration.positionPcts.find((x) => x.ticker === cand.trimTicker);
    const buyPositionPct = concentration.positionPcts.find((x) => x.ticker === cand.buyTicker);
    const buySector =
      universeBySymbol.get(cand.buyTicker)?.sector ?? buyPositionPct?.sector ?? null;
    const trimSector = trimPositionPct?.sector ?? null;
    const trimValueUsd = nativeAmountToUsd(
      trimNativeValue,
      trimPositionPct?.currency ?? 'USD',
      usdCadRate,
    );
    const capResult = evaluateRotationCaps({
      concentration,
      buyTicker: cand.buyTicker,
      buySector,
      trimSector,
      trimValueUsd,
      singlePositionCapPct: settings.singlePositionCapPct,
      sectorCapPct: settings.sectorCapPct,
    });
    if (!capResult.ok && capResult.reason === 'single-position-cap') {
      log?.debug?.(
        {
          pair: `${cand.trimTicker}->${cand.buyTicker}`,
          newBuyPct: capResult.newBuyPct,
          cap: settings.singlePositionCapPct,
        },
        '[rotation] dropped pair — buy side would breach single-position cap',
      );
      continue;
    }
    if (!capResult.ok && capResult.reason === 'sector-cap') {
      log?.debug?.(
        {
          pair: `${cand.trimTicker}->${cand.buyTicker}`,
          newSectorPct: capResult.newSectorPct,
          cap: settings.sectorCapPct,
        },
        '[rotation] dropped pair — buy side would breach sector cap',
      );
      continue;
    }

    validated.push(cand);
  }
  if (validated.length === 0) {
    log?.info?.(
      { raw: raw.length },
      '[rotation] every candidate pair failed post-swap cap validation',
    );
    return [];
  }

  // ---- 6. PassCooldown filter (both sides) ------------------------------
  const cooldownFiltered: RotationCandidate[] = [];
  for (const cand of validated) {
    if (!skipCooldown) {
      const [trimBlocked, buyBlocked] = await Promise.all([
        isPassCooldownActive(cand.trimTicker, 'trim'),
        isPassCooldownActive(cand.buyTicker, 'buy'),
      ]);
      if (trimBlocked || buyBlocked) {
        log?.info?.(
          {
            pair: `${cand.trimTicker}->${cand.buyTicker}`,
            trimBlocked,
            buyBlocked,
          },
          '[rotation] dropped pair — active cooldown on one or both sides',
        );
        continue;
      }
    }
    cooldownFiltered.push(cand);
  }

  // ---- 7. Sort by delta desc, take top-N, dedup per held ticker ----------
  cooldownFiltered.sort((a, b) => b.scoreDelta - a.scoreDelta);
  const seenTrim = new Set<string>();
  const out: RotationCandidate[] = [];
  for (const c of cooldownFiltered) {
    // Only one best candidate per held position — otherwise a single
    // weakening ticker monopolizes the list against every top-20 discovery.
    if (seenTrim.has(c.trimTicker)) continue;
    seenTrim.add(c.trimTicker);
    out.push(c);
    if (out.length >= maxCandidates) break;
  }

  // ---- 8. Annotate placement + trim-account on emitted pairs only -------
  await annotatePlacements(out, positions, log);

  log?.info?.(
    {
      pairsRaw: raw.length,
      pairsValidated: validated.length,
      emitted: out.length,
      threshold,
      capDrivenCandidateFloor,
    },
    '[rotation] scored',
  );
  return out;
}

/**
 * Attach `buyPlacement` and `trimAccount` to every emitted RotationCandidate.
 * Mutates the input array. Failures degrade silently — placement guidance is a
 * nice-to-have, never a blocker.
 *
 * AccountSummaries are loaded ONCE for the whole batch since they don't vary
 * per ticker. StockProfile is per-ticker so we fan out in parallel.
 */
async function annotatePlacements(
  candidates: RotationCandidate[],
  heldPositions: ReadonlyArray<Position>,
  log: RotationLogger | undefined,
): Promise<void> {
  if (candidates.length === 0) return;
  let summaries: Awaited<ReturnType<typeof loadAccountSummaries>>;
  try {
    summaries = await loadAccountSummaries();
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[rotation] account summary load failed — skipping placement',
    );
    return;
  }

  // Pre-load trim-account metadata. A trim ticker may live in multiple
  // accounts; only annotate when it's uniquely placed.
  const trimAccountIdsByTicker = new Map<string, Set<number>>();
  for (const p of heldPositions) {
    const key = p.ticker.toUpperCase();
    const set = trimAccountIdsByTicker.get(key) ?? new Set<number>();
    set.add(p.accountId);
    trimAccountIdsByTicker.set(key, set);
  }
  const accountIdsToFetch = new Set<number>();
  for (const c of candidates) {
    const ids = trimAccountIdsByTicker.get(c.trimTicker);
    if (ids && ids.size === 1) {
      for (const id of ids) accountIdsToFetch.add(id);
    }
  }
  const accountMeta = new Map<number, { id: number; name: string; type: AccountType }>();
  if (accountIdsToFetch.size > 0) {
    try {
      const rows = await prisma.account.findMany({
        where: { id: { in: [...accountIdsToFetch] } },
        select: { id: true, name: true, type: true },
      });
      for (const r of rows) {
        accountMeta.set(r.id, {
          id: r.id,
          name: r.name,
          type: r.type as AccountType,
        });
      }
    } catch (err) {
      log?.warn?.(
        { err: err instanceof Error ? err.message : err },
        '[rotation] account metadata load failed — trim-account annotations skipped',
      );
    }
  }

  await Promise.all(
    candidates.map(async (c) => {
      // Buy-side placement.
      try {
        const profile = await loadStockProfile(c.buyTicker);
        if (profile) {
          c.buyPlacement = decidePlacement(profile, summaries);
        }
      } catch (err) {
        log?.debug?.(
          {
            buyTicker: c.buyTicker,
            err: err instanceof Error ? err.message : err,
          },
          '[rotation] placement lookup failed for buy ticker',
        );
      }
      // Trim-side single-account annotation.
      const ids = trimAccountIdsByTicker.get(c.trimTicker);
      if (ids && ids.size === 1) {
        const id = [...ids][0]!;
        const meta = accountMeta.get(id);
        if (meta) c.trimAccount = meta;
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadPrices(
  oracle: PriceOracle,
  tickers: readonly string[],
): Promise<Map<string, PriceResult | null>> {
  if (tickers.length === 0) return new Map();
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const record = await oracle.getLatestPrices(unique);
  const out = new Map<string, PriceResult | null>();
  for (const t of unique) out.set(t, record[t] ?? null);
  return out;
}

/**
 * Recent total return per ticker from provider-agnostic DailyBar rows. Query
 * the persisted table once, then compare the oldest and newest close in the
 * 30-day window.
 *
 * If no bars are available, return 0 — the scorer degrades gracefully to
 * status-only health.
 */
async function loadMomentum(
  tickers: readonly string[],
  log?: RotationLogger,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tickers.length === 0) return out;
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  // Use prisma.dailyBar if the model exists; otherwise fall through silently.
  // The project's DailyBar model lives via pollEodHistory but is not
  // guaranteed to be populated in every environment.
  const modelAny = (prisma as unknown as Record<string, unknown>)['dailyBar'];
  if (!modelAny) return out;
  try {
    const client = modelAny as {
      findMany: (args: {
        where: { ticker: { in: string[] }; date: { gte: Date } };
        orderBy: { date: 'asc' | 'desc' };
        select: { ticker: true; date: true; close: true };
      }) => Promise<Array<{ ticker: string; date: Date; close: number }>>;
    };
    const bars = await client.findMany({
      where: {
        ticker: { in: tickers.map((t) => t.toUpperCase()) },
        date: { gte: since },
      },
      orderBy: { date: 'asc' },
      select: { ticker: true, date: true, close: true },
    });
    const byTicker = new Map<string, Array<{ date: Date; close: number }>>();
    for (const b of bars) {
      const t = b.ticker.toUpperCase();
      const arr = byTicker.get(t) ?? [];
      arr.push({ date: b.date, close: Number(b.close) });
      byTicker.set(t, arr);
    }
    for (const [t, arr] of byTicker.entries()) {
      if (arr.length < 2) continue;
      const first = arr[0];
      const last = arr[arr.length - 1];
      if (!first || !last || first.close <= 0) continue;
      out.set(t, (last.close - first.close) / first.close);
    }
  } catch (err) {
    log?.warn?.({ err, tickerCount: tickers.length }, '[rotation] momentum lookup failed');
  }
  return out;
}

function toPriceRecord(priceMap: Map<string, PriceResult | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, r] of priceMap) {
    if (r) out[t] = r.price;
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildRationale(input: {
  trimTicker: string;
  buyTicker: string;
  delta: number;
  status: ThesisStatus;
  candidateScore: number;
}): string {
  return (
    `${input.trimTicker} thesis ${input.status}; ` +
    `${input.buyTicker} discovery score ${input.candidateScore.toFixed(2)} ` +
    `(delta ${input.delta.toFixed(2)}). Dollar-neutral rotation candidate.`
  );
}
