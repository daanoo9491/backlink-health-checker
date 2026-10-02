/**
 * Checks one backlink page. Follows redirects by hand (max 5 hops) so that
 * EVERY hop is validated: http/https only, no credentials, no local names or
 * private IPs, and a DNS check before connecting.
 */
import type { LinkStatus } from '../../shared/status';
import { checkUrl, isInternalHost } from '../../shared/url';
import { BudgetExhausted, type SubrequestBudget } from './budget';
import { classifyResponse } from './classify';
import type { Resolver } from './dns';
import { extractFacts } from './page-facts';
import { readPage } from './page-reader';
import { judgePage } from './soft-404';
import type { PageSignals } from '../indexing/evaluate';

export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;

// Honest identification, with a browser-like prefix because many sites
// reject requests that don't look like a browser at all.
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 LinkLedgerSEO/1.0';

export interface CheckResult {
  status: LinkStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  redirected: boolean;
  responseTimeMs: number | null;
  reason: string;
  error: string | null;
  /** True when the failure may be temporary, so the check is worth repeating later. */
  retryable: boolean;
  /** Seconds the site asked us to wait (Retry-After on a 429/503), if any. */
  retryAfterSec?: number;
  /** The page's <title>, when it loaded as HTML. */
  pageTitle: string | null;
  /** Indexing signals (meta robots, canonical, headers) when the page loaded. */
  signals: PageSignals | null;
}

/** Reads a Retry-After header: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((t - now) / 1000));
}

export interface CheckDeps {
  resolver: Resolver;
  budget: SubrequestBudget;
  /** Hostnames we must never request (e.g. this app itself, to avoid loops). */
  blockedHosts: Set<string>;
  /** Development only: skip the DNS check (no DoH access). */
  skipDns?: boolean;
  timeoutMs?: number;
}

const fail = (status: LinkStatus, reason: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status,
  httpStatus: null,
  finalUrl: null,
  redirected: false,
  responseTimeMs: null,
  reason,
  error: reason,
  retryable: false,
  pageTitle: null,
  signals: null,
  ...extra,
});

/** Validates a URL before we connect to it. Returns a failure, or null if it's safe. */
async function guard(url: URL, deps: CheckDeps): Promise<CheckResult | null> {
  const verdict = checkUrl(url.href);
  if (!verdict.ok) {
    return fail('NETWORK_ERROR', 'Points to an address we don’t check (private, local or not http/https)');
  }
  const host = url.hostname.toLowerCase();
  if (isInternalHost(host) || deps.blockedHosts.has(host)) {
    return fail('NETWORK_ERROR', 'Points to an address we don’t check (private, local or not http/https)');
  }
  if (deps.skipDns) return null;
  const dns = await deps.resolver(host, deps.budget);
  if (dns.ok) return null;
  if (dns.reason === 'NOT_FOUND') return fail('NETWORK_ERROR', 'The domain doesn’t exist (it may have expired)');
  if (dns.reason === 'INTERNAL') {
    return fail('NETWORK_ERROR', 'Points to an address we don’t check (private, local or not http/https)');
  }
  return fail('NETWORK_ERROR', 'Couldn’t look up the domain. Try again later', { retryable: true });
}

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export type SafeFetch =
  | {
      kind: 'response';
      /** The final, non-redirect response. Its body is unread: read or cancel it. */
      res: Response;
      startUrl: string;
      finalUrl: string;
      /** Time to the final response's headers. */
      answeredMs: number;
    }
  | { kind: 'failed'; result: CheckResult };

/**
 * GET with every hop validated (see top of file), following up to
 * MAX_REDIRECTS redirects by hand. Shared by the link check and robots.txt.
 */
export async function safeFetch(url: string, deps: CheckDeps, accept = ACCEPT_HTML): Promise<SafeFetch> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { kind: 'failed', result: fail('NETWORK_ERROR', 'Not a valid web address') };
  }
  current.hash = ''; // never sent to servers
  const startUrl = current.href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await guard(current, deps);
    if (blocked) {
      return {
        kind: 'failed',
        result: hop === 0 ? blocked : { ...blocked, finalUrl: current.href, redirected: true },
      };
    }

    if (!deps.budget.take()) throw new BudgetExhausted();
    let res: Response;
    try {
      res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-GB,en;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      const extra = { finalUrl: current.href, redirected: hop > 0 };
      if (name === 'TimeoutError' || name === 'AbortError') {
        return {
          kind: 'failed',
          result: fail('TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)} seconds`, {
            ...extra,
            retryable: true,
          }),
        };
      }
      return {
        kind: 'failed',
        result: fail('NETWORK_ERROR', 'Couldn’t connect to the site (connection or security certificate problem)', {
          ...extra,
          error: String((e as Error)?.message ?? e).slice(0, 300),
          retryable: true,
        }),
      };
    }

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('Location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) {
        return {
          kind: 'failed',
          result: fail('SERVER_ERROR', `HTTP ${res.status} redirect without a destination`, {
            httpStatus: res.status,
            finalUrl: current.href,
          }),
        };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          kind: 'failed',
          result: fail('SERVER_ERROR', 'Redirects to an invalid address', { httpStatus: res.status }),
        };
      }
      next.hash = '';
      current = next;
      continue;
    }
    return { kind: 'response', res, startUrl, finalUrl: current.href, answeredMs: Date.now() - started };
  }
  return {
    kind: 'failed',
    result: fail('SERVER_ERROR', `More than ${MAX_REDIRECTS} redirects (redirect loop)`, {
      finalUrl: current.href,
      redirected: true,
    }),
  };
}

export async function checkLink(originalUrl: string, deps: CheckDeps): Promise<CheckResult> {
  const f = await safeFetch(originalUrl, deps);
  if (f.kind === 'failed') return f.result;
  const { res, startUrl, finalUrl } = f;

  const retryAfter = res.headers.get('Retry-After');
  const ok = res.status >= 200 && res.status < 300;
  // A page that loaded is read (size-capped) to spot soft 404s and read its
  // indexing signals; any other body is never needed, so it is released.
  const page = ok ? await readPage(res) : null;
  if (!ok) await res.body?.cancel().catch(() => undefined);

  const classified = classifyResponse(res.status, startUrl, finalUrl);
  const facts = page?.isHtml ? extractFacts(page.html) : null;
  // "200 OK" isn't the whole story: the page may say it's gone, or be a bot check.
  const verdict = ok ? judgePage(startUrl, finalUrl, facts) : null;
  const { status, reason } = verdict ?? classified;
  return {
    status,
    httpStatus: res.status,
    finalUrl,
    redirected: finalUrl !== startUrl,
    responseTimeMs: f.answeredMs,
    reason,
    error: null,
    pageTitle: facts?.title ?? null,
    signals: ok
      ? {
          robotsMeta: facts?.robotsMeta ?? [],
          canonicals: facts?.canonicals ?? [],
          xRobotsTag: res.headers.get('X-Robots-Tag'),
          linkHeader: res.headers.get('Link'),
          isHtml: page?.isHtml ?? false,
        }
      : null,
    // Rate limits and server errors are often temporary; everything else is a firm answer.
    retryable: status === 'RATE_LIMITED' || status === 'SERVER_ERROR' || status === 'TIMEOUT',
    ...(status === 'RATE_LIMITED' || status === 'SERVER_ERROR' ? { retryAfterSec: parseRetryAfter(retryAfter) } : {}),
  };
}
