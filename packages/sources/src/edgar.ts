/**
 * SEC EDGAR adapter.
 *
 * - CIK lookup cached from https://www.sec.gov/files/company_tickers.json
 * - RSS (Atom) poll per CIK for 8-K / 10-Q / 10-K
 * - MANDATORY User-Agent from EDGAR_USER_AGENT or SEC silently IP-bans
 * - Polite rate limit: max 10 req/sec per SEC guidelines
 *
 * Atom feed URL template:
 *   https://www.sec.gov/cgi-bin/browse-edgar
 *     ?action=getcompany&CIK={cik}&type={form}
 *     &dateb=&owner=include&count=40&output=atom
 */

import { RateLimiter } from './rate-limit.js';
import type { NormalizedArticle, NormalizedEvent } from './types.js';

const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const BROWSE_BASE = 'https://www.sec.gov/cgi-bin/browse-edgar';

/** SEC ticker-map shape: { "0": { cik_str, ticker, title }, "1": {...}, ... } */
interface SecTickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}
type SecTickerMap = Record<string, SecTickerRow>;

export class EdgarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgarConfigError';
  }
}

export interface EdgarFiling {
  cik: string; // 10-digit zero-padded
  ticker: string;
  companyName: string;
  formType: string; // e.g. "8-K", "10-Q", "10-K"
  filedAt: Date;
  title: string;
  url: string; // link to the filing index page
  accessionNumber: string | null;
}

export type EdgarFormType = '8-K' | '10-Q' | '10-K' | string;

export interface EdgarAdapterOptions {
  userAgent?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  /** How long to cache the ticker->cik map in ms. Default 24h. */
  tickerMapTtlMs?: number;
}

export class EdgarAdapter {
  readonly name = 'edgar';
  readonly tier = 1 as const;
  readonly rateLimit = { perMinute: 600 }; // 10/sec
  private readonly userAgent: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly tickerMapTtlMs: number;
  private tickerMap: Map<string, SecTickerRow> | null = null;
  private tickerMapFetchedAt = 0;

  constructor(opts: EdgarAdapterOptions = {}) {
    const ua = opts.userAgent ?? process.env.EDGAR_USER_AGENT;
    if (!ua || !ua.includes('@')) {
      throw new EdgarConfigError(
        'EDGAR_USER_AGENT must be set to a descriptive string with a contact email (e.g. "vantage you@example.com")',
      );
    }
    this.userAgent = ua;
    // 10/sec ≈ 600/min — set both to match SEC guidelines.
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 600 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tickerMapTtlMs = opts.tickerMapTtlMs ?? 24 * 3_600_000;
  }

