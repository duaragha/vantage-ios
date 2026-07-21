/**
 * TickerUniverse CRUD helpers.
 *
 * Populated weekly by `apps/worker/src/jobs/pollTickerUniverse.ts` from Tiingo
 * (US) and Twelve Data (Canada), then enriched from provider profiles. Used by:
 *   - packages/llm/src/ticker-extract.ts  (regex + alias dictionary for extraction)
 *   - packages/core/src/discover/signals.ts (filter by sector / marketCap)
 */

import type { Prisma, TickerUniverse } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertTickerInput {
  symbol: string;
  name: string;
  exchange: string;
  /**
   * Reporting currency of the listing — USD for US exchanges, CAD for TO/NE/V.
   * Callers should run `deriveCurrency(exchange)` from
   * `@vantage/sources/symbols` to keep the mapping consistent. On create an
   * omission is inferred from suffix/exchange; on update it preserves the row.
   */
  currency?: 'USD' | 'CAD';
  /**
   * Symbol without its exchange suffix — e.g. "SHOP" for "SHOP.TO". Lets us
   * match cashtag hits ($SHOP) back to either the US or CA listing and
   * preserve the original ticker printed on a source page.
   */
  symbolRaw?: string | null;
  /** SEC Central Index Key. Omit to preserve an existing mapping. */
  cik?: string | null;
  /** Omit enrichment fields to preserve their existing values on refresh. */
  sector?: string | null;
  marketCapUsd?: number | Prisma.Decimal | null;
  /** Omit aliases to preserve the current alias dictionary. */
  aliases?: string[];
}

const CANADIAN_EXCHANGES = new Set([
  'TO',
  'TSX',
  'XTSE',
  'NE',
  'NEO',
  'CBOE CANADA',
  'V',
  'TSXV',
  'TSX-V',
  'XTSX',
]);

export function inferTickerCurrency(symbol: string, exchange: string): 'USD' | 'CAD' {
  if (/\.(TO|NE|V)$/i.test(symbol.trim())) return 'CAD';
  return CANADIAN_EXCHANGES.has(exchange.trim().toUpperCase()) ? 'CAD' : 'USD';
}

export function buildTickerUniverseUpdate(
  record: UpsertTickerInput,
  lastRefreshed: Date,
): Prisma.TickerUniverseUpdateInput {
  const marketCapUsd =
    record.marketCapUsd === undefined || record.marketCapUsd === null
      ? null
      : (record.marketCapUsd as unknown as Prisma.Decimal);

  return {
    name: record.name,
    exchange: record.exchange,
    ...(record.currency !== undefined ? { currency: record.currency } : {}),
    ...(record.symbolRaw !== undefined ? { symbolRaw: record.symbolRaw } : {}),
    ...(record.cik !== undefined ? { cik: record.cik } : {}),
    ...(record.sector !== undefined ? { sector: record.sector } : {}),
    ...(record.marketCapUsd !== undefined ? { marketCapUsd } : {}),
    ...(record.aliases !== undefined ? { aliases: record.aliases } : {}),
    lastRefreshed,
  };
}

/**
 * Bulk upsert ticker universe rows. Uses `prisma.$transaction` over individual
 * upserts — Postgres doesn't support a native ON CONFLICT path through the
 * Prisma createMany with updates. For the 5k-symbol weekly refresh this runs
 * in ~10s which is acceptable given the job is a once-weekly scheduled task.
 *
 * Records are upserted by `symbol`. `lastRefreshed` is always bumped.
 */
export async function upsertBulk(
  records: readonly UpsertTickerInput[],
): Promise<{ upsertedCount: number }> {
  if (records.length === 0) return { upsertedCount: 0 };

  // Chunk to keep the transaction size reasonable. 200 upserts per tx is well
  // under Postgres/Prisma's statement limit and keeps memory bounded.
  const CHUNK = 200;
  let upsertedCount = 0;

  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((r) => {
        const base = {
          symbol: r.symbol.toUpperCase(),
          name: r.name,
          exchange: r.exchange,
          currency: r.currency ?? inferTickerCurrency(r.symbol, r.exchange),
          symbolRaw: r.symbolRaw ?? null,
          cik: r.cik ?? null,
          sector: r.sector ?? null,
          marketCapUsd:
            r.marketCapUsd === undefined || r.marketCapUsd === null
              ? null
              : (r.marketCapUsd as unknown as Prisma.Decimal),
          aliases: r.aliases ?? [],
          lastRefreshed: new Date(),
        };
        return prisma.tickerUniverse.upsert({
          where: { symbol: base.symbol },
          create: base,
          update: buildTickerUniverseUpdate(r, base.lastRefreshed),
        });
      }),
    );
    upsertedCount += slice.length;
  }

  return { upsertedCount };
}

export function getBySymbol(symbol: string): Promise<TickerUniverse | null> {
  return prisma.tickerUniverse.findUnique({
    where: { symbol: symbol.toUpperCase() },
  });
}

/**
 * Return a Map keyed by symbol, value = full alias list for that symbol. The
 * company `name` is always included as the first alias (stripped of suffixes
 * like Inc./Corp./Ltd. when the caller builds the universe).
 */
