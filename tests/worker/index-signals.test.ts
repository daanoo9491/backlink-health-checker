import { describe, expect, it } from 'vitest';
import { INDEX_STATUSES, INDEX_STATUS_INFO } from '../../src/shared/index-status';
import { LINK_STATUSES } from '../../src/shared/status';
import { extractFacts } from '../../src/worker/checker/page-facts';
import {
  evaluateIndex,
  type IndexInputs,
  type PageSignals,
  type RobotsVerdict,
} from '../../src/worker/indexing/evaluate';
import {
  headerNoindex,
  headSignals,
  judgeCanonical,
  linkHeaderCanonicals,
  metaNoindex,
} from '../../src/worker/indexing/signals';

describe('meta robots', () => {
  it('reads robots and googlebot meta tags from <head>, in any attribute order and quoting', () => {
    const { robotsMeta } = headSignals(
      `<meta charset="utf-8"><meta content="noindex,follow" name="ROBOTS"><meta name=googlebot content='nosnippet'>
       <meta name="bingbot" content="noindex"><meta property="og:title" content="x">`,
    );
    expect(robotsMeta).toEqual([
      { name: 'robots', content: 'noindex,follow' },
      { name: 'googlebot', content: 'nosnippet' },
    ]);
  });

  it('noindex and none mean noindex; other crawlers’ tags don’t count', () => {
    expect(metaNoindex([{ name: 'robots', content: 'NOINDEX, nofollow' }])?.content).toBe('NOINDEX, nofollow');
    expect(metaNoindex([{ name: 'googlebot', content: 'none' }])).not.toBeNull();
    expect(metaNoindex([{ name: 'robots', content: 'index, follow' }])).toBeNull();
    expect(metaNoindex([{ name: 'robots', content: 'noimageindex' }])).toBeNull();
    expect(metaNoindex(headSignals('<meta name="bingbot" content="noindex">').robotsMeta)).toBeNull();
  });

  it('only <head> counts, and commented-out tags are ignored', () => {
    const f = extractFacts(
      '<html><head><!-- <meta name="robots" content="noindex"> --><title>T</title></head><body><meta name="robots" content="noindex"></body></html>',
    );
    expect(f.robotsMeta).toEqual([]);
  });
});

describe('X-Robots-Tag header', () => {
  it('applies to Googlebot unless it names another crawler', () => {
    expect(headerNoindex('noindex')).toBe(true);
    expect(headerNoindex('none')).toBe(true);
    expect(headerNoindex('googlebot: noindex')).toBe(true);
    expect(headerNoindex('GoogleBot: NoIndex, nofollow')).toBe(true);
    expect(headerNoindex('otherbot: noindex')).toBe(false);
    expect(headerNoindex('otherbot: noindex, nofollow')).toBe(false); // "nofollow" continues otherbot's section
    expect(headerNoindex('otherbot: nofollow, googlebot: noindex')).toBe(true);
    expect(headerNoindex('unavailable_after: 25 Jun 2010 15:00:00 PST')).toBe(false);
    expect(headerNoindex('noarchive, nosnippet')).toBe(false);
    expect(headerNoindex(null)).toBe(false);
  });
});

