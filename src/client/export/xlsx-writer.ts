/**
 * A small Excel (.xlsx) writer: the parts of the format the download needs and
 * nothing more. Text is written as inline strings (never as formulas), dates as
 * real Excel dates, numbers as numbers. The header row is bold and frozen, with
 * filter buttons, so the file is ready to sort and filter in Excel.
 */
import { strToU8, zipSync } from 'fflate';
import type { CellValue, Table } from './table';

export interface SheetSpec {
  name: string;
  table: Table;
}

/** Excel's own limits. */
const MAX_CELL_TEXT = 32_767;
const MAX_SHEET_NAME = 31;

const STYLE = { normal: 0, header: 1, date: 2, wrap: 3 } as const;

/** Characters XML 1.0 can't hold at all are dropped; the rest are escaped. */
export function xmlText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

/** 0 -> A, 25 -> Z, 26 -> AA … */
export function columnLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel stores date-times as days since 1899-12-30, in the reader's local time. */
export function excelSerial(d: Date): number {
  const local = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return Math.round(local / 1000) / 86_400 + 25_569; // whole seconds, no rounding drift
}

/** Sheet names: no []:*?/\ , at most 31 characters, unique, never blank. */
export function safeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, MAX_SHEET_NAME);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function cell(ref: string, v: CellValue, header: boolean): string {
  if (v === null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : `<c r="${ref}" s="${STYLE.date}"><v>${excelSerial(v)}</v></c>`;
  }
  const text = String(v).slice(0, MAX_CELL_TEXT);
  const style = header ? ` s="${STYLE.header}"` : text.includes('\n') ? ` s="${STYLE.wrap}"` : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

/** Column widths from the content, within sensible bounds. */
function widths(table: Table): number[] {
  const n = Math.max(table.headers.length, ...table.rows.slice(0, 2000).map((r) => r.length), 0);
  const w = Array.from({ length: n }, (_, i) => Math.max(8, (table.headers[i] ?? '').length + 3));
  for (const row of table.rows.slice(0, 2000)) {
    row.forEach((v, i) => {
      const len = v instanceof Date ? 16 : v === null ? 0 : String(v).length;
      w[i] = Math.max(w[i]!, Math.min(len + 2, 60));
    });
  }
  return w.map((x) => Math.min(x, 60));
}

function sheetXml(table: Table): string {
  const hasHeader = table.headers.length > 0;
  const all = hasHeader ? [table.headers as CellValue[], ...table.rows] : table.rows;
  const cols = widths(table);
  const lastCol = columnLetters(Math.max(cols.length, 1) - 1);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    hasHeader
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
  ];
  if (cols.length) {
    parts.push(
      `<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`,
    );
  }
  parts.push('<sheetData>');
  all.forEach((row, r) => {
    const cells = row.map((v, c) => cell(`${columnLetters(c)}${r + 1}`, v, hasHeader && r === 0)).join('');
    parts.push(`<row r="${r + 1}">${cells}</row>`);
  });
  parts.push('</sheetData>');
  if (hasHeader) parts.push(`<autoFilter ref="A1:${lastCol}${Math.max(all.length, 1)}"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

export function toXlsx(sheets: SheetSpec[]): Uint8Array {
  const names = safeSheetNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {};
  const add = (path: string, xml: string) => (files[path] = strToU8(xml));

  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      names
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );

  // Excel expects a hidden name for each sheet's filter range.
  const filterNames = sheets
    .map((s, i) => {
      if (!s.table.headers.length) return '';
      const cols = Math.max(s.table.headers.length, 1);
      const ref = `'${names[i]!.replace(/'/g, "''")}'!$A$1:$${columnLetters(cols - 1)}$${s.table.rows.length + 1}`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(ref)}</definedName>`;
    })
    .join('');
  add(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView/></bookViews>' +
      `<sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (filterNames ? `<definedNames>${filterNames}</definedNames>` : '') +
      '</workbook>',
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  add('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.table)));

  return zipSync(files, { level: 6 });
}
