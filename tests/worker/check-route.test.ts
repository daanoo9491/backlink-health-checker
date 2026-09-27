import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckBatchResponse, ScanDetail, ScanRowsResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { call, cookieFrom, ORIGIN, signedIn, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});
afterEach(() => vi.unstubAllGlobals());

async function makeScan(urls: string[], extraRows = 0): Promise<string> {
  const rows = urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: {} }));
  for (let k = 0; k < extraRows; k++) {
    rows.push({ sheet: 'S', row: urls.length + 2 + k, value: urls[0]!, urlIndex: 0, cells: {} });
  }
  const { id } = (await (
    await api('/api/scans', {
      method: 'POST',
      json: {
        fileName: 'f.xlsx',
        fileSize: 1,
        worksheets: 1,
        sheets: [],
        headers: ['Backlinks'],
        totalRows: rows.length,
        uniqueUrls: urls.length,
        blankRows: 0,
      },
    })
  ).json()) as { id: string };
  await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
  await api(`/api/scans/${id}/rows`, {
    method: 'POST',
    json: { rows: rows.map((r, i) => (i >= urls.length ? { ...r, duplicate: true } : r)) },
  });
  await api(`/api/scans/${id}/complete`, { method: 'POST' });
  return id;
}

const PUBLIC = ['93.184.216.34'];

describe('POST /api/scans/:id/check', () => {
  it('checks every link in batches, updates totals and completes the scan', async () => {
    const dns: Record<string, string[]> = {};
    const pages: Record<string, { status: number }> = {};
    const urls: string[] = [];
    for (let i = 0; i < 12; i++) {
      const host = `site${i}.example.com`;
      dns[host] = PUBLIC;
      const u = `https://${host}/post`;
      urls.push(u);
      pages[u] = { status: i < 8 ? 200 : i < 10 ? 404 : 403 };
    }
    fakeInternet(dns, pages);
    const id = await makeScan(urls, 3);

    let last: CheckBatchResponse | null = null;
    for (let n = 0; n < 10; n++) {
      last = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
      if (last.remaining === 0) break;
    }
    expect(last!.remaining).toBe(0);
    expect(last!.scan).toMatchObject({
      status: 'completed',
      checkedCount: 12,
      activeCount: 8,
      deadCount: 2,
      blockedCount: 2,
      errorCount: 0,
    });
    expect(last!.scan.completedAt).not.toBeNull();

    // Every row sharing a link shows that link's result.
    const page = (await (await api(`/api/scans/${id}/rows?pageSize=25`)).json()) as ScanRowsResponse;
    const dupRows = page.rows.filter((r) => r.url === urls[0]);
    expect(dupRows).toHaveLength(4);
    expect(dupRows.every((r) => r.status === 'ACTIVE' && r.httpStatus === 200)).toBe(true);
    expect(page.rows.find((r) => r.url === urls[8])).toMatchObject({
      status: 'DEAD',
      checkReason: 'HTTP 404 Not Found',
    });
  });

  it('marks the scan running with a start time after the first batch', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://s${i}.example.com/`);
    fakeInternet(Object.fromEntries(urls.map((u) => [new URL(u).hostname, PUBLIC])), {});
    const id = await makeScan(urls);
    const first = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(first.processed).toBeGreaterThan(0);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.scan.status).toBe('running');
    expect(first.scan.startedAt).not.toBeNull();
  });

  it('puts links back in the queue when the request budget runs out', async () => {
    // Every link redirects 5 times on a new host: far more requests than one batch may make.
    const dns: Record<string, string[]> = {};
    const pages: Record<string, { status: number; location?: string }> = {};
    const urls: string[] = [];
    for (let i = 0; i < 8; i++) {
      for (let h = 0; h < 6; h++) dns[`l${i}h${h}.example.com`] = PUBLIC;
      for (let h = 0; h < 5; h++) {
        pages[`https://l${i}h${h}.example.com/`] = { status: 301, location: `https://l${i}h${h + 1}.example.com/` };
      }
      pages[`https://l${i}h5.example.com/`] = { status: 200 };
      urls.push(`https://l${i}h0.example.com/`);
    }
    fakeInternet(dns, pages);
    const id = await makeScan(urls);
    const r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(r.processed).toBeLessThan(8);
    expect(r.remaining).toBe(8 - r.processed);
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM unique_urls WHERE scan_id = ?1 AND status = 'PENDING' AND claimed_at IS NULL`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(pending?.n).toBe(r.remaining);
  });

  it('takes over links abandoned mid-check (e.g. tab closed)', async () => {
    fakeInternet({ 'z.example.com': PUBLIC }, { 'https://z.example.com/': { status: 200 } });
    const id = await makeScan(['https://z.example.com/']);
    await env.DB.prepare(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = 1 WHERE scan_id = ?1`)
      .bind(id)
      .run();
    const r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(r.scan.status).toBe('completed');
    expect(r.scan.activeCount).toBe(1);
  });

  it('does not touch links another batch is checking right now', async () => {
    const net = fakeInternet({ 'y.example.com': PUBLIC }, { 'https://y.example.com/': { status: 200 } });
    const id = await makeScan(['https://y.example.com/']);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = ?2 WHERE scan_id = ?1`)
      .bind(id, now)
      .run();
    const r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(r.processed).toBe(0);
    expect(r.remaining).toBe(1);
    expect(net.requested).toHaveLength(0);
  });

  it("can't check someone else's scan", async () => {
    const net = fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    const otherEnv = { ...env, AUTH_EMAIL: 'other@example.com', AUTH_PASSWORD: 'other password 123' };
    const login = await call(otherEnv, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.44' },
      body: JSON.stringify({ email: 'other@example.com', password: 'other password 123' }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    const res = await call(otherEnv, `/api/scans/${id}/check`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
    expect(net.requested).toHaveLength(0);
  });

  it('refuses unfinished uploads', async () => {
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
    expect((await api(`/api/scans/${id}/check`, { method: 'POST' })).status).toBe(409);
    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan.status).toBe('uploading');
  });
});
