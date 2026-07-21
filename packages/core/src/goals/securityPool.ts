// Hand-curated pool of vetted Canadian/US ETFs + select individual names used
// by the goals engine to recommend holdings. Most TSX ETFs aren't in the
// discovery-scored universe (which biases to US large-caps from news scraping),
// so we keep a small authoritative list here. Re-review annually.
//
// Each entry carries Canadian-tax-aware metadata: `optimalAccounts` flags the
// account types where the holding shines (after the cap-gains math, dividend
// tax credit, Canada-US treaty exemption, etc.), `suboptimalAccounts` flags
// places where another instrument would clearly be better, and `taxRationale`
// supplies a one-liner the UI surfaces alongside the fit score.

import type { AccountType, SecurityCategory } from '@vantage/db';
import type { IncomeRiskKey } from './monthlyIncome.js';

export interface CuratedSecurity {
  ticker: string;
  name: string;
  category: SecurityCategory;
  currency: 'CAD' | 'USD';
  /** Approximate equity weight for one-ticket allocation funds. Used by the
   * goals engine to rank XINC/XCNS/XBAL/XGRO/XEQT-like funds against the risk
   * tier rather than treating every Balanced/Growth label as equivalent. */
  equityPct?: number | null;
  /** Optional explicit risk band, 1 safest through 5 most speculative. When
   * omitted, the goals engine derives a conservative rating from category,
   * duration, equity weight, yield, leverage, and NAV-erosion metadata. */
  riskRating?: 1 | 2 | 3 | 4 | 5;
  expectedYield: number | null;
  durationYears: number | null;
  mer: number | null;
  description: string;
  /** Account types where this security shines after Canadian tax math. */
  optimalAccounts: AccountType[];
  /** Account types where this security is meaningfully worse than alternatives. */
  suboptimalAccounts: AccountType[];
  /** Per-account tax rationale. UI surfaces this alongside fit score. */
  taxRationale?: { account: AccountType; reason: string }[];
  /** NAV-erosion / sustainability risk for high-distribution products. Drives
   * a UI warning + a fitScore penalty so yield-traps don't out-rank sustainable
   * income. null = N/A (normal equity/bond). */
  navErosionRisk?: 'low' | 'moderate' | 'high' | null;
  /** First income-risk tier allowed to surface this product. This is distinct
   * from yield: a 4% individual REIT is not automatically safer than cash. */
  incomeRiskFloor?: IncomeRiskKey;
}

