import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ExportRow, RowFilters } from '../../src/shared/api';
import { buildFile } from '../../src/client/export/build-file';
import { localDateTime, neutralise, toCsv } from '../../src/client/export/csv';
import { buildSummary, buildTable, describeFilters, exportFileName } from '../../src/client/export/table';
import { columnLetters, safeSheetNames, toXlsx, xmlText } from '../../src/client/export/xlsx-writer';
import { readXlsx } from '../../src/client/import/xlsx-reader';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  sheet: 'Guest Posts',
  row: 2,
  value: 'https://a.example.com/post',
  cells: { Backlinks: 'https://a.example.com/post', DA: '45' },
  url: 'https://a.example.com/post',
  duplicate: false,
  invalidReason: null,
  targetUrl: null,
  anchorText: null,
  status: 'ACTIVE',
  checkReason: null,
  retryAt: null,
  httpStatus: 200,
  finalUrl: 'https://a.example.com/post',
  pageTitle: 'A post',
  responseTimeMs: 120,
  checkedAt: '2026-10-01T10:30:00.000Z',
  indexStatus: null,
  indexReason: null,
  indexEvidence: null,
  indexSource: null,
  googleCheckedAt: null,
  ...over,
});

const NO_FILTERS: RowFilters = { group: 'all', sheet: '', http: '', q: '', sort: 'row', dir: 'asc' };

/** Reads a sheet back as text, with the app's own Excel reader. */
function readBack(bytes: Uint8Array, sheet = 0): string[][] {
  const wb = readXlsx(bytes);
  const s = wb.sheets[sheet]!;
  const maxRow = Math.max(...s.rows.keys());
  return Array.from({ length: maxRow }, (_, r) => {
    const cells = s.rows.get(r + 1) ?? new Map();
    const maxCol = Math.max(-1, ...cells.keys());
    return Array.from({ length: maxCol + 1 }, (_, c) => cells.get(c)?.text ?? '');
  });
}

