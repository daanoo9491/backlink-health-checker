/**
 * Issue categories for Link Health: every result that isn't "Active" falls in
 * exactly one, each with plain advice on what to do. Also the order used when
 * sorting by status (most urgent first).
 */
import type { LinkStatus } from './status';
import type { StatusTone } from './status';

export const ISSUE_CATEGORY_KEYS = ['dead', 'unreachable', 'site_error', 'refused', 'redirected'] as const;
export type IssueCategoryKey = (typeof ISSUE_CATEGORY_KEYS)[number];

export interface IssueCategory {
  key: IssueCategoryKey;
  label: string;
  statuses: readonly LinkStatus[];
  tone: StatusTone;
  /** What it means and what to do, in one or two sentences. */
  advice: string;
}

export const ISSUE_CATEGORIES: readonly IssueCategory[] = [
  {
    key: 'dead',
    label: 'Page gone',
    statuses: ['DEAD', 'SOFT_404'],
    tone: 'dead',
    advice: 'The page was removed. Ask the site owner to restore it, or replace the backlink.',
  },
  {
    key: 'unreachable',
    label: 'Can’t be reached',
    statuses: ['NETWORK_ERROR'],
    tone: 'review',
    advice:
      'The domain may have expired, or its security certificate is broken. Open it yourself; if it fails for you too, treat the link as lost.',
  },
  {
    key: 'site_error',
    label: 'Site errors',
    statuses: ['SERVER_ERROR', 'TIMEOUT'],
    tone: 'review',
    advice: 'The site had a problem or was too slow. We already retried; it is often fixed within a day or two.',
  },
  {
    key: 'refused',
    label: 'Site refused our check',
    statuses: ['BLOCKED', 'RATE_LIMITED'],
    tone: 'review',
    advice: 'Many sites block automated checks but work fine for visitors. Open the page in your browser to confirm.',
  },
  {
    key: 'redirected',
    label: 'Redirected',
    statuses: ['REDIRECTED'],
    tone: 'redirected',
    advice: 'The page now lives at another address. Check that your link is still on the new page.',
  },
];

/** Problems that need a person to look (everything except gone and redirected). */
export const REVIEW_STATUSES: readonly LinkStatus[] = [
  'BLOCKED',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
];

/** Sorting by status, ascending: most urgent first; not-yet-checked last. */
export const STATUS_SORT_ORDER: readonly LinkStatus[] = [
  'DEAD',
  'SOFT_404',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  'BLOCKED',
  'RATE_LIMITED',
  'REDIRECTED',
  'ACTIVE',
  'CHECKING',
  'PENDING',
];
