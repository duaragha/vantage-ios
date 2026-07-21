import type { Prisma } from '@vantage/db';

export interface RotationActionInput {
  trimTicker: string;
  buyTicker: string;
  scoreDelta: number;
  source: string;
}

export interface NormalizedInsightAction {
  type: string | null;
  action: string | null;
  ticker: string | null;
  shares: number | null;
  priceSnapshot: number | null;
  priceCurrency: 'USD' | 'CAD' | null;
  trimTicker: string | null;
  trimShares: number | null;
  trimPriceSnapshot: number | null;
  trimPriceCurrency: 'USD' | 'CAD' | null;
  buyTicker: string | null;
  buyShares: number | null;
  scoreDelta: number | null;
  positionId: number | null;
  replacementConsidered: boolean | null;
  replacementFound: boolean | null;
  replacementState: string | null;
  replacementNote: string | null;
  catalystKind: string | null;
  conjunctionLevel: number | null;
  urgencyHours: number | null;
  urgencyExpiresAt: string | null;
}

export function buildRotationActionJson(input: RotationActionInput): Prisma.InputJsonValue {
  const trimTicker = input.trimTicker.trim().toUpperCase();
  const buyTicker = input.buyTicker.trim().toUpperCase();
  return {
    type: 'rotation',
    ticker: buyTicker,
    shares: null,
    trimTicker,
    trimShares: null,
    buyTicker,
    buyShares: null,
    scoreDelta: input.scoreDelta,
    source: input.source,
    replacementConsidered: true,
    replacementFound: true,
    replacementState: 'found',
  } as Prisma.InputJsonValue;
}

/**
 * Collapse every historical actionJson shape into the one view model consumed
 * by Insights. In particular, legacy rotations stored the sell ticker in
 * `ticker` and the buy ticker in `targetTicker`; canonical rotations store the
 * buy ticker in `ticker` so the Bought flow can never prefill the sell leg.
 */
export function normalizeInsightAction(
  value: unknown,
  context: { positionTicker?: string | null } = {},
): NormalizedInsightAction | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const rawType = text(raw['type']);
  const rawAction = text(raw['action']);
  const rawTicker = ticker(raw['ticker']);
  const targetTicker = ticker(raw['targetTicker']);
  const explicitTrimTicker = ticker(raw['trimTicker']);
  const explicitBuyTicker = ticker(raw['buyTicker']);
  const rotation = rawType === 'rotation' || (rawType === 'rebalance' && rawAction === 'rotate');

  const trimTicker = rotation
    ? (explicitTrimTicker ?? (targetTicker ? rawTicker : null))
    : explicitTrimTicker;
  const buyTicker = rotation ? (explicitBuyTicker ?? targetTicker ?? rawTicker) : explicitBuyTicker;
  const positionTicker = ticker(context.positionTicker);
  const canonicalTicker = rotation
    ? buyTicker
    : (rawTicker ?? (rawType === 'thesis-update' ? positionTicker : null));
  const legacyTickerIsTrim = rotation && targetTicker !== null && explicitTrimTicker === null;

  const rawShares = finiteNumber(raw['shares']);
  const explicitBuyShares = finiteNumber(raw['buyShares']);
  const explicitTrimShares = finiteNumber(raw['trimShares']);
  const buyShares = rotation
    ? (explicitBuyShares ?? (!legacyTickerIsTrim ? rawShares : null))
    : explicitBuyShares;
  const trimShares = rotation
    ? (explicitTrimShares ?? (legacyTickerIsTrim ? rawShares : null))
    : explicitTrimShares;

  const rawPrice = finiteNumber(raw['priceSnapshot']);
  const rawCurrency = currency(raw['priceCurrency']);
  const inferredBuyCurrency = listingCurrency(canonicalTicker);
  const inferredTrimCurrency = listingCurrency(trimTicker);
  const replacementConsidered =
    booleanValue(raw['replacementConsidered']) ?? (rotation ? true : null);
  const replacementFound = booleanValue(raw['replacementFound']) ?? (rotation ? true : null);

  return {
    type: rotation ? 'rotation' : rawType,
    action: rotation ? 'rotate' : rawAction,
    ticker: canonicalTicker,
    shares: rotation ? buyShares : rawShares,
    priceSnapshot: rotation && legacyTickerIsTrim ? null : rawPrice,
    priceCurrency:
      rotation && legacyTickerIsTrim ? inferredBuyCurrency : (rawCurrency ?? inferredBuyCurrency),
    trimTicker,
    trimShares,
    trimPriceSnapshot:
      finiteNumber(raw['trimPriceSnapshot']) ?? (rotation && legacyTickerIsTrim ? rawPrice : null),
    trimPriceCurrency:
      currency(raw['trimPriceCurrency']) ??
      (rotation && legacyTickerIsTrim ? rawCurrency : null) ??
      inferredTrimCurrency,
    buyTicker,
    buyShares,
    scoreDelta: finiteNumber(raw['scoreDelta']),
    positionId: integer(raw['positionId']),
    replacementConsidered,
    replacementFound,
    replacementState: text(raw['replacementState']) ?? (rotation ? 'found' : null),
    replacementNote: text(raw['replacementNote']),
    catalystKind: text(raw['catalystKind']),
    conjunctionLevel: finiteNumber(raw['conjunctionLevel']),
    urgencyHours: finiteNumber(raw['urgencyHours']),
    urgencyExpiresAt: text(raw['urgencyExpiresAt']),
  };
}

export function isInsightActionable(
  kind: string,
  status: string,
  action: NormalizedInsightAction | null,
): boolean {
  if (status !== 'New' || !action?.ticker) return false;
  if (kind === 'Rebalance' && action.type === 'rotation') return true;
  if (kind === 'BuySuggestion') return action.type === 'buy';
  return kind === 'Rebalance' && action.type === 'rebalance' && action.action === 'buy';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function ticker(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText.toUpperCase() : null;
}

function listingCurrency(value: string | null): 'CAD' | 'USD' | null {
  if (!value) return null;
  return /\.(TO|NE|V)$/.test(value) ? 'CAD' : 'USD';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function currency(value: unknown): 'USD' | 'CAD' | null {
  return value === 'USD' || value === 'CAD' ? value : null;
}
