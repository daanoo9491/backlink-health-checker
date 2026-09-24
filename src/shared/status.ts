/**
 * Backlink check statuses. Machine values (stored in the database, used in
 * code) are kept separate from the friendly labels shown to Marketing users.
 */
export const LINK_STATUSES = [
  'ACTIVE',
  'DEAD',
  'SOFT_404',
  'REDIRECTED',
  'BLOCKED',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'PENDING',
  'CHECKING',
] as const;

export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Colour/icon group used by the UI. Every badge also shows text. */
export type StatusTone = 'active' | 'dead' | 'review' | 'redirected' | 'pending';

export interface StatusInfo {
  label: string;
  tone: StatusTone;
  description: string;
  /** Temporary problems can be retried; they are never treated as dead. */
  retryable: boolean;
}

export const STATUS_INFO: Record<LinkStatus, StatusInfo> = {
  ACTIVE: { label: 'Active', tone: 'active', description: 'The page loads normally.', retryable: false },
  DEAD: { label: 'Dead', tone: 'dead', description: 'The page is gone (404 or 410).', retryable: false },
  SOFT_404: {
    label: 'Soft 404',
    tone: 'dead',
    description: 'The page loads but says it no longer exists.',
    retryable: false,
  },
  REDIRECTED: {
    label: 'Redirected',
    tone: 'redirected',
    description: 'The page sends visitors to a different address.',
    retryable: false,
  },
  BLOCKED: {
    label: 'Blocked',
    tone: 'review',
    description: 'The site refused our check. Open it yourself to confirm.',
    retryable: true,
  },
  RATE_LIMITED: {
    label: 'Rate limited',
    tone: 'review',
    description: 'The site asked us to slow down. Retry later.',
    retryable: true,
  },
  SERVER_ERROR: {
    label: 'Server error',
    tone: 'review',
    description: 'The site had a problem on its side. Retry later.',
    retryable: true,
  },
  TIMEOUT: { label: 'Timed out', tone: 'review', description: 'The site took too long to respond.', retryable: true },
  NETWORK_ERROR: {
    label: 'Could not connect',
    tone: 'review',
    description: 'The address could not be reached (DNS or connection problem).',
    retryable: true,
  },
  PENDING: { label: 'Waiting', tone: 'pending', description: 'Not checked yet.', retryable: false },
  CHECKING: { label: 'Checking', tone: 'pending', description: 'Being checked right now.', retryable: false },
};
