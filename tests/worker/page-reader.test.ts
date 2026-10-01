import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubrequestBudget } from '../../src/worker/checker/budget';
import { checkLink, type CheckDeps } from '../../src/worker/checker/check-link';
import { createResolver } from '../../src/worker/checker/dns';
import { isHtmlType, readPage } from '../../src/worker/checker/page-reader';
import { fakeInternet } from './fake-net';

afterEach(() => vi.unstubAllGlobals());

const html = (body: string, type = 'text/html; charset=utf-8') =>
  new Response(body, { headers: { 'Content-Type': type } });

/** A response whose body streams the given chunks, then optionally fails. */
function streamed(chunks: Uint8Array[], opts: { fail?: boolean; type?: string } = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled < chunks.length) c.enqueue(chunks[pulled++]!);
      else if (opts.fail) c.error(new TypeError('Network connection lost.'));
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = new Response(body, { headers: { 'Content-Type': opts.type ?? 'text/html' } });
  return { res, wasCancelled: () => cancelled, pulled: () => pulled };
}

describe('readPage', () => {
  it('reads an HTML page', async () => {
    const r = await readPage(html('<html><title>Hi</title></html>'));
    expect(r).toMatchObject({ isHtml: true, html: '<html><title>Hi</title></html>', truncated: false });
  });

  it('stops at the size cap and cancels the rest of the download', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const s = streamed(Array.from({ length: 100 }, () => chunk)); // 6.4 MB on offer
    const r = await readPage(s.res, 256 * 1024);
    expect(r.bytes).toBe(256 * 1024);
    expect(r.truncated).toBe(true);
    expect(s.pulled()).toBeLessThan(10);
    expect(s.wasCancelled()).toBe(true);
  });

  it('a page exactly at the cap is not marked truncated', async () => {
    const s = streamed([new Uint8Array(1024).fill(0x61)]);
    const r = await readPage(s.res, 1024);
    expect(r).toMatchObject({ bytes: 1024, truncated: false });
  });

  it('keeps what arrived when the connection drops half-way', async () => {
    const s = streamed([new TextEncoder().encode('<html><title>Partial</title>')], { fail: true });
    const r = await readPage(s.res);
    expect(r.html).toBe('<html><title>Partial</title>');
  });

  it('skips non-HTML responses without downloading them', async () => {
    const s = streamed([new Uint8Array(10)], { type: 'application/pdf' });
    const r = await readPage(s.res);
    expect(r).toMatchObject({ isHtml: false, html: '' });
    expect(s.pulled()).toBe(0);
  });

  it('decodes the charset from the header or a <meta> tag', async () => {
    const latin1 = new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9]); // "<p>café" in ISO-8859-1
    expect((await readPage(html(latin1 as unknown as string, 'text/html; charset=iso-8859-1'))).html).toBe('<p>café');
    const meta = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1252"><p>'),
      0x93,
      0x68,
      0x69,
      0x94,
    ]);
    expect((await readPage(html(meta as unknown as string, 'text/html'))).html).toContain('“hi”');
    // An unknown charset falls back to UTF-8 instead of failing.
    expect((await readPage(html('<p>ok</p>', 'text/html; charset=klingon'))).html).toBe('<p>ok</p>');
  });

  it('with no Content-Type, only treats real HTML as a page', async () => {
    const noType = (body: string) => {
      const r = new Response(body);
      r.headers.delete('Content-Type');
      return r;
    };
    expect((await readPage(noType('<!DOCTYPE html><title>x</title>'))).isHtml).toBe(true);
    expect((await readPage(noType('%PDF-1.7 binary'))).isHtml).toBe(false);
  });

  it('recognises HTML content types', () => {
    expect(isHtmlType('text/html; charset=UTF-8')).toBe(true);
    expect(isHtmlType('application/xhtml+xml')).toBe(true);
    expect(isHtmlType('application/json')).toBe(false);
    expect(isHtmlType('image/png')).toBe(false);
  });
});

const PUBLIC = ['93.184.216.34'];
const deps = (): CheckDeps => ({
  resolver: createResolver(),
  budget: new SubrequestBudget(45),
  blockedHosts: new Set(),
  timeoutMs: 500,
});

describe('checkLink reads the page', () => {
  it('records the page title of a working page', async () => {
    fakeInternet(
      { 'ok.example.com': PUBLIC },
      { 'https://ok.example.com/post': { status: 200, html: '<title>Ten SEO tips</title><body><h1>Tips</h1></body>' } },
    );
    expect(await checkLink('https://ok.example.com/post', deps())).toMatchObject({
      status: 'ACTIVE',
      pageTitle: 'Ten SEO tips',
      reason: 'HTTP 200 OK',
    });
  });

  it('reports a soft 404, keeping the real HTTP code', async () => {
    fakeInternet(
      { 's.example.com': PUBLIC },
      { 'https://s.example.com/post': { status: 200, html: '<title>Page not found – Blog</title><body></body>' } },
    );
    expect(await checkLink('https://s.example.com/post', deps())).toMatchObject({
      status: 'SOFT_404',
      httpStatus: 200,
      reason: 'The page loads, but its title says “Page not found – Blog”',
      retryable: false,
    });
  });

  it('a removed page that redirects to the home page', async () => {
    fakeInternet(
      { 'r.example.com': PUBLIC },
      {
        'https://r.example.com/guest-post': { status: 301, location: '/' },
        'https://r.example.com/': { status: 200, html: '<title>Welcome</title><body><h1>Home</h1></body>' },
      },
    );
    const r = await checkLink('https://r.example.com/guest-post', deps());
    expect(r).toMatchObject({ status: 'SOFT_404', redirected: true, finalUrl: 'https://r.example.com/' });
    expect(r.reason).toMatch(/home page/);
  });

  it('a bot check is Blocked', async () => {
    fakeInternet(
      { 'b.example.com': PUBLIC },
      { 'https://b.example.com/': { status: 200, html: '<title>Just a moment...</title><body></body>' } },
    );
    expect((await checkLink('https://b.example.com/', deps())).status).toBe('BLOCKED');
  });

  it('error pages are not read (their body is never needed)', async () => {
    fakeInternet(
      { 'e.example.com': PUBLIC },
      { 'https://e.example.com/x': { status: 404, html: '<title>Lovely page</title>' } },
    );
    expect(await checkLink('https://e.example.com/x', deps())).toMatchObject({ status: 'DEAD', pageTitle: null });
  });

  it('non-HTML files (PDFs, images) stay Active', async () => {
    fakeInternet(
      { 'f.example.com': PUBLIC },
      {
        'https://f.example.com/guide.pdf': {
          status: 200,
          html: '%PDF-1.7 Page not found',
          contentType: 'application/pdf',
        },
      },
    );
    expect(await checkLink('https://f.example.com/guide.pdf', deps())).toMatchObject({
      status: 'ACTIVE',
      pageTitle: null,
    });
  });
});
