import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubrequestBudget, BudgetExhausted } from '../../src/worker/checker/budget';
import { checkLink, type CheckDeps } from '../../src/worker/checker/check-link';
import { createResolver } from '../../src/worker/checker/dns';
import { isInternalIp } from '../../src/shared/url';
import { fakeInternet } from './fake-net';

afterEach(() => vi.unstubAllGlobals());

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  resolver: createResolver(),
  budget: new SubrequestBudget(45),
  blockedHosts: new Set(['app.workers.dev']),
  timeoutMs: 200,
  ...over,
});

const PUBLIC = ['93.184.216.34'];

describe('checkLink: ordinary results', () => {
  it('Active on 200, with timing and no redirect', async () => {
    fakeInternet({ 'ok.example.com': PUBLIC }, { 'https://ok.example.com/post': { status: 200 } });
    const r = await checkLink('https://ok.example.com/post', deps());
    expect(r).toMatchObject({ status: 'ACTIVE', httpStatus: 200, redirected: false, error: null });
    expect(r.finalUrl).toBe('https://ok.example.com/post');
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('Dead on 404 and 410', async () => {
    fakeInternet({ 'x.example.com': PUBLIC }, { 'https://x.example.com/gone': { status: 410 } });
    expect((await checkLink('https://x.example.com/missing', deps())).status).toBe('DEAD');
    expect((await checkLink('https://x.example.com/gone', deps())).status).toBe('DEAD');
  });

  it('follows redirects and records the final address', async () => {
    fakeInternet(
      { 'a.example.com': PUBLIC, 'b.example.org': PUBLIC },
      {
        'https://a.example.com/old': { status: 301, location: '/newer' },
        'https://a.example.com/newer': { status: 302, location: 'https://b.example.org/landing' },
        'https://b.example.org/landing': { status: 200 },
      },
    );
    const r = await checkLink('https://a.example.com/old', deps());
    expect(r).toMatchObject({ status: 'REDIRECTED', redirected: true, finalUrl: 'https://b.example.org/landing' });
  });

  it('http→https on the same page is Active (recorded as redirected)', async () => {
    fakeInternet(
      { 'site.example.com': PUBLIC },
      {
        'http://site.example.com/p': { status: 301, location: 'https://site.example.com/p/' },
        'https://site.example.com/p/': { status: 200 },
      },
    );
    const r = await checkLink('http://site.example.com/p', deps());
    expect(r).toMatchObject({ status: 'ACTIVE', redirected: true, finalUrl: 'https://site.example.com/p/' });
  });

  it('a redirect that ends on a 404 is Dead', async () => {
    fakeInternet(
      { 'r.example.com': PUBLIC },
      { 'https://r.example.com/a': { status: 307, location: '/b' }, 'https://r.example.com/b': { status: 404 } },
    );
    expect((await checkLink('https://r.example.com/a', deps())).status).toBe('DEAD');
  });

  it('403 Blocked, 429 Rate limited, 503 Server error: none of them Dead', async () => {
    fakeInternet(
      { 's.example.com': PUBLIC },
      {
        'https://s.example.com/403': { status: 403 },
        'https://s.example.com/429': { status: 429 },
        'https://s.example.com/503': { status: 503 },
      },
    );
    expect((await checkLink('https://s.example.com/403', deps())).status).toBe('BLOCKED');
    expect((await checkLink('https://s.example.com/429', deps())).status).toBe('RATE_LIMITED');
    expect((await checkLink('https://s.example.com/503', deps())).status).toBe('SERVER_ERROR');
  });

  it('Timeout when the site does not answer in time', async () => {
    fakeInternet({ 'slow.example.com': PUBLIC }, { 'https://slow.example.com/': 'timeout' });
    const r = await checkLink('https://slow.example.com/', deps());
    expect(r.status).toBe('TIMEOUT');
    expect(r.reason).toMatch(/No response within/);
  });

  it('Network error on a dropped connection', async () => {
    fakeInternet({ 'bad.example.com': PUBLIC }, { 'https://bad.example.com/': 'reset' });
    const r = await checkLink('https://bad.example.com/', deps());
    expect(r.status).toBe('NETWORK_ERROR');
    expect(r.error).toMatch(/connection lost/i);
  });

  it('explains when the domain no longer exists', async () => {
    fakeInternet({}, {});
    const r = await checkLink('https://expired-domain.example/', deps());
    expect(r.status).toBe('NETWORK_ERROR');
    expect(r.reason).toMatch(/doesn’t exist/);
  });

  it('stops redirect loops', async () => {
    fakeInternet(
      { 'loop.example.com': PUBLIC },
      {
        'https://loop.example.com/a': { status: 302, location: '/b' },
        'https://loop.example.com/b': { status: 302, location: '/a' },
      },
    );
    const r = await checkLink('https://loop.example.com/a', deps());
    expect(r.status).toBe('SERVER_ERROR');
    expect(r.reason).toMatch(/redirect loop/);
  });
});

describe('checkLink: SSRF protection', () => {
  it('refuses hostnames that resolve to private or metadata addresses, without connecting', async () => {
    const net = fakeInternet(
      { 'sneaky.example.com': ['10.0.0.5'], 'meta.example.com': ['169.254.169.254'], 'v6.example.com': ['fd00::1'] },
      {},
    );
    for (const u of ['https://sneaky.example.com/', 'https://meta.example.com/', 'https://v6.example.com/']) {
      const r = await checkLink(u, deps());
      expect(r.status).toBe('NETWORK_ERROR');
      expect(r.reason).toMatch(/address we don’t check/);
    }
    expect(net.requested).toEqual([]); // never connected to any of them
  });

  it('refuses a public page that redirects to an internal address', async () => {
    const net = fakeInternet(
      { 'public.example.com': PUBLIC },
      {
        'https://public.example.com/a': { status: 302, location: 'http://127.0.0.1:8787/admin' },
        'https://public.example.com/b': { status: 302, location: 'http://169.254.169.254/latest/meta-data' },
        'https://public.example.com/c': { status: 302, location: 'http://localhost/' },
        'https://public.example.com/d': { status: 302, location: 'file:///etc/passwd' },
        'https://public.example.com/e': { status: 302, location: 'http://[::1]/' },
      },
    );
    for (const p of ['a', 'b', 'c', 'd', 'e']) {
      const r = await checkLink(`https://public.example.com/${p}`, deps());
      expect(r.status).toBe('NETWORK_ERROR');
      expect(r.redirected).toBe(true);
    }
    expect(net.requested.every((u) => u.startsWith('https://public.example.com/'))).toBe(true);
  });

  it('never requests the app itself (avoids loops)', async () => {
    const net = fakeInternet({ 'app.workers.dev': PUBLIC }, {});
    const r = await checkLink('https://app.workers.dev/api/scans', deps());
    expect(r.status).toBe('NETWORK_ERROR');
    expect(net.requested).toEqual([]);
  });

  it('fails closed when DNS cannot be checked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('DNS service down');
      }),
    );
    const r = await checkLink('https://any.example.com/', deps());
    expect(r.status).toBe('NETWORK_ERROR');
    expect(r.reason).toMatch(/Couldn’t look up/);
  });

  it('sends no credentials and an identifying User-Agent', async () => {
    const net = fakeInternet({ 'ua.example.com': PUBLIC }, { 'https://ua.example.com/': { status: 200 } });
    await checkLink('https://ua.example.com/', deps());
    const call = net.fetchMock.mock.calls.find(([u]) => String(u).startsWith('https://ua.example.com'))!;
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get('User-Agent')).toMatch(/BacklinkHealthChecker/);
    expect(headers.get('Cookie')).toBeNull();
    expect((call[1] as RequestInit).redirect).toBe('manual');
  });
});

describe('free-plan request budget', () => {
  it('stops cleanly when the budget runs out', async () => {
    fakeInternet({ 'b.example.com': PUBLIC }, { 'https://b.example.com/': { status: 200 } });
    await expect(checkLink('https://b.example.com/', deps({ budget: new SubrequestBudget(2) }))).rejects.toBeInstanceOf(
      BudgetExhausted,
    );
  });

  it('looks up each hostname once per batch', async () => {
    const net = fakeInternet(
      { 'c.example.com': PUBLIC },
      { 'https://c.example.com/1': { status: 200 }, 'https://c.example.com/2': { status: 200 } },
    );
    const d = deps();
    await checkLink('https://c.example.com/1', d);
    await checkLink('https://c.example.com/2', d);
    const dnsCalls = net.fetchMock.mock.calls.filter(([u]) => String(u).includes('cloudflare-dns.com'));
    expect(dnsCalls).toHaveLength(2); // A + AAAA, once
  });
});

describe('isInternalIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false],
    ['8.8.8.8', false],
    ['2606:4700::6810:85e5', false],
  ])('%s -> %s', (ip, internal) => {
    expect(isInternalIp(ip)).toBe(internal);
  });
});
