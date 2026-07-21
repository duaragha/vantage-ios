/**
 * Source-tier classifier + satire blocklist.
 *
 * Tiering:
 *   tier 1 — wires & primary sources (Reuters, Bloomberg, AP, WSJ, FT, SEC)
 *   tier 2 — reputable general news & finance outlets
 *   tier 3 — social (Reddit, StockTwits), personal blogs, unknown
 *
 * Satire domains are always blocked regardless of tier (their content never
 * reaches the LLM, per spec).
 */

export const TIER_1_DOMAINS: readonly string[] = [
  'reuters.com',
  'bloomberg.com',
  'apnews.com',
  'ap.org',
  'wsj.com',
  'ft.com',
  'sec.gov',
];

export const TIER_2_DOMAINS: readonly string[] = [
  'cnbc.com',
  'marketwatch.com',
  'finance.yahoo.com',
  'yahoo.com',
  'seekingalpha.com',
  'barrons.com',
  'forbes.com',
  'businessinsider.com',
  'investopedia.com',
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk',
  'cnn.com',
  'theguardian.com',
  'economist.com',
  'axios.com',
  'thestreet.com',
  'fool.com',
  'benzinga.com',
  'investors.com',
  'zacks.com',
  'morningstar.com',
  'globeandmail.com',
  'financialpost.com',
  'theglobeandmail.com',
  'fortune.com',
  'bnnbloomberg.ca',
];

/**
 * Known satire/fake-news domains. Blocked before any article hits the LLM.
 * Extensible — push more here as they surface.
 */
export const SATIRE_DOMAINS: readonly string[] = [
  'babylonbee.com',
  'theonion.com',
  'clickhole.com',
  'reductress.com',
  'hard-drive.net',
  'thehardtimes.net',
  'newsthump.com',
  'thebeaverton.com',
  'waterfordwhispersnews.com',
  'theshovel.com.au',
  'dailymash.co.uk',
];

/** Social sources that are always tier-3 regardless of domain heuristics. */
const TIER_3_FORCE: readonly string[] = ['reddit.com', 'stocktwits.com', 'x.com', 'twitter.com'];

/**
 * Extract the base domain from a URL. Strips `www.` and any port/trailing-slash.
 * Returns null if the URL can't be parsed.
 */
export function extractDomain(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Match a URL's host against a list of base domains, honoring subdomains
 * (`finance.yahoo.com` matches `yahoo.com` entry) but never matching a
 * different TLD.
 */
function hostMatches(host: string, list: readonly string[]): boolean {
  for (const d of list) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

export interface ClassifyResult {
  tier: 1 | 2 | 3;
  domain: string | null;
  isSatire: boolean;
}

/**
 * Classify a URL. Unknown domains default to tier 3.
 * Satire domains return `{ isSatire: true }` and tier 3 (the content should be
 * blocked before the LLM sees it; tier is informational).
 */
export function classifyDomain(url: string): ClassifyResult {
  const domain = extractDomain(url);
  if (!domain) return { tier: 3, domain: null, isSatire: false };

  if (hostMatches(domain, SATIRE_DOMAINS)) {
    return { tier: 3, domain, isSatire: true };
  }

  // Social sources & force-tier-3 list take precedence over any generic domain
  // list matches (a LinkedIn re-post of Reuters is still tier 3 social).
  if (hostMatches(domain, TIER_3_FORCE)) {
    return { tier: 3, domain, isSatire: false };
  }

  if (hostMatches(domain, TIER_1_DOMAINS)) {
    return { tier: 1, domain, isSatire: false };
  }
  if (hostMatches(domain, TIER_2_DOMAINS)) {
    return { tier: 2, domain, isSatire: false };
  }

  return { tier: 3, domain, isSatire: false };
}

/** Convenience: just the satire check. */
export function isSatireDomain(url: string): boolean {
  const domain = extractDomain(url);
  if (!domain) return false;
  return hostMatches(domain, SATIRE_DOMAINS);
}