// Reusable rationale snippets to keep the table readable.
const R = {
  cashTfsa: {
    account: 'TFSA' as AccountType,
    reason: 'Interest is fully tax-sheltered in a TFSA — same yield, no T5.',
  },
  cashPersonal: {
    account: 'Personal' as AccountType,
    reason:
      'Outside a TFSA the interest is taxed at your marginal rate, but cash still belongs here over an RRSP (RRSP withdrawal triggers tax and destroys room).',
  },
  cashRrspBad: {
    account: 'RRSP' as AccountType,
    reason:
      "Avoid: cash-equivalent yields don't compound enough to justify burning RRSP room — and withdrawals are taxed as ordinary income.",
  },

  cdnDivTfsa: {
    account: 'TFSA' as AccountType,
    reason: 'Canadian eligible dividends are tax-free inside a TFSA and gains compound untaxed.',
  },
  cdnDivPersonal: {
    account: 'Personal' as AccountType,
    reason:
      'Eligible dividends qualify for the federal dividend tax credit in non-registered — most tax-efficient placement.',
  },
  cdnDivMargin: {
    account: 'Margin' as AccountType,
    reason:
      'Same eligible-dividend tax credit applies; capital losses on shares are also deductible against gains.',
  },
  cdnDivRrspBad: {
    account: 'RRSP' as AccountType,
    reason:
      'Avoid in RRSP: the dividend tax credit is lost on withdrawal, when dividends convert to ordinary income.',
  },

  usDivRrsp: {
    account: 'RRSP' as AccountType,
    reason: 'Canada-US treaty exempts 15% US withholding tax when held in an RRSP/RRIF.',
  },
  usDivSpousal: {
    account: 'SpousalRRSP' as AccountType,
    reason: 'Same treaty exemption as RRSP — withholding-free US dividends.',
  },
  usDivLira: {
    account: 'LIRA' as AccountType,
    reason: 'LIRA inherits the RRSP treaty exemption — withholding-free US dividends.',
  },
  usDivRrif: {
    account: 'RRIF' as AccountType,
    reason: 'RRIF inherits the RRSP treaty exemption — withholding-free US dividends.',
  },
  usDivTfsaBad: {
    account: 'TFSA' as AccountType,
    reason:
      "Avoid in TFSA: 15% US withholding is unrecoverable (the treaty exemption doesn't apply to TFSA).",
  },
  usDivRespBad: {
    account: 'RESP' as AccountType,
    reason:
      'Avoid in RESP: 15% US withholding is unrecoverable (same as TFSA — no treaty exemption).',
  },

  growthTfsa: {
    account: 'TFSA' as AccountType,
    reason:
      'Capital gains on high-growth equities are tax-free forever inside a TFSA — the single best wrapper for big winners.',
  },
  growthPersonalOk: {
    account: 'Personal' as AccountType,
    reason:
      'Only 50% of capital gains are taxable in non-reg, and losses are deductible — workable if TFSA is maxed.',
  },

  pureGrowthRrspMid: {
    account: 'RRSP' as AccountType,
    reason:
      'Works, but suboptimal: gains convert to ordinary income on RRSP withdrawal, losing the cap-gains advantage.',
  },

  reitRrsp: {
    account: 'RRSP' as AccountType,
    reason:
      'US REIT distributions are exempt from the 15% withholding under the Canada-US treaty when held in RRSP — best placement.',
  },
  reitTfsaBad: {
    account: 'TFSA' as AccountType,
    reason:
      'Avoid in TFSA: US REIT distributions get the 15% withholding hit (no treaty exemption for TFSA).',
  },
  reitPersonalBad: {
    account: 'Personal' as AccountType,
    reason:
      'Avoid in non-reg: REIT distributions are non-eligible (taxed as ordinary income, no dividend tax credit).',
  },

  bondRrsp: {
    account: 'RRSP' as AccountType,
    reason:
      'Interest income is taxed as ordinary income — shelter it inside an RRSP rather than non-reg.',
  },
  bondSpousal: {
    account: 'SpousalRRSP' as AccountType,
    reason: 'Interest income is fully tax-sheltered until withdrawal.',
  },
  bondTfsa: {
    account: 'TFSA' as AccountType,
    reason:
      'Interest is fully sheltered in a TFSA; useful when this is shorter-horizon money and RRSP withdrawal tax would be awkward.',
  },
  bondPersonalBad: {
    account: 'Personal' as AccountType,
    reason:
      'Avoid in non-reg: interest income is fully taxed at marginal rate (no cap-gains discount, no div credit).',
  },
  bondMarginBad: {
    account: 'Margin' as AccountType,
    reason:
      'Avoid in non-reg: interest income is fully taxed at marginal rate — bond ballast belongs in registered accounts.',
  },

  broadEquityTfsa: {
    account: 'TFSA' as AccountType,
    reason: 'All-equity index — TFSA captures the long-run gains tax-free.',
  },
  broadEquityRrsp: {
    account: 'RRSP' as AccountType,
    reason: 'Tax-deferred compounding on equity gains; works well for retirement-horizon money.',
  },
  broadEquitySpousal: {
    account: 'SpousalRRSP' as AccountType,
    reason: 'Tax-deferred compounding plus income-splitting flexibility at retirement.',
  },
  broadEquityResp: {
    account: 'RESP' as AccountType,
    reason: 'Tax-sheltered equity growth aligned with an 18-year compounding window.',
  },

  // Covered-call / BDC / HY credit — high-distribution products. US ones pay
  // mostly ordinary income + return-of-capital (no eligible-dividend credit, no
  // treaty relief in TFSA), so shelter them in an RRSP. Canadian ones pay
  // eligible Cdn dividends → TFSA/Personal-optimal.
  ccUsRrsp: {
    account: 'RRSP' as AccountType,
    reason:
      'US covered-call distributions are mostly ordinary income + return-of-capital (no dividend tax credit) — shelter them in an RRSP, where the treaty also blocks the 15% withholding.',
  },
  ccUsSpousal: {
    account: 'SpousalRRSP' as AccountType,
    reason:
      'Same as RRSP: ordinary-income distributions sheltered + treaty exemption on the US-source slice.',
  },
  ccUsLira: {
    account: 'LIRA' as AccountType,
    reason:
      'LIRA inherits the RRSP treaty exemption and shelters the ordinary-income distributions.',
  },
  ccUsRrif: {
    account: 'RRIF' as AccountType,
    reason:
      'RRIF inherits the RRSP treaty exemption and shelters the ordinary-income distributions.',
  },
  ccUsTfsaBad: {
    account: 'TFSA' as AccountType,
    reason:
      'Avoid in TFSA: 15% US withholding on the option-income slice is unrecoverable (no treaty exemption for TFSA), and the distributions are taxed as ordinary income outside it anyway.',
  },
  ccUsPersonalBad: {
    account: 'Personal' as AccountType,
    reason:
      'Avoid in non-reg: distributions are ordinary income + return-of-capital (no eligible-dividend credit) and the US withholding leaks — RRSP is the right wrapper.',
  },

  ccCdnTfsa: {
    account: 'TFSA' as AccountType,
    reason:
      'Canadian covered-call ETF — eligible dividends + capital-gains-shaped option premium are tax-free in a TFSA, and there is no US withholding to worry about.',
  },
  ccCdnPersonal: {
    account: 'Personal' as AccountType,
    reason:
      'Distributions blend eligible Canadian dividends (dividend tax credit) with return-of-capital — efficient in non-registered.',
  },
  ccCdnMargin: {
    account: 'Margin' as AccountType,
    reason: 'Eligible-dividend tax credit applies; return-of-capital defers tax by lowering ACB.',
  },
  ccCdnRrspBad: {
    account: 'RRSP' as AccountType,
    reason:
      'Suboptimal in RRSP: the eligible-dividend tax credit is lost on withdrawal (converts to ordinary income).',
  },

  bdcRrsp: {
    account: 'RRSP' as AccountType,
    reason:
      'BDC distributions are mostly ordinary income — shelter in an RRSP, where the treaty also blocks the 15% US withholding.',
  },
  hyRrsp: {
    account: 'RRSP' as AccountType,
    reason:
      'High-yield bond interest is fully taxed as ordinary income — shelter it in an RRSP rather than non-reg.',
  },
} as const;

