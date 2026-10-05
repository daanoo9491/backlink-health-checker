/**
 * Runs INSIDE the Google tab (injected with chrome.scripting): reads the
 * result links and recognises CAPTCHA and cookie pages. Must stay
 * self-contained: no imports, no outside variables.
 */
export function readGooglePage(doc = document, loc = location) {
  if (/^consent\./.test(loc.hostname)) return { kind: 'consent', links: [], noResults: false };
  if (
    loc.pathname.startsWith('/sorry') ||
    doc.querySelector('form#captcha-form, #recaptcha, iframe[src*="recaptcha"], form[action*="/sorry/"]')
  ) {
    return { kind: 'captcha', links: [], noResults: false };
  }
  const links = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('#search a[href], #rso a[href], #botstuff a[href]')) {
    let href = a.getAttribute('href') || '';
    if (href.startsWith('/url?')) {
      try {
        href = new URL(href, 'https://www.google.com').searchParams.get('q') || '';
      } catch {
        href = '';
      }
    }
    if (!/^https?:\/\//i.test(href)) continue;
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (/(^|\.)google\.[a-z.]+$/i.test(host) || /googleusercontent\.com$|gstatic\.com$/i.test(host)) continue;
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
    if (links.length >= 60) break;
  }
  const text = doc.body ? doc.body.textContent || '' : '';
  const noResults = /did not match any documents|No results found for/i.test(text);
  const isResults = !!doc.querySelector('#search, #rso, #res, #topstuff, #botstuff');
  return { kind: isResults || noResults ? 'ok' : 'unknown', links, noResults };
}
