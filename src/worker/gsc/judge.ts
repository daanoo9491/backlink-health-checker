/**
 * Search Console ("Route A") for your own sites: which property covers a URL,
 * and what Google's answer means. Pure functions.
 *
 * Google's own record is the only source allowed to say "Indexed" or
 * "Not indexed", and it wins over every signal our crawler saw.
 */
import type { IndexEvidence } from '../../shared/index-status';
import type { IndexResult } from '../indexing/evaluate';
import type { GscProperty, IndexStatusResult } from './client';

/**
 * The property that covers a URL, the most specific first:
 * URL-prefix properties must match scheme, host and path prefix;
 * a domain property covers the domain and every subdomain, http and https.
 */
export function propertyFor(url: string, properties: GscProperty[]): GscProperty | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let best: GscProperty | null = null;
  let bestScore = -1;
  for (const p of properties) {
    let score = -1;
    if (p.siteUrl.startsWith('sc-domain:')) {
      const domain = p.siteUrl.slice('sc-domain:'.length).toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) score = domain.length;
    } else {
      const prefix = p.siteUrl;
      try {
        const pu = new URL(prefix);
        const sameOrigin = pu.protocol === u.protocol && pu.host.toLowerCase() === u.host.toLowerCase();
        if (sameOrigin && u.pathname.startsWith(pu.pathname)) score = 1000 + prefix.length; // prefixes are more specific
      } catch {
        /* not a URL property */
      }
    }
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

const PLAIN: Record<string, string> = {
  // pageFetchState
  SUCCESSFUL: 'fetched successfully',
  SOFT_404: 'soft 404',
  BLOCKED_ROBOTS_TXT: 'blocked by robots.txt',
  NOT_FOUND: 'not found (404)',
  ACCESS_DENIED: 'access denied (401)',
  SERVER_ERROR: 'server error (5xx)',
  REDIRECT_ERROR: 'redirect error',
  ACCESS_FORBIDDEN: 'access forbidden (403)',
  BLOCKED_4XX: 'blocked (4xx)',
  INTERNAL_CRAWL_ERROR: 'Google crawl error',
  INVALID_URL: 'invalid URL',
  // indexingState
  INDEXING_ALLOWED: 'allowed',
  BLOCKED_BY_META_TAG: 'blocked by a noindex meta tag',
  BLOCKED_BY_HTTP_HEADER: 'blocked by a noindex X-Robots-Tag header',
  BLOCKED_BY_ROBOTS_TXT: 'blocked by robots.txt',
  // robotsTxtState
  ALLOWED: 'allows Google',
  DISALLOWED: 'blocks Google',
};
const plain = (v: string | undefined) => (v ? (PLAIN[v] ?? v.toLowerCase().replace(/_/g, ' ')) : null);

/** "2026-10-01" from Google's timestamp. */
const day = (iso: string | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? iso.slice(0, 10) : null);

/**
 * Google's verdict for the URL: PASS = on Google ("Valid"); FAIL and NEUTRAL =
 * not on Google ("Error"/"Excluded"), with coverageState saying why.
 * Anything else is no answer (null): the crawler's signals are used instead.
 */
export function judgeInspection(r: IndexStatusResult, property: string): IndexResult | null {
  const indexed = r.verdict === 'PASS' || r.verdict === 'PARTIAL';
  const notIndexed = r.verdict === 'FAIL' || r.verdict === 'NEUTRAL';
  if (!indexed && !notIndexed) return null;

  const coverage = r.coverageState?.trim() || (indexed ? 'Indexed' : 'Not indexed');
  const crawled = day(r.lastCrawlTime);
  const evidence: IndexEvidence[] = [{ signal: 'gsc', text: `Google Search Console: ${coverage}`, bad: notIndexed }];
  if (crawled) evidence.push({ signal: 'gsc', text: `Last crawled by Google: ${crawled}` });
  else evidence.push({ signal: 'gsc', text: 'Google hasn’t crawled it yet' });
  const fetch = plain(r.pageFetchState);
  if (fetch && r.pageFetchState !== 'SUCCESSFUL') {
    evidence.push({ signal: 'gsc', text: `Google’s fetch: ${fetch}`, bad: true });
  }
  const indexing = plain(r.indexingState);
  if (indexing && r.indexingState !== 'INDEXING_ALLOWED' && r.indexingState !== 'INDEXING_STATE_UNSPECIFIED') {
    evidence.push({ signal: 'gsc', text: `Indexing: ${indexing}`, bad: true });
  }
  if (r.robotsTxtState === 'DISALLOWED') evidence.push({ signal: 'gsc', text: 'robots.txt blocks Google', bad: true });
  if (r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical) {
    evidence.push({
      signal: 'gsc',
      text: `Google chose ${r.googleCanonical} as canonical (the page declares ${r.userCanonical})`,
      bad: true,
    });
  } else if (r.googleCanonical) {
    evidence.push({ signal: 'gsc', text: `Google’s canonical: ${r.googleCanonical}` });
  }
  evidence.push({ signal: 'gsc', text: `Checked in Search Console property ${property}` });

  return indexed
    ? {
        status: 'INDEXED',
        reason: `Google Search Console: ${coverage}${crawled ? ` (last crawled ${crawled})` : ''}`,
        evidence,
      }
    : { status: 'NOT_INDEXED', reason: `Google Search Console: ${coverage}`, evidence };
}
