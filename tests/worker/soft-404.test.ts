/**
 * Soft-404 detection against a test set of genuine pages and error pages.
 * The genuine set matters most: a working backlink must never be reported as
 * gone. Pages are modelled on common templates (WordPress, Blogger, Shopify,
 * Squarespace, Wix, Ghost, Medium, Apache/nginx) and on genuine articles that
 * talk about 404 errors.
 */
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../../src/worker/checker/page-facts';
import { isNotFoundLabel, judgeContent, judgePage, judgeRedirect } from '../../src/worker/checker/soft-404';

const NAV = `<header><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/blog">Blog</a>
  <a href="/about">About us</a> <a href="/contact">Contact</a></nav></header>`;
const FOOTER = `<footer><p>© 2026 Example Ltd. All rights reserved.</p><a href="/privacy">Privacy</a></footer>`;
const LONG = Array.from(
  { length: 40 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. Search engines follow links between pages, and every link that still works passes on trust and visitors. Keeping a record of where your links live helps you notice when something changes.</p>`,
).join('\n');

function page(o: { title?: string; h1?: string; body?: string; head?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  ${o.title !== undefined ? `<title>${o.title}</title>` : ''}
  <script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}</script>
  <style>.x{color:red}</style>${o.head ?? ''}</head>
  <body>${NAV}<main>${o.h1 !== undefined ? `<h1>${o.h1}</h1>` : ''}${o.body ?? ''}</main>${FOOTER}</body></html>`;
}

const verdict = (html: string, url = 'https://site.example.com/blog/post', final = url) =>
  judgePage(url, final, extractFacts(html));

describe('genuine pages are never flagged', () => {
  const genuine: [string, string][] = [
    [
      'article about fixing 404 errors',
      page({
        title: 'How to Fix a 404 Page Not Found Error (5 Easy Ways) – Kinsta',
        h1: 'How to Fix a 404 Page Not Found Error',
        body: `<p>Seeing "page not found"? The page you are looking for could not be found is a common message.</p>${LONG}`,
      }),
    ],
    [
      'explainer with Error 404 in the title',
      page({ title: 'Error 404: What It Means and How to Fix It | SEO Blog', h1: 'Error 404 explained', body: LONG }),
    ],
    [
      'design roundup',
      page({ title: 'Top 25 Creative 404 Page Designs | Design Weekly', h1: '25 404 pages', body: LONG }),
    ],
    ['news with 404 in a headline', page({ title: '404 Days Later: Bridge Reopens | City News', body: LONG })],
    [
      'lost and found office',
      page({
        title: 'Lost and Found – City Council',
        h1: 'Lost and found',
        body: '<p>Report a lost item or collect something you left behind.</p>',
      }),
    ],
    [
      'short contact page',
      page({
        title: 'Contact us – LANOP Business & Tax Advisors',
        h1: 'Contact us',
        body: '<p>Call 020 0000 0000 or email info@example.com. Open Monday to Friday, 9am to 5pm.</p>',
      }),
    ],
    [
      'short help page that mentions the phrase',
      page({
        title: 'Help – Example',
        h1: 'Help',
        body: '<p>Seeing a "page not found" or "error 404" message? Nothing found in search? Contact support and we will help.</p>',
      }),
    ],
    [
      'app shell rendered by JavaScript',
      `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div>
       <script>const NOT_FOUND = "Page not found"; const t = "The page you are looking for could not be found";</script></body></html>`,
    ],
    [
      'hidden template and comments',
      page({
        title: 'Pricing – Example',
        h1: 'Pricing',
        body: '<!-- 404 page not found --><template><h1>Page not found</h1></template><noscript>This page does not exist without JS</noscript><p>Plans from £10.</p>',
      }),
    ],
    [
      'inline SVG with a "not found" title in the body',
      page({
        title: 'Our services – Example',
        h1: 'Our services',
        body: '<svg><title>Not found</title><path d="M0 0"/></svg><p>Accounts, tax and payroll.</p>',
      }),
    ],
    ['search results', page({ title: 'Search results for “seo” – Blog', h1: 'Search results', body: LONG })],
    [
      'thank-you page',
      page({ title: 'Thanks for subscribing', h1: 'You’re in!', body: '<p>Check your inbox to confirm.</p>' }),
    ],
    ['page without a title or heading', page({ body: LONG })],
    [
      'a book about found things',
      page({ title: 'Found: The Lost City | Books', h1: 'Found: The Lost City', body: LONG }),
    ],
    [
      'long page that mentions "this page doesn’t exist" in passing',
      page({
        title: 'Redirects explained – Guide',
        h1: 'Redirects explained',
        body: `<p>If this page doesn't exist any more, set up a 301 redirect.</p>${LONG}`,
      }),
    ],
  ];
  for (const [name, html] of genuine) {
    it(name, () => expect(verdict(html)).toBeNull());
  }

  it('redirects that keep the same page, or start from a home page', () => {
    expect(judgeRedirect('http://site.example.com/post', 'https://www.site.example.com/post/')).toBeNull();
    expect(judgeRedirect('https://site.example.com/old-post', 'https://site.example.com/new-post')).toBeNull();
    expect(judgeRedirect('https://site.example.com/', 'https://site.example.com/en/')).toBeNull();
    expect(judgeRedirect('https://site.example.com/en', 'https://site.example.com/')).toBeNull();
    expect(judgeRedirect('https://site.example.com/?ref=x', 'https://site.example.com/')).toBeNull();
    expect(judgeRedirect('https://site.example.com/blog/a', 'https://site.example.com/ai/')).toBeNull(); // not a language
  });
});

describe('soft 404s are found, with a reason', () => {
  const gone: [string, string, RegExp][] = [
    [
      'WordPress',
      page({ title: 'Page not found – My Blog', h1: 'Oops! That page can’t be found.' }),
      /title says “Page not found – My Blog”/,
    ],
    ['Shopify', page({ title: '404 Not Found – Acme Store', h1: 'Page not found' }), /title/],
    [
      'Squarespace',
      page({ title: 'Page Not Found — Studio Nine', body: '<p>We couldn’t find the page.</p>' }),
      /title/,
    ],
    ['Ghost', page({ title: '404 — Page not found', h1: '404' }), /title/],
    ['nginx-style', page({ title: '404 Not Found', h1: '404 Not Found' }), /title/],
    ['Error 404 title', page({ title: 'Error 404 | Example', body: LONG }), /title/],
    [
      'Medium-style heading',
      page({ title: 'Medium', h1: '404', body: '<p>Out of nothing, something.</p>' }),
      /heading says “404”/,
    ],
    ['Wix-style heading', page({ title: 'Example Studio', h1: 'This page isn’t available.' }), /heading/],
    ['German', page({ title: 'Seite nicht gefunden | Firma GmbH' }), /title/],
    ['French heading', page({ title: 'Boutique', h1: 'Page introuvable' }), /heading/],
    ['Spanish', page({ title: 'Página no encontrada - Tienda' }), /title/],
    [
      'Blogger',
      page({
        title: 'Travel Notes',
        body: '<p>Sorry, the page you were looking for in this blog does not exist.</p><a href="/">Home</a>',
      }),
      /says “page you were looking for in this blog does not exist”/,
    ],
    [
      'plain message',
      page({
        title: 'Acme Corp',
        body: '<p>We’re sorry, the page you requested could not be found. Go back home.</p>',
      }),
      /says/,
    ],
    [
      'Apache-style message',
      page({ title: 'Acme', body: '<p>The requested URL /blog/post was not found on this server.</p>' }),
      /says/,
    ],
    [
      'entities in the title',
      page({ title: 'Page Not Found &#8211; Example', h1: 'Oops!' }),
      /Page Not Found – Example/,
    ],
  ];
  for (const [name, html, reason] of gone) {
    it(name, () => {
      const v = verdict(html);
      expect(v?.status).toBe('SOFT_404');
      expect(v?.reason).toMatch(reason);
    });
  }

  it('a specific page that now lands on a home page', () => {
    expect(judgeRedirect('https://site.example.com/blog/post', 'https://www.site.example.com/')).toEqual({
      status: 'SOFT_404',
      reason: 'Sends visitors to the site’s home page instead (the page was probably removed)',
    });
    expect(judgeRedirect('https://site.example.com/blog/post', 'https://site.example.com/en-gb/')?.status).toBe(
      'SOFT_404',
    );
    expect(judgeRedirect('https://old.example.com/guest-post', 'https://buyer.example.org/')?.reason).toMatch(
      /home page of buyer\.example\.org/,
    );
  });

  it('a page that redirects to an error address', () => {
    expect(judgeRedirect('https://site.example.com/a', 'https://site.example.com/404.html')?.reason).toBe(
      'Sends visitors to an error page (/404.html)',
    );
    expect(judgeRedirect('https://site.example.com/a', 'https://site.example.com/page-not-found/')?.status).toBe(
      'SOFT_404',
    );
    expect(judgeRedirect('https://site.example.com/a', 'https://site.example.com/search?error=404')?.status).toBe(
      'SOFT_404',
    );
  });

  it('the address rules win, because the home page itself looks normal', () => {
    const home = page({ title: 'Example – Home', h1: 'Welcome', body: LONG });
    expect(verdict(home, 'https://site.example.com/blog/post', 'https://site.example.com/')?.status).toBe('SOFT_404');
  });
});

describe('bot checks are Blocked, not gone', () => {
  it('recognises common bot-protection pages', () => {
    for (const title of [
      'Just a moment...',
      'Attention Required! | Cloudflare',
      'Access denied',
      'Pardon Our Interruption',
    ]) {
      expect(verdict(page({ title }))?.status).toBe('BLOCKED');
    }
    expect(
      verdict(page({ title: 'example.com', body: '<p>Enable JavaScript and cookies to continue</p>' }))?.status,
    ).toBe('BLOCKED');
  });
});

describe('labels', () => {
  it('match only when a whole title part is the message', () => {
    expect(isNotFoundLabel('Not Found')).toBe(true);
    expect(isNotFoundLabel('Oops! Page not found.')).toBe(true);
    expect(isNotFoundLabel('Page Not Found (404) | Site')).toBe(true);
    expect(isNotFoundLabel('Nothing found')).toBe(true);
    expect(isNotFoundLabel('Lost & Not Found Records')).toBe(false);
    expect(isNotFoundLabel('Why your page is not found on Google')).toBe(false);
    expect(isNotFoundLabel('')).toBe(false);
    expect(isNotFoundLabel(null)).toBe(false);
  });
});

describe('page facts', () => {
  it('reads title, first heading and visible text only', () => {
    const f = extractFacts(page({ title: 'A &amp; B', h1: 'Hello <em>there</em>', body: '<p>Visible</p>' }));
    expect(f.title).toBe('A & B');
    expect(f.h1).toBe('Hello there');
    expect(f.text).toContain('Visible');
    expect(f.text).not.toMatch(/dataLayer|color:red/);
  });

  it('copes with a script cut off by the size cap', () => {
    const f = extractFacts('<html><head><title>T</title></head><body><p>Hi</p><script>var a = "page not found');
    expect(f.text).toBe('Hi');
  });

  it('a whole batch of large pages stays cheap (free-plan CPU)', () => {
    const big = page({ title: 'Big', h1: 'Big', body: `<script>${'x'.repeat(100_000)}</script>${LONG.repeat(12)}` });
    expect(big.length).toBeGreaterThan(200_000);
    const t = performance.now();
    for (let i = 0; i < 8; i++) judgeContent(extractFacts(big));
    expect(performance.now() - t).toBeLessThan(60); // measured ~5 ms; generous for slow CI machines
  });
});