  private headers(): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      Accept: 'application/json, application/atom+xml, text/xml',
      'Accept-Encoding': 'gzip, deflate',
    };
  }

  /** Load + cache the ticker->CIK master file. */
  async loadTickerMap(force = false): Promise<Map<string, SecTickerRow>> {
    const fresh = this.tickerMap && Date.now() - this.tickerMapFetchedAt < this.tickerMapTtlMs;
    if (fresh && !force && this.tickerMap) return this.tickerMap;

    await this.limiter.acquire();
    const res = await this.fetchImpl(TICKER_MAP_URL, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`edgar: company_tickers.json fetch failed (${res.status})`);
    }
    const raw = (await res.json()) as SecTickerMap;
    const map = new Map<string, SecTickerRow>();
    for (const row of Object.values(raw)) {
      map.set(row.ticker.toUpperCase(), row);
    }
    this.tickerMap = map;
    this.tickerMapFetchedAt = Date.now();
    return map;
  }

  /** Resolve a ticker to a 10-digit zero-padded CIK. Returns null if unknown. */
  async getCikForTicker(ticker: string): Promise<string | null> {
    const map = await this.loadTickerMap();
    const row = map.get(ticker.toUpperCase());
    if (!row) return null;
    return String(row.cik_str).padStart(10, '0');
  }

  /**
   * Poll the Atom feed for a given CIK + form type and parse to normalized
   * filing records. Returns empty array on soft failures.
   */
  async pollFilings(cik: string, formType: EdgarFormType, count = 40): Promise<EdgarFiling[]> {
    const url = new URL(BROWSE_BASE);
    url.searchParams.set('action', 'getcompany');
    url.searchParams.set('CIK', cik);
    url.searchParams.set('type', formType);
    url.searchParams.set('dateb', '');
    url.searchParams.set('owner', 'include');
    url.searchParams.set('count', String(count));
    url.searchParams.set('output', 'atom');

    await this.limiter.acquire();
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    } catch (err) {
      console.warn(`[edgar] network error for CIK ${cik}:`, err);
      return [];
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[edgar] soft failure ${res.status} for CIK ${cik}`);
      return [];
    }
    if (!res.ok) {
      console.warn(`[edgar] unexpected ${res.status} for CIK ${cik}`);
      return [];
    }
    const xml = await res.text();
    return parseAtomFeed(xml, cik, formType);
  }

  /** Poll by ticker (handles CIK lookup internally). */
  async pollByTicker(ticker: string, formType: EdgarFormType, count = 40): Promise<EdgarFiling[]> {
    const cik = await this.getCikForTicker(ticker);
    if (!cik) return [];
    const filings = await this.pollFilings(cik, formType, count);
    const map = await this.loadTickerMap();
    const row = map.get(ticker.toUpperCase());
    if (row) {
      for (const f of filings) {
        f.ticker = ticker.toUpperCase();
        if (!f.companyName) f.companyName = row.title;
      }
    }
    return filings;
  }

  /**
   * Phase 17 — fetch the human-readable text of a filing's index page.
   *
   * The 8-K classifier needs the body of the filing, not just the index URL
   * we record in `Article.url`. EDGAR's index page lists the primary
   * documents (typically a `.htm` or `.txt`); we fetch the index, locate
   * the first primary doc URL, then fetch that document and return its raw
   * HTML/text. Callers should strip tags + truncate before piping into the
   * LLM context.
   *
   * Returns null on soft failures (network, 404, HTML structure unknown).
   * The caller falls back to the headline + summary in that case.
   */
  async fetchFilingPrimaryText(indexUrl: string): Promise<string | null> {
    if (!indexUrl) return null;
    let indexHtml: string;
    try {
      await this.limiter.acquire();
      const res = await this.fetchImpl(indexUrl, { headers: this.headers() });
      if (!res.ok) {
        console.warn(`[edgar] index fetch failed ${res.status} for ${indexUrl}`);
        return null;
      }
      indexHtml = await res.text();
    } catch (err) {
      console.warn(`[edgar] index network error for ${indexUrl}:`, err);
      return null;
    }

    // Find the first link to a primary filing document (.htm / .txt) in the
    // documents table on the index page. The href is relative to the index
    // URL — resolve via URL constructor.
    const docHref = locatePrimaryDocHref(indexHtml);
    if (!docHref) {
      return null;
    }
    let docUrl: string;
    try {
      docUrl = new URL(docHref, indexUrl).toString();
    } catch {
      return null;
    }

    try {
      await this.limiter.acquire();
      const res = await this.fetchImpl(docUrl, { headers: this.headers() });
      if (!res.ok) {
        console.warn(`[edgar] primary doc fetch failed ${res.status} for ${docUrl}`);
        return null;
      }
      const body = await res.text();
      // Strip tags + collapse whitespace for the classifier window. We keep
      // the first 8k chars — 8-Ks are short documents (the body is usually
      // 1-3 pages) and the classifier's prompt is bounded anyway.
      const stripped = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      return stripped.slice(0, 8000);
    } catch (err) {
      console.warn(`[edgar] primary doc network error for ${docUrl}:`, err);
      return null;
    }
  }

  /** Convenience: the adapter's Article-shape output for the Article table. */
  filingsToArticles(filings: EdgarFiling[]): NormalizedArticle[] {
    return filings.map((f) => ({
      source: 'edgar',
      domain: 'sec.gov',
      url: f.url,
      headline: `${f.ticker} ${f.formType}: ${f.title}`,
      body: null,
      publishedAt: f.filedAt,
      tickers: [f.ticker],
    }));
  }

  /** Convenience: the adapter's Event-shape output for the MarketEvent table. */
  filingsToEvents(filings: EdgarFiling[]): NormalizedEvent[] {
    return filings.map((f) => ({
      kind: f.formType === '8-K' ? 'Filing8K' : 'BreakingNews',
      ticker: f.ticker,
      occurredAt: f.filedAt,
      payload: {
        formType: f.formType,
        companyName: f.companyName,
        url: f.url,
        accessionNumber: f.accessionNumber,
        cik: f.cik,
      },
    }));
  }
}

// --- Atom feed parsing (zero-dep). --------------------------------------------

/**
 * Pull <entry> blocks out of a browse-edgar atom feed and map them to our
 * EdgarFiling shape. We do light regex-based parsing rather than bolting on an
 * XML lib — SEC's atom output is stable and simple, and this keeps the adapter
 * dependency-free.
 */
function parseAtomFeed(xml: string, cik: string, defaultForm: string): EdgarFiling[] {
  const companyName = firstMatch(xml, /<title>[^<]*-\s*([^<]+?)\s*<\/title>/) ?? '';
  const entries = matchAllBlocks(xml, /<entry>([\s\S]*?)<\/entry>/g);
  const out: EdgarFiling[] = [];
  for (const entry of entries) {
    const titleRaw = firstMatch(entry, /<title>([\s\S]*?)<\/title>/) ?? '';
    const title = decodeEntities(stripTags(titleRaw)).trim();
    const updated = firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/) ?? '';
    const link = firstMatch(entry, /<link[^>]*href="([^"]+)"/) ?? '';
    const category = firstMatch(entry, /<category[^>]*term="([^"]+)"/) ?? defaultForm;
    const filedAt = updated ? new Date(updated) : new Date();
    const accession = firstMatch(entry, /Acc-no:\s*([0-9-]+)/) ?? null;
    if (!link) continue;
    out.push({
      cik,
      ticker: '',
      companyName,
      formType: category,
      filedAt,
      title,
      url: link,
      accessionNumber: accession,
    });
  }
  return out;
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m && m[1] !== undefined ? m[1] : null;
}

function matchAllBlocks(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  while ((m = r.exec(s)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Phase 17 helper — locate the first primary-document href on a filing
 * index page. EDGAR index pages render a "Document Format Files" table
 * whose first row is the primary filing document. We look for the first
 * `<a href="...">` whose URL ends in `.htm`, `.html`, or `.txt` and is NOT
 * the FilingSummary link. Fallback strategy is the first .htm link, period.
 */
function locatePrimaryDocHref(html: string): string | null {
  // Anchor in the documents table by looking for hrefs with the standard
  // EDGAR document path. SEC index hrefs are relative like
  // `/Archives/edgar/data/<cik>/<accession>/<doc>.htm` so a prefix match
  // is reliable.
  const re = /<a\s+[^>]*href="([^"]+\.(?:htm|html|txt))"/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] && !m[1].includes('FilingSummary')) {
      matches.push(m[1]);
    }
  }
  return matches[0] ?? null;
}

// --- XBRL company-facts (standalone) ------------------------------------------

const XBRL_FACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
const DEFAULT_FACTS_USER_AGENT = 'vantage/1.0 raghav@frameworth.com';
// Module-scoped limiter so standalone callers stay within SEC's 10/sec ceiling
// even when they don't go through an EdgarAdapter instance.
const factsLimiter = new RateLimiter({ perMinute: 600 });

export interface FactPoint {
  periodEnd: Date;
  periodType: 'Q' | 'FY';
  value: number;
  filedAt: Date;
  fiscalYear: number;
  fiscalPeriod: string;
}

export interface CompanyFactsResult {
  cik: number;
  entityName: string;
  facts: {
    revenue: FactPoint[];
    costOfRevenue: FactPoint[];
    grossProfit: FactPoint[];
    operatingIncome: FactPoint[];
    netIncome: FactPoint[];
    epsBasic: FactPoint[];
    epsDiluted: FactPoint[];
    totalAssets: FactPoint[];
    totalLiabilities: FactPoint[];
    longTermDebt: FactPoint[];
    shortTermDebt: FactPoint[];
    stockholdersEquity: FactPoint[];
    cash: FactPoint[];
    operatingCashFlow: FactPoint[];
    capex: FactPoint[];
    sharesOutstanding: FactPoint[];
  };
}

export interface TickerCikMap {
  [ticker: string]: number;
}

interface XbrlFactRaw {
  start?: string;
  end: string;
  val: number;
  filed: string;
  fp: string;
  fy: number;
  form: string;
}

interface XbrlConcept {
  units?: Record<string, XbrlFactRaw[]>;
}

interface XbrlCompanyFacts {
  cik: number;
  entityName: string;
  facts?: {
    'us-gaap'?: Record<string, XbrlConcept>;
  };
}

interface ConceptSpec {
  key: keyof CompanyFactsResult['facts'];
  concepts: string[];
  unit: 'USD' | 'shares' | 'USD/shares';
  signFlipIfNegative?: boolean;
}

const CONCEPT_MAP: ConceptSpec[] = [
  {
    key: 'revenue',
    unit: 'USD',
    concepts: [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'SalesRevenueNet',
    ],
  },
  {
    key: 'costOfRevenue',
    unit: 'USD',
    concepts: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  },
  { key: 'grossProfit', unit: 'USD', concepts: ['GrossProfit'] },
  { key: 'operatingIncome', unit: 'USD', concepts: ['OperatingIncomeLoss'] },
  { key: 'netIncome', unit: 'USD', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  { key: 'epsBasic', unit: 'USD/shares', concepts: ['EarningsPerShareBasic'] },
  { key: 'epsDiluted', unit: 'USD/shares', concepts: ['EarningsPerShareDiluted'] },
  { key: 'totalAssets', unit: 'USD', concepts: ['Assets'] },
  { key: 'totalLiabilities', unit: 'USD', concepts: ['Liabilities'] },
  { key: 'longTermDebt', unit: 'USD', concepts: ['LongTermDebtNoncurrent', 'LongTermDebt'] },
  {
    key: 'shortTermDebt',
    unit: 'USD',
    concepts: ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
  },
  { key: 'stockholdersEquity', unit: 'USD', concepts: ['StockholdersEquity'] },
  { key: 'cash', unit: 'USD', concepts: ['CashAndCashEquivalentsAtCarryingValue', 'Cash'] },
  {
    key: 'operatingCashFlow',
    unit: 'USD',
    concepts: ['NetCashProvidedByUsedInOperatingActivities'],
  },
  // SEC convention reports capex as a positive outflow; some filers post negatives — flip so downstream FCF math is consistent.
  {
    key: 'capex',
    unit: 'USD',
    concepts: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    signFlipIfNegative: true,
  },
  {
    key: 'sharesOutstanding',
    unit: 'shares',
    concepts: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'],
  },
];

function factsHeaders(): Record<string, string> {
  return {
    'User-Agent': process.env['EDGAR_USER_AGENT'] ?? DEFAULT_FACTS_USER_AGENT,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
}

function toFactPoint(raw: XbrlFactRaw, signFlipIfNegative: boolean): FactPoint | null {
  if (!raw.end || !raw.filed || !raw.fp || raw.val === undefined || raw.val === null) return null;
  const periodEnd = new Date(raw.end);
  const filedAt = new Date(raw.filed);
  if (Number.isNaN(periodEnd.getTime()) || Number.isNaN(filedAt.getTime())) return null;
  let value = Number(raw.val);
  if (!Number.isFinite(value)) return null;
  if (signFlipIfNegative && value < 0) value = -value;
  return {
    periodEnd,
    periodType: raw.fp === 'FY' ? 'FY' : 'Q',
    value,
    filedAt,
    fiscalYear: raw.fy,
    fiscalPeriod: raw.fp,
  };
}

// Amendments (10-Q/A, 10-K/A) republish the same period; keep only the most-recently-filed value per (periodEnd,periodType).
function dedupeByLatestFiling(points: FactPoint[]): FactPoint[] {
  const byKey = new Map<string, FactPoint>();
  for (const p of points) {
    const key = `${p.periodEnd.toISOString()}|${p.periodType}`;
    const prev = byKey.get(key);
    if (!prev || p.filedAt.getTime() > prev.filedAt.getTime()) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()].sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime());
}

function extractConcept(usGaap: Record<string, XbrlConcept>, spec: ConceptSpec): FactPoint[] {
  for (const conceptName of spec.concepts) {
    const concept = usGaap[conceptName];
    if (!concept || !concept.units) continue;
    const series = concept.units[spec.unit];
    if (!series || series.length === 0) continue;
    const points: FactPoint[] = [];
    for (const raw of series) {
      const fp = toFactPoint(raw, !!spec.signFlipIfNegative);
      if (fp) points.push(fp);
    }
    if (points.length > 0) return dedupeByLatestFiling(points);
  }
  return [];
}

export async function getCompanyFacts(
  cik: string | number,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CompanyFactsResult | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cikNum = typeof cik === 'string' ? Number(cik.replace(/^0+/, '') || '0') : cik;
  if (!Number.isFinite(cikNum) || cikNum <= 0) {
    throw new Error(`edgar: invalid CIK "${cik}"`);
  }
  const padded = String(cikNum).padStart(10, '0');
  const url = `${XBRL_FACTS_BASE}/CIK${padded}.json`;

  await factsLimiter.acquire();
  const res = await fetchImpl(url, { headers: factsHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`edgar: companyfacts fetch failed (${res.status}) for CIK ${padded}`);
  }
  const body = (await res.json()) as XbrlCompanyFacts;
  const usGaap = body.facts?.['us-gaap'];
  if (!usGaap) return null;

  const facts = {} as CompanyFactsResult['facts'];
  for (const spec of CONCEPT_MAP) {
    (facts[spec.key] as FactPoint[]) = extractConcept(usGaap, spec);
  }

  return {
    cik: body.cik ?? cikNum,
    entityName: body.entityName ?? '',
    facts,
  };
}

export async function getTickerCikMap(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TickerCikMap> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  await factsLimiter.acquire();
  const res = await fetchImpl(TICKER_MAP_URL, { headers: factsHeaders() });
  if (!res.ok) {
    throw new Error(`edgar: company_tickers.json fetch failed (${res.status})`);
  }
  const raw = (await res.json()) as Record<string, SecTickerRow>;
  const out: TickerCikMap = {};
  for (const row of Object.values(raw)) {
    if (row && row.ticker && typeof row.cik_str === 'number') {
      out[row.ticker.toUpperCase()] = row.cik_str;
    }
  }
  return out;
}
