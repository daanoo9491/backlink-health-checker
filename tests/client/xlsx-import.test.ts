import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importBacklinks, ImportError, type ImportResult } from '../../src/client/import/backlink-import';
import { excelDateToIso, readXlsx, XlsxError } from '../../src/client/import/xlsx-reader';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', name)));
const load = (name: string): ImportResult => {
  const data = fixture(name);
  return importBacklinks(readXlsx(data), name, data.length);
};
const failCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof XlsxError || e instanceof ImportError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

// Both the openpyxl file (inline strings) and the Excel-style file (shared strings)
// must give identical results.
describe.each(['multi-sheet.xlsx', 'multi-sheet-excel-style.xlsx'])('%s', (name) => {
  const r = load(name);
  const row = (sheet: string, n: number) => r.rows.find((x) => x.sheet === sheet && x.rowNumber === n);

  it('inspects every worksheet, including hidden and empty ones', () => {
    expect(r.worksheets).toBe(5);
    expect(r.sheets.map((s) => [s.name, s.status])).toEqual([
      ['Guest Posts', 'used'],
      ['Notes', 'no-backlinks-column'],
      ['Directories', 'used'],
      ['Old', 'used'],
      ['Empty', 'empty'],
    ]);
    expect(r.sheets.find((s) => s.name === 'Old')?.hidden).toBe(true);
  });

  it('finds the column regardless of case/spaces and header position', () => {
    expect(r.sheets[0]?.headerRow).toBe(1);
    expect(r.sheets[2]?.headerRow).toBe(3); // title rows above the header
    expect(r.sheets[2]?.backlinksHeader).toBe('BACKLINKS');
  });

  it('counts rows, valid, invalid, blank, unique and duplicates', () => {
    expect(r.totals).toEqual({
      rows: 15,
      valid: 11,
      invalid: 4,
      blank: 1,
      unique: 9,
      duplicates: 2,
      addedScheme: 1,
    });
    expect(r.uniqueUrls).toHaveLength(9);
  });

  it('keeps the original sheet and Excel row number', () => {
    expect(row('Guest Posts', 2)?.url).toBe('https://blog.example.com/post-1');
    expect(row('Directories', 4)?.url).toBe('https://dir-a.example.com/lanop');
    expect(row('Old', 2)?.url).toBe('https://old.example.com/a');
  });

  it('detects duplicates within and across sheets and maps them to one check', () => {
    const first = row('Guest Posts', 2)!;
    const dup = row('Guest Posts', 4)!;
    expect(dup.duplicate).toBe(true);
    expect(dup.uniqueIndex).toBe(first.uniqueIndex);
    expect(dup.originalValue).toBe('HTTPS://Blog.Example.com/post-1#comments');

    const crossSheet = row('Directories', 5)!;
    expect(crossSheet.duplicate).toBe(true);
    expect(crossSheet.uniqueIndex).toBe(row('Guest Posts', 3)!.uniqueIndex);
  });

  it('gives a reason for every invalid row', () => {
    expect(row('Guest Posts', 6)?.invalidReason).toBe('NOT_A_URL');
    expect(row('Guest Posts', 7)?.invalidReason).toBe('UNSUPPORTED_PROTOCOL');
    expect(row('Guest Posts', 9)?.invalidReason).toBe('INTERNAL_ADDRESS');
    expect(row('Directories', 6)?.invalidReason).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('fixes www. links and trims spaces', () => {
    expect(row('Guest Posts', 8)?.url).toBe('https://www.directory.example.org/listing/99');
    expect(row('Guest Posts', 8)?.addedScheme).toBe(true);
    expect(row('Guest Posts', 10)?.url).toBe('https://news.example.net/story?id=7');
  });

  it('uses the hyperlink behind a "View post" cell', () => {
    const r11 = row('Guest Posts', 11)!;
    expect(r11.url).toBe('https://forum.example.com/thread/555');
    expect(r11.cells['Backlinks']).toBe('View post'); // original text kept for export
  });

  it('reads =HYPERLINK() formulas and rich-text cells', () => {
    expect(row('Guest Posts', 12)?.url).toBe('https://wiki.example.com/page');
    expect(row('Guest Posts', 13)?.url).toBe('https://rich.example.com/a');
  });

  it('recognises and keeps optional columns', () => {
    expect(r.optionalColumns.sort()).toEqual(['anchorText', 'da', 'date', 'status', 'targetUrl']);
    const first = row('Guest Posts', 2)!;
    expect(first.targetUrl).toBe('https://lanop.co.uk/');
    expect(first.anchorText).toBe('tax advisors');
    expect(first.cells['Date']).toBe('2026-03-14'); // real date, not 46095
    expect(first.cells['DA']).toBe('45');
    expect(first.cells['Notes']).toBeUndefined(); // empty cell
    expect(row('Directories', 4)?.cells['Site']).toBe('Dir A');
  });

  it('lists every original column for export', () => {
    expect(r.headers).toEqual(
      expect.arrayContaining([
        'Backlinks',
        'Target URL',
        'Anchor Text',
        'Date',
        'DA',
        'Notes',
        'Site',
        'BACKLINKS',
        'Status',
      ]),
    );
  });
});

describe('friendly failures', () => {
  it('no Backlinks column', () => {
    expect(failCode(() => load('no-backlinks-column.xlsx'))).toBe('NO_BACKLINKS_COLUMN');
  });
  it('column present but no links', () => {
    expect(failCode(() => load('no-valid-urls.xlsx'))).toBe('NO_VALID_URLS');
  });
  it('a text file renamed to .xlsx', () => {
    expect(failCode(() => load('not-really.xlsx'))).toBe('NOT_XLSX');
  });
  it('a password-protected workbook', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(failCode(() => readXlsx(ole))).toBe('PROTECTED');
  });
  it('a zip that is not a workbook', () => {
    expect(failCode(() => readXlsx(zipSync({ 'hello.txt': strToU8('hi') })))).toBe('NOT_XLSX');
  });
});

describe('large workbook', () => {
  it('reads 5,000 rows quickly and de-duplicates', () => {
    const t0 = performance.now();
    const r = load('large-5000.xlsx');
    const ms = performance.now() - t0;
    expect(r.totals.rows).toBe(5000);
    expect(r.totals.valid).toBe(5000);
    expect(r.totals.unique).toBeLessThan(5000);
    expect(r.totals.unique + r.totals.duplicates).toBe(5000);
    expect(ms).toBeLessThan(2000);
  });
});

describe('unusual but valid XML', () => {
  // Hand-built workbook: namespace prefixes, missing cell refs, phonetic runs,
  // XML entities and Excel's _xHHHH_ escapes.
  function build(sheetXml: string, shared = '<sst/>') {
    return zipSync({
      'xl/workbook.xml': strToU8(
        `<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="S &amp; P" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml" Type="ws"/></Relationships>`,
      ),
      'xl/sharedStrings.xml': strToU8(shared),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    });
  }

  it('handles prefixes, implicit positions, entities and phonetic hints', () => {
    const shared = `<sst><si><t>Backlinks</t></si><si><r><t>https://a.example.com/?x=1&amp;y=2</t></r><rPh><t>ignored</t></rPh></si></sst>`;
    const sheet = `<x:worksheet><x:sheetData>
      <x:row><x:c t="s"><x:v>0</x:v></x:c><x:c t="inlineStr"><x:is><x:t>Note_x000D_</x:t></x:is></x:c></x:row>
      <x:row><x:c t="s"><x:v>1</x:v></x:c><x:c t="str"><x:v>a &lt;b&gt;</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`;
    const wb = readXlsx(build(sheet, shared));
    expect(wb.sheets[0]?.name).toBe('S & P');
    const r = importBacklinks(wb, 't.xlsx', 1);
    expect(r.rows[0]?.url).toBe('https://a.example.com/?x=1&y=2');
    expect(r.rows[0]?.rowNumber).toBe(2);
    expect(r.rows[0]?.cells['Note']).toBe('a <b>');
  });

  it('ignores internal (#Sheet!A1) hyperlinks', () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Backlinks</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>https://b.example.com</t></is></c></row>
    </sheetData><hyperlinks><hyperlink ref="A2" location="Sheet2!A1"/></hyperlinks></worksheet>`;
    const r = importBacklinks(readXlsx(build(sheet)), 't.xlsx', 1);
    expect(r.rows[0]?.url).toBe('https://b.example.com/');
  });
});

describe('excelDateToIso', () => {
  it('converts serial dates', () => {
    expect(excelDateToIso(46095)).toBe('2026-03-14');
    expect(excelDateToIso(45000.5)).toBe('2023-03-15 12:00');
  });
});