describe('canonical', () => {
  it('reads <link rel="canonical"> and the HTTP Link header', () => {
    expect(headSignals('<link rel="canonical" href="https://x.example/a">').canonicals).toEqual([
      'https://x.example/a',
    ]);
    expect(headSignals('<link href="/b" rel="Canonical">').canonicals).toEqual(['/b']);
    expect(headSignals('<link rel="alternate" href="/c">').canonicals).toEqual([]);
    expect(
      linkHeaderCanonicals('<https://x.example/a.pdf>; rel="canonical", <https://x.example/fr>; rel="alternate"'),
    ).toEqual(['https://x.example/a.pdf']);
    expect(linkHeaderCanonicals('<https://x.example/b>; rel=canonical')).toEqual(['https://x.example/b']);
    expect(linkHeaderCanonicals(null)).toEqual([]);
  });

  it('this page, ignoring http/https, www and a trailing slash', () => {
    expect(judgeCanonical('https://x.example/post', ['http://www.x.example/post/']).kind).toBe('self');
    expect(judgeCanonical('https://x.example/post', ['/post']).kind).toBe('self');
    expect(judgeCanonical('https://x.example/post', []).kind).toBe('none');
  });

  it('a different page, resolved against the page address', () => {
    expect(judgeCanonical('https://x.example/blog/post?utm=1', ['../other'])).toEqual({
      kind: 'elsewhere',
      url: 'https://x.example/other',
    });
    expect(judgeCanonical('https://x.example/post?page=2', ['https://x.example/post']).kind).toBe('elsewhere');
  });

  it('several different canonicals cancel out; invalid ones are ignored', () => {
    expect(judgeCanonical('https://x.example/p', ['https://x.example/a', 'https://x.example/b']).kind).toBe(
      'conflicting',
    );
    expect(judgeCanonical('https://x.example/p', ['https://x.example/p', 'https://x.example/p/']).kind).toBe('self');
    expect(judgeCanonical('https://x.example/p', ['javascript:alert(1)', 'http://[bad']).kind).toBe('none');
  });
});

const PAGE: PageSignals = { robotsMeta: [], canonicals: [], xRobotsTag: null, linkHeader: null, isHtml: true };
const ALLOWED: RobotsVerdict = { kind: 'allowed', rule: null };
const ok = (over: Partial<IndexInputs> = {}): IndexInputs => ({
  link: { status: 'ACTIVE', reason: 'HTTP 200 OK', retryable: false, httpStatus: 200, finalUrl: 'https://x.example/p' },
  page: PAGE,
  robots: ALLOWED,
  ...over,
});
const disallowed: RobotsVerdict = { kind: 'disallowed', rule: { allow: false, path: '/p', line: 'Disallow: /p' } };

