import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanDetail, ScanRowsResponse, ScanSummary } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { reviveStalled } from '../../src/worker/queue';
import { call, consumerDb, cookieFrom, drain, ORIGIN, queueOf, signedIn, sql, testEnv } from './helpers';

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

const start = async (id: string) => (await (await api(`/api/scans/${id}/start`, { method: 'POST' })).json()) as ScanSummary;
const pause = async (id: string) => (await (await api(`/api/scans/${id}/pause`, { method: 'POST' })).json()) as ScanSummary;
const detail = async (id: string) => (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;

describe('background checking (POST /api/scans/:id/start + queue)', () => {
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

    const started = await start(id);
    expect(started.status).toBe('queued');
    expect(queueOf(env).sent).toHaveLength(1);

    const outcomes = await drain(env);
    expect(outcomes.map((o) => o.kind)).toEqual(['next', 'done']); // 12 links, 8 per batch
    expect(queueOf(env).sent).toHaveLength(0);

    const scan = await detail(id);
    expect(scan).toMatchObject({
      status: 'completed',
      checkedCount: 12,
      activeCount: 8,
      deadCount: 2,
      blockedCount: 2,
      errorCount: 0,
    });
    expect(scan.completedAt).not.toBeNull();
    expect(scan.startedAt).not.toBeNull();

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

  it('pressing Start twice starts only one chain', async () => {
    fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    await start(id);
    await start(id);
    expect(queueOf(env).sent).toHaveLength(1);
  });

  it('a completed scan is not started again', async () => {
    fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    await start(id);
    await drain(env);
    expect((await start(id)).status).toBe('completed');
    expect(queueOf(env).sent).toHaveLength(0);
  });

  it('pause stops the chain; resume carries on from where it stopped', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://p${i}.example.com/`);
    const net = fakeInternet(Object.fromEntries(urls.map((u) => [new URL(u).hostname, PUBLIC])), {});
    const id = await makeScan(urls);
    await start(id);
    await drain(env, 1); // one batch of 8
    expect((await pause(id)).status).toBe('paused');
    const afterPause = await drain(env); // the already-queued message is dropped
    expect(afterPause).toEqual([{ kind: 'dropped', why: 'old-chain' }]);
    expect(net.requested).toHaveLength(8);
    expect((await detail(id)).checkedCount).toBe(8);

    expect((await start(id)).status).toBe('queued');
    await drain(env);
    const scan = await detail(id);
    expect(scan.status).toBe('completed');
    expect(scan.checkedCount).toBe(20);
  });

  it('resuming a scan with nothing left to check completes it', async () => {
    fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    await start(id);
    await drain(env);
    // As if Pause landed while the final batch ran.
    await sql(`UPDATE scans SET status = 'paused', completed_at = NULL WHERE id = $1`, [id]);
    await start(id);
    expect(await drain(env)).toEqual([{ kind: 'done' }]);
    const scan = await detail(id);
    expect(scan.status).toBe('completed');
    expect(scan.completedAt).not.toBeNull();
  });

  it('shows as running while it waits for retries', async () => {
    fakeInternet({ 'busy.example.com': PUBLIC }, { 'https://busy.example.com/': { status: 429 } });
    const id = await makeScan(['https://busy.example.com/']);
    await start(id);
    await drain(env, 1);
    await pause(id);
    expect(await drain(env)).toEqual([{ kind: 'dropped', why: 'old-chain' }]);
    await start(id); // resume while the retry isn't due yet
    const [o] = await drain(env, 1);
    expect(o?.kind).toBe('next');
    expect((o as { delaySeconds: number }).delaySeconds).toBeGreaterThanOrEqual(50);
    expect((await detail(id)).status).toBe('running');
  });

  it('drops messages for a deleted scan', async () => {
    fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    await start(id);
    await api(`/api/scans/${id}`, { method: 'DELETE' });
    expect(await drain(env)).toEqual([{ kind: 'dropped', why: 'missing' }]);
  });

  it('retries temporary failures later, then keeps the last answer', async () => {
    const net = fakeInternet({ 'busy.example.com': PUBLIC }, { 'https://busy.example.com/': { status: 503 } });
    const id = await makeScan(['https://busy.example.com/']);
    await start(id);

    // Attempt 1: 503 → stays "to do" with a retry time; the chain waits.
    let [o] = await drain(env, 1);
    expect(o).toEqual({ kind: 'next', delaySeconds: 0 });
    let [row] = await sql<{ status: string; attempts: number; retry_at: string | null }>(
      'SELECT status, attempts, retry_at FROM unique_urls WHERE scan_id = $1',
      [id],
    );
    expect(row).toMatchObject({ status: 'SERVER_ERROR', attempts: 1 });
    expect(Number(row!.retry_at)).toBeGreaterThan(Date.now() / 1000 + 50);
    const waiting = await detail(id);
    expect(waiting.status).toBe('running');

    // Nothing due yet: the next message just waits (about a minute).
    [o] = await drain(env, 1);
    expect(o?.kind).toBe('next');
    expect((o as { delaySeconds: number }).delaySeconds).toBeGreaterThanOrEqual(50);

    // Make the retry due, then attempts 2 and 3.
    for (let attempt = 2; attempt <= 3; attempt++) {
      await sql('UPDATE unique_urls SET retry_at = 1 WHERE scan_id = $1', [id]);
      queueOf(env).sent.forEach((m) => (m.delaySeconds = 0));
      await drain(env, 1);
    }
    [row] = await sql('SELECT status, attempts, retry_at FROM unique_urls WHERE scan_id = $1', [id]);
    expect(row).toMatchObject({ status: 'SERVER_ERROR', attempts: 3, retry_at: null });
    expect(net.requested).toHaveLength(3);
    const done = await detail(id);
    expect(done.status).toBe('completed');
    expect(done.errorCount).toBe(1);
  });

  it('firm answers (404, DNS not found) are not retried', async () => {
    fakeInternet({ 'gone.example.com': PUBLIC }, { 'https://gone.example.com/': { status: 404 } });
    const id = await makeScan(['https://gone.example.com/', 'https://nxdomain.example.com/']);
    await start(id);
    await drain(env);
    const rows = await sql<{ retry_at: string | null; attempts: number }>(
      'SELECT retry_at, attempts FROM unique_urls WHERE scan_id = $1',
      [id],
    );
    expect(rows.every((r) => r.retry_at === null && r.attempts === 1)).toBe(true);
    expect((await detail(id)).status).toBe('completed');
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
    await start(id);
    const [first] = await drain(env, 1);
    expect(first).toEqual({ kind: 'next', delaySeconds: 0 }); // no waiting: carry straight on
    expect(queueOf(env).sent[0]?.body.size).toBe(1); // …one link at a time, so each gets the whole budget
    const [pending] = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM unique_urls WHERE scan_id = $1 AND status = 'PENDING' AND claimed_at IS NULL`,
      [id],
    );
    expect(pending?.n).toBeGreaterThan(0);
    await drain(env);
    const scan = await detail(id);
    expect(scan.status).toBe('completed');
    expect(scan.activeCount + scan.redirectedCount).toBe(8);
  });

  it('takes over links abandoned mid-check', async () => {
    fakeInternet({ 'z.example.com': PUBLIC }, { 'https://z.example.com/': { status: 200 } });
    const id = await makeScan(['https://z.example.com/']);
    await sql(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = 1 WHERE scan_id = $1`, [id]);
    await start(id);
    await drain(env);
    const scan = await detail(id);
    expect(scan.status).toBe('completed');
    expect(scan.activeCount).toBe(1);
  });

  it('waits (without requests) for links another batch is checking right now', async () => {
    const net = fakeInternet({ 'y.example.com': PUBLIC }, { 'https://y.example.com/': { status: 200 } });
    const id = await makeScan(['https://y.example.com/']);
    await sql(`UPDATE unique_urls SET status = 'CHECKING', claimed_at = $2 WHERE scan_id = $1`, [
      id,
      Math.floor(Date.now() / 1000),
    ]);
    await start(id);
    const [o] = await drain(env, 1);
    expect(o).toEqual({ kind: 'next', delaySeconds: 60 });
    expect(net.requested).toHaveLength(0);
  });

  it('the safety net restarts a scan whose chain went quiet', async () => {
    fakeInternet({ 'q.example.com': PUBLIC }, { 'https://q.example.com/': { status: 200 } });
    const id = await makeScan(['https://q.example.com/']);
    await start(id);
    queueOf(env).sent.length = 0; // the message was lost
    expect(await reviveStalled(consumerDb(), queueOf(env))).toBe(0); // heartbeat still fresh
    await sql(`UPDATE scans SET heartbeat_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
    expect(await reviveStalled(consumerDb(), queueOf(env))).toBe(1);
    await drain(env);
    expect((await detail(id)).status).toBe('completed');
  });

  it('the safety net leaves paused and finished scans alone', async () => {
    fakeInternet({ 'q.example.com': PUBLIC }, {});
    const a = await makeScan(['https://q.example.com/a']);
    const b = await makeScan(['https://q.example.com/b']);
    await start(a);
    await pause(a);
    await sql(`UPDATE scans SET heartbeat_at = now() - interval '1 day'`);
    expect(await reviveStalled(consumerDb(), queueOf(env))).toBe(0);
    expect((await detail(b)).status).toBe('ready');
  });

  it("can't start someone else's scan", async () => {
    fakeInternet({ 'a.example.com': PUBLIC }, { 'https://a.example.com/': { status: 200 } });
    const id = await makeScan(['https://a.example.com/']);
    const otherEnv = { ...env, AUTH_EMAIL: 'other@example.com', AUTH_PASSWORD: 'other password 123' };
    const login = await call(otherEnv, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.44' },
      body: JSON.stringify({ email: 'other@example.com', password: 'other password 123' }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    for (const action of ['start', 'pause']) {
      const res = await call(otherEnv, `/api/scans/${id}/${action}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN },
      });
      expect(res.status).toBe(404);
    }
    expect(queueOf(env).sent).toHaveLength(0);
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
    expect((await api(`/api/scans/${id}/start`, { method: 'POST' })).status).toBe(409);
    expect((await detail(id)).status).toBe('uploading');
    expect(queueOf(env).sent).toHaveLength(0);
  });
});
