import type { BacktestConfig, BacktestStrategy } from '@vantage/core';

type ParseResult = { ok: true; value: BacktestConfig } | { ok: false; error: string };

const STRATEGIES = new Set<BacktestStrategy>([
  'monthly-allocation',
  'rebalance-only',
  'catalyst-driven',
]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,23}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDateKey(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return TICKER.test(normalized) ? normalized : null;
}

function finiteNumber(value: unknown, fallback: number): number | null {
  const candidate = value === undefined ? fallback : value;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

export function parseBacktestRequest(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'request body must be an object' };

  const startDate = parseDateKey(input.startDate);
  const endDate = parseDateKey(input.endDate);
  if (!startDate || !endDate) {
    return { ok: false, error: 'startDate and endDate must be valid YYYY-MM-DD dates' };
  }
  if (endDate <= startDate) {
    return { ok: false, error: 'endDate must be after startDate' };
  }

  if (typeof input.strategy !== 'string' || !STRATEGIES.has(input.strategy as BacktestStrategy)) {
    return { ok: false, error: 'invalid strategy' };
  }
  const strategy = input.strategy as BacktestStrategy;

  const initialCashUsd = finiteNumber(input.initialCashUsd, 0);
  if (initialCashUsd === null || initialCashUsd < 0) {
    return { ok: false, error: 'initialCashUsd must be a finite number at least 0' };
  }
  const monthlyBudgetUsd = finiteNumber(input.monthlyBudgetUsd, 0);
  if (monthlyBudgetUsd === null || monthlyBudgetUsd < 0) {
    return { ok: false, error: 'monthlyBudgetUsd must be a finite number at least 0' };
  }

  if (input.caps !== undefined && !isRecord(input.caps)) {
    return { ok: false, error: 'caps must be an object' };
  }
  const caps = isRecord(input.caps) ? input.caps : {};
  const singlePositionCapPct = finiteNumber(caps.singlePositionCapPct, 25);
  if (singlePositionCapPct === null || singlePositionCapPct <= 0 || singlePositionCapPct > 100) {
    return { ok: false, error: 'singlePositionCapPct must be a finite number in (0, 100]' };
  }
  const sectorCapPct = finiteNumber(caps.sectorCapPct, 60);
  if (sectorCapPct === null || sectorCapPct <= 0 || sectorCapPct > 100) {
    return { ok: false, error: 'sectorCapPct must be a finite number in (0, 100]' };
  }

  let seedPositions: BacktestConfig['seedPositions'];
  if (input.seedPositions !== undefined) {
    if (!Array.isArray(input.seedPositions) || input.seedPositions.length > 500) {
      return { ok: false, error: 'seedPositions must be an array with at most 500 rows' };
    }
    const parsed: Array<{ ticker: string; shares: number; avgCost: number }> = [];
    const seen = new Set<string>();
    for (const row of input.seedPositions) {
      if (!isRecord(row)) return { ok: false, error: 'each seed position must be an object' };
      const ticker = normalizeTicker(row.ticker);
      const shares = finiteNumber(row.shares, Number.NaN);
      const avgCost = finiteNumber(row.avgCost, Number.NaN);
      if (!ticker) return { ok: false, error: 'each seed position needs a valid ticker' };
      if (seen.has(ticker)) {
        return { ok: false, error: `seed position ${ticker} is duplicated` };
      }
      if (shares === null || shares <= 0) {
        return { ok: false, error: `seed position ${ticker} shares must be greater than 0` };
      }
      if (avgCost === null || avgCost < 0) {
        return { ok: false, error: `seed position ${ticker} avgCost must be at least 0` };
      }
      seen.add(ticker);
      parsed.push({ ticker, shares, avgCost });
    }
    seedPositions = parsed;
  }

  let candidateUniverse: BacktestConfig['candidateUniverse'];
  if (input.candidateUniverse !== undefined) {
    if (!Array.isArray(input.candidateUniverse) || input.candidateUniverse.length > 2_000) {
      return { ok: false, error: 'candidateUniverse must be an array with at most 2000 tickers' };
    }
    const normalized = input.candidateUniverse.map(normalizeTicker);
    if (normalized.some((ticker) => ticker === null)) {
      return { ok: false, error: 'candidateUniverse contains an invalid ticker' };
    }
    candidateUniverse = [...new Set(normalized as string[])];
  }

  let sectors: BacktestConfig['sectors'];
  if (input.sectors !== undefined) {
    if (!isRecord(input.sectors) || Object.keys(input.sectors).length > 2_000) {
      return { ok: false, error: 'sectors must map at most 2000 tickers to sector names' };
    }
    sectors = {};
    for (const [rawTicker, rawSector] of Object.entries(input.sectors)) {
      const ticker = normalizeTicker(rawTicker);
      if (!ticker || (rawSector !== null && typeof rawSector !== 'string')) {
        return { ok: false, error: 'sectors contains an invalid ticker or sector name' };
      }
      const sector = typeof rawSector === 'string' ? rawSector.trim() : null;
      if (sector !== null && (sector.length === 0 || sector.length > 100)) {
        return { ok: false, error: `sector for ${ticker} must contain 1 to 100 characters` };
      }
      sectors[ticker] = sector;
    }
  }

  const optionalPositiveInteger = (
    value: unknown,
    field: string,
    max: number,
  ): { value?: number; error?: string } => {
    if (value === undefined) return {};
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
      return { error: `${field} must be an integer from 1 to ${max}` };
    }
    return { value };
  };
  const holdingDays = optionalPositiveInteger(input.holdingDays, 'holdingDays', 2_520);
  if (holdingDays.error) return { ok: false, error: holdingDays.error };
  const catalystMaxPerDay = optionalPositiveInteger(
    input.catalystMaxPerDay,
    'catalystMaxPerDay',
    100,
  );
  if (catalystMaxPerDay.error) return { ok: false, error: catalystMaxPerDay.error };

  return {
    ok: true,
    value: {
      startDate,
      endDate,
      strategy,
      initialCashUsd,
      monthlyBudgetUsd,
      caps: { singlePositionCapPct, sectorCapPct },
      ...(seedPositions ? { seedPositions } : {}),
      ...(candidateUniverse ? { candidateUniverse } : {}),
      ...(sectors ? { sectors } : {}),
      ...(holdingDays.value !== undefined ? { holdingDays: holdingDays.value } : {}),
      ...(catalystMaxPerDay.value !== undefined
        ? { catalystMaxPerDay: catalystMaxPerDay.value }
        : {}),
    },
  };
}
