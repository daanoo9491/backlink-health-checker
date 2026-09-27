import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  CreateScanRequest,
  DashboardSummary,
  ScanDetail,
  ScanListResponse,
  ScanRowInput,
  ScanRowsResponse,
} from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { call, signedIn, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});

const meta = (over: Partial<CreateScanRequest> = {}): CreateScanRequest => ({
  fileName: 'Backlinks.xlsx',
  fileSize: 12_345,
  worksheets: 2,
  sheets: [
    {
      name: 'Guest Posts',
      hidden: false,
      status: 'used',
      headerRow: 1,
      backlinksHeader: 'Backlinks',
      rows: 4,
      valid: 3,
      invalid: 1,
      blank: 1,
    },
    { name: 'Notes', hidden: false, status: 'no-backlinks-column', rows: 0, valid: 0, invalid: 0, blank: 0 },
  ],
  headers: ['Backlinks', 'Target URL', 'DA'],
  totalRows: 4,
  uniqueUrls: 2,
  blankRows: 1,
  ...over,
});

const urls = ['https://a.example.com/post', 'https://b.example.com/post'];
const rows: ScanRowInput[] = [
  {
    sheet: 'Guest Posts',
    row: 2,
    value: 'https://a.example.com/post',
    urlIndex: 0,
    targetUrl: 'https://lanop.co.uk/',
    cells: { Backlinks: 'https://a.example.com/post', DA: '45' },
  },
  {
    sheet: 'Guest Posts',
    row: 3,
    value: 'https://b.example.com/post',
    urlIndex: 1,
    cells: { Backlinks: 'https://b.example.com/post' },
  },
  {
    sheet: 'Guest Posts',
    row: 4,
    value: 'HTTPS://A.example.com/post#x',
    urlIndex: 0,
    duplicate: true,
    cells: { Backlinks: 'x' },
  },
  { sheet: 'Guest Posts', row: 5, value: 'not a link', invalidReason: 'NOT_A_URL', cells: { Backlinks: 'not a link' } },
];

async function createFullScan(): Promise<string> {
  const res = await api('/api/scans', { method: 'POST', json: meta() });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect((await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } })).status).toBe(200);
  expect((await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: rows.slice(0, 2) } })).status).toBe(200);
  expect((await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: rows.slice(2) } })).status).toBe(200);
  const done = await api(`/api/scans/${id}/complete`, { method: 'POST' });
  expect(done.status).toBe(200);
  return id;
}

describe('creating a scan', () => {
  it('saves the scan in steps and marks it ready with server-computed counts', async () => {
    const id = await createFullScan();
    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan).toMatchObject({
      status: 'ready',
      fileName: 'Backlinks.xlsx',
      totalRows: 4,
      validUrls: 3,
      invalidRows: 1,
      uniqueUrls: 2,
      duplicateRows: 1,
      blankRows: 1,
      checkedCount: 0,
    });
    expect(scan.sheets).toHaveLength(2);
    expect(scan.headers).toEqual(['Backlinks', 'Target URL', 'DA']);
  });

  it('keeps sheet, row number, original columns and links rows to their unique URL', async () => {
    const id = await createFullScan();
    const page = (await (await api(`/api/scans/${id}/rows?page=1&pageSize=25`)).json()) as ScanRowsResponse;
    expect(page.total).toBe(4);
    expect(page.rows[0]).toMatchObject({
      sheet: 'Guest Posts',
      row: 2,
      url: 'https://a.example.com/post',
      status: 'PENDING',
      targetUrl: 'https://lanop.co.uk/',
      duplicate: false,
    });
    expect(page.rows[2]).toMatchObject({ row: 4, url: 'https://a.example.com/post', duplicate: true });
    expect(page.rows[3]).toMatchObject({ row: 5, url: null, invalidReason: 'NOT_A_URL', status: null });

    const cells = await env.DB.prepare(`SELECT cells_json FROM scan_rows WHERE scan_id = ?1 AND row_number = 2`)
      .bind(id)
      .first<{ cells_json: string }>();
    expect(JSON.parse(cells!.cells_json)).toEqual({ Backlinks: 'https://a.example.com/post', DA: '45' });
  });

  it('checks each unique URL once: 4 rows, only 2 URL records', async () => {
    const id = await createFullScan();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM unique_urls WHERE scan_id = ?1')
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('retrying a chunk does not create duplicates', async () => {
    const res = await api('/api/scans', { method: 'POST', json: meta() });
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < 2; i++) {
      await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
      await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows } });
    }
    expect((await api(`/api/scans/${id}/complete`, { method: 'POST' })).status).toBe(200);
    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan.totalRows).toBe(4);
  });

  it('refuses to complete when part of the upload is missing', async () => {
    const { id } = (await (await api('/api/scans', { method: 'POST', json: meta() })).json()) as { id: string };
    await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
    await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: rows.slice(0, 3) } }); // one row short
    const res = await api(`/api/scans/${id}/complete`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('rejects unsafe or malformed data', async () => {
    const { id } = (await (await api('/api/scans', { method: 'POST', json: meta() })).json()) as { id: string };
    const bad = [
      { offset: 0, urls: ['javascript:alert(1)'] },
      { offset: 0, urls: ['ftp://x.example.com'] },
      { offset: 5, urls: urls }, // beyond declared total
      { offset: 0, urls: [] },
    ];
    for (const body of bad) {
      expect((await api(`/api/scans/${id}/urls`, { method: 'POST', json: body })).status).toBe(400);
    }
    const badRows = [
      { rows: [{ ...rows[0], urlIndex: 99 }] }, // points past the unique list
      { rows: [{ ...rows[3], invalidReason: 'MADE_UP' }] },
      { rows: [{ ...rows[0], row: 0 }] },
      { rows: [{ ...rows[0], cells: 'nope' }] },
    ];
    for (const body of badRows) {
      expect((await api(`/api/scans/${id}/rows`, { method: 'POST', json: body })).status).toBe(400);
    }
    expect((await api('/api/scans', { method: 'POST', json: { ...meta(), totalRows: 50_000 } })).status).toBe(400);
    expect(
      (await api('/api/scans', { method: 'POST', body: 'nope', headers: { 'Content-Type': 'application/json' } }))
        .status,
    ).toBe(400);
  });

  it('trims very long cells instead of failing the upload', async () => {
    const { id } = (await (
      await api('/api/scans', { method: 'POST', json: meta({ totalRows: 1, uniqueUrls: 1 }) })
    ).json()) as { id: string };
    await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls: [urls[0]] } });
    const long = { ...rows[0], cells: { Notes: 'x'.repeat(5000) } };
    expect((await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: [long] } })).status).toBe(200);
    const r = await env.DB.prepare('SELECT cells_json FROM scan_rows WHERE scan_id = ?1')
      .bind(id)
      .first<{ cells_json: string }>();
    expect((JSON.parse(r!.cells_json) as { Notes: string }).Notes).toHaveLength(1000);
  });

  it('cannot add to a scan once it is saved', async () => {
    const id = await createFullScan();
    expect((await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows } })).status).toBe(409);
  });
});