describe('the export table', () => {
  it('keeps every original column first, in order, then adds the link results', () => {
    const t = buildTable({ headers: ['Backlinks', 'DA', 'Owner'], tool: 'links' }, [row()]);
    expect(t.headers).toEqual([
      'Backlinks',
      'DA',
      'Owner',
      'Sheet',
      'Row',
      'Checked URL',
      'Note',
      'Link status',
      'Status details',
      'HTTP code',
      'Final URL',
      'Page title',
      'Response time (ms)',
      'Checked at',
    ]);
    const r = t.rows[0]!;
    expect(r.slice(0, 3)).toEqual(['https://a.example.com/post', '45', null]); // a blank original cell stays blank
    expect(r[7]).toBe('Active');
    expect(r[9]).toBe(200);
    expect(r[10]).toBeNull(); // final URL only when it differs
    expect(r[13]).toEqual(new Date('2026-10-01T10:30:00.000Z'));
  });

  it('adds the index results for an index check, with friendly labels and the evidence', () => {
    const t = buildTable({ headers: ['URL'], tool: 'index' }, [
      row({
        indexStatus: 'NOT_INDEXED',
        indexSource: 'google_search',
        indexReason: 'Google search found nothing',
        indexEvidence: [
          { signal: 'google', text: 'Google search for "site:a.example.com/post": no results', bad: true },
          { signal: 'robots', text: 'robots.txt allows Googlebot' },
        ],
        googleCheckedAt: '2026-10-02T09:00:00.000Z',
      }),
    ]);
    const col = (name: string) => t.rows[0]![t.headers.indexOf(name)];
    expect(col('Index status')).toBe('Not indexed');
    expect(col('Answer from')).toBe('Google search (browser helper)');
    expect(col('Evidence')).toBe(
      '✗ Google search for "site:a.example.com/post": no results; robots.txt allows Googlebot',
    );
    expect(col('Google checked at')).toEqual(new Date('2026-10-02T09:00:00.000Z'));
    expect(col('Link status')).toBe('Active');
  });

  it('explains skipped, repeated, waiting and retrying rows in plain words', () => {
    const t = buildTable({ headers: [], tool: 'index' }, [
      row({ url: null, status: null, invalidReason: 'NOT_A_URL', indexStatus: null }),
      row({ duplicate: true }),
      row({ status: 'PENDING', indexStatus: null }),
      row({ status: 'TIMEOUT', retryAt: '2026-10-01T11:00:00.000Z', indexStatus: 'UNKNOWN' }),
    ]);
    const col = (i: number, name: string) => t.rows[i]![t.headers.indexOf(name)];
    expect([col(0, 'Index status'), col(0, 'Link status'), col(0, 'Note')]).toEqual([
      'Skipped',
      'Skipped',
      'Not a web address',
    ]);
    expect(col(1, 'Note')).toBe('Same link as an earlier row (checked once)');
    expect([col(2, 'Index status'), col(2, 'Link status')]).toEqual(['Waiting', 'Waiting']);
    expect(col(3, 'Link status')).toBe('Timed out (retrying automatically)');
    expect(col(3, 'Index status')).toBe('Unknown (retrying automatically)');
  });

  it('never lets a result column hide an original column with the same name', () => {
    const t = buildTable({ headers: ['Link Status', 'Note', 'Note (LinkLedger)'], tool: 'links' }, [row()]);
    expect(t.headers).toContain('Link Status');
    expect(t.headers).toContain('Link status (LinkLedger)');
    expect(t.headers).toContain('Note (LinkLedger 3)');
    expect(new Set(t.headers.map((h) => h.toLowerCase())).size).toBe(t.headers.length);
  });

  it('summarises the rows by result, most common first', () => {
    const s = buildSummary(
      {
        fileName: 'B.xlsx',
        tool: 'links',
        createdAt: '2026-10-01T10:00:00Z',
        completedAt: null,
        uniqueUrls: 3,
        status: 'running',
      },
      [row(), row({ status: 'DEAD' }), row({ status: 'DEAD' })],
      { ...NO_FILTERS, group: 'dead', sheet: 'Guest Posts' },
      new Date('2026-10-06T12:00:00Z'),
    );
    expect(s.headers).toEqual([]);
    expect(s.rows).toContainEqual(['Checking finished', 'Not finished yet']);
    expect(s.rows).toContainEqual(['Filters', 'Result: Dead · Sheet: Guest Posts']);
    const i = s.rows.findIndex((r) => r[0] === 'Link status');
    expect(s.rows.slice(i + 1)).toEqual([
      ['Dead', 2],
      ['Active', 1],
    ]);
  });

  it('describes filters with the same names as the filter buttons', () => {
    expect(describeFilters({ ...NO_FILTERS, group: 'not_indexed', http: 'none', q: 'blog' }, 'index')).toBe(
      'Result: Not indexed · HTTP code: no response · Search: “blog”',
    );
    expect(describeFilters({ ...NO_FILTERS, group: 'review' }, 'links')).toBe('Result: Need a look');
  });

  it('makes a file name that is safe on Windows', () => {
    const when = new Date(2026, 9, 6, 15, 45);
    expect(exportFileName('Backlinks Q3.xlsx', 'links', when, false)).toBe(
      'Backlinks Q3 - LinkLedger link results 2026-10-06',
    );
    expect(exportFileName('a/b:c*?"<>|.xlsx', 'index', when, true)).toBe(
      'a b c - LinkLedger index results (filtered) 2026-10-06',
    );
    expect(exportFileName('.xlsx', 'links', when, false)).toBe('scan - LinkLedger link results 2026-10-06');
  });
});

