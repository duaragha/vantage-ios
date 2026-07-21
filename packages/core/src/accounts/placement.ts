/**
 * Tax-aware account-placement decision engine.
 *
 * Given a Wealthsimple-supported account set and a stock profile, rank the
 * account types from best to worst tax outcome, pick the best concrete account
 * the user actually owns, and surface a short rationale + tradeoff figures.
 *
 * The module is pure TypeScript — no schema imports, no DB types. Callers from
 * the catalyst engine, discovery rotation, and dashboard glue it together.
 *
 * The five decision branches (speculative, US-dividend, CA-dividend,
 * high-growth, default) capture the meaningful tax-law levers a Canadian
 * Wealthsimple user faces. Tax-law specifics live in rationale strings —
 * code stays terse.
 */

export type AccountType =
  | 'TFSA'
  | 'RRSP'
  | 'SpousalRRSP'
  | 'RESP'
  | 'LIRA'
  | 'RRIF'
  | 'Personal'
  | 'Margin';

export interface AccountSummary {
  id: number;
  type: AccountType;
  /** "CAD" | "USD" — WS Plus/Premium supports USD sub-accounts */
  currency: 'CAD' | 'USD';
  /** Null when room is unknown or N/A (e.g. Personal, Margin). */
  contributionRoomCad: number | null;
  /** Sum of current position market values in this account, CAD. Used to detect "full" accounts. */
  currentValueCad: number;
  archived: boolean;
}

export interface StockProfile {
  ticker: string;
  /** Where the stock is primarily listed. Drives the US-withholding logic. */
  listingCountry: 'US' | 'CA';
  /** Dividend yield as a decimal (e.g. 0.025 = 2.5%). Null when unknown — treat as 0. */
  dividendYieldTtm: number | null;
  /** Expected growth proxy — pass epsGrowth5y or revenueGrowth5y from TickerMetrics.
   * Decimal (0.15 = 15%). Null = unknown. */
  growth5y: number | null;
  /** Volatility / risk proxy — use beta (1 = market), or pass the stock's "category"
   * from the existing Position.category field if downstream caller is from holdings. */
  beta: number | null;
  /** True for stocks the lottery detector or category flagged as speculative.
   * Caller computes from TickerUniverse.isLottery OR Position.category === 'Speculative' || 'Meme'. */
  isSpeculative: boolean;
  /** Optional — current market cap in USD. Used for size sanity-checks. */
  marketCapUsd: number | null;
}

export interface PlacementTradeoff {
  accountType: AccountType;
  dragBps: number;
  reason: string;
}

export interface PlacementDecision {
  /** Account types the engine considers eligible (sorted best→worst). */
  rankedAccountTypes: AccountType[];
  /** Best account ID among user's actual accounts (using the `accounts` param).
   * Null when no eligible account exists (e.g. all archived, or all contribution rooms exhausted). */
  bestAccountId: number | null;
  /** Plain-english explanation (one to three sentences) the dashboard surfaces to the user. */
  rationale: string;
  /** Tax-drag estimate vs. the best slot, in basis points per year. 0 = optimal placement.
   * E.g. a US dividend stock in TFSA vs RRSP might be ~37 bps for a 2.5% yield × 15% withholding. */
  tradeoffsBps?: PlacementTradeoff[];
}

const US_WITHHOLDING_RATE = 0.15;
const DIVIDEND_THRESHOLD = 0.01;
const GROWTH_THRESHOLD = 0.15;

const SPECULATIVE_RANK: AccountType[] = ['Personal', 'Margin'];

const US_DIVIDEND_RANK: AccountType[] = [
  'RRSP',
  'SpousalRRSP',
  'LIRA',
  'RRIF',
  'Personal',
  'Margin',
  'TFSA',
  'RESP',
];

const CA_DIVIDEND_RANK: AccountType[] = [
  'TFSA',
  'Personal',
  'Margin',
  'RESP',
  'SpousalRRSP',
  'RRSP',
  'LIRA',
  'RRIF',
];

const GROWTH_RANK: AccountType[] = [
  'TFSA',
  'RESP',
  'Personal',
  'Margin',
  'SpousalRRSP',
  'RRSP',
  'LIRA',
  'RRIF',
];

const DEFAULT_RANK: AccountType[] = [
  'TFSA',
  'Personal',
  'Margin',
  'RRSP',
  'SpousalRRSP',
  'RESP',
  'LIRA',
  'RRIF',
];

interface BranchResult {
  rankedAccountTypes: AccountType[];
  rationale: string;
  tradeoffsBps?: PlacementTradeoff[];
}

