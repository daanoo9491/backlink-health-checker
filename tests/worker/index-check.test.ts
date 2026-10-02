/**
 * Index Checker end to end through the API and the queue: index scans,
 * robots.txt fetching and caching, results and filters, and running an index
 * check on a Link Health scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardSummary,
  IndexCheckFromScanResponse,
  ScanDetail,
  ScanListResponse,
  ScanRowsResponse,
} from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { drain, queryCounter, signedIn, sql, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});
afterEach(() => vi.unstubAllGlobals());

const PUBLIC = ['93.184.216.34'];
const page = (head = '', status = 200, headers: Record<string, string> = {}) => ({
  status,
  html: `<html><head><title>T</title>${head}</head><body><h1>Article</h1><p>Text</p></body></html>`,
  headers,
});
const robots = (body: string) => ({ status: 200, html: body, contentType: 'text/plain' });

async function makeScan(urls: string[], tool: 'links' | 'index' = 'index'): Promise<string> {
  const { id } = (await (
    await api('/api/scans', {
      method: 'POST',
      json: {
        tool,
        fileName: 'urls.xlsx',
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
    json: { rows: urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: { URL: u } })) },
  });
  await api(`/api/scans/${id}/complete`, { method: 'POST' });
  return id;
}

const rowsOf = async (id: string, qs = 'pageSize=100') =>
  (await (await api(`/api/scans/${id}/rows?${qs}`)).json()) as ScanRowsResponse;
const detail = async (id: string) => (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
const byUrl = (r: ScanRowsResponse) => Object.fromEntries(r.rows.map((x) => [x.url, x]));

describe('index checks', () => {
  it('judges every page from its signals and robots.txt', async () => {
    const net = fakeInternet(
      { 'a.example.com': PUBLIC, 'b.example.org': PUBLIC, 'gone.example.net': PUBLIC },
      {
        'https://a.example.com/robots.txt': robots('User-agent: *\nDisallow: /private/\n'),
        'https://a.example.com/ok': page('<link rel="canonical" href="https://a.example.com/ok">'),
        'https://a.example.com/noindex': page('<meta name="robots" content="noindex, follow">'),
        'https://a.example.com/header': page('', 200, { 'X-Robots-Tag': 'googlebot: noindex' }),
        'https://a.example.com/private/x': page(),
        'https://a.example.com/copy': page('<link rel="canonical" href="/ok">'),
        'https://b.example.org/robots.txt': { status: 503 },
        'https://b.example.org/post': page(),
        'https://gone.example.net/robots.txt': { status: 404 },
      },
    );
    const urls = [
      'https://a.example.com/ok',
      'https://a.example.com/noindex',
      'https://a.example.com/header',
      'https://a.example.com/private/x',
      'https://a.example.com/copy',
      'https://b.example.org/post',
      'https://gone.example.net/post', // 404
    ];
    const id = await makeScan(urls);
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    await drain(env);

    const r = byUrl(await rowsOf(id));
    expect(r['https://a.example.com/ok']).toMatchObject({ indexStatus: 'INDEXABLE' });
    expect(r['https://a.example.com/noindex']).toMatchObject({
      indexStatus: 'NOINDEX',
      indexReason: 'noindex in the meta robots tag',
    });
    expect(r['https://a.example.com/header']).toMatchObject({ indexStatus: 'NOINDEX' });
    expect(r['https://a.example.com/private/x']).toMatchObject({
      indexStatus: 'ROBOTS_BLOCKED',
      indexReason: 'robots.txt blocks Googlebot (Disallow: /private/)',
    });
    expect(r['https://a.example.com/copy']).toMatchObject({ indexStatus: 'CANONICAL_ELSEWHERE' });
    expect(r['https://b.example.org/post']).toMatchObject({ indexStatus: 'UNKNOWN' });
    expect(r['https://b.example.org/post']!.indexReason).toMatch(/robots\.txt \(HTTP 503\)/);
    expect(r['https://gone.example.net/post']).toMatchObject({ indexStatus: 'NOT_REACHABLE', status: 'DEAD' });
    expect(r['https://a.example.com/ok']!.indexEvidence!.length).toBeGreaterThan(2);

    // robots.txt for a.example.com fetched once for five pages; none for a site whose page is gone.
    expect(net.requested.filter((u) => u === 'https://a.example.com/robots.txt')).toHaveLength(1);
    expect(net.requested).not.toContain('https://gone.example.net/robots.txt');

    const scan = await detail(id);
    expect(scan).toMatchObject({
      tool: 'index',
      status: 'completed',
      indexableCount: 1,
      indexIssueCount: 5,
      indexUnknownCount: 1,
    });
    const all = await rowsOf(id);
    expect(all.facets.index).toEqual({
      INDEXABLE: 1,
      NOINDEX: 2,
      ROBOTS_BLOCKED: 1,
      CANONICAL_ELSEWHERE: 1,
      UNKNOWN: 1,
      NOT_REACHABLE: 1,
    });
    expect(all.facets.groups).toMatchObject({ indexable: 1, noindex: 2, robots_blocked: 1, index_unknown: 1 });
  });

  it('filters and sorts by index result (most urgent first)', async () => {
    fakeInternet(
      { 'c.example.com': PUBLIC },
      {
        'https://c.example.com/robots.txt': { status: 404 },
        'https://c.example.com/1': page(),
        'https://c.example.com/2': page('<meta name="robots" content="none">'),
      },
    );
    const id = await makeScan(['https://c.example.com/1', 'https://c.example.com/2', 'https://c.example.com/3']);
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    await drain(env);
    expect((await rowsOf(id, 'status=noindex')).rows.map((x) => x.url)).toEqual(['https://c.example.com/2']);
    expect((await rowsOf(id, 'sort=status')).rows.map((x) => x.indexStatus)).toEqual([
      'NOT_REACHABLE',
      'NOINDEX',
      'INDEXABLE',
    ]);
  });

  it('reuses a cached robots.txt across batches and scans, for a day', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://d.example.com/p${i}`);
    const pages: Record<string, ReturnType<typeof page> | ReturnType<typeof robots>> = {
      'https://d.example.com/robots.txt': robots('User-agent: *\nAllow: /'),
    };
    for (const u of urls) pages[u] = page();
    const net = fakeInternet({ 'd.example.com': PUBLIC }, pages);
    const first = await makeScan(urls);
    await api(`/api/scans/${first}/start`, { method: 'POST' });
    await drain(env); // two batches
    const second = await makeScan(urls.slice(0, 2));
    await api(`/api/scans/${second}/start`, { method: 'POST' });
    await drain(env);
    expect(net.requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);

    await sql(`UPDATE robots_cache SET fetched_at = now() - interval '25 hours'`);
    const third = await makeScan(urls.slice(0, 1));
    await api(`/api/scans/${third}/start`, { method: 'POST' });
    await drain(env);
    expect(net.requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('Link Health scans don’t fetch robots.txt or judge indexing', async () => {
    const net = fakeInternet({ 'e.example.com': PUBLIC }, { 'https://e.example.com/a': page() });
    const id = await makeScan(['https://e.example.com/a'], 'links');
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    await drain(env);
    expect(net.requested).toEqual(['https://e.example.com/a']);
    expect((await rowsOf(id)).rows[0]).toMatchObject({ status: 'ACTIVE', indexStatus: null });
  });

  it('an index batch stays within its database budget', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://h${i}.example.com/`);
    const pages: Record<string, ReturnType<typeof page>> = {};
    for (const u of urls) pages[u] = page();
    fakeInternet(Object.fromEntries(urls.map((u) => [new URL(u).hostname, PUBLIC])), pages);
    const id = await makeScan(urls);
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    queryCounter.reset();
    await drain(env, 1);
    // read scan, reserve, robots cache read + write, save, recount
    expect(queryCounter.count).toBeLessThanOrEqual(7);
  });
});

describe('running an index check on a Link Health scan', () => {
  it('copies the links and rows into a new index check and starts it; the original is untouched', async () => {
    fakeInternet(
      { 'f.example.com': PUBLIC },
      { 'https://f.example.com/robots.txt': { status: 404 }, 'https://f.example.com/a': page() },
    );
    const source = await makeScan(['https://f.example.com/a', 'https://f.example.com/b'], 'links');
    const res = await api(`/api/scans/${source}/index-check`, { method: 'POST' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as IndexCheckFromScanResponse;
    expect(id).not.toBe(source);

    const created = await detail(id);
    expect(created).toMatchObject({ tool: 'index', sourceScanId: source, status: 'queued', uniqueUrls: 2 });
    await drain(env);
    const rows = await rowsOf(id);
    expect(rows.rows.map((r) => [r.row, r.url, r.indexStatus])).toEqual([
      [2, 'https://f.example.com/a', 'INDEXABLE'],
      [3, 'https://f.example.com/b', 'NOT_REACHABLE'],
    ]);
    expect((await detail(source)).status).toBe('ready'); // not started, not changed
  });

  it("can't copy someone else's scan or an unfinished upload", async () => {
    expect((await api('/api/scans/00000000-0000-4000-8000-000000000000/index-check', { method: 'POST' })).status).toBe(
      404,
    );
    const { id } = (await (
      await api('/api/scans', {
        method: 'POST',
        json: {
          fileName: 'f',
          fileSize: 1,
          worksheets: 1,
          sheets: [],
          headers: [],
          totalRows: 1,
          uniqueUrls: 1,
          blankRows: 0,
        },
      })
    ).json()) as { id: string };
    expect((await api(`/api/scans/${id}/index-check`, { method: 'POST' })).status).toBe(409);
  });
});

describe('two tools, two lists', () => {
  it('scan lists and the dashboard keep Link Health and Index Checker apart', async () => {
    fakeInternet({}, {});
    await makeScan(['https://x.example.com/1'], 'links');
    await makeScan(['https://x.example.com/2'], 'index');
    await makeScan(['https://x.example.com/3'], 'index');
    const links = (await (await api('/api/scans')).json()) as ScanListResponse;
    const index = (await (await api('/api/scans?tool=index')).json()) as ScanListResponse;
    expect(links.scans.map((s) => s.tool)).toEqual(['links']);
    expect(index.scans.map((s) => s.tool)).toEqual(['index', 'index']);
    const dash = (await (await api('/api/dashboard')).json()) as DashboardSummary;
    expect(dash).toMatchObject({ totalScans: 1, indexChecks: 2 });
    expect(dash.recentIndexChecks).toHaveLength(2);
  });

  it('rejects an unknown tool', async () => {
    const res = await api('/api/scans', {
      method: 'POST',
      json: {
        tool: 'spy',
        fileName: 'f',
        fileSize: 1,
        worksheets: 1,
        sheets: [],
        headers: [],
        totalRows: 1,
        uniqueUrls: 1,
        blankRows: 0,
      },
    });
    expect(res.status).toBe(400);
  });
});