export const CURATED_POOL: readonly CuratedSecurity[] = Object.freeze<CuratedSecurity[]>([
  // ---- Cash equivalents -------------------------------------------------
  {
    ticker: 'CASH.TO',
    name: 'Global X High Interest Savings ETF',
    category: 'CashEquivalent',
    currency: 'CAD',
    expectedYield: 0.05,
    durationYears: 0,
    mer: 0.0014,
    description:
      'High-interest savings deposits at Schedule I banks. Cash-equivalent, near-instant access via TSX.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cashTfsa, R.cashPersonal, R.cashRrspBad],
  },
  {
    ticker: 'CBIL.TO',
    name: 'Global X 0-3 Month T-Bill ETF',
    category: 'CashEquivalent',
    currency: 'CAD',
    expectedYield: 0.046,
    durationYears: 0.1,
    mer: 0.0014,
    description: 'Government of Canada T-bills, 0-3 month maturity. No credit risk. Daily liquid.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cashTfsa, R.cashPersonal, R.cashRrspBad],
  },
  {
    ticker: 'PSA.TO',
    name: 'Purpose High Interest Savings ETF',
    category: 'CashEquivalent',
    currency: 'CAD',
    expectedYield: 0.049,
    durationYears: 0,
    mer: 0.0017,
    description:
      'CDIC-eligible deposits across multiple banks. Same shape as CASH.TO with a slightly different bank mix.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cashTfsa, R.cashPersonal, R.cashRrspBad],
  },
  {
    ticker: 'ZMMK.TO',
    name: 'BMO Money Market Fund ETF',
    category: 'CashEquivalent',
    currency: 'CAD',
    expectedYield: 0.045,
    durationYears: 0.15,
    mer: 0.0028,
    description:
      'BMO money-market basket: T-bills + commercial paper. Slightly more credit risk than CBIL.TO.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cashTfsa, R.cashPersonal, R.cashRrspBad],
  },

  // ---- Short-term bond ETFs --------------------------------------------
  {
    ticker: 'XSB.TO',
    name: 'iShares Core Canadian Short Term Bond',
    category: 'ShortTermBond',
    currency: 'CAD',
    expectedYield: 0.032,
    durationYears: 2.7,
    mer: 0.001,
    description:
      'Short Canadian investment-grade bonds. More rate risk than cash, much less than the broad bond index.',
    optimalAccounts: ['TFSA', 'RRSP', 'SpousalRRSP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.bondTfsa, R.bondRrsp, R.bondSpousal, R.bondPersonalBad, R.bondMarginBad],
  },
  {
    ticker: 'VSB.TO',
    name: 'Vanguard Canadian Short-Term Bond Index',
    category: 'ShortTermBond',
    currency: 'CAD',
    expectedYield: 0.031,
    durationYears: 2.7,
    mer: 0.0011,
    description:
      'Short-term Canadian government and investment-grade corporate bonds. Low duration ballast for conservative goals.',
    optimalAccounts: ['TFSA', 'RRSP', 'SpousalRRSP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.bondTfsa, R.bondRrsp, R.bondSpousal, R.bondPersonalBad, R.bondMarginBad],
  },

  // ---- Canadian dividend ETFs ------------------------------------------
  {
    ticker: 'VDY.TO',
    name: 'Vanguard FTSE Canadian High Dividend Yield Index',
    category: 'DividendCanadian',
    currency: 'CAD',
    expectedYield: 0.041,
    durationYears: null,
    mer: 0.0022,
    description:
      'Canadian high-yield stocks. Eligible dividends qualify for the federal dividend tax credit in non-registered accounts.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cdnDivTfsa, R.cdnDivPersonal, R.cdnDivMargin, R.cdnDivRrspBad],
  },
  {
    ticker: 'ZDV.TO',
    name: 'BMO Canadian Dividend ETF',
    category: 'DividendCanadian',
    currency: 'CAD',
    expectedYield: 0.044,
    durationYears: null,
    mer: 0.0039,
    description: "BMO's Canadian dividend basket, screened for yield + growth history.",
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cdnDivTfsa, R.cdnDivPersonal, R.cdnDivMargin, R.cdnDivRrspBad],
  },
  {
    ticker: 'XEI.TO',
    name: 'iShares S&P/TSX Composite High Dividend',
    category: 'DividendCanadian',
    currency: 'CAD',
    expectedYield: 0.054,
    durationYears: null,
    mer: 0.0022,
    description:
      'iShares high-yield Canadian basket. Higher yield than VDY.TO with more financials and energy concentration.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [R.cdnDivTfsa, R.cdnDivPersonal, R.cdnDivMargin, R.cdnDivRrspBad],
  },

  // ---- US dividend ETFs -------------------------------------------------
  {
    ticker: 'SCHD',
    name: 'Schwab US Dividend Equity ETF',
    category: 'DividendUS',
    currency: 'USD',
    expectedYield: 0.036,
    durationYears: null,
    mer: 0.0006,
    description:
      'US dividend payers screened for quality and sustained growth. In an RRSP, avoids the 15% US withholding tax via the Canada-US treaty.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'RESP'],
    taxRationale: [
      R.usDivRrsp,
      R.usDivSpousal,
      R.usDivLira,
      R.usDivRrif,
      R.usDivTfsaBad,
      R.usDivRespBad,
    ],
  },
  {
    ticker: 'VYM',
    name: 'Vanguard High Dividend Yield ETF',
    category: 'DividendUS',
    currency: 'USD',
    expectedYield: 0.029,
    durationYears: null,
    mer: 0.0006,
    description: 'US large-cap dividend index. Best in RRSP for the treaty exemption.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'RESP'],
    taxRationale: [
      R.usDivRrsp,
      R.usDivSpousal,
      R.usDivLira,
      R.usDivRrif,
      R.usDivTfsaBad,
      R.usDivRespBad,
    ],
  },

  // ---- All-equity / balanced single-ticker funds -----------------------
  {
    ticker: 'XEQT.TO',
    name: 'iShares Core Equity ETF Portfolio',
    category: 'AllEquity',
    currency: 'CAD',
    equityPct: 100,
    expectedYield: 0.018,
    durationYears: null,
    mer: 0.002,
    description:
      '100% global equity, single-ticker diversification across roughly 24,000 holdings.',
    optimalAccounts: ['TFSA', 'RRSP', 'SpousalRRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquitySpousal],
  },
  {
    ticker: 'VEQT.TO',
    name: 'Vanguard All-Equity ETF Portfolio',
    category: 'AllEquity',
    currency: 'CAD',
    equityPct: 100,
    expectedYield: 0.018,
    durationYears: null,
    mer: 0.0024,
    description:
      'Single-ticker all-equity portfolio, ~13,000 holdings. Slightly more US/large-cap-weighted than XEQT.TO; same buy-one-fund-and-hold role.',
    optimalAccounts: ['TFSA', 'RRSP', 'SpousalRRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquitySpousal],
  },
  {
    ticker: 'VFV.TO',
    name: 'Vanguard S&P 500 Index (CAD)',
    category: 'EquityUS',
    currency: 'CAD',
    expectedYield: 0.012,
    durationYears: null,
    mer: 0.0009,
    description: 'S&P 500 in a CAD wrapper. Best in TFSA for the gains.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp],
  },
  {
    ticker: 'ZSP.TO',
    name: 'BMO S&P 500 Index (CAD)',
    category: 'EquityUS',
    currency: 'CAD',
    expectedYield: 0.012,
    durationYears: null,
    mer: 0.0009,
    description:
      'S&P 500 (500 US large-caps) in a CAD-listed wrapper — no USD conversion needed. Interchangeable with VFV.TO; pick on whichever MER/spread is lower.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp],
  },
  {
    ticker: 'VTI',
    name: 'Vanguard Total US Stock Market',
    category: 'EquityUS',
    currency: 'USD',
    expectedYield: 0.013,
    durationYears: null,
    mer: 0.0003,
    description:
      'Cheapest exposure to the entire US stock market. USD-denominated — pair with a USD sub-account.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp],
  },
  {
    ticker: 'XINC.TO',
    name: 'iShares Core Income Balanced ETF Portfolio',
    category: 'Balanced',
    currency: 'CAD',
    equityPct: 20,
    expectedYield: 0.028,
    durationYears: 4,
    mer: 0.0017,
    description:
      '20/80 equity-to-bond all-in-one portfolio. Conservative income-first allocation for low-risk goals.',
    optimalAccounts: ['TFSA', 'RRSP', 'RESP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquityResp, R.bondPersonalBad],
  },
  {
    ticker: 'XCNS.TO',
    name: 'iShares Core Conservative Balanced ETF Portfolio',
    category: 'Balanced',
    currency: 'CAD',
    equityPct: 40,
    expectedYield: 0.025,
    durationYears: 5,
    mer: 0.0017,
    description:
      '40/60 equity-to-bond all-in-one portfolio. Conservative growth with meaningful fixed-income ballast.',
    optimalAccounts: ['TFSA', 'RRSP', 'RESP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquityResp, R.bondPersonalBad],
  },
  {
    ticker: 'XBAL.TO',
    name: 'iShares Core Balanced ETF Portfolio',
    category: 'Balanced',
    currency: 'CAD',
    equityPct: 60,
    expectedYield: 0.022,
    durationYears: 6,
    mer: 0.002,
    description: '60/40 equity-to-bond global mix. Good for 3-7yr horizons.',
    optimalAccounts: ['TFSA', 'RRSP', 'RESP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquityResp],
  },
  {
    ticker: 'XGRO.TO',
    name: 'iShares Core Growth ETF Portfolio',
    category: 'Growth',
    currency: 'CAD',
    equityPct: 80,
    expectedYield: 0.02,
    durationYears: 4,
    mer: 0.002,
    description: '80/20 equity-to-bond. Aimed at 5-15yr horizons with some bond ballast.',
    optimalAccounts: ['TFSA', 'RRSP', 'RESP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp, R.broadEquityResp],
  },
  {
    ticker: 'ZAG.TO',
    name: 'BMO Aggregate Bond Index',
    category: 'IntermediateBond',
    currency: 'CAD',
    expectedYield: 0.034,
    durationYears: 7.5,
    mer: 0.0009,
    description: 'Broad Canadian investment-grade bond market.',
    optimalAccounts: ['RRSP', 'SpousalRRSP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.bondRrsp, R.bondSpousal, R.bondPersonalBad, R.bondMarginBad],
  },
  {
    ticker: 'XBB.TO',
    name: 'iShares Core Canadian Universe Bond',
    category: 'IntermediateBond',
    currency: 'CAD',
    expectedYield: 0.033,
    durationYears: 7.5,
    mer: 0.0009,
    description:
      'Broad Canadian investment-grade bond index (governments + corporates), ~7.5yr duration. Interchangeable with ZAG.TO as registered-account bond ballast.',
    optimalAccounts: ['RRSP', 'SpousalRRSP'],
    suboptimalAccounts: ['Personal', 'Margin'],
    taxRationale: [R.bondRrsp, R.bondSpousal, R.bondPersonalBad, R.bondMarginBad],
  },
  {
    ticker: 'XAW.TO',
    name: 'iShares Core MSCI All Country World ex Canada',
    category: 'EquityInternational',
    currency: 'CAD',
    expectedYield: 0.018,
    durationYears: null,
    mer: 0.0022,
    description:
      'Global ex-Canada equity. Pairs with a Canadian-equity holding for full diversification.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [R.broadEquityTfsa, R.broadEquityRrsp],
  },

  // =====================================================================
  // Phase 18 — tax-aware aggressive additions
  // =====================================================================

  // ---- Growth individual stocks (TFSA-optimal — no/low dividend, big upside)
  {
    ticker: 'NVDA',
    name: 'Nvidia Corporation',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0.0003,
    durationYears: null,
    mer: null,
    description: 'AI/datacenter GPU leader. Negligible dividend — pure capital-gains compounding.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'TSLA',
    name: 'Tesla, Inc.',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: null,
    description: 'EV + energy. No dividend — pure cap-gains play with high volatility.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'AMD',
    name: 'Advanced Micro Devices',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: null,
    description: 'AI/datacenter CPU+GPU. No dividend — TFSA is the perfect wrapper for the upside.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'PLTR',
    name: 'Palantir Technologies',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: null,
    description:
      'Data analytics platform — high volatility, no dividend, lottery-shaped distribution.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'MSTR',
    name: 'MicroStrategy',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: null,
    description:
      'Effectively a leveraged Bitcoin proxy via corporate treasury. Extreme volatility.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'AVGO',
    name: 'Broadcom',
    category: 'IndividualStock',
    currency: 'USD',
    expectedYield: 0.012,
    durationYears: null,
    mer: null,
    description:
      'Semiconductor + software conglomerate. Small dividend, predominantly cap-gains story.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },

  // ---- Growth ETFs (TFSA-optimal)
  {
    ticker: 'ARKK',
    name: 'ARK Innovation ETF',
    category: 'Speculative',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: 0.0075,
    description:
      'Cathie Wood actively-managed disruptive-innovation ETF. High vol, no meaningful div.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },
  {
    ticker: 'IWO',
    name: 'iShares Russell 2000 Growth ETF',
    category: 'Speculative',
    currency: 'USD',
    expectedYield: 0.005,
    durationYears: null,
    mer: 0.0024,
    description: 'US small-cap growth basket. Long-tail upside; volatility belongs in a TFSA.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },

  // ---- Leveraged ETFs (TFSA-only aggressive)
  {
    ticker: 'TQQQ',
    name: 'ProShares UltraPro QQQ (3x Nasdaq-100)',
    category: 'LeveragedETF',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: 0.0098,
    description:
      '3x daily-resetting Nasdaq-100 leverage. Decay risk on flat tape; massive upside in trends.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [
      {
        account: 'TFSA',
        reason:
          '3x leverage — any blow-up gain is tax-free, and the volatility budget belongs where gains are sheltered.',
      },
      {
        account: 'Personal',
        reason:
          'Workable only if losses are valuable (deductible against gains) and you can stomach the daily-reset decay drag.',
      },
      R.pureGrowthRrspMid,
    ],
  },
  {
    ticker: 'SOXL',
    name: 'Direxion Daily Semiconductor Bull 3X',
    category: 'LeveragedETF',
    currency: 'USD',
    expectedYield: 0,
    durationYears: null,
    mer: 0.0094,
    description:
      '3x daily-resetting semiconductor index. Highly volatile — sized small and sheltered.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [
      {
        account: 'TFSA',
        reason: 'Triple-leveraged semis — TFSA shelters both the volatility and any windfall gain.',
      },
      {
        account: 'Personal',
        reason: 'Only justifiable in non-reg if you actively want the losses to be deductible.',
      },
      R.pureGrowthRrspMid,
    ],
  },

  // ---- Sector ETFs (TFSA-leaning aggressive)
  {
    ticker: 'SMH',
    name: 'VanEck Semiconductor ETF',
    category: 'SectorEquity',
    currency: 'USD',
    expectedYield: 0.005,
    durationYears: null,
    mer: 0.0035,
    description:
      'Concentrated semiconductor exposure (TSM, NVDA, AVGO heavyweights). Almost no dividend.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [
      R.broadEquityTfsa,
      R.broadEquityRrsp,
      {
        account: 'Personal',
        reason:
          'Workable in non-reg given the tiny yield — 50% cap-gains inclusion still cheaper than ordinary income.',
      },
    ],
  },
  {
    ticker: 'XBI',
    name: 'SPDR S&P Biotech ETF',
    category: 'SectorEquity',
    currency: 'USD',
    expectedYield: 0.001,
    durationYears: null,
    mer: 0.0035,
    description:
      'Equal-weighted US biotech basket. Highly volatile, lottery-shaped — no meaningful dividend.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [R.growthTfsa, R.growthPersonalOk, R.pureGrowthRrspMid],
  },

  // ---- REITs (RRSP-optimal high-yield)
  {
    ticker: 'O',
    name: 'Realty Income Corp',
    category: 'REIT',
    currency: 'USD',
    expectedYield: 0.055,
    durationYears: null,
    mer: null,
    description:
      'US monthly-pay net-lease REIT, dividend aristocrat. Distributions are treaty-exempt in RRSP only.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal', 'Margin', 'RESP'],
    taxRationale: [
      {
        account: 'RRSP',
        reason:
          'US REIT distributions are treaty-exempt from 15% withholding inside an RRSP — best wrapper.',
      },
      {
        account: 'SpousalRRSP',
        reason: 'Same treaty exemption applies; plus retirement income-splitting flexibility.',
      },
      R.reitTfsaBad,
      R.reitPersonalBad,
    ],
  },

  // ---- Canadian eligible dividend champions (Personal/Margin-optimal)
  {
    ticker: 'RY.TO',
    name: 'Royal Bank of Canada',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.038,
    durationYears: null,
    mer: null,
    description: "Canada's largest bank — eligible dividends, ~25 years of growth.",
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'Canadian eligible dividend qualifies for the federal dividend tax credit — best in non-registered.',
      },
      {
        account: 'Margin',
        reason: 'Same dividend tax credit applies; capital losses on shares also deductible.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'BNS.TO',
    name: 'Bank of Nova Scotia',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.066,
    durationYears: null,
    mer: null,
    description: 'Highest-yielding Big 5 Canadian bank. Eligible-dividend tax credit eligible.',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'High eligible-dividend yield maximises the federal dividend tax credit in non-reg.',
      },
      {
        account: 'Margin',
        reason: 'Eligible dividend + deductible interest if borrowed-to-invest.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'BMO.TO',
    name: 'Bank of Montreal',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.046,
    durationYears: null,
    mer: null,
    description: 'Big 5 Canadian bank with longest unbroken dividend history (1829).',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'Canadian eligible dividend qualifies for the federal dividend tax credit — best in non-registered.',
      },
      {
        account: 'Margin',
        reason: 'Same dividend tax credit; capital losses deductible against other gains.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'TD.TO',
    name: 'Toronto-Dominion Bank',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.051,
    durationYears: null,
    mer: null,
    description: 'Big 5 with major US retail-banking footprint. Eligible-dividend payer.',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'Canadian eligible dividend qualifies for the federal dividend tax credit — best in non-registered.',
      },
      { account: 'Margin', reason: 'Eligible dividend tax credit applies; losses deductible.' },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'ENB.TO',
    name: 'Enbridge Inc.',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.072,
    durationYears: null,
    mer: null,
    description:
      "North America's largest energy infrastructure / pipelines operator. 29+ years of dividend growth.",
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'High eligible-dividend yield maximises the federal dividend tax credit in non-reg.',
      },
      {
        account: 'Margin',
        reason:
          'Eligible dividend + borrowed-to-invest interest deductibility makes this a non-reg classic.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'TRP.TO',
    name: 'TC Energy',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.068,
    durationYears: null,
    mer: null,
    description:
      'Major Canadian pipeline operator. Eligible-dividend payer with 20+ years of growth.',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'High eligible-dividend yield qualifies for the federal dividend tax credit in non-reg.',
      },
      {
        account: 'Margin',
        reason: 'Eligible dividend + deductible interest if borrowed-to-invest.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'T.TO',
    name: 'Telus Corp',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.072,
    durationYears: null,
    mer: null,
    description: 'Canadian telecom with steady eligible-dividend growth.',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason: 'Eligible dividend tax credit makes this most efficient in non-reg.',
      },
      { account: 'Margin', reason: 'Same dividend tax credit; capital losses deductible.' },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'BCE.TO',
    name: 'BCE Inc.',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.085,
    durationYears: null,
    mer: null,
    description:
      'Bell Canada parent. High eligible-dividend yield with payout-ratio pressure (size for risk).',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason: 'Very high eligible-dividend yield → large federal dividend tax credit in non-reg.',
      },
      {
        account: 'Margin',
        reason: 'Eligible dividend + interest deductibility if borrowed-to-invest.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'FTS.TO',
    name: 'Fortis Inc.',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.041,
    durationYears: null,
    mer: null,
    description:
      'Regulated utility, 51+ years of consecutive dividend growth (Canadian aristocrat).',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      {
        account: 'Personal',
        reason:
          'Eligible dividend tax credit; stable utility cashflow makes this a non-reg cornerstone.',
      },
      {
        account: 'Margin',
        reason: 'Same dividend tax credit; eligible for borrowed-to-invest interest deductibility.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },
  {
    ticker: 'EMA.TO',
    name: 'Emera Inc.',
    category: 'IndividualStock',
    currency: 'CAD',
    expectedYield: 0.054,
    durationYears: null,
    mer: null,
    description:
      'Atlantic-Canada utility with regulated US assets. Eligible-dividend payer with 17+ years of growth.',
    optimalAccounts: ['Personal', 'Margin', 'TFSA'],
    suboptimalAccounts: ['RRSP'],
    taxRationale: [
      { account: 'Personal', reason: 'Eligible dividend tax credit applies in non-reg.' },
      {
        account: 'Margin',
        reason: 'Eligible dividend + interest deductibility if borrowed-to-invest.',
      },
      R.cdnDivTfsa,
      R.cdnDivRrspBad,
    ],
  },

  // ---- Crypto-adjacent
  {
    ticker: 'BTCC.B.TO',
    name: 'Purpose Bitcoin ETF (CAD)',
    category: 'CryptoAdjacent',
    currency: 'CAD',
    expectedYield: 0,
    durationYears: null,
    mer: 0.01,
    description: 'Spot Bitcoin ETF in CAD. No dividend — pure capital-gains exposure to BTC.',
    optimalAccounts: ['TFSA'],
    suboptimalAccounts: [],
    taxRationale: [
      {
        account: 'TFSA',
        reason:
          'Spot BTC exposure with no distribution — TFSA shelters the volatility and any windfall gain.',
      },
      {
        account: 'Personal',
        reason: 'Workable in non-reg: 50% cap-gains inclusion; losses deductible against gains.',
      },
      R.pureGrowthRrspMid,
    ],
  },

  // ---- Emerging markets
  {
    ticker: 'VEE.TO',
    name: 'Vanguard FTSE Emerging Markets All Cap',
    category: 'EquityEmerging',
    currency: 'CAD',
    expectedYield: 0.027,
    durationYears: null,
    mer: 0.0024,
    description:
      'Emerging-markets equity (China/India/Taiwan/Brazil-heavy) in a CAD wrapper — the higher-growth, higher-volatility satellite to a developed-world core.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [
      R.broadEquityTfsa,
      R.broadEquityRrsp,
      {
        account: 'Personal',
        reason:
          'Workable in non-reg, but EM distributions are typically non-eligible — TFSA/RRSP preferred.',
      },
    ],
  },
  {
    ticker: 'ZEM.TO',
    name: 'BMO MSCI Emerging Markets Index',
    category: 'EquityEmerging',
    currency: 'CAD',
    expectedYield: 0.027,
    durationYears: null,
    mer: 0.0027,
    description:
      'Emerging-markets equity (MSCI EM) in a CAD wrapper — the higher-growth, higher-volatility satellite. Interchangeable with VEE.TO; pick on MER/tracking.',
    optimalAccounts: ['TFSA', 'RRSP'],
    suboptimalAccounts: [],
    taxRationale: [
      R.broadEquityTfsa,
      R.broadEquityRrsp,
      {
        account: 'Personal',
        reason:
          'Workable in non-reg, but EM distributions are typically non-eligible — TFSA/RRSP preferred.',
      },
    ],
  },

  // =====================================================================
  // High-yield-high-risk tier — covered-call ETFs + BDCs + HY credit.
  // Ranked by SUSTAINABLE yield: navErosionRisk drives a fitScore penalty so
  // spread-based income (QQQI/JEPI, 'low') out-ranks leveraged products (HDIV,
  // 'high'). YieldMax-style single-stock synthetic covered-call ETFs are NEVER
  // listed here — they live only in YIELD_TRAP_BLOCKLIST.
  // =====================================================================

  // ---- US covered-call / spread-based income ETFs (RRSP-optimal)
  {
    ticker: 'QQQI',
    name: 'NEOS Nasdaq-100 High Income ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.14,
    durationYears: null,
    mer: 0.0068,
    description:
      'Nasdaq-100 with a tax-efficient index-option spread overlay. Earns the option premium rather than bleeding NAV — sustainable high yield.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    navErosionRisk: 'low',
    taxRationale: [
      R.ccUsRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
  {
    ticker: 'SPYI',
    name: 'NEOS S&P 500 High Income ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.12,
    durationYears: null,
    mer: 0.0068,
    description:
      'S&P 500 with an index-option spread overlay. Distributions funded by genuine option premium, not return-of-capital — low NAV-erosion risk.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    navErosionRisk: 'low',
    taxRationale: [
      R.ccUsRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
  {
    ticker: 'JEPI',
    name: 'JPMorgan Equity Premium Income ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.08,
    durationYears: null,
    mer: 0.0035,
    description:
      'Low-volatility S&P 500 equity sleeve + equity-linked notes writing index calls. Conservative, sustainable monthly income — the gold standard for low NAV erosion.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'low',
    taxRationale: [
      R.ccUsRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
  {
    ticker: 'JEPQ',
    name: 'JPMorgan Nasdaq Equity Premium Income ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.1,
    durationYears: null,
    mer: 0.0035,
    description:
      'Nasdaq-100 sibling of JEPI — equity sleeve + ELNs writing index calls. Higher yield than JEPI with comparably low NAV erosion.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    navErosionRisk: 'low',
    taxRationale: [
      R.ccUsRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },

  // ---- Canadian covered-call ETFs (TFSA/Personal-optimal — Cdn dividends)
  {
    ticker: 'ZWB.TO',
    name: 'BMO Covered Call Canadian Banks ETF',
    category: 'CoveredCall',
    currency: 'CAD',
    expectedYield: 0.07,
    durationYears: null,
    mer: 0.0072,
    description:
      'Big-6 Canadian banks with a covered-call overlay. Eligible Canadian dividends + option premium — sustainable, no US withholding.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'low',
    taxRationale: [R.ccCdnTfsa, R.ccCdnPersonal, R.ccCdnMargin, R.ccCdnRrspBad],
  },
  {
    ticker: 'ZWU.TO',
    name: 'BMO Covered Call Utilities ETF',
    category: 'CoveredCall',
    currency: 'CAD',
    expectedYield: 0.08,
    durationYears: null,
    mer: 0.0071,
    description:
      'Canadian utilities/pipelines/telecom with a covered-call overlay. Higher yield, but rate-sensitive holdings carry some NAV-erosion risk.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'moderate',
    taxRationale: [R.ccCdnTfsa, R.ccCdnPersonal, R.ccCdnMargin, R.ccCdnRrspBad],
  },
  {
    ticker: 'ZWC.TO',
    name: 'BMO Canadian High Dividend Covered Call ETF',
    category: 'CoveredCall',
    currency: 'CAD',
    expectedYield: 0.07,
    durationYears: null,
    mer: 0.0072,
    description:
      'Diversified Canadian high-dividend basket with a covered-call overlay. Eligible dividends; moderate NAV erosion from the call drag.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'moderate',
    taxRationale: [R.ccCdnTfsa, R.ccCdnPersonal, R.ccCdnMargin, R.ccCdnRrspBad],
  },
  {
    ticker: 'HMAX.TO',
    name: 'Hamilton Canadian Financials Yield Maximizer ETF',
    category: 'CoveredCall',
    currency: 'CAD',
    expectedYield: 0.13,
    durationYears: null,
    mer: 0.0065,
    description:
      'Canadian financials with an aggressive ~50% covered-call write. High Cdn-dividend yield; the heavy call write caps upside → moderate NAV erosion.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    navErosionRisk: 'moderate',
    taxRationale: [R.ccCdnTfsa, R.ccCdnPersonal, R.ccCdnMargin, R.ccCdnRrspBad],
  },
  {
    ticker: 'HDIV.TO',
    name: 'Hamilton Enhanced Multi-Sector Covered Call ETF',
    category: 'CoveredCall',
    currency: 'CAD',
    expectedYield: 0.095,
    durationYears: null,
    mer: 0.0284,
    description:
      '25% leveraged fund-of-covered-call-ETFs at a 2.84% MER. The leverage amplifies both the yield and the NAV-erosion risk — sized carefully.',
    optimalAccounts: ['TFSA', 'Personal', 'Margin'],
    suboptimalAccounts: ['RRSP'],
    navErosionRisk: 'high',
    taxRationale: [
      R.ccCdnTfsa,
      R.ccCdnPersonal,
      {
        account: 'Margin',
        reason:
          'Eligible-dividend credit applies, but the 2.84% MER + 25% leverage make this a satellite-only position.',
      },
      R.ccCdnRrspBad,
    ],
  },

  // ---- US BDCs (RRSP-optimal — ordinary-income distributions)
  {
    ticker: 'MAIN',
    name: 'Main Street Capital (BDC)',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.07,
    durationYears: null,
    mer: null,
    description:
      'Internally-managed BDC lending to lower-middle-market companies. Conservative leverage and a long monthly-dividend record — moderate NAV-erosion risk.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'moderate',
    taxRationale: [
      R.bdcRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
  {
    ticker: 'ARCC',
    name: 'Ares Capital Corporation (BDC)',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.09,
    durationYears: null,
    mer: null,
    description:
      'Largest publicly-traded BDC — senior secured middle-market lending. Higher yield carries more credit/NAV sensitivity than MAIN.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    navErosionRisk: 'moderate',
    taxRationale: [
      R.bdcRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },

  // ---- US high-yield credit (RRSP-optimal — interest income)
  {
    ticker: 'HYG',
    name: 'iShares iBoxx High Yield Corporate Bond ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.06,
    durationYears: 3.5,
    mer: 0.0049,
    description:
      'Broad US high-yield ("junk") corporate bond basket. Income is interest — credit risk drives NAV moves in a downturn.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'moderate',
    taxRationale: [
      R.hyRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
  {
    ticker: 'JNK',
    name: 'SPDR Bloomberg High Yield Bond ETF',
    category: 'CoveredCall',
    currency: 'USD',
    expectedYield: 0.06,
    durationYears: 3.5,
    mer: 0.004,
    description:
      'SPDR high-yield corporate bond basket — sibling of HYG. Interest income; NAV tracks high-yield credit spreads.',
    optimalAccounts: ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'],
    suboptimalAccounts: ['TFSA', 'Personal'],
    riskRating: 4,
    incomeRiskFloor: 'high',
    navErosionRisk: 'moderate',
    taxRationale: [
      R.hyRrsp,
      R.ccUsSpousal,
      R.ccUsLira,
      R.ccUsRrif,
      R.ccUsTfsaBad,
      R.ccUsPersonalBad,
    ],
  },
]);

// YieldMax + single-stock synthetic covered-call ETFs — NAV-erosion yield
// traps. Never recommended (curated or discovery). User-confirmed exclusion.
export const YIELD_TRAP_BLOCKLIST: ReadonlySet<string> = new Set([
  'TSLY',
  'NVDY',
  'MSTY',
  'CONY',
  'ULTY',
  'AMDY',
  'APLY',
  'FBY',
  'GOOY',
  'NFLY',
  'MRNY',
  'AMZY',
  'JPMO',
  'YMAX',
  'YMAG',
  'PLTY',
  'SMCY',
  'DIPS',
  'CRSH',
  'FIAT',
]);
export function isYieldTrap(ticker: string): boolean {
  return YIELD_TRAP_BLOCKLIST.has(ticker.toUpperCase());
}

export function poolByCategories(...cats: SecurityCategory[]): CuratedSecurity[] {
  const set = new Set(cats);
  return CURATED_POOL.filter((s) => set.has(s.category));
}

export function findCurated(ticker: string): CuratedSecurity | null {
  return CURATED_POOL.find((s) => s.ticker.toUpperCase() === ticker.toUpperCase()) ?? null;
}

export function incomeRiskFloorForSecurity(security: CuratedSecurity): IncomeRiskKey {
  if (security.incomeRiskFloor) return security.incomeRiskFloor;

  switch (security.category) {
    case 'CashEquivalent':
    case 'ShortTermBond':
      return 'veryLow';
    case 'IntermediateBond':
    case 'Balanced':
    case 'DividendCanadian':
      return 'low';
    case 'DividendUS':
    case 'REIT':
      return 'moderate';
    case 'CoveredCall':
      return 'aggressive';
    default:
      return 'aggressive';
  }
}