describe('large scans stay within free-plan limits', () => {
  it('saves 5,000 rows / 4,000 URLs in chunks', async () => {
    const U = 4000;
    const R = 5000;
    const bigUrls = Array.from({ length: U }, (_, i) => `https://site${i % 300}.example.com/post-${i}`);
    const bigRows: ScanRowInput[] = Array.from({ length: R }, (_, i) => ({
      sheet: 'Big',
      row: i + 2,
      value: bigUrls[i % U]!,
      urlIndex: i % U,
      duplicate: i >= U,
      cells: { Backlinks: bigUrls[i % U]!, 'Anchor Text': `anchor ${i}` },
    }));
    const { id } = (await (
      await api('/api/scans', { method: 'POST', json: meta({ totalRows: R, uniqueUrls: U, blankRows: 0 }) })
    ).json()) as { id: string };
    for (let o = 0; o < U; o += 2000) {
      expect(
        (await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: o, urls: bigUrls.slice(o, o + 2000) } }))
          .status,
      ).toBe(200);
    }
    for (let o = 0; o < R; o += 1000) {
      expect(
        (await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: bigRows.slice(o, o + 1000) } })).status,
      ).toBe(200);
    }
    const done = (await (await api(`/api/scans/${id}/complete`, { method: 'POST' })).json()) as ScanDetail;
    expect(done).toMatchObject({ status: 'ready', totalRows: R, uniqueUrls: U, duplicateRows: R - U });
  });
});

describe('reading, listing and deleting', () => {
  it('lists scans newest first and feeds the dashboard', async () => {
    await createFullScan();
    await createFullScan();
    const list = (await (await api('/api/scans')).json()) as ScanListResponse;
    expect(list.scans).toHaveLength(2);
    const dash = (await (await api('/api/dashboard')).json()) as DashboardSummary;
    expect(dash.totalScans).toBe(2);
    expect(dash.recentScans).toHaveLength(2);
  });

  it('leaves unfinished uploads out of the dashboard', async () => {
    await api('/api/scans', { method: 'POST', json: meta() });
    const dash = (await (await api('/api/dashboard')).json()) as DashboardSummary;
    expect(dash.totalScans).toBe(0);
  });

  it('deletes a scan and everything in it', async () => {
    const id = await createFullScan();
    expect((await api(`/api/scans/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/scans/${id}`)).status).toBe(404);
    for (const t of ['scan_rows', 'unique_urls']) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE scan_id = ?1`)
        .bind(id)
        .first<{ n: number }>();
      expect(n?.n).toBe(0);
    }
  });

  it('paginates rows', async () => {
    const id = await createFullScan();
    const p2 = (await (await api(`/api/scans/${id}/rows?page=2&pageSize=25`)).json()) as ScanRowsResponse;
    expect(p2.rows).toHaveLength(0);
    expect(p2.total).toBe(4);
  });
});

describe('privacy between users', () => {
  it("one user can't see, change or delete another user's scan", async () => {
    const id = await createFullScan();
    // A second account on the same database.
    const otherEnv = { ...env, AUTH_EMAIL: 'other@example.com', AUTH_PASSWORD: 'another long password' };
    const other = await (async () => {
      const res = await call(otherEnv, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://bhc.test', 'CF-Connecting-IP': '192.0.2.9' },
        body: JSON.stringify({ email: 'other@example.com', password: 'another long password' }),
      });
      const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0]!;
      return (path: string, init: RequestInit = {}) =>
        call(otherEnv, path, { ...init, headers: { Cookie: cookie, Origin: 'https://bhc.test' } });
    })();

    expect((await other(`/api/scans/${id}`)).status).toBe(404);
    expect((await other(`/api/scans/${id}/rows`)).status).toBe(404);
    expect((await other(`/api/scans/${id}`, { method: 'DELETE' })).status).toBe(404);
    const list = (await (await other('/api/scans')).json()) as ScanListResponse;
    expect(list.scans).toHaveLength(0);
    expect((await api(`/api/scans/${id}`)).status).toBe(200); // still there for the owner
  });

  it('requires sign-in', async () => {
    expect((await call(env, '/api/scans')).status).toBe(401);
    expect((await call(env, '/api/scans', { method: 'POST', headers: { Origin: 'https://bhc.test' } })).status).toBe(
      401,
    );
  });
});
