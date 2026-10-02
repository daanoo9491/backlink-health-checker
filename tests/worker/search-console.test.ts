/**
 * Search Console ("Route A"): service-account sign-in, which property covers
 * a URL, what Google's answer means, quota, fallbacks, and the Settings status.
 * Google's endpoints are faked; the JWT is signed and verified for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanDetail, ScanRowView, ScanRowsResponse, SearchConsoleStatus } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { forgetToken, GSC_SCOPE, readServiceAccount, signJwt } from '../../src/worker/gsc/auth';
import type { GscProperty, IndexStatusResult } from '../../src/worker/gsc/client';
import { judgeInspection, propertyFor } from '../../src/worker/gsc/judge';
import { DAILY_LIMIT, forgetProperties } from '../../src/worker/gsc/service';
import { evaluateIndex } from '../../src/worker/indexing/evaluate';
import { fakeInternet } from './fake-net';
import { drain, queryCounter, signedIn, sql, testEnv } from './helpers';

// ---------- a real RSA key, as in a Google key file ----------
const pair = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))
  .match(/.{1,64}/g)!
  .join('\n')}\n-----END PRIVATE KEY-----\n`;
const EMAIL = 'linkledger@my-project.iam.gserviceaccount.com';
const KEY_FILE = JSON.stringify({
  type: 'service_account',
  client_email: EMAIL,
  private_key: pem,
  token_uri: 'https://oauth2.googleapis.com/token',
});

const b64urlDecode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---------- a fake Google ----------
interface FakeGoogle {
  sites: GscProperty[];
  inspect: (url: string, site: string) => IndexStatusResult | Response;
  tokenStatus?: number;
  calls: { token: number; sites: number; inspect: { url: string; site: string; auth: string | null }[] };
}
function fakeGoogle(g: Omit<FakeGoogle, 'calls'>): FakeGoogle {
  const state: FakeGoogle = { ...g, calls: { token: 0, sites: 0, inspect: [] } };
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'oauth2.googleapis.com') {
      state.calls.token++;
      const form = new URLSearchParams(String(init?.body));
      const [h, c, sig] = form.get('assertion')!.split('.');
      const ok = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        pair.publicKey,
        b64urlDecode(sig!),
        new TextEncoder().encode(`${h}.${c}`),
      );
      if (!ok || state.tokenStatus)
        return Response.json({ error: 'invalid_grant' }, { status: state.tokenStatus ?? 400 });
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    if (url.hostname === 'searchconsole.googleapis.com') {
      const auth = new Headers(init?.headers).get('Authorization');
      if (url.pathname === '/webmasters/v3/sites') {
        state.calls.sites++;
        return Response.json({ siteEntry: state.sites });
      }
      if (url.pathname === '/v1/urlInspection/index:inspect') {
        const body = JSON.parse(String(init?.body)) as { inspectionUrl: string; siteUrl: string };
        state.calls.inspect.push({ url: body.inspectionUrl, site: body.siteUrl, auth });
        const r = state.inspect(body.inspectionUrl, body.siteUrl);
        return r instanceof Response ? r : Response.json({ inspectionResult: { indexStatusResult: r } });
      }
    }
    return inner(input, init);
  });
  return state;
}

const SITES: GscProperty[] = [
  { siteUrl: 'sc-domain:lanop.example', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://www.client.example/blog/', permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser' },
];
const INDEXED: IndexStatusResult = {
  verdict: 'PASS',
  coverageState: 'Submitted and indexed',
  robotsTxtState: 'ALLOWED',
  indexingState: 'INDEXING_ALLOWED',
  pageFetchState: 'SUCCESSFUL',
  lastCrawlTime: '2026-09-30T08:12:00Z',
  googleCanonical: 'https://lanop.example/vat',
  userCanonical: 'https://lanop.example/vat',
};
const NOT_INDEXED: IndexStatusResult = {
  verdict: 'NEUTRAL',
  coverageState: 'Crawled - currently not indexed',
  robotsTxtState: 'ALLOWED',
  indexingState: 'INDEXING_ALLOWED',
  pageFetchState: 'SUCCESSFUL',
  lastCrawlTime: '2026-09-12T10:00:00Z',
};

beforeEach(() => {
  forgetToken();
  forgetProperties();
});
afterEach(() => vi.unstubAllGlobals());

describe('service-account sign-in', () => {
  it('reads the key file; nothing set means not connected', () => {
    expect(readServiceAccount(undefined)).toBeNull();
    expect(readServiceAccount(' ')).toBeNull();
    expect(readServiceAccount(KEY_FILE)).toMatchObject({ clientEmail: EMAIL });
    expect(() => readServiceAccount('{not json')).toThrow(/isn’t valid JSON/);
    expect(() => readServiceAccount('{"client_email":"x"}')).toThrow(/missing client_email or private_key/);
  });

  it('only ever sends the signed token to Google', () => {
    const sa = readServiceAccount(
      KEY_FILE.replace('https://oauth2.googleapis.com/token', 'https://evil.example/token'),
    );
    expect(sa?.tokenUri).toBe('https://oauth2.googleapis.com/token');
  });

  it('signs a valid RS256 JWT with the read-only scope', async () => {
    const jwt = await signJwt(readServiceAccount(KEY_FILE)!, 1_800_000_000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h!)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c!)))).toEqual({
      iss: EMAIL,
      scope: GSC_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        pair.publicKey,
        b64urlDecode(sig!),
        new TextEncoder().encode(`${h}.${c}`),
      ),
    ).toBe(true);
  });
});

describe('which property covers a URL', () => {
  const props = SITES.slice(0, 2);
  it('a domain property covers every subdomain, on http and https', () => {
    expect(propertyFor('https://lanop.example/vat', props)?.siteUrl).toBe('sc-domain:lanop.example');
    expect(propertyFor('http://blog.lanop.example/x', props)?.siteUrl).toBe('sc-domain:lanop.example');
    expect(propertyFor('https://notlanop.example/', props)).toBeNull();
  });

  it('a URL-prefix property needs the same scheme, host and path prefix', () => {
    expect(propertyFor('https://www.client.example/blog/post', props)?.siteUrl).toBe(
      'https://www.client.example/blog/',
    );
    expect(propertyFor('https://www.client.example/shop/', props)).toBeNull();
    expect(propertyFor('http://www.client.example/blog/post', props)).toBeNull();
    expect(propertyFor('https://client.example/blog/post', props)).toBeNull();
  });

  it('the most specific property wins', () => {
    const both = [...props, { siteUrl: 'sc-domain:client.example', permissionLevel: 'siteOwner' }];
    expect(propertyFor('https://www.client.example/blog/post', both)?.siteUrl).toBe('https://www.client.example/blog/');
    expect(propertyFor('https://www.client.example/shop/', both)?.siteUrl).toBe('sc-domain:client.example');
  });
});

describe('what Google’s answer means', () => {
  it('PASS is Indexed, with when Google last crawled it', () => {
    const r = judgeInspection(INDEXED, 'sc-domain:lanop.example')!;
    expect(r).toMatchObject({
      status: 'INDEXED',
      reason: 'Google Search Console: Submitted and indexed (last crawled 2026-09-30)',
    });
    expect(r.evidence.map((e) => e.text)).toContain('Checked in Search Console property sc-domain:lanop.example');
  });

  it('NEUTRAL and FAIL are Not indexed, with Google’s reason', () => {
    expect(judgeInspection(NOT_INDEXED, 'p')).toMatchObject({
      status: 'NOT_INDEXED',
      reason: 'Google Search Console: Crawled - currently not indexed',
    });
    const soft = judgeInspection({ verdict: 'FAIL', coverageState: 'Soft 404', pageFetchState: 'SOFT_404' }, 'p')!;
    expect(soft.status).toBe('NOT_INDEXED');
    expect(soft.evidence.map((e) => e.text)).toContain('Google’s fetch: soft 404');
    const unknown = judgeInspection({ verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' }, 'p')!;
    expect(unknown.evidence.map((e) => e.text)).toContain('Google hasn’t crawled it yet');
  });

  it('shows when Google picked a different canonical, or found a noindex', () => {
    const r = judgeInspection(
      {
        ...NOT_INDEXED,
        coverageState: 'Excluded by ‘noindex’ tag',
        indexingState: 'BLOCKED_BY_META_TAG',
        googleCanonical: 'https://a.example/x',
        userCanonical: 'https://a.example/y',
      },
      'p',
    )!;
    const lines = r.evidence.map((e) => e.text);
    expect(lines).toContain('Indexing: blocked by a noindex meta tag');
    expect(lines).toContain('Google chose https://a.example/x as canonical (the page declares https://a.example/y)');
  });

  it('no verdict is no answer', () => {
    expect(judgeInspection({ verdict: 'VERDICT_UNSPECIFIED' }, 'p')).toBeNull();
    expect(judgeInspection({}, 'p')).toBeNull();
  });

  it('only Search Console can say Indexed or Not indexed', () => {
    for (const status of ['ACTIVE', 'DEAD', 'SOFT_404', 'BLOCKED'] as const) {
      const r = evaluateIndex({
        link: { status, reason: 'r', retryable: false, httpStatus: 200, finalUrl: 'https://x.example/' },
        page: { robotsMeta: [], canonicals: [], xRobotsTag: null, linkHeader: null, isHtml: true },
        robots: { kind: 'allowed', rule: null },
      });
      expect(['INDEXED', 'NOT_INDEXED']).not.toContain(r.status);
    }
  });
});

// ---------- end to end through the queue ----------

const PUBLIC = ['93.184.216.34'];
const page = { status: 200, html: '<html><head><title>T</title></head><body><h1>Hi</h1></body></html>' };

describe('index checks with Search Console', () => {
  let env: Env;
  let api: Awaited<ReturnType<typeof signedIn>>;
  beforeEach(async () => {
    env = await testEnv({ GSC_SERVICE_ACCOUNT: KEY_FILE });
    api = await signedIn(env);
  });

  async function indexScan(urls: string[], tool: 'index' | 'links' = 'index') {
    const { id } = (await (
      await api('/api/scans', {
        method: 'POST',
        json: {
          tool,
          fileName: 'f',
          fileSize: 1,
          worksheets: 1,
          sheets: [],
          headers: ['URL'],
          totalRows: urls.length,
          uniqueUrls: urls.length,
          blankRows: 0,
        },
      })
    ).json()) as { id: string };
    await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
    await api(`/api/scans/${id}/rows`, {
      method: 'POST',
      json: { rows: urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: {} })) },
    });
    await api(`/api/scans/${id}/complete`, { method: 'POST' });
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    return id;
  }
  const rows = async (id: string): Promise<Record<string, ScanRowView>> =>
    Object.fromEntries(
      ((await (await api(`/api/scans/${id}/rows?pageSize=100`)).json()) as ScanRowsResponse).rows.map((r) => [
        r.url,
        r,
      ]),
    );

  function internet() {
    return fakeInternet(
      { 'lanop.example': PUBLIC, 'blog.lanop.example': PUBLIC, 'other.example': PUBLIC },
      {
        'https://lanop.example/robots.txt': { status: 404 },
        'https://blog.lanop.example/robots.txt': { status: 404 },
        'https://other.example/robots.txt': { status: 404 },
        'https://lanop.example/vat': page,
        'https://lanop.example/old': page,
        'https://blog.lanop.example/post': page,
        'https://other.example/guest-post': page,
      },
    );
  }

  it('your own sites get Google’s answer; everyone else’s get signals', async () => {
    internet();
    const g = fakeGoogle({
      sites: SITES,
      inspect: (url) => (url.endsWith('/old') ? NOT_INDEXED : INDEXED),
    });
    const id = await indexScan([
      'https://lanop.example/vat',
      'https://lanop.example/old',
      'https://blog.lanop.example/post',
      'https://other.example/guest-post',
    ]);
    await drain(env);
    const r = await rows(id);
    expect(r['https://lanop.example/vat']).toMatchObject({ indexStatus: 'INDEXED', indexSource: 'search_console' });
    expect(r['https://lanop.example/old']).toMatchObject({
      indexStatus: 'NOT_INDEXED',
      indexReason: 'Google Search Console: Crawled - currently not indexed',
    });
    expect(r['https://blog.lanop.example/post']!.indexStatus).toBe('INDEXED');
    expect(r['https://other.example/guest-post']).toMatchObject({ indexStatus: 'INDEXABLE', indexSource: 'signals' });

    // Google's answer first, our own check underneath.
    const lines = r['https://lanop.example/vat']!.indexEvidence!.map((e) => e.text);
    expect(lines[0]).toBe('Google Search Console: Submitted and indexed');
    expect(lines).toContain('Our own check:');

    expect(g.calls.inspect.map((c) => c.url).sort()).toEqual([
      'https://blog.lanop.example/post',
      'https://lanop.example/old',
      'https://lanop.example/vat',
    ]);
    expect(g.calls.inspect.every((c) => c.site === 'sc-domain:lanop.example' && c.auth === 'Bearer ya29.test')).toBe(
      true,
    );
    expect(g.calls.token).toBe(1);
    expect(g.calls.sites).toBe(1);

    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan).toMatchObject({ indexableCount: 3, indexIssueCount: 1 });
    const [usage] = await sql<{ used: number }>(
      `SELECT used FROM gsc_usage WHERE property = 'sc-domain:lanop.example'`,
    );
    expect(usage?.used).toBe(3);
  });

  it('Google wins over our crawler, and the conflict stays visible', async () => {
    fakeInternet(
      { 'lanop.example': PUBLIC },
      { 'https://lanop.example/robots.txt': { status: 404 }, 'https://lanop.example/vat': { status: 403 } },
    );
    fakeGoogle({ sites: SITES, inspect: () => INDEXED });
    const id = await indexScan(['https://lanop.example/vat']);
    await drain(env);
    const r = (await rows(id))['https://lanop.example/vat']!;
    expect(r).toMatchObject({ status: 'BLOCKED', indexStatus: 'INDEXED' });
    expect(r.indexEvidence!.map((e) => e.text)).toContain('Couldn’t load the page: HTTP 403 Forbidden');
  });

  it('over today’s limit: signals only, and says why', async () => {
    internet();
    const g = fakeGoogle({ sites: SITES, inspect: () => INDEXED });
    await sql(
      `INSERT INTO gsc_usage (property, day, used) VALUES ('sc-domain:lanop.example', (now() AT TIME ZONE 'America/Los_Angeles')::date, $1)`,
      [DAILY_LIMIT],
    );
    const id = await indexScan(['https://lanop.example/vat']);
    await drain(env);
    const r = (await rows(id))['https://lanop.example/vat']!;
    expect(r).toMatchObject({ indexStatus: 'INDEXABLE', indexSource: 'signals' });
    expect(r.indexEvidence![0]!.text).toMatch(
      /Search Console unavailable \(today’s Search Console limit for sc-domain:lanop\.example is used up\)/,
    );
    expect(g.calls.inspect).toHaveLength(0);
  });

  it('when Google is busy or refuses, falls back to signals', async () => {
    internet();
    fakeGoogle({
      sites: SITES,
      inspect: (url) =>
        url.endsWith('/vat')
          ? Response.json({ error: { code: 429 } }, { status: 429 })
          : Response.json({ error: { code: 403 } }, { status: 403 }),
    });
    const id = await indexScan(['https://lanop.example/vat', 'https://lanop.example/old']);
    await drain(env);
    const r = await rows(id);
    expect(r['https://lanop.example/vat']!.indexEvidence![0]!.text).toMatch(/usage limit was reached/);
    expect(r['https://lanop.example/old']!.indexEvidence![0]!.text).toMatch(
      /no access to this Search Console property/,
    );
    expect(r['https://lanop.example/old']!.indexStatus).toBe('INDEXABLE');
  });

  it('a rejected key: signals only, nothing breaks', async () => {
    internet();
    const g = fakeGoogle({ sites: SITES, inspect: () => INDEXED, tokenStatus: 400 });
    const id = await indexScan(['https://lanop.example/vat']);
    await drain(env);
    expect((await rows(id))['https://lanop.example/vat']).toMatchObject({
      indexStatus: 'INDEXABLE',
      indexSource: 'signals',
    });
    expect(g.calls.inspect).toHaveLength(0);
  });

  it('not connected, or a Link Health scan: Google is never called', async () => {
    internet();
    const g = fakeGoogle({ sites: SITES, inspect: () => INDEXED });
    const links = await indexScan(['https://lanop.example/vat'], 'links');
    await drain(env);
    expect((await rows(links))['https://lanop.example/vat']!.indexStatus).toBeNull();
    const plainEnv = { ...env, GSC_SERVICE_ACCOUNT: undefined };
    env = plainEnv as Env;
    await indexScan(['https://lanop.example/old']);
    await drain(env);
    expect(g.calls.token + g.calls.sites + g.calls.inspect.length).toBe(0);
  });

  it('an index batch with Search Console stays within its database budget', async () => {
    internet();
    fakeGoogle({ sites: SITES, inspect: () => INDEXED });
    await indexScan(['https://lanop.example/vat', 'https://other.example/guest-post']);
    queryCounter.reset();
    await drain(env, 1);
    // read scan, reserve, robots cache read + write, quota, save, recount
    expect(queryCounter.count).toBeLessThanOrEqual(8);
  });
});

describe('Settings: Search Console status', () => {
  it('not connected', async () => {
    const env = await testEnv();
    const api = await signedIn(env);
    expect((await (await api('/api/search-console')).json()) as SearchConsoleStatus).toMatchObject({
      configured: false,
      email: null,
      properties: [],
    });
  });

  it('lists the sites the service account can see, with today’s usage, and never the key', async () => {
    const env = await testEnv({ GSC_SERVICE_ACCOUNT: KEY_FILE });
    const api = await signedIn(env);
    fakeGoogle({ sites: SITES, inspect: () => INDEXED });
    await sql(
      `INSERT INTO gsc_usage (property, day, used) VALUES ('sc-domain:lanop.example', (now() AT TIME ZONE 'America/Los_Angeles')::date, 12)`,
    );
    const res = await api('/api/search-console');
    const text = await res.text();
    expect(text).not.toMatch(/PRIVATE KEY/);
    expect(JSON.parse(text)).toEqual({
      configured: true,
      email: EMAIL,
      dailyLimit: DAILY_LIMIT,
      error: null,
      properties: [
        { siteUrl: 'https://www.client.example/blog/', permissionLevel: 'siteRestrictedUser', usedToday: 0 },
        { siteUrl: 'sc-domain:lanop.example', permissionLevel: 'siteFullUser', usedToday: 12 },
      ],
    });
  });

  it('explains a rejected key, a broken secret, or no shared sites', async () => {
    let env = await testEnv({ GSC_SERVICE_ACCOUNT: KEY_FILE });
    let api = await signedIn(env);
    fakeGoogle({ sites: [], inspect: () => INDEXED });
    expect(((await (await api('/api/search-console')).json()) as SearchConsoleStatus).error).toMatch(
      /no sites are shared with linkledger@/,
    );
    vi.unstubAllGlobals();
    forgetToken();
    fakeGoogle({ sites: SITES, inspect: () => INDEXED, tokenStatus: 400 });
    expect(((await (await api('/api/search-console')).json()) as SearchConsoleStatus).error).toMatch(
      /rejected the service-account key/,
    );
    env = await testEnv({ GSC_SERVICE_ACCOUNT: '{oops' });
    api = await signedIn(env);
    expect((await (await api('/api/search-console')).json()) as SearchConsoleStatus).toMatchObject({
      configured: true,
      error: expect.stringMatching(/isn’t valid JSON/),
    });
  });

  it('needs sign-in', async () => {
    const env = await testEnv();
    const { call } = await import('./helpers');
    expect((await call(env, '/api/search-console')).status).toBe(401);
  });
});
