/**
 * Company profile lookup — multi-source with Canadian-suffix fallback.
 *
 * Server-only. Used by /api/tickers/lookup/:symbol to pre-fill name + sector
 * on the Add Position form. Resolution order per candidate symbol:
 *   1. TickerUniverse table (instant, free, ~11k tickers incl. all TSX/.TO)
 *   2. Finnhub /stock/profile2 (US stocks; spotty on newer ETFs)
 *   3. Yahoo Finance (newer ETFs + TSX/NEO)
 *
 * If a bare symbol (no exchange suffix) misses everywhere, we retry the whole
 * chain with Canadian suffixes (.TO, .NE, .V) since a Wealthsimple user often
 * types "VDY" meaning "VDY.TO". Returns the RESOLVED ticker so the form can
 * correct the symbol field. Returns null only when every source + variant
 * misses.
 */

import { prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/lib/profile');

export interface CompanyProfile {
  ticker: string;
  name: string;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  currency: string | null;
  marketCapUsd: number | null;
  logo: string | null;
  weburl: string | null;
}

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const CA_SUFFIXES = ['.TO', '.NE', '.V'] as const;

interface FinnhubProfile {
  name?: string;
  ticker?: string;
  exchange?: string;
  currency?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number; // millions of USD
  logo?: string;
  weburl?: string;
}

async function fromDb(ticker: string): Promise<CompanyProfile | null> {
  const row = await prisma.tickerUniverse
    .findUnique({
      where: { symbol: ticker.toUpperCase() },
    })
    // Provider fallbacks still work during a database outage.
    .catch((err: unknown) => {
      log.warn({ ticker, err }, 'ticker-universe profile lookup failed');
      return null;
    });
  if (!row) return null;
  return {
    ticker: row.symbol,
    name: row.name,
    sector: row.sector,
    industry: row.sector,
    exchange: row.exchange,
    currency: row.currency,
    marketCapUsd: row.marketCapUsd ? Number(row.marketCapUsd) : null,
    logo: null,
    weburl: null,
  };
}

async function fromFinnhub(ticker: string): Promise<CompanyProfile | null> {
  const key = process.env['FINNHUB_API_KEY'];
  if (!key) return null;
  const url = `${FINNHUB_BASE}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      log.warn({ ticker, status: res.status }, 'Finnhub profile lookup rejected');
      return null;
    }
    const body = (await res.json()) as FinnhubProfile;
    if (!body || Object.keys(body).length === 0 || !body.name) return null;
    return {
      ticker: (body.ticker ?? ticker).toUpperCase(),
      name: body.name,
      sector: body.finnhubIndustry ?? null,
      industry: body.finnhubIndustry ?? null,
      exchange: body.exchange ?? null,
      currency: body.currency ?? null,
      marketCapUsd:
        typeof body.marketCapitalization === 'number' && body.marketCapitalization > 0
          ? body.marketCapitalization * 1_000_000
          : null,
      logo: body.logo ?? null,
      weburl: body.weburl ?? null,
    };
  } catch (err) {
    log.warn({ ticker, err }, 'Finnhub profile lookup failed');
    return null;
  }
}

async function fromYahoo(ticker: string): Promise<CompanyProfile | null> {
  try {
    const { YFinanceAdapter } = await import('@vantage/sources');
    const yf = new YFinanceAdapter();
    const p = await yf.getProfile(ticker);
    if (!p) return null;
    const name = p.longName ?? p.shortName;
    if (!name) return null;
    return {
      ticker: p.symbol.toUpperCase(),
      name,
      sector: p.sector,
      industry: p.industry,
      exchange: p.exchange,
      currency: p.currency,
      marketCapUsd: p.marketCapUsd,
      logo: null,
      weburl: null,
    };
  } catch (err) {
    log.warn({ ticker, err }, 'yfinance profile lookup failed');
    return null;
  }
}

async function resolveOne(ticker: string): Promise<CompanyProfile | null> {
  // DB first — instant, covers all seeded TSX/.TO names. Only trust it when it
  // carries a usable name (it always does).
  const db = await fromDb(ticker);
  if (db) return db;
  const finnhub = await fromFinnhub(ticker);
  if (finnhub) return finnhub;
  return fromYahoo(ticker);
}

export async function fetchCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const upper = ticker.trim().toUpperCase();
  if (!upper) return null;

  // Try as-typed first.
  const direct = await resolveOne(upper);
  if (direct) return direct;

  // Bare symbol (no exchange suffix) — a Canadian user typing "VDY" likely
  // means "VDY.TO". Retry the chain with Canadian suffixes.
  if (!upper.includes('.')) {
    for (const suffix of CA_SUFFIXES) {
      const withSuffix = await resolveOne(upper + suffix);
      if (withSuffix) return withSuffix;
    }
  }

  return null;
}
