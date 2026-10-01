import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanRowsResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { drain, signedIn, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
let id: string;
afterEach(() => vi.unstubAllGlobals());

const PUBLIC = ['93.184.216.34'];
const URLS = [
  'https://medium.com/@lanop/post', // 0 Active, sheet A
  'https://blog.example.com/gone', // 1 Dead 404, sheet A
  'https://forum.example.org/thread', // 2 Blocked 403, sheet B
  'https://old.example.net/', // 3 Redirected, sheet B
  'https://news.example.com/100%_real', // 4 Active, sheet B (search chars % and _)
];

beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
  fakeInternet(
    {
      'medium.com': PUBLIC,
      'blog.example.com': PUBLIC,
      'forum.example.org': PUBLIC,
      'old.example.net': PUBLIC,
      'new.example.net': PUBLIC,
      'news.example.com': PUBLIC,
    },
    {
      [URLS[0]!]: { status: 200 },
      [URLS[2]!]: { status: 403 },
      [URLS[3]!]: { status: 301, location: 'https://new.example.net/home' },
      'https://new.example.net/home': { status: 200 },
      [URLS[4]!]: { status: 200 },
    },
  );
  const rows = [
    { sheet: 'A', row: 2, value: URLS[0]!, urlIndex: 0, targetUrl: 'https://lanop.co.uk/', cells: {} },
    { sheet: 'A', row: 3, value: URLS[1]!, urlIndex: 1, cells: {} },
    { sheet: 'A', row: 4, value: 'not a link', invalidReason: 'NOT_A_URL', cells: {} },
    { sheet: 'B', row: 2, value: URLS[2]!, urlIndex: 2, cells: {} },
    { sheet: 'B', row: 3, value: URLS[3]!, urlIndex: 3, targetUrl: 'https://lanop.co.uk/vat', cells: {} },
    { sheet: 'B', row: 4, value: URLS[0]!, urlIndex: 0, duplicate: true, cells: {} },
    { sheet: 'B', row: 5, value: URLS[4]!, urlIndex: 4, cells: {} },
  ];
  id = (
    (await (
      await api('/api/scans', {
        method: 'POST',
        json: {
          fileName: 'f.xlsx',
          fileSize: 1,
          worksheets: 2,
          sheets: ['A', 'B'].map((name) => ({
            name,
            hidden: false,
            status: 'used',
            rows: 0,
            valid: 0,
            invalid: 0,
            blank: 0,
          })),
          headers: [],
          totalRows: rows.length,
          uniqueUrls: URLS.length,
          blankRows: 0,
        },
      })
    ).json()) as { id: string }
  ).id;
  await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls: URLS } });
  await api(`/api/scans/${id}/rows`, { method: 'POST', json: { rows } });
  await api(`/api/scans/${id}/complete`, { method: 'POST' });
  await api(`/api/scans/${id}/start`, { method: 'POST' });
  await drain(env);
});

const get = async (qs: string) => (await (await api(`/api/scans/${id}/rows?${qs}`)).json()) as ScanRowsResponse;
const rowIds = (r: ScanRowsResponse) => r.rows.map((x) => `${x.sheet}${x.row}`);

describe('row filters', () => {
  it('counts rows per status group', async () => {
    const r = await get('');
    expect(r.total).toBe(7);
    expect(r.facets.groups).toEqual({
      all: 7,
      active: 3, // A2, B4 (repeat of A2), B5
      dead: 1,
      redirected: 1,
      review: 1,
      waiting: 0,
      skipped: 1,
    });
    expect(r.facets.sheets).toEqual(['A', 'B']);
    expect(r.facets.httpCodes).toEqual([200, 403, 404]);
  });

  it('filters by status group', async () => {
    expect(rowIds(await get('status=active'))).toEqual(['A2', 'B4', 'B5']);
    expect(rowIds(await get('status=dead'))).toEqual(['A3']);
    expect(rowIds(await get('status=review'))).toEqual(['B2']);
    expect(rowIds(await get('status=redirected'))).toEqual(['B3']);
    expect(rowIds(await get('status=skipped'))).toEqual(['A4']);
  });

  it('filters by sheet, and group counts follow the other filters', async () => {
    const r = await get('sheet=B');
    expect(rowIds(r)).toEqual(['B2', 'B3', 'B4', 'B5']);
    expect(r.facets.groups.active).toBe(2);
    expect(r.facets.groups.dead).toBe(0);
    expect(rowIds(await get('sheet=B&status=active'))).toEqual(['B4', 'B5']);
  });

  it('filters by HTTP code, including "no response"', async () => {
    expect(rowIds(await get('http=404'))).toEqual(['A3']);
    expect(rowIds(await get('http=none'))).toEqual(['A4']); // the skipped row
  });

  it('searches the backlink and the target URL, case-insensitively', async () => {
    expect(rowIds(await get('q=MEDIUM'))).toEqual(['A2', 'B4']);
    expect(rowIds(await get('q=lanop.co.uk/vat'))).toEqual(['B3']);
    expect(rowIds(await get('q=not a link'))).toEqual(['A4']);
  });

  it('treats % and _ in the search literally', async () => {
    expect(rowIds(await get(`q=${encodeURIComponent('100%_real')}`))).toEqual(['B5']);
    expect(rowIds(await get(`q=${encodeURIComponent('%')}`))).toEqual(['B5']);
  });

  it('is safe against SQL in the search box and ignores junk parameters', async () => {
    const r = await get(`q=${encodeURIComponent("' OR 1=1 --")}&status=nonsense&http=abc&sheet=`);
    expect(r.total).toBe(0);
    expect(r.facets.groups.all).toBe(0);
    const all = await get('status=nonsense&http=999');
    expect(all.total).toBe(7); // unknown values mean "no filter"
  });

  it('paginates within the filtered rows', async () => {
    const r = await get('status=active&pageSize=25&page=2');
    expect(r.rows).toHaveLength(0);
    expect(r.total).toBe(3);
  });
});
