/**
 * Keeps database usage in check. Each endpoint the scan page calls, and each
 * queue message, has a fixed query budget, so a big workbook or a long check
 * can't quietly multiply database usage (which is what exhausted D1's daily limit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanSummary } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { drain, queryCounter, queueOf, signedIn, sql, testEnv } from './helpers';

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

describe('database queries', () => {
  it('Start: at most 3 queries (session scan lookup + one update)', async () => {
    queryCounter.reset();
    const r = (await (await api(`/api/scans/${id}/start`, { method: 'POST' })).json()) as ScanSummary;
    expect(r.status).toBe('queued');
    expect(queryCounter.count).toBeLessThanOrEqual(3);
  });

  it('a checking batch (one queue message): at most 5 queries', async () => {
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    queryCounter.reset();
    const [o] = await drain(env, 1);
    expect(o).toEqual({ kind: 'next', delaySeconds: 0 });
    expect(queryCounter.count).toBeLessThanOrEqual(5);
  });

  it('an idle batch (everything reserved elsewhere): at most 3 queries, and it waits', async () => {
    await sql(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = $2 WHERE scan_id = $1`, [
      id,
      Math.floor(Date.now() / 1000),
    ]);
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    queryCounter.reset();
    const [o] = await drain(env, 1);
    expect(o).toEqual({ kind: 'next', delaySeconds: 60 });
    expect(queueOf(env).sent[0]?.delaySeconds).toBe(60);
    expect(queryCounter.count).toBeLessThanOrEqual(3);
  });

  it('a polling request for the scan page: at most 2 queries', async () => {
    queryCounter.reset();
    expect((await api(`/api/scans/${id}`)).status).toBe(200);
    expect(queryCounter.count).toBeLessThanOrEqual(2);
  });

  it('a results page with filter counts: at most 5 queries', async () => {
    queryCounter.reset();
    const res = await api(`/api/scans/${id}/rows?status=active&q=example`);
    expect(res.status).toBe(200);
    expect(queryCounter.count).toBeLessThanOrEqual(5);
  });

  it('checking a whole scan uses a predictable number of queries and messages', async () => {
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    queryCounter.reset();
    const outcomes = await drain(env);
    expect(outcomes).toHaveLength(3); // 20 links, 8 per batch
    expect(outcomes.at(-1)).toEqual({ kind: 'done' });
    expect(queryCounter.count).toBeLessThanOrEqual(outcomes.length * 5);
  });
});
