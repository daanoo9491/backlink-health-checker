/**
 * Index Checker results for other people's pages ("Route B": signals any
 * crawler can read). None of these claims anything about Google's index:
 * only Google Search Console can say "Indexed" or "Not indexed" (Phase 9),
 * so those words never appear here.
 */
import type { StatusTone } from './status';

export const INDEX_STATUSES = [
  'INDEXABLE',
  'NOINDEX',
  'ROBOTS_BLOCKED',
  'CANONICAL_ELSEWHERE',
  'NOT_REACHABLE',
  'UNKNOWN',
] as const;
export type IndexStatus = (typeof INDEX_STATUSES)[number];

export interface IndexStatusInfo {
  label: string;
  tone: StatusTone;
  /** What it means, in one sentence. */
  description: string;
  /** What to do about it (shown in "Issues to look at"). */
  advice: string;
}

export const INDEX_STATUS_INFO: Record<IndexStatus, IndexStatusInfo> = {
  INDEXABLE: {
    label: 'Indexable',
    tone: 'active',
    description: 'Nothing stops Google from indexing this page. This is not a confirmation that it is indexed.',
    advice: 'Nothing to fix.',
  },
  NOINDEX: {
    label: 'Blocked from indexing',
    tone: 'dead',
    description: 'The page asks search engines not to index it (noindex).',
    advice:
      'The page tells Google not to index it, so a backlink on it is likely worth little. Ask the site owner to remove the noindex, or replace the backlink.',
  },
  ROBOTS_BLOCKED: {
    label: 'Crawling blocked',
    tone: 'review',
    description: 'robots.txt stops Googlebot from reading this page. It may still be listed, without its content.',
    advice:
      'Google can’t read the page, so it can’t see your link on it. Ask the site owner to allow it in robots.txt.',
  },
  CANONICAL_ELSEWHERE: {
    label: 'Canonical points elsewhere',
    tone: 'redirected',
    description: 'The page asks Google to index a different address instead.',
    advice: 'Google is asked to index another page instead. Check that your link also appears on the canonical page.',
  },
  NOT_REACHABLE: {
    label: 'Page not reachable',
    tone: 'dead',
    description: 'The page is gone, sends visitors elsewhere, or its domain no longer works.',
    advice: 'A page that doesn’t load can’t be indexed. Fix or replace the backlink first.',
  },
  UNKNOWN: {
    label: 'Unknown',
    tone: 'pending',
    description:
      'We couldn’t finish the check (the site blocked us, timed out or failed). Never treated as a negative.',
    advice: 'Usually temporary. Check again later, or open the page yourself.',
  },
};

/** Sorting by index result, ascending: most urgent first. */
export const INDEX_SORT_ORDER: readonly IndexStatus[] = [
  'NOT_REACHABLE',
  'NOINDEX',
  'ROBOTS_BLOCKED',
  'CANONICAL_ELSEWHERE',
  'UNKNOWN',
  'INDEXABLE',
];

/** One line of evidence behind an index result. `bad` lines explain a problem. */
export interface IndexEvidence {
  signal: 'page' | 'robots' | 'meta' | 'header' | 'canonical';
  text: string;
  bad?: boolean;
}