export function decidePlacement(
  stock: StockProfile,
  accounts: readonly AccountSummary[],
): PlacementDecision {
  const branch = selectBranch(stock);
  const bestAccountId = resolveBestAccount(branch.rankedAccountTypes, stock, accounts);

  const rationale =
    accounts.length === 0
      ? `No accounts on file. ${branch.rationale}`
      : branch.rationale;

  const decision: PlacementDecision = {
    rankedAccountTypes: branch.rankedAccountTypes,
    bestAccountId,
    rationale,
  };

  if (branch.tradeoffsBps && branch.tradeoffsBps.length > 0) {
    decision.tradeoffsBps = branch.tradeoffsBps;
  }

  return decision;
}

function selectBranch(stock: StockProfile): BranchResult {
  const yield_ = stock.dividendYieldTtm ?? 0;
  const growth = stock.growth5y ?? 0;

  if (stock.isSpeculative) {
    return {
      rankedAccountTypes: SPECULATIVE_RANK,
      rationale:
        'Speculative names belong in non-registered — capital losses are deductible there but lost in TFSA/RRSP.',
    };
  }

  if (stock.listingCountry === 'US' && yield_ > DIVIDEND_THRESHOLD) {
    const dragBps = Math.round(yield_ * US_WITHHOLDING_RATE * 10_000);
    const yieldPct = (yield_ * 100).toFixed(2);
    return {
      rankedAccountTypes: US_DIVIDEND_RANK,
      rationale: `Holding US dividend payers in your RRSP avoids the 15% US withholding tax via the Canada-US tax treaty. In a TFSA the 15% drag is permanent — that's ~${dragBps} bps/year on a ${yieldPct}% yield.`,
      tradeoffsBps: [
        {
          accountType: 'TFSA',
          dragBps,
          reason: '15% US withholding is non-recoverable in TFSA (no foreign tax credit available).',
        },
        {
          accountType: 'RESP',
          dragBps,
          reason: '15% US withholding is non-recoverable in RESP (no foreign tax credit available).',
        },
        {
          accountType: 'Personal',
          dragBps: 0,
          reason: 'US withholding is recoverable via the foreign tax credit in non-registered accounts.',
        },
        {
          accountType: 'Margin',
          dragBps: 0,
          reason: 'US withholding is recoverable via the foreign tax credit in non-registered accounts.',
        },
      ],
    };
  }

  if (stock.listingCountry === 'CA' && yield_ > DIVIDEND_THRESHOLD) {
    return {
      rankedAccountTypes: CA_DIVIDEND_RANK,
      rationale:
        'Canadian eligible dividends qualify for the dividend tax credit in non-registered accounts. TFSA shelters them entirely; RRSP would convert the credit to ordinary income on withdrawal — worst slot.',
    };
  }

  if (growth > GROWTH_THRESHOLD && yield_ < DIVIDEND_THRESHOLD) {
    return {
      rankedAccountTypes: GROWTH_RANK,
      rationale:
        'Growth stocks belong in TFSA — gains are tax-free forever, vs. RRSP which converts capital gains to ordinary income on withdrawal.',
    };
  }

  return {
    rankedAccountTypes: DEFAULT_RANK,
    rationale:
      'Stable low-yield, low-growth name — TFSA first to shelter any future gains, then non-registered, then RRSP as a last resort.',
  };
}

function resolveBestAccount(
  ranked: readonly AccountType[],
  stock: StockProfile,
  accounts: readonly AccountSummary[],
): number | null {
  if (accounts.length === 0) return null;

  const open = accounts.filter((a) => !a.archived);
  if (open.length === 0) return null;

  const preferUsd = stock.listingCountry === 'US';

  for (const type of ranked) {
    const matches = open.filter((a) => a.type === type);
    if (matches.length === 0) continue;

    const withRoom = matches.filter(
      (a) => (a.contributionRoomCad ?? Number.POSITIVE_INFINITY) > 0,
    );
    if (withRoom.length === 0) continue;

    const sorted = [...withRoom].sort((a, b) => {
      if (preferUsd && a.currency !== b.currency) {
        if (a.currency === 'USD') return -1;
        if (b.currency === 'USD') return 1;
      }
      const roomA = a.contributionRoomCad ?? Number.POSITIVE_INFINITY;
      const roomB = b.contributionRoomCad ?? Number.POSITIVE_INFINITY;
      if (roomA !== roomB) return roomB - roomA;
      return a.id - b.id;
    });

    const pick = sorted[0];
    if (pick) return pick.id;
  }

  return null;
}