export async function getAliasMap(): Promise<Map<string, string[]>> {
  const rows = await prisma.tickerUniverse.findMany({
    select: { symbol: true, name: true, aliases: true },
  });
  const out = new Map<string, string[]>();
  for (const r of rows) {
    // Keep dedup + preserve order: name first, then aliases.
    const combined = [r.name, ...r.aliases].filter((s) => s && s.length > 0);
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const s of combined) {
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(s);
    }
    out.set(r.symbol, deduped);
  }
  return out;
}

export function listAll(): Promise<TickerUniverse[]> {
  return prisma.tickerUniverse.findMany({
    orderBy: { symbol: 'asc' },
  });
}

export function listBySector(sector: string): Promise<TickerUniverse[]> {
  return prisma.tickerUniverse.findMany({
    where: { sector },
    orderBy: { symbol: 'asc' },
  });
}

/** Count rows — used by smoke tests + the discovery job to sanity-check the universe is seeded. */
export function countAll(): Promise<number> {
  return prisma.tickerUniverse.count();
}

/**
 * Strip boilerplate corporate suffixes from a company name so matching catches
 * "Apple" when the filing says "Apple Inc." and vice-versa.
 *
 * Exported for reuse by pollTickerUniverse when building aliases[] at refresh
 * time, and by ticker-extract as a defensive re-normalizer.
 */
export function canonicalizeName(name: string): string {
  return name
    .replace(
      /\b(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|ltd\.?|limited|plc|holdings?|group|llc|l\.?l\.?c\.?|l\.?p\.?|s\.?a\.?|n\.?v\.?)\b\.?/gi,
      '',
    )
    .replace(/[,.]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a small alias list from a company name. Shared between the weekly
 * pollTickerUniverse refresh and the web-app server action that upserts from
 * Finnhub on Position add / edit.
 *
 * Example: "The Home Depot, Inc." → canonicalized to "The Home Depot" → also
 * drop the leading "The " so both "Home Depot" and "The Home Depot" resolve.
 */
export function buildAliases(name: string): string[] {
  const aliases: string[] = [];
  const canonical = canonicalizeName(name);
  if (canonical && canonical.toLowerCase() !== name.toLowerCase()) {
    aliases.push(canonical);
  }
  if (canonical.toLowerCase().startsWith('the ')) {
    aliases.push(canonical.slice(4).trim());
  }
  // Dedup + drop empties / very short (≤1 char).
  const seen = new Set<string>();
  return aliases.filter((a) => {
    const k = a.toLowerCase();
    if (!a || a.length < 2 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Freshness window for TickerUniverse rows. The weekly refresh beats us to
 * most rows, but when a Position is added between refreshes we refresh the
 * row iff it's missing OR older than this window.
 */
export const UNIVERSE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UpsertFromFinnhubProfileInput {
  symbol: string;
  /** Finnhub profile fields — same shape as FinnhubProfile from sources. */
  profile: {
    name?: string;
    exchange?: string;
    finnhubIndustry?: string;
    marketCapitalization?: number;
    currency?: string;
  };
  /** Fallback name to use when the profile has no `name`. */
  fallbackName?: string;
}

/**
 * Upsert a TickerUniverse row from a Finnhub profile payload.
 *
 * Always writes — callers should gate on `shouldRefreshUniverseRow` before
 * deciding to pay for the Finnhub profile call.
 *
 * Currency is inferred from the symbol suffix (`.TO` / `.NE` / `.V` → CAD)
 * first and the Finnhub `currency` field second — Finnhub's /stock/profile2
 * doesn't always populate it on free tier.
 */
export async function upsertFromFinnhubProfile(
  input: UpsertFromFinnhubProfileInput,
): Promise<{ upsertedCount: number }> {
  const symbol = input.symbol.toUpperCase();
  const name =
    input.profile.name && input.profile.name.length > 0
      ? input.profile.name
      : (input.fallbackName ?? symbol);
  const marketCapUsd =
    typeof input.profile.marketCapitalization === 'number' && input.profile.marketCapitalization > 0
      ? input.profile.marketCapitalization * 1_000_000
      : null;
  const suffix = symbol.match(/\.(TO|NE|V)$/i)?.[1]?.toUpperCase() ?? null;
  const inferredCurrency: 'USD' | 'CAD' = suffix ? 'CAD' : 'USD';
  const currency: 'USD' | 'CAD' =
    input.profile.currency === 'CAD' || inferredCurrency === 'CAD' ? 'CAD' : 'USD';
  const exchange =
    suffix ??
    (input.profile.exchange && input.profile.exchange.length > 0 ? input.profile.exchange : 'US');
  const symbolRaw = suffix ? symbol.slice(0, symbol.length - suffix.length - 1) : null;
  return upsertBulk([
    {
      symbol,
      name,
      exchange,
      currency,
      symbolRaw,
      ...(input.profile.finnhubIndustry ? { sector: input.profile.finnhubIndustry } : {}),
      ...(marketCapUsd !== null ? { marketCapUsd } : {}),
      aliases: buildAliases(name),
    },
  ]);
}

/**
 * Should we refresh the TickerUniverse row for this symbol? True when no row
 * exists OR the existing row's lastRefreshed is older than UNIVERSE_STALE_MS.
 */
export async function shouldRefreshUniverseRow(symbol: string): Promise<boolean> {
  const row = await getBySymbol(symbol);
  if (!row) return true;
  return Date.now() - row.lastRefreshed.getTime() > UNIVERSE_STALE_MS;
}
