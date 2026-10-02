/**
 * Fetching robots.txt for a site, with the same SSRF protection as every
 * other request, and turning the answer into a verdict for one URL.
 *
 * How the answer is treated (Google's documented behaviour, except that a
 * failure is reported as "Unknown" rather than assumed):
 *   2xx           -> the file's rules apply
 *   4xx (not 429) -> no robots.txt: everything may be crawled
 *   too many redirects -> treated like 404, as Google does
 *   429, 5xx, timeouts, connection errors -> Unknown
 */
import { BudgetExhausted } from '../checker/budget';
import { safeFetch, type CheckDeps } from '../checker/check-link';
import { readText } from '../checker/page-reader';
import type { RobotsVerdict } from './evaluate';
import { googlebotMayCrawl, ROBOTS_MAX_BYTES } from './robots-txt';

export type RobotsFile =
  | { outcome: 'file'; httpStatus: number; body: string }
  | { outcome: 'no-file'; httpStatus: number | null }
  | { outcome: 'unknown'; why: string };

/** "https://example.com" or "https://example.com:8443": robots.txt is per scheme, host and port. */
export const originOf = (u: URL) => `${u.protocol}//${u.host}`;

export async function fetchRobots(origin: string, deps: CheckDeps): Promise<RobotsFile> {
  let f;
  try {
    f = await safeFetch(`${origin}/robots.txt`, deps, 'text/plain,*/*;q=0.5');
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    return { outcome: 'unknown', why: 'request failed' };
  }
  if (f.kind === 'failed') {
    if (/redirect loop/.test(f.result.reason)) return { outcome: 'no-file', httpStatus: null };
    return { outcome: 'unknown', why: f.result.reason.replace(/\. Try again later$/, '').toLowerCase() };
  }
  const { res } = f;
  if (res.status >= 200 && res.status < 300) {
    return { outcome: 'file', httpStatus: res.status, body: await readText(res, ROBOTS_MAX_BYTES) };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    return { outcome: 'no-file', httpStatus: res.status };
  }
  return { outcome: 'unknown', why: `HTTP ${res.status}` };
}

export function robotsVerdict(file: RobotsFile, url: URL): RobotsVerdict {
  if (file.outcome === 'unknown') return { kind: 'unknown', why: file.why };
  if (file.outcome === 'no-file') return { kind: 'no-file', httpStatus: file.httpStatus };
  const d = googlebotMayCrawl(file.body, url);
  return d.allowed ? { kind: 'allowed', rule: d.rule } : { kind: 'disallowed', rule: d.rule! };
}
