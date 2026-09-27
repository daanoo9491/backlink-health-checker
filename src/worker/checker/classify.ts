/**
 * Turns an HTTP outcome into a link status. Pure and fully unit-tested.
 * Principle: only 404/410 mean "Dead". Anything temporary or ambiguous is a
 * "needs a look" status that can be retried, never Dead.
 */
import type { LinkStatus } from '../../shared/status';

export interface Classification {
  status: LinkStatus;
  reason: string;
}

const REASON_PHRASE: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const code = (n: number) => `HTTP ${n}${REASON_PHRASE[n] ? ` ${REASON_PHRASE[n]}` : ''}`;

/**
 * A redirect that lands on the same page: http→https, adding/removing
 * "www.", or adding/removing a trailing slash. Treated as Active.
 */
export function isSamePageRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
    const path = (p: string) => p.replace(/\/+$/, '') || '/';
    return host(a.hostname) === host(b.hostname) && path(a.pathname) === path(b.pathname) && a.search === b.search;
  } catch {
    return false;
  }
}

export function classifyResponse(httpStatus: number, originalUrl: string, finalUrl: string): Classification {
  const redirected = finalUrl !== originalUrl;

  if (httpStatus >= 200 && httpStatus < 300) {
    if (!redirected) return { status: 'ACTIVE', reason: code(httpStatus).replace(/^HTTP 200$/, 'HTTP 200 OK') };
    if (isSamePageRedirect(originalUrl, finalUrl)) {
      return { status: 'ACTIVE', reason: 'Loads fine after a small address change (https, www or trailing slash)' };
    }
    return { status: 'REDIRECTED', reason: 'Sends visitors to a different page' };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return {
      status: 'DEAD',
      reason: redirected ? `Redirects to a missing page (${code(httpStatus)})` : code(httpStatus),
    };
  }
  if (httpStatus === 429) return { status: 'RATE_LIMITED', reason: code(429) };
  if (httpStatus >= 500) return { status: 'SERVER_ERROR', reason: code(httpStatus) };
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 451) {
    return { status: 'BLOCKED', reason: code(httpStatus) };
  }
  if (httpStatus === 408) return { status: 'TIMEOUT', reason: code(408) };
  if (httpStatus >= 400) {
    // 400/405/406 etc.: usually bot filtering, not proof the page is gone.
    return { status: 'BLOCKED', reason: `${code(httpStatus)}: the site rejected our check` };
  }
  return { status: 'SERVER_ERROR', reason: `Unexpected response (HTTP ${httpStatus})` };
}
