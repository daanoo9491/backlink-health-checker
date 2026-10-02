/**
 * Turns everything we saw about a page into one Index Checker result, with
 * the evidence behind it. Pure and fully tested.
 *
 * Rules (from the product plan):
 *  - this route never says "Not indexed": only Search Console can (Phase 9);
 *  - every result carries its evidence;
 *  - conflicting signals are all shown, never averaged;
 *  - a failed check is "Unknown", never a negative.
 */
import type { IndexEvidence, IndexStatus } from '../../shared/index-status';
import type { LinkStatus } from '../../shared/status';
import type { RobotsRule } from './robots-txt';
import { headerNoindex, judgeCanonical, linkHeaderCanonicals, metaNoindex, type MetaTag } from './signals';

export type RobotsVerdict =
  | { kind: 'allowed'; rule: RobotsRule | null }
  | { kind: 'no-file'; httpStatus: number | null }
  | { kind: 'disallowed'; rule: RobotsRule }
  | { kind: 'unknown'; why: string };

export interface PageSignals {
  robotsMeta: MetaTag[];
  /** <link rel="canonical"> values from <head>, as written. */
  canonicals: string[];
  xRobotsTag: string | null;
  linkHeader: string | null;
  /** False for PDFs and other files: only headers apply to them. */
  isHtml: boolean;
}

export interface IndexInputs {
  link: {
    status: LinkStatus;
    reason: string;
    retryable: boolean;
    httpStatus: number | null;
    finalUrl: string | null;
  };
  page: PageSignals | null;
  /** Not needed when the page itself didn't load. */
  robots: RobotsVerdict | null;
}

export interface IndexResult {
  status: IndexStatus;
  reason: string;
  evidence: IndexEvidence[];
}

const quote = (s: string) => `“${s.length > 100 ? `${s.slice(0, 99)}…` : s}”`;

export function evaluateIndex({ link, page, robots }: IndexInputs): IndexResult {
  // 1. The page has to load before anything else matters.
  if (link.status === 'DEAD' || link.status === 'SOFT_404') {
    return {
      status: 'NOT_REACHABLE',
      reason: link.reason,
      evidence: [{ signal: 'page', text: `Page gone: ${link.reason}`, bad: true }],
    };
  }
  if (link.status === 'REDIRECTED') {
    const to = link.finalUrl ?? 'another address';
    return {
      status: 'NOT_REACHABLE',
      reason: `Redirects to ${to}. Google indexes the destination, not this address`,
      evidence: [{ signal: 'page', text: `Redirects to ${to}`, bad: true }],
    };
  }
  if (link.status === 'NETWORK_ERROR' && !link.retryable) {
    return {
      status: 'NOT_REACHABLE',
      reason: link.reason,
      evidence: [{ signal: 'page', text: link.reason, bad: true }],
    };
  }
  if (link.status !== 'ACTIVE' || !page || !link.finalUrl) {
    return {
      status: 'UNKNOWN',
      reason: `Couldn’t load the page (${link.reason})`,
      evidence: [{ signal: 'page', text: `Couldn’t load the page: ${link.reason}` }],
    };
  }

  // 2. Read every signal; all of them go into the evidence.
  const evidence: IndexEvidence[] = [
    { signal: 'page', text: `Page loads${link.httpStatus ? ` (HTTP ${link.httpStatus})` : ''}` },
  ];

  const blockedByRobots = robots?.kind === 'disallowed';
  if (!robots || robots.kind === 'unknown') {
    evidence.push({ signal: 'robots', text: `Couldn’t read robots.txt${robots ? ` (${robots.why})` : ''}` });
  } else if (robots.kind === 'disallowed') {
    evidence.push({ signal: 'robots', text: `robots.txt blocks Googlebot (${robots.rule.line})`, bad: true });
  } else if (robots.kind === 'no-file') {
    evidence.push({ signal: 'robots', text: 'No robots.txt, so everything may be crawled' });
  } else {
    evidence.push({
      signal: 'robots',
      text: robots.rule ? `robots.txt allows Googlebot (${robots.rule.line})` : 'robots.txt allows Googlebot',
    });
  }

  const meta = page.isHtml ? metaNoindex(page.robotsMeta) : null;
  if (meta) {
    evidence.push({ signal: 'meta', text: `Meta ${meta.name} tag: ${quote(meta.content)}`, bad: true });
  } else if (page.isHtml && page.robotsMeta.length) {
    evidence.push({
      signal: 'meta',
      text: `Meta ${page.robotsMeta[0]!.name} tag: ${quote(page.robotsMeta[0]!.content)}`,
    });
  }
  const header = headerNoindex(page.xRobotsTag);
  if (page.xRobotsTag) {
    evidence.push({ signal: 'header', text: `X-Robots-Tag header: ${quote(page.xRobotsTag)}`, bad: header });
  }
  if (!meta && !header) evidence.push({ signal: 'meta', text: 'No noindex tag or header' });

  const declared = [...(page.isHtml ? page.canonicals : []), ...linkHeaderCanonicals(page.linkHeader)];
  const canonical = judgeCanonical(link.finalUrl, declared);
  if (canonical.kind === 'none') {
    evidence.push({ signal: 'canonical', text: 'No canonical: Google chooses one itself' });
  } else if (canonical.kind === 'self') {
    evidence.push({ signal: 'canonical', text: 'Canonical: this page' });
  } else if (canonical.kind === 'elsewhere') {
    evidence.push({ signal: 'canonical', text: `Canonical: ${canonical.url}`, bad: true });
  } else {
    evidence.push({
      signal: 'canonical',
      text: `Several different canonicals (${canonical.urls.join(', ')}); Google ignores them`,
    });
  }

  // 3. The strongest problem names the result; the evidence keeps the rest.
  if (blockedByRobots) {
    if (meta || header) {
      evidence.push({
        signal: 'robots',
        text: 'Google can’t see the noindex while robots.txt blocks crawling',
      });
    }
    return {
      status: 'ROBOTS_BLOCKED',
      reason: `robots.txt blocks Googlebot (${robots.rule.line})`,
      evidence,
    };
  }
  if (meta || header) {
    const where = [meta && `the meta ${meta.name} tag`, header && 'the X-Robots-Tag header'].filter(Boolean);
    return { status: 'NOINDEX', reason: `noindex in ${where.join(' and ')}`, evidence };
  }
  if (!robots || robots.kind === 'unknown') {
    return {
      status: 'UNKNOWN',
      reason: `Couldn’t read robots.txt${robots ? ` (${robots.why})` : ''}, so we can’t confirm Google may crawl it`,
      evidence,
    };
  }
  if (canonical.kind === 'elsewhere') {
    return { status: 'CANONICAL_ELSEWHERE', reason: `Canonical points to ${canonical.url}`, evidence };
  }
  return {
    status: 'INDEXABLE',
    reason: 'Loads, no noindex, and robots.txt lets Googlebot crawl it',
    evidence,
  };
}
