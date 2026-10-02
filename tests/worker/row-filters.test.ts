import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanRowsResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { drain, signedIn, sql, testEnv } from './helpers';

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
      unreachable: 0,
      site_error: 0,
      refused: 1,
      indexed: 0, // index results exist only in Index Checker scans
      not_indexed: 0,
      indexable: 0,
      noindex: 0,
      robots_blocked: 0,
      canonical_elsewhere: 0,
      not_reachable: 0,
      index_unknown: 0,
      waiting: 0,
      skipped: 1,
    });
    expect(r.facets.sheets).toEqual(['A', 'B']);
    expect(r.facets.httpCodes).toEqual([200, 403, 404]);
  });

  it('counts unique links per result for the whole scan, ignoring filters', async () => {
    const expected = { byStatus: { ACTIVE: 2, DEAD: 1, BLOCKED: 1, REDIRECTED: 1 }, retrying: 0 };
    expect((await get('')).facets.links).toEqual(expected);
    expect((await get('sheet=A&status=dead&q=zzz')).facets.links).toEqual(expected);
  });

  it('filters by issue category', async () => {
    expect(rowIds(await get('status=refused'))).toEqual(['B2']);
    expect(rowIds(await get('status=site_error'))).toEqual([]);
    expect(rowIds(await get('status=unreachable'))).toEqual([]);
  });

  it('a link waiting for its automatic retry counts as waiting only', async () => {
    await sql('UPDATE unique_urls SET retry_at = 9999999999 WHERE scan_id = $1 AND url_index = 2', [id]);
    const r = await get('');
    expect(r.facets.groups).toMatchObject({ review: 0, refused: 0, waiting: 1 });
    expect(r.facets.links.retrying).toBe(1);
    expect(r.facets.links.byStatus.BLOCKED).toBeUndefined();
    expect(rowIds(await get('status=waiting'))).toEqual(['B2']);
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

describe('row sorting', () => {
  it('keeps workbook order by default', async () => {
    expect(rowIds(await get(''))).toEqual(['A2', 'A3', 'A4', 'B2', 'B3', 'B4', 'B5']);
    expect(rowIds(await get('sort=row&dir=desc'))).toEqual(['B5', 'B4', 'B3', 'B2', 'A4', 'A3', 'A2']);
  });

  it('sorts by status: most urgent first, skipped rows always last', async () => {
    expect(rowIds(await get('sort=status'))).toEqual(['A3', 'B2', 'B3', 'A2', 'B4', 'B5', 'A4']);
    expect(rowIds(await get('sort=status&dir=desc'))).toEqual(['A2', 'B4', 'B5', 'B3', 'B2', 'A3', 'A4']);
  });

  it('sorts by backlink address, case-insensitively', async () => {
    expect(rowIds(await get('sort=url'))).toEqual(['A3', 'B2', 'A2', 'B4', 'B5', 'B3', 'A4']);
  });

  it('sorts by HTTP code, rows without a response last', async () => {
    expect(rowIds(await get('sort=http'))).toEqual(['A2', 'B3', 'B4', 'B5', 'B2', 'A3', 'A4']);
    expect(rowIds(await get('sort=http&dir=desc'))).toEqual(['A3', 'B2', 'A2', 'B3', 'B4', 'B5', 'A4']);
  });

  it('sorts within filters and pages', async () => {
    const r = await get('status=active&sort=url&dir=desc&pageSize=25');
    expect(rowIds(r)).toEqual(['B5', 'A2', 'B4']);
  });

  it('ignores unknown sort values', async () => {
    expect(rowIds(await get(`sort=${encodeURIComponent('u.url; DROP TABLE scans')}&dir=sideways`))).toEqual([
      'A2',
      'A3',
      'A4',
      'B2',
      'B3',
      'B4',
      'B5',
    ]);
  });
});