describe('evaluateIndex: each result', () => {
  it('Indexable, with evidence for every signal', () => {
    const r = evaluateIndex(ok());
    expect(r.status).toBe('INDEXABLE');
    expect(r.evidence.map((e) => e.signal)).toEqual(['page', 'robots', 'meta', 'canonical']);
    expect(r.evidence.some((e) => e.bad)).toBe(false);
  });

  it('No robots.txt counts as allowed', () => {
    expect(evaluateIndex(ok({ robots: { kind: 'no-file', httpStatus: 404 } })).status).toBe('INDEXABLE');
  });

  it('Blocked from indexing: meta tag or header', () => {
    const meta = evaluateIndex(ok({ page: { ...PAGE, robotsMeta: [{ name: 'robots', content: 'noindex' }] } }));
    expect(meta).toMatchObject({ status: 'NOINDEX', reason: 'noindex in the meta robots tag' });
    const header = evaluateIndex(ok({ page: { ...PAGE, xRobotsTag: 'noindex' } }));
    expect(header).toMatchObject({ status: 'NOINDEX', reason: 'noindex in the X-Robots-Tag header' });
    expect(header.evidence.find((e) => e.signal === 'header')).toMatchObject({ bad: true });
  });

  it('PDFs: only the header counts', () => {
    const pdf = { ...PAGE, isHtml: false, robotsMeta: [{ name: 'robots', content: 'noindex' }] };
    expect(evaluateIndex(ok({ page: pdf })).status).toBe('INDEXABLE');
    expect(evaluateIndex(ok({ page: { ...pdf, xRobotsTag: 'noindex' } })).status).toBe('NOINDEX');
  });

  it('Crawling blocked, noting a noindex Google can’t see', () => {
    const r = evaluateIndex(
      ok({ robots: disallowed, page: { ...PAGE, robotsMeta: [{ name: 'robots', content: 'noindex' }] } }),
    );
    expect(r).toMatchObject({ status: 'ROBOTS_BLOCKED', reason: 'robots.txt blocks Googlebot (Disallow: /p)' });
    expect(r.evidence.map((e) => e.text)).toContain('Google can’t see the noindex while robots.txt blocks crawling');
  });

  it('Canonical points elsewhere (header canonicals count too)', () => {
    expect(evaluateIndex(ok({ page: { ...PAGE, canonicals: ['https://x.example/q'] } }))).toMatchObject({
      status: 'CANONICAL_ELSEWHERE',
      reason: 'Canonical points to https://x.example/q',
    });
    expect(evaluateIndex(ok({ page: { ...PAGE, linkHeader: '<https://x.example/q>; rel="canonical"' } })).status).toBe(
      'CANONICAL_ELSEWHERE',
    );
  });

  it('Page not reachable: gone, soft 404, redirected away, domain gone', () => {
    const link = (status: IndexInputs['link']['status'], retryable = false) => ({
      ...ok().link,
      status,
      retryable,
      reason: 'r',
      finalUrl: 'https://y.example/',
    });
    for (const s of ['DEAD', 'SOFT_404', 'REDIRECTED'] as const) {
      expect(evaluateIndex({ link: link(s), page: null, robots: null }).status).toBe('NOT_REACHABLE');
    }
    expect(evaluateIndex({ link: link('NETWORK_ERROR'), page: null, robots: null }).status).toBe('NOT_REACHABLE');
    expect(evaluateIndex({ link: link('REDIRECTED'), page: null, robots: null }).reason).toMatch(
      /Redirects to https:\/\/y\.example\//,
    );
  });

  it('Unknown when the page or robots.txt couldn’t be read: never a negative', () => {
    for (const s of ['BLOCKED', 'RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT'] as const) {
      expect(evaluateIndex({ link: { ...ok().link, status: s }, page: null, robots: null }).status).toBe('UNKNOWN');
    }
    expect(
      evaluateIndex({ link: { ...ok().link, status: 'NETWORK_ERROR', retryable: true }, page: null, robots: null })
        .status,
    ).toBe('UNKNOWN');
    const r = evaluateIndex(ok({ robots: { kind: 'unknown', why: 'HTTP 503' } }));
    expect(r).toMatchObject({ status: 'UNKNOWN' });
    expect(r.reason).toMatch(/Couldn’t read robots\.txt \(HTTP 503\)/);
  });

  it('a noindex still shows when robots.txt couldn’t be read', () => {
    const r = evaluateIndex(
      ok({ robots: { kind: 'unknown', why: 'HTTP 503' }, page: { ...PAGE, xRobotsTag: 'noindex' } }),
    );
    expect(r.status).toBe('NOINDEX');
  });
});

describe('Route B never says “Not indexed”', () => {
  it('in any label, description or advice', () => {
    for (const s of INDEX_STATUSES) {
      const info = INDEX_STATUS_INFO[s];
      expect(`${info.label} ${info.description} ${info.advice}`).not.toMatch(/not indexed/i);
    }
  });

  it('in any result or evidence, for every combination of signals', () => {
    const robotsOptions: (RobotsVerdict | null)[] = [
      null,
      ALLOWED,
      disallowed,
      { kind: 'no-file', httpStatus: 404 },
      { kind: 'unknown', why: 'HTTP 503' },
    ];
    const pages: (PageSignals | null)[] = [
      null,
      PAGE,
      { ...PAGE, robotsMeta: [{ name: 'robots', content: 'noindex' }] },
      { ...PAGE, xRobotsTag: 'googlebot: none' },
      { ...PAGE, canonicals: ['https://x.example/other'] },
      { ...PAGE, canonicals: ['https://x.example/a', 'https://x.example/b'] },
      { ...PAGE, isHtml: false },
    ];
    let n = 0;
    for (const status of LINK_STATUSES) {
      for (const retryable of [false, true]) {
        for (const robots of robotsOptions) {
          for (const page of pages) {
            const r = evaluateIndex({ link: { ...ok().link, status, retryable }, page, robots });
            expect(INDEX_STATUSES).toContain(r.status);
            const text = [r.reason, ...r.evidence.map((e) => e.text)].join(' ');
            expect(text).not.toMatch(/not indexed/i);
            expect(r.evidence.length).toBeGreaterThan(0);
            n++;
          }
        }
      }
    }
    expect(n).toBe(LINK_STATUSES.length * 2 * 5 * 7);
  });
});
