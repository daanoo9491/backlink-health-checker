import { beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_PAGE_SIZE, type ExportPageResponse, type ScanRowInput } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { call, signedIn, sql, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});

/** A saved scan with `n` rows on two sheets; every 3rd row repeats a link, the last one is invalid. */
async function scanWith(n: number, opts: { complete?: boolean } = {}): Promise<string> {
  const urls: string[] = [];
  const rows: ScanRowInput[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dup = i % 3 === 2;
    if (!dup) urls.push(`https://site${i}.example.com/post`);
    rows.push({
      sheet: i < n / 2 ? 'Guest Posts' : 'Directories',
      row: i + 2,
      value: dup ? urls[urls.length - 1]! : urls[urls.length - 1]!,
      urlIndex: urls.length - 1,
      duplicate: dup,
      cells: { Backlinks: urls[urls.length - 1]!, DA: String(i), Notes: i === 0 ? '=1+1' : '' },
    });
  }
  rows.push({
    sheet: 'Directories',
    row: n + 1,
    value: 'nope',
    invalidReason: 'NOT_A_URL',
    cells: { Backlinks: 'nope' },
  });
  const res = await api('/api/scans', {
    method: 'POST',
    json: {
      fileName: 'Big.xlsx',
      fileSize: 1000,
      worksheets: 2,
      sheets: [
        { name: 'Guest Posts', hidden: false, status: 'used', rows: 1, valid: 1, invalid: 0, blank: 0 },
        { name: 'Directories', hidden: false, status: 'used', rows: 1, valid: 1, invalid: 1, blank: 0 },
      ],
      headers: ['Backlinks', 'DA', 'Notes'],
      totalRows: rows.length,
      uniqueUrls: urls.length,
      blankRows: 0,
    },
  });
  const { id } = (await res.json()) as { id: string };
  expect((await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } })).status).toBe(200);
  for (let i = 0; i < rows.length; i += 500) {
    expect(
      (await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows: rows.slice(i, i + 500) } })).status,
    ).toBe(200);
  }
  if (opts.complete !== false) expect((await api(`/api/scans/${id}/complete`, { method: 'POST' })).status).toBe(200);
  return id;
}

const page = async (id: string, query = '') => {
  const res = await api(`/api/scans/${id}/export${query ? `?${query}` : ''}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ExportPageResponse;
};

async function all(
  id: string,
  query = '',
): Promise<{ rows: ExportPageResponse['rows']; pages: number; total: number | null }> {
  const out: ExportPageResponse['rows'] = [];
  let after = '';
  let pages = 0;
  let total: number | null = null;
  for (;;) {
    const q = new URLSearchParams(query);
    if (after) q.set('after', after);
    const p = await page(id, q.toString());
    pages++;
    if (pages === 1) total = p.total;
    else expect(p.total).toBeNull(); // counted once, on the first page
    out.push(...p.rows);
    if (!p.next) break;
    after = p.next;
  }
  return { rows: out, pages, total };
}

describe('export rows', () => {
  it('hands out every row once, in workbook order, a page at a time', async () => {
    const id = await scanWith(600);
    const { rows, pages, total } = await all(id);
    expect(total).toBe(600);
    expect(rows).toHaveLength(600);
    expect(pages).toBe(Math.ceil(600 / EXPORT_PAGE_SIZE));
    expect(rows.map((r) => r.row)).toEqual(Array.from({ length: 600 }, (_, i) => i + 2));
    expect(rows[0]).toMatchObject({
      sheet: 'Guest Posts',
      url: 'https://site0.example.com/post',
      cells: { Backlinks: 'https://site0.example.com/post', DA: '0', Notes: '=1+1' },
      status: 'PENDING',
      duplicate: false,
    });
    expect(rows[2]!.duplicate).toBe(true);
    expect(rows[599]).toMatchObject({ url: null, invalidReason: 'NOT_A_URL', cells: { Backlinks: 'nope' } });
  });

  it('includes results, index evidence and Google check time', async () => {
    const id = await scanWith(4);
    await sql(
      `UPDATE unique_urls SET status = 'DEAD', http_status = 404, check_reason = 'Not found', page_title = 'Oops',
              checked_at = '2026-10-01T10:00:00Z', response_time_ms = 321,
              index_status = 'NOT_INDEXED', index_source = 'google_search', index_reason = 'No result',
              index_evidence = '[{"signal":"google","text":"no results","bad":true}]'::jsonb,
              google_checked_at = '2026-10-02T11:00:00Z'
       WHERE scan_id = $1 AND url_index = 0`,
      [id],
    );
    const { rows } = await all(id);
    expect(rows[0]).toMatchObject({
      status: 'DEAD',
      httpStatus: 404,
      checkReason: 'Not found',
      pageTitle: 'Oops',
      responseTimeMs: 321,
      checkedAt: '2026-10-01T10:00:00.000Z',
      indexStatus: 'NOT_INDEXED',
      indexSource: 'google_search',
      indexReason: 'No result',
      indexEvidence: [{ signal: 'google', text: 'no results', bad: true }],
      googleCheckedAt: '2026-10-02T11:00:00.000Z',
    });
  });

  it('applies the same filters as the results table', async () => {
    const id = await scanWith(10);
    await sql(`UPDATE unique_urls SET status = 'DEAD' WHERE scan_id = $1 AND url_index IN (0, 1)`, [id]);
    const dead = await all(id, 'status=dead');
    expect(dead.total).toBe(dead.rows.length);
    expect(dead.rows.every((r) => r.status === 'DEAD')).toBe(true);
    expect(dead.rows.map((r) => r.row)).toEqual([2, 3, 4]); // the repeat of a dead link is included
    const sheet = await all(id, 'sheet=Directories');
    expect(sheet.rows.every((r) => r.sheet === 'Directories')).toBe(true);
    const skipped = await all(id, 'status=skipped');
    expect(skipped.rows.map((r) => r.value)).toEqual(['nope']);
    const search = await all(id, 'q=SITE4.example');
    expect(search.rows.map((r) => r.url)).toEqual(['https://site4.example.com/post', 'https://site4.example.com/post']);
  });

  it('never skips or repeats rows when results change between pages', async () => {
    const id = await scanWith(600);
    const first = await page(id);
    // Checking carries on in the background while the browser fetches the next page.
    await sql(`UPDATE unique_urls SET status = 'ACTIVE' WHERE scan_id = $1`, [id]);
    const rest = await all(id, `after=${first.next}`);
    const seen = [...first.rows, ...rest.rows].map((r) => `${r.sheet}:${r.row}`);
    expect(new Set(seen).size).toBe(600);
    expect(seen).toHaveLength(600);
  });

  it('ignores a malformed cursor and starts from the beginning', async () => {
    const id = await scanWith(5);
    const p = await page(id, 'after=1;DROP TABLE scans');
    expect(p.rows[0]!.row).toBe(2);
    expect(p.total).toBe(5);
  });

  it('is only for the signed-in owner, and only for saved scans', async () => {
    const id = await scanWith(5, { complete: false });
    expect((await api(`/api/scans/${id}/export`)).status).toBe(409);
    expect((await api(`/api/scans/00000000-0000-4000-8000-000000000000/export`)).status).toBe(404);
    expect((await call(env, `/api/scans/${id}/export`)).status).toBe(401);
  });

  it('is not cached by the browser', async () => {
    const id = await scanWith(3);
    expect((await api(`/api/scans/${id}/export`)).headers.get('Cache-Control')).toBe('no-store');
  });
});
