/**
 * The browser helper API: connection codes, the Google-check queue, saving
 * answers, and keeping each user's data to themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HelperClaimResponse,
  HelperStatusResponse,
  HelperTokenCreated,
  HelperTokenList,
  ScanDetail,
  ScanRowsResponse,
} from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { call, cookieFrom, drain, ORIGIN, signedIn, sql, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});
afterEach(() => vi.unstubAllGlobals());

const PUBLIC = ['93.184.216.34'];
const OK_PAGE = { status: 200, html: '<html><head><title>T</title></head><body><h1>Hi</h1></body></html>' };

/** A finished index check over these links (all on a.example.com). */
async function indexCheck(urls: string[], tool: 'index' | 'links' = 'index', apiFn = api, e = env) {
  const { id } = (await (
    await apiFn('/api/scans', {
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
  await apiFn(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
  await apiFn(`/api/scans/${id}/rows`, {
    method: 'POST',
    json: { rows: urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: {} })) },
  });
  await apiFn(`/api/scans/${id}/complete`, { method: 'POST' });
  await apiFn(`/api/scans/${id}/start`, { method: 'POST' });
  await drain(e);
  return id;
}

function site() {
  fakeInternet(
    { 'a.example.com': PUBLIC },
    {
      'https://a.example.com/robots.txt': { status: 404 },
      'https://a.example.com/1': OK_PAGE,
      'https://a.example.com/2': OK_PAGE,
      'https://a.example.com/3': OK_PAGE,
      // /gone is a 404: not worth a Google search
    },
  );
}

async function newCode(apiFn = api): Promise<string> {
  const res = await apiFn('/api/helper/tokens', { method: 'POST', json: { label: 'My Chrome' } });
  expect(res.status).toBe(201);
  return ((await res.json()) as HelperTokenCreated).token;
}

/** Calls the helper API the way the extension does: Bearer code, no cookie, no Origin. */
const helper = (code: string, path: string, json?: unknown, e = env) =>
  call(e, `/api/helper${path}`, {
    method: json === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

describe('connection codes', () => {
  it('are shown once, stored only as a hash, and listed without the code', async () => {
    const code = await newCode();
    expect(code).toMatch(/^llh_[A-Za-z0-9_-]{43}$/);
    const [row] = await sql<{ token_hash: string }>('SELECT token_hash FROM helper_tokens');
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token_hash).not.toContain(code);
    const list = (await (await api('/api/helper/tokens')).json()) as HelperTokenList;
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(code);
    expect(list.tokens[0]).toMatchObject({ label: 'My Chrome', lastUsedAt: null });
  });

  it('connect the helper as their user; a removed code stops working at once', async () => {
    const code = await newCode();
    const status = await helper(code, '/status');
    expect(status.status).toBe(200);
    expect(((await status.json()) as HelperStatusResponse).email).toBe('marketing@example.com');
    const { tokens } = (await (await api('/api/helper/tokens')).json()) as HelperTokenList;
    expect(tokens[0]!.lastUsedAt).not.toBeNull();
    await api(`/api/helper/tokens/${tokens[0]!.id}`, { method: 'DELETE' });
    expect((await helper(code, '/status')).status).toBe(401);
  });

  it('wrong, missing or cookie-only credentials are refused', async () => {
    expect((await helper('llh_nope', '/status')).status).toBe(401);
    expect((await call(env, '/api/helper/status')).status).toBe(401);
    expect((await api('/api/helper/status')).status).toBe(401); // a signed-in browser isn't a helper
  });

  it('managing codes needs a signed-in user from this site', async () => {
    expect((await call(env, '/api/helper/tokens')).status).toBe(401);
    const login = await call(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.9' },
      body: JSON.stringify({ email: 'Marketing@Example.com', password: 'correct horse battery staple' }),
    });
    const res = await call(env, '/api/helper/tokens', {
      method: 'POST',
      headers: { Cookie: cookieFrom(login), Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403); // cross-site request forgery is still blocked
  });
});

describe('the Google-check queue', () => {
  it('hands out links waiting for Google, never twice at once', async () => {
    site();
    await indexCheck(['https://a.example.com/1', 'https://a.example.com/2', 'https://a.example.com/gone']);
    const code = await newCode();
    const first = (await (await helper(code, '/claim', { max: 1 })).json()) as HelperClaimResponse;
    expect(first.jobs).toEqual([{ id: expect.stringMatching(/:0$/), url: 'https://a.example.com/1' }]);
    const second = (await (await helper(code, '/claim', { max: 10 })).json()) as HelperClaimResponse;
    expect(second.jobs.map((j) => j.url)).toEqual(['https://a.example.com/2']); // /gone isn't worth a search
    expect(((await (await helper(code, '/claim', {})).json()) as HelperClaimResponse).jobs).toEqual([]);

    // Unanswered for 10 minutes: back in the queue.
    await sql(`UPDATE unique_urls SET google_claimed_at = now() - interval '11 minutes' WHERE url_index = 0`);
    expect(((await (await helper(code, '/claim', {})).json()) as HelperClaimResponse).jobs).toHaveLength(1);
  });

  it('skips Link Health scans and links Search Console already answered', async () => {
    site();
    await indexCheck(['https://a.example.com/1'], 'links');
    const id = await indexCheck(['https://a.example.com/2', 'https://a.example.com/3']);
    await sql(
      `UPDATE unique_urls SET index_source = 'search_console', index_status = 'INDEXED' WHERE scan_id = $1 AND url_index = 0`,
      [id],
    );
    const code = await newCode();
    const r = (await (await helper(code, '/claim', { max: 10 })).json()) as HelperClaimResponse;
    expect(r.jobs.map((j) => j.url)).toEqual(['https://a.example.com/3']);
  });

  it('shows how many links are waiting, on the helper and on the scan page', async () => {
    site();
    const id = await indexCheck(['https://a.example.com/1', 'https://a.example.com/2']);
    const code = await newCode();
    expect((await (await helper(code, '/status')).json()) as HelperStatusResponse).toMatchObject({
      pending: 2,
      checkedToday: 0,
    });
    const rows = (await (await api(`/api/scans/${id}/rows`)).json()) as ScanRowsResponse;
    expect(rows.facets.googlePending).toBe(2);
    expect(rows.facets.links.byStatus.ACTIVE).toBe(2); // still counted in the per-result totals
  });
});

describe('saving Google’s answers', () => {
  it('Found → Indexed, not found → Not indexed, with the evidence first', async () => {
    site();
    const id = await indexCheck(['https://a.example.com/1', 'https://a.example.com/2']);
    const code = await newCode();
    const { jobs } = (await (await helper(code, '/claim', { max: 5 })).json()) as HelperClaimResponse;
    const res = await helper(code, '/results', {
      results: [
        { id: jobs[0]!.id, outcome: 'FOUND', query: 'site:a.example.com/1', resultCount: 1 },
        { id: jobs[1]!.id, outcome: 'NOT_FOUND', query: 'site:a.example.com/2', resultCount: 0 },
      ],
    });
    expect(await res.json()).toEqual({ saved: 2 });

    const rows = ((await (await api(`/api/scans/${id}/rows`)).json()) as ScanRowsResponse).rows;
    expect(rows[0]).toMatchObject({
      indexStatus: 'INDEXED',
      indexSource: 'google_search',
      indexReason: 'Found in Google for this exact URL',
    });
    expect(rows[0]!.indexEvidence![0]).toEqual({
      signal: 'google',
      text: 'Google search for “site:a.example.com/1”: this URL is in the results',
      bad: false,
    });
    expect(rows[0]!.indexEvidence!.map((e) => e.text)).toContain('Our own check:');
    expect(rows[1]).toMatchObject({
      indexStatus: 'NOT_INDEXED',
      indexReason: 'Not found in Google for this exact URL',
    });
    expect(rows[1]!.indexEvidence![0]!.text).toBe('Google search for “site:a.example.com/2”: no results');

    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan).toMatchObject({ indexableCount: 1, indexIssueCount: 1 });
    expect((await (await helper(code, '/status')).json()) as HelperStatusResponse).toMatchObject({
      pending: 0,
      checkedToday: 2,
    });
    // Answered links aren't searched again.
    expect(((await (await helper(code, '/claim', {})).json()) as HelperClaimResponse).jobs).toEqual([]);
  });

  it('a failed search is retried, then given up after 3 tries', async () => {
    site();
    await indexCheck(['https://a.example.com/1']);
    const code = await newCode();
    for (let i = 1; i <= 3; i++) {
      const { jobs } = (await (await helper(code, '/claim', {})).json()) as HelperClaimResponse;
      expect(jobs).toHaveLength(1);
      await helper(code, '/results', {
        results: [{ id: jobs[0]!.id, outcome: 'ERROR', why: 'results page not recognised' }],
      });
    }
    const [row] = await sql<{ google_status: string; index_status: string }>(
      'SELECT google_status, index_status FROM unique_urls',
    );
    expect(row).toEqual({ google_status: 'ERROR', index_status: 'INDEXABLE' }); // the crawler's answer stays
    expect(((await (await helper(code, '/claim', {})).json()) as HelperClaimResponse).jobs).toEqual([]);
  });

  it('never touches another user’s links, or a Search Console answer', async () => {
    site();
    const mine = await indexCheck(['https://a.example.com/1']);
    // A second user with their own code.
    const otherEnv = { ...env, AUTH_EMAIL: 'other@example.com', AUTH_PASSWORD: 'other password 123' } as Env;
    const login = await call(otherEnv, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.50' },
      body: JSON.stringify({ email: 'other@example.com', password: 'other password 123' }),
    });
    const cookie = cookieFrom(login);
    const otherApi = (path: string, init: RequestInit & { json?: unknown } = {}) =>
      call(otherEnv, path, {
        method: init.method,
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      });
    const theirCode = await newCode(otherApi);
    const [job] = (await sql<{ scan_id: string }>('SELECT scan_id FROM unique_urls')).map((r) => `${r.scan_id}:0`);
    expect(((await (await helper(theirCode, '/claim', {}, otherEnv)).json()) as HelperClaimResponse).jobs).toEqual([]);
    const res = await helper(
      theirCode,
      '/results',
      { results: [{ id: job, outcome: 'NOT_FOUND', query: 'q' }] },
      otherEnv,
    );
    expect(await res.json()).toEqual({ saved: 0 });

    await sql(`UPDATE unique_urls SET index_source = 'search_console', index_status = 'INDEXED' WHERE scan_id = $1`, [
      mine,
    ]);
    const code = await newCode();
    expect(
      await (await helper(code, '/results', { results: [{ id: job, outcome: 'NOT_FOUND', query: 'q' }] })).json(),
    ).toEqual({
      saved: 0,
    });
  });

  it('a link handed back unsearched (offline, robot check) is free to take again, no try counted', async () => {
    site();
    await indexCheck(['https://a.example.com/1']);
    const code = await newCode();
    const { jobs } = (await (await helper(code, '/claim', {})).json()) as HelperClaimResponse;
    await helper(code, '/results', { results: [{ id: jobs[0]!.id, outcome: 'SKIP' }] });
    const [row] = await sql<{ google_attempts: number; google_status: string | null }>(
      'SELECT google_attempts, google_status FROM unique_urls',
    );
    expect(row).toEqual({ google_attempts: 0, google_status: null });
    expect(((await (await helper(code, '/claim', {})).json()) as HelperClaimResponse).jobs).toHaveLength(1);
  });

  it('ignores malformed reports', async () => {
    const code = await newCode();
    expect((await helper(code, '/results', { results: 'nope' })).status).toBe(400);
    expect((await helper(code, '/results', { results: Array.from({ length: 21 }, () => ({})) })).status).toBe(400);
    const res = await helper(code, '/results', {
      results: [
        { id: 'x:1', outcome: 'FOUND' },
        { id: '00000000-0000-4000-8000-000000000000:1', outcome: 'MAYBE' },
      ],
    });
    expect(await res.json()).toEqual({ saved: 0 });
  });
});
