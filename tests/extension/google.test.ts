/**
 * The browser helper's logic: which search to run, how addresses are
 * compared, and what a Google results page means.
 */
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { comparable, judge, sameUrl, searchFor } from '../../extension/lib/google.js';
import { readGooglePage } from '../../extension/lib/page.js';

describe('the search to run', () => {
  it('site: with host and path for a plain address', () => {
    const s = searchFor('https://www.example.com/blog/my-post/#comments');
    expect(s.query).toBe('site:www.example.com/blog/my-post/');
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://www.google.com/search');
    expect(u.searchParams.get('q')).toBe('site:www.example.com/blog/my-post/');
    expect(u.searchParams.get('hl')).toBe('en');
    expect(u.searchParams.get('filter')).toBe('0');
  });

  it('a home page searches the whole host; an address with a query is quoted', () => {
    expect(searchFor('https://example.com/').query).toBe('site:example.com');
    expect(searchFor('https://example.com/p?id=7').query).toBe('"https://example.com/p?id=7"');
  });
});

describe('comparing addresses', () => {
  it('ignores http/https, www, case, a trailing slash and #fragments', () => {
    expect(sameUrl('http://www.Example.com/Blog/Post/', 'https://example.com/blog/post#top')).toBe(true);
    expect(sameUrl('https://example.com/caf%C3%A9', 'https://example.com/café')).toBe(true);
  });

  it('a different path, query or host is a different page', () => {
    expect(sameUrl('https://example.com/blog/post', 'https://example.com/blog/post-2')).toBe(false);
    expect(sameUrl('https://example.com/p?id=1', 'https://example.com/p?id=2')).toBe(false);
    expect(sameUrl('https://blog.example.com/p', 'https://example.com/p')).toBe(false);
    expect(comparable('not a url')).toBeNull();
    expect(sameUrl('not a url', 'not a url')).toBe(false);
  });
});

describe('what a results page means', () => {
  const T = 'https://example.com/blog/post';
  it('FOUND when the exact page is listed', () => {
    expect(
      judge(T, { kind: 'ok', links: ['https://other.com/x', 'https://www.example.com/blog/post/'], noResults: false }),
    ).toEqual({ outcome: 'FOUND', resultCount: 2, why: '' });
  });

  it('NOT_FOUND when Google answered without it', () => {
    expect(judge(T, { kind: 'ok', links: ['https://example.com/blog/post-2'], noResults: false })).toMatchObject({
      outcome: 'NOT_FOUND',
      resultCount: 1,
    });
    expect(judge(T, { kind: 'ok', links: [], noResults: true })).toMatchObject({
      outcome: 'NOT_FOUND',
      resultCount: 0,
    });
  });

  it('CAPTCHA and cookie pages pause the helper; anything else is an error to retry', () => {
    expect(judge(T, { kind: 'captcha', links: [] }).outcome).toBe('CAPTCHA');
    expect(judge(T, { kind: 'consent', links: [] }).outcome).toBe('CONSENT');
    expect(judge(T, { kind: 'offline', links: [] }).outcome).toBe('OFFLINE');
    expect(judge(T, { kind: 'unknown', links: [] }).outcome).toBe('ERROR');
    expect(judge(T, null).outcome).toBe('ERROR');
  });
});

describe('reading a Google page (inside the tab)', () => {
  const page = (html: string, url = 'https://www.google.com/search?q=x') => {
    const w = new Window({ url });
    w.document.write(html);
    return readGooglePage(w.document as never, w.location as never);
  };

  it('collects result links, unwrapping /url?q= and skipping Google’s own', () => {
    const r = page(`<html><body><div id="search"><div id="rso">
      <a href="https://www.example.com/blog/post/"><h3>Post</h3></a>
      <a href="/url?q=https://other.com/page&sa=U">Other</a>
      <a href="https://www.google.com/search?q=more">More</a>
      <a href="https://webcache.googleusercontent.com/x">Cached</a>
      <a href="#">x</a>
    </div></div></body></html>`);
    expect(r).toEqual({
      kind: 'ok',
      links: ['https://www.example.com/blog/post/', 'https://other.com/page'],
      noResults: false,
    });
    expect(judge('https://example.com/blog/post', r).outcome).toBe('FOUND');
  });

  it('recognises “no results”', () => {
    const r = page(
      `<html><body><div id="topstuff"><p>Your search - <b>site:example.com/x</b> - did not match any documents.</p></div></body></html>`,
    );
    expect(r).toMatchObject({ kind: 'ok', links: [], noResults: true });
    expect(judge('https://example.com/x', r).outcome).toBe('NOT_FOUND');
  });

  it('recognises the robot check and the cookie page', () => {
    expect(
      page('<html><body><form id="captcha-form"></form></body></html>', 'https://www.google.com/sorry/index?continue=x')
        .kind,
    ).toBe('captcha');
    expect(page('<html><body><form id="captcha-form"></form></body></html>').kind).toBe('captcha');
    expect(page('<html><body>Before you continue</body></html>', 'https://consent.google.com/ml?continue=x').kind).toBe(
      'consent',
    );
  });

  it('an unrecognised page is not taken as an answer', () => {
    const r = page('<html><body><p>Something else</p></body></html>');
    expect(r.kind).toBe('unknown');
    expect(judge('https://example.com/x', r).outcome).toBe('ERROR');
  });
});