describe('CSV', () => {
  it('opens in Excel as UTF-8, quotes where needed and uses CRLF', () => {
    const csv = toCsv({
      headers: ['Name', 'Note'],
      rows: [
        ['Café, "Zürich"', 'line 1\nline 2'],
        [42, null],
      ],
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Name,Note\r\n"Café, ""Zürich""","line 1\nline 2"\r\n42,\r\n');
  });

  it('never lets text from a file or a web page run as a formula', () => {
    for (const bad of ['=HYPERLINK("http://evil")', '+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(neutralise(bad).startsWith("'")).toBe(true);
    }
    expect(neutralise('https://a.example.com')).toBe('https://a.example.com');
    expect(toCsv({ headers: [], rows: [['=1+1']] })).toContain("'=1+1");
  });

  it('writes dates in local time, as people read them', () => {
    const d = new Date(2026, 9, 6, 9, 5);
    expect(localDateTime(d)).toBe('2026-10-06 09:05');
    expect(toCsv({ headers: [], rows: [[d]] })).toContain('2026-10-06 09:05');
  });
});

describe('Excel writer', () => {
  it('writes a workbook the app itself (and Excel) can read back', () => {
    const when = new Date(2026, 9, 6, 15, 45);
    const bytes = toXlsx([
      {
        name: 'Results',
        table: {
          headers: ['Backlinks', 'HTTP code', 'Checked at', 'Note'],
          rows: [
            ['https://a.example.com/?a=1&b=<2>', 200, when, '=1+1'],
            ['Ünïcödé “quotes” 😀', null, null, 'x\u0001y'],
          ],
        },
      },
      { name: 'Summary', table: { headers: [], rows: [['File', 'B.xlsx']] } },
    ]);
    expect(readBack(bytes)).toEqual([
      ['Backlinks', 'HTTP code', 'Checked at', 'Note'],
      ['https://a.example.com/?a=1&b=<2>', '200', '2026-10-06 15:45', '=1+1'],
      ['Ünïcödé “quotes” 😀', '', '', 'xy'],
    ]);
    expect(readBack(bytes, 1)).toEqual([['File', 'B.xlsx']]);
    expect(readXlsx(bytes).sheets.map((s) => s.name)).toEqual(['Results', 'Summary']);
  });

  it('writes text as text (never a formula), freezes and filters the header row', () => {
    const files = unzipSync(toXlsx([{ name: 'Results', table: { headers: ['A', 'B'], rows: [['=1+1', 'b']] } }]));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=1+1</t>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:B2"/>');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain("'Results'!$A$1:$B$2");
  });

  it('handles many columns and Excel’s sheet-name rules', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(safeSheetNames(['Results', 'results', 'a/b:c', '', 'x'.repeat(40)])).toEqual([
      'Results',
      'results (2)',
      'a b c',
      'Sheet',
      'x'.repeat(31),
    ]);
    const headers = Array.from({ length: 30 }, (_, i) => `H${i}`);
    const back = readBack(toXlsx([{ name: 'R', table: { headers, rows: [headers.map((h) => h.toLowerCase())] } }]));
    expect(back[1]![29]).toBe('h29');
  });

  it('drops characters XML can’t hold and cuts text at Excel’s cell limit', () => {
    expect(xmlText('a\u0000b\u001fc\ud800d & <e>')).toBe('abcd &amp; &lt;e&gt;');
    const long = 'x'.repeat(40_000);
    const back = readBack(toXlsx([{ name: 'R', table: { headers: ['A'], rows: [[long]] } }]));
    expect(back[1]![0]).toHaveLength(32_767);
  });

  it('builds the whole download: Results + Summary for Excel, one table for CSV', async () => {
    const scan = {
      id: 's',
      fileName: 'Backlinks.xlsx',
      tool: 'links' as const,
      headers: ['Backlinks', 'DA'],
      createdAt: '2026-10-01T10:00:00Z',
      completedAt: '2026-10-01T11:00:00Z',
      uniqueUrls: 1,
      status: 'completed' as const,
    } as Parameters<typeof buildFile>[0];
    const now = new Date(2026, 9, 6);
    const xlsx = buildFile(scan, [row()], null, 'xlsx', now);
    expect(xlsx.name).toBe('Backlinks - LinkLedger link results 2026-10-06.xlsx');
    const bytes = new Uint8Array(await xlsx.blob.arrayBuffer());
    expect(readXlsx(bytes).sheets.map((s) => s.name)).toEqual(['Results', 'Summary']);
    expect(readBack(bytes)[1]!.slice(0, 2)).toEqual(['https://a.example.com/post', '45']);

    const csv = buildFile(scan, [row()], { ...NO_FILTERS, group: 'active' }, 'csv', now);
    expect(csv.name).toBe('Backlinks - LinkLedger link results (filtered) 2026-10-06.csv');
    expect(await csv.blob.text()).toContain('Backlinks,DA,Sheet,Row');
  });
});

describe('Excel dates', () => {
  it('keep the exact minute and second', async () => {
    const { excelSerial } = await import('../../src/client/export/xlsx-writer');
    const d = new Date(2026, 9, 1, 15, 30, 0);
    const serial = excelSerial(d);
    const back = new Date(Math.round((serial - 25_569) * 86_400) * 1000);
    expect([back.getUTCHours(), back.getUTCMinutes(), back.getUTCSeconds()]).toEqual([15, 30, 0]);
  });
});
