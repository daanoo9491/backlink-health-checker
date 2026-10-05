/**
 * Pure helpers for the Google check: the search to run for a backlink, how
 * to compare addresses, and what a results page means. No browser APIs here,
 * so the app's test suite can test them.
 */

/**
 * The search to run. A plain address uses `site:` with the host and path
 * (what SEO tools use to test whether one page is indexed); an address with
 * a query string is searched in quotes, because `site:` ignores queries.
 */
export function searchFor(target) {
  const u = new URL(target);
  u.hash = '';
  const query = u.search ? `"${u.href}"` : `site:${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en'); // English page, so "no results" can be recognised
  url.searchParams.set('num', '20');
  url.searchParams.set('filter', '0'); // don't fold similar results away
  url.searchParams.set('pws', '0'); // no personal results
  return { query, url: url.href };
}

/** One address in a form that ignores http/https, "www.", case, a trailing slash and #fragments. */
export function comparable(address) {
  let u;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    /* keep it encoded */
  }
  path = path.replace(/\/+$/, '') || '/';
  return `${u.host.toLowerCase().replace(/^www\./, '')}${path.toLowerCase()}${u.search}`;
}

export function sameUrl(a, b) {
  const x = comparable(a);
  return x !== null && x === comparable(b);
}

/**
 * What a results page means for the backlink:
 *   FOUND      Google listed this exact address
 *   NOT_FOUND  Google answered, and this address isn't among the results
 *   CAPTCHA    Google wants a human check: the helper pauses and asks you
 *   CONSENT    Google's cookie page: accept it once, then the helper goes on
 *   OFFLINE    Google couldn't be reached (no internet?): try again later, no harm done
 *   ERROR      the page couldn't be understood (tried again later)
 */
export function judge(target, page) {
  if (!page || typeof page !== 'object') return { outcome: 'ERROR', resultCount: 0, why: 'no page' };
  if (page.kind === 'captcha') return { outcome: 'CAPTCHA', resultCount: 0, why: 'Google asked for a human check' };
  if (page.kind === 'consent') return { outcome: 'CONSENT', resultCount: 0, why: 'Google’s cookie page' };
  if (page.kind === 'offline') return { outcome: 'OFFLINE', resultCount: 0, why: 'Google couldn’t be reached' };
  if (page.kind !== 'ok') return { outcome: 'ERROR', resultCount: 0, why: 'results page not recognised' };
  const links = Array.isArray(page.links) ? page.links : [];
  if (links.some((l) => sameUrl(l, target))) return { outcome: 'FOUND', resultCount: links.length, why: '' };
  return { outcome: 'NOT_FOUND', resultCount: page.noResults ? 0 : links.length, why: '' };
}
