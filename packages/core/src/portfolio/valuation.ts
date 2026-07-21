import { convertToUsdWithRate } from '../fx.js';

export type PortfolioCurrency = 'USD' | 'CAD';

export interface PortfolioValuePosition {
  ticker: string;
  shares: unknown;
  avgCost: unknown;
  currency?: string | null;
  sector?: string | null;
}

export interface PortfolioAuditInput {
  positions: ReadonlyArray<PortfolioValuePosition>;
  /** Native-currency market prices. Missing tickers use weighted avgCost. */
  prices?: Readonly<Record<string, number>>;
  /** Explicit ticker currencies. Missing tickers use Position.currency. */
  currencies?: Readonly<Record<string, PortfolioCurrency>>;
  /** Canadian dollars per US dollar. */
  usdCadRate: number;
}

export interface PortfolioAuditPosition {
  ticker: string;
  sector: string | null;
  shares: number;
  pricePerShare: number;
  nativeValue: number;
  valueUsd: number;
  valueCad: number;
  currency: PortfolioCurrency;
  pct: number;
  pricedFromMarket: boolean;
}

export interface PortfolioAuditBucket {
  valueUsd: number;
  valueCad: number;
  pct: number;
}

export interface PortfolioAuditTicker extends PortfolioAuditBucket {
  sector: string | null;
  currency: PortfolioCurrency;
}

export interface PortfolioAudit {
  usdCadRate: number;
  totalValueUsd: number;
  totalValueCad: number;
  positions: PortfolioAuditPosition[];
  byTicker: Map<string, PortfolioAuditTicker>;
  bySector: Map<string, PortfolioAuditBucket>;
  pricesResolved: number;
}

export function portfolioCurrency(
  value: string | null | undefined,
  ticker?: string,
): PortfolioCurrency {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'USD' || normalized === 'CAD') return normalized;
  if (normalized) {
    throw new Error(`[portfolio/valuation] unsupported currency: ${value}`);
  }
  const upperTicker = ticker?.trim().toUpperCase() ?? '';
  return /\.(TO|NE|V)$/.test(upperTicker) ? 'CAD' : 'USD';
}

export function currenciesByTicker(
  positions: ReadonlyArray<PortfolioValuePosition>,
): Record<string, PortfolioCurrency> {
  const out: Record<string, PortfolioCurrency> = {};
  for (const position of positions) {
    const ticker = position.ticker.toUpperCase();
    const currency = portfolioCurrency(position.currency, ticker);
    const existing = out[ticker];
    if (existing && existing !== currency) {
      throw new Error(
        `[portfolio/valuation] ${ticker} has conflicting currencies: ${existing}/${currency}`,
      );
    }
    out[ticker] = currency;
  }
  return out;
}

export function nativeAmountToUsd(
  amount: number,
  currency: PortfolioCurrency,
  usdCadRate: number,
): number {
  assertRate(usdCadRate);
  return convertToUsdWithRate(amount, currency, usdCadRate);
}

export function usdAmountToCad(amountUsd: number, usdCadRate: number): number {
  assertRate(usdCadRate);
  return amountUsd * usdCadRate;
}

/**
 * Value a mixed USD/CAD portfolio once, in both currencies. All portfolio
 * engines use this function so currency handling cannot diverge by caller.
 */
export function auditPortfolio(input: PortfolioAuditInput): PortfolioAudit {
  assertRate(input.usdCadRate);

  const grouped = new Map<
    string,
    {
      sector: string | null;
      currency: PortfolioCurrency;
      shares: number;
      costNotional: number;
    }
  >();

  for (const position of input.positions) {
    const ticker = position.ticker.toUpperCase();
    const currency = input.currencies?.[ticker] ?? portfolioCurrency(position.currency, ticker);
    const shares = Number(position.shares);
    const avgCost = Number(position.avgCost);
    if (!Number.isFinite(shares) || !Number.isFinite(avgCost)) {
      throw new Error(`[portfolio/valuation] non-finite position values for ${ticker}`);
    }

    const existing = grouped.get(ticker);
    if (existing && existing.currency !== currency) {
      throw new Error(
        `[portfolio/valuation] ${ticker} has conflicting currencies: ${existing.currency}/${currency}`,
      );
    }
    const entry = existing ?? {
      sector: position.sector ?? null,
      currency,
      shares: 0,
      costNotional: 0,
    };
    entry.shares += shares;
    entry.costNotional += shares * avgCost;
    if (!entry.sector && position.sector) entry.sector = position.sector;
    grouped.set(ticker, entry);
  }

  const positions: PortfolioAuditPosition[] = [];
  const byTicker = new Map<string, PortfolioAuditTicker>();
  const bySector = new Map<string, PortfolioAuditBucket>();
  let totalValueUsd = 0;
  let pricesResolved = 0;

  for (const [ticker, groupedPosition] of grouped) {
    const marketPrice = input.prices?.[ticker];
    const pricedFromMarket =
      typeof marketPrice === 'number' && Number.isFinite(marketPrice) && marketPrice > 0;
    const avgCost =
      groupedPosition.shares > 0 ? groupedPosition.costNotional / groupedPosition.shares : 0;
    const pricePerShare = pricedFromMarket ? marketPrice : avgCost;
    if (pricedFromMarket) pricesResolved += 1;
    const nativeValue = groupedPosition.shares * pricePerShare;
    const valueUsd = nativeAmountToUsd(nativeValue, groupedPosition.currency, input.usdCadRate);
    const valueCad = usdAmountToCad(valueUsd, input.usdCadRate);
    totalValueUsd += valueUsd;

    const audited: PortfolioAuditPosition = {
      ticker,
      sector: groupedPosition.sector,
      shares: groupedPosition.shares,
      pricePerShare,
      nativeValue,
      valueUsd,
      valueCad,
      currency: groupedPosition.currency,
      pct: 0,
      pricedFromMarket,
    };
    positions.push(audited);
    byTicker.set(ticker, {
      sector: audited.sector,
      currency: audited.currency,
      valueUsd,
      valueCad,
      pct: 0,
    });
    if (audited.sector) {
      const sector = bySector.get(audited.sector) ?? {
        valueUsd: 0,
        valueCad: 0,
        pct: 0,
      };
      sector.valueUsd += valueUsd;
      sector.valueCad += valueCad;
      bySector.set(audited.sector, sector);
    }
  }

  const totalValueCad = usdAmountToCad(totalValueUsd, input.usdCadRate);
  if (totalValueUsd > 0) {
    for (const position of positions) {
      position.pct = (position.valueUsd / totalValueUsd) * 100;
    }
    for (const value of byTicker.values()) {
      value.pct = (value.valueUsd / totalValueUsd) * 100;
    }
    for (const value of bySector.values()) {
      value.pct = (value.valueUsd / totalValueUsd) * 100;
    }
  }

  return {
    usdCadRate: input.usdCadRate,
    totalValueUsd,
    totalValueCad,
    positions,
    byTicker,
    bySector,
    pricesResolved,
  };
}

function assertRate(usdCadRate: number): void {
  if (!Number.isFinite(usdCadRate) || usdCadRate <= 0) {
    throw new Error(`[portfolio/valuation] invalid USD/CAD rate: ${usdCadRate}`);
  }
}
