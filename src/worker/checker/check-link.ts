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

export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;

// Honest identification, with a browser-like prefix because many sites
// reject requests that don't look like a browser at all.
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 BacklinkHealthChecker/1.0';

export interface CheckResult {
  status: LinkStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  redirected: boolean;
  responseTimeMs: number | null;
  reason: string;
  error: string | null;
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
  return fail('NETWORK_ERROR', 'Couldn’t look up the domain. Try again later');
}

export async function checkLink(originalUrl: string, deps: CheckDeps): Promise<CheckResult> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();
  let current: URL;
  try {
    current = new URL(originalUrl);
  } catch {
    return fail('NETWORK_ERROR', 'Not a valid web address');
  }
  current.hash = ''; // never sent to servers
  const startUrl = current.href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await guard(current, deps);
    if (blocked) return hop === 0 ? blocked : { ...blocked, finalUrl: current.href, redirected: true };

    if (!deps.budget.take()) throw new BudgetExhausted();
    let res: Response;
    try {
      res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      const extra = { finalUrl: current.href, redirected: hop > 0 };
      if (name === 'TimeoutError' || name === 'AbortError') {
        return fail('TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)} seconds`, extra);
      }
      return fail('NETWORK_ERROR', 'Couldn’t connect to the site (connection or security certificate problem)', {
        ...extra,
        error: String((e as Error)?.message ?? e).slice(0, 300),
      });
    }

    // We never need the page body in this phase; release the connection.
    const location = res.headers.get('Location');
    await res.body?.cancel().catch(() => undefined);

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      if (!location) {
        return fail('SERVER_ERROR', `HTTP ${res.status} redirect without a destination`, {
          httpStatus: res.status,
          finalUrl: current.href,
        });
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return fail('SERVER_ERROR', 'Redirects to an invalid address', { httpStatus: res.status });
      }
      next.hash = '';
      current = next;
      continue;
    }

    const { status, reason } = classifyResponse(res.status, startUrl, current.href);
    return {
      status,
      httpStatus: res.status,
      finalUrl: current.href,
      redirected: current.href !== startUrl,
      responseTimeMs: Date.now() - started,
      reason,
      error: null,
    };
  }
  return fail('SERVER_ERROR', `More than ${MAX_REDIRECTS} redirects (redirect loop)`, {
    finalUrl: current.href,
    redirected: true,
  });
}
