/**
 * Keeps database usage in check. Each endpoint the scan page calls while
 * checking has a fixed query budget, so a big workbook or a long check can't
 * quietly multiply database usage (which is what exhausted D1's daily limit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckBatchResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { queryCounter, signedIn, sql, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
let id: string;
afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
  const urls = Array.from({ length: 20 }, (_, i) => `https://s${i}.example.com/`);
  fakeInternet(Object.fromEntries(urls.map((u) => [new URL(u).hostname, ['93.184.216.34']])), {});
  const rows = urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: {} }));
  id = (
    (await (
      await api('/api/scans', {
        method: 'POST',
        json: {
          fileName: 'f.xlsx',
          fileSize: 1,
          worksheets: 1,
          sheets: [{ name: 'S', hidden: false, status: 'used', rows: 20, valid: 20, invalid: 0, blank: 0 }],
          headers: ['Backlinks'],
          totalRows: 20,
          uniqueUrls: 20,
          blankRows: 0,
        },
      })
    ).json()) as { id: string }
  ).id;
  await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
  await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows } });
  await api(`/api/scans/${id}/complete`, { method: 'POST' });
});

describe('database queries per request', () => {
  it('a checking batch: at most 5 queries (read scan, reserve, save, recount+return)', async () => {
    queryCounter.reset();
    const r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(r.processed).toBeGreaterThan(0);
    expect(queryCounter.count).toBeLessThanOrEqual(5);
  });

  it('an idle batch (everything reserved elsewhere): at most 3 queries, and it says to wait', async () => {
    await sql(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = $2 WHERE scan_id = $1`, [
      id,
      Math.floor(Date.now() / 1000),
    ]);
    queryCounter.reset();
    const r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    expect(r).toMatchObject({ processed: 0, remaining: 20, retryAfterMs: 5_000 });
    expect(queryCounter.count).toBeLessThanOrEqual(3);
  });

  it('no wait hint once everything is checked', async () => {
    let r: CheckBatchResponse | null = null;
    for (let i = 0; i < 5 && r?.remaining !== 0; i++) {
      r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    }
    expect(r).toMatchObject({ remaining: 0 });
    expect(r!.retryAfterMs).toBeUndefined();
    expect(r!.scan.status).toBe('completed');
  });

  it('a results page with filter counts: at most 5 queries', async () => {
    queryCounter.reset();
    const res = await api(`/api/scans/${id}/rows?status=active&q=example`);
    expect(res.status).toBe(200);
    expect(queryCounter.count).toBeLessThanOrEqual(5);
  });

  it('checking a whole scan uses a predictable number of queries', async () => {
    queryCounter.reset();
    let batches = 0;
    for (let r: CheckBatchResponse | null = null; r?.remaining !== 0 && batches < 10; batches++) {
      r = (await (await api(`/api/scans/${id}/check`, { method: 'POST' })).json()) as CheckBatchResponse;
    }
    expect(batches).toBe(3); // 20 links, 8 per batch
    expect(queryCounter.count).toBeLessThanOrEqual(batches * 5);
  });
});
