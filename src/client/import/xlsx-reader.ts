/**
 * Minimal, dependency-light .xlsx reader.
 *
 * An .xlsx file is a zip of XML files. We read only what we need: sheet
 * names, cell text, hyperlinks and date formats. No DOM APIs are used, so
 * the same code runs in a Web Worker and in Node tests.
 *
 * Safety: size limits guard against zip bombs; nothing is evaluated; cell
 * text is treated as plain strings.
 */
import { unzipSync } from 'fflate';

export interface Cell {
  text: string;
  /** Target of a hyperlink on this cell, if any. */
  hyperlink?: string;
}

export interface Sheet {
  name: string;
  hidden: boolean;
  /** rows[rowNumber][columnIndex] (1-based Excel row numbers, 0-based columns). */
  rows: Map<number, Map<number, Cell>>;
}

export interface Workbook {
  sheets: Sheet[];
}

export type XlsxErrorCode = 'NOT_XLSX' | 'PROTECTED' | 'TOO_LARGE' | 'TOO_MANY_ROWS';

export class XlsxError extends Error {
  constructor(readonly code: XlsxErrorCode) {
    super(code);
  }
}

export const LIMITS = {
  /** Total uncompressed size of the XML we read. */
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 256,
};

// ---------- small XML helpers (regex based; xlsx XML is machine-generated and regular) ----------

const P = '(?:[A-Za-z_][\\w.-]*:)?'; // optional namespace prefix, e.g. "x:"

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const key = m[1]!;
    const val = decodeXml(m[2] ?? m[3] ?? '');
    out[key] = val;
    // Also expose the local name (r:id -> id) for prefix-agnostic lookups.
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (!(local in out)) out[local] = val;
  }
  return out;
}

export function decodeXml(s: string): string {
  if (!s.includes('&') && !s.includes('_x')) return s;
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return safeFromCodePoint(code);
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => safeFromCodePoint(parseInt(h, 16)));
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Concatenated text of <t> elements, skipping phonetic hints (<rPh>). */
function textRuns(xml: string): string {
  const noPhonetic = xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '');
  let out = '';
  const re = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(noPhonetic))) out += decodeXml(m[1]!);
  return out;
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  return m ? { col: columnIndex(m[1]!), row: Number(m[2]) } : null;
}

// ---------- package parts ----------

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function readRels(xml: string | undefined): Map<string, { target: string; external: boolean }> {
  const map = new Map<string, { target: string; external: boolean }>();
  if (!xml) return map;
  const re = new RegExp(`<${P}Relationship\\b([^>]*)/?>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = attrs(m[1]!);
    if (a.Id && a.Target) map.set(a.Id, { target: a.Target, external: a.TargetMode === 'External' });
  }
  return map;
}

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = new RegExp(`<${P}si\\s*/>|<${P}si(?:\\s[^>]*)?>([\\s\\S]*?)</${P}si>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ? textRuns(m[1]) : '');
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell style indexes display numbers as dates. */
function readDateStyles(xml: string | undefined): Set<number> {
  const dateStyles = new Set<number>();
  if (!xml) return dateStyles;

  const customDate = new Set<number>();
  const numFmtRe = new RegExp(`<${P}numFmt\\b([^>]*)/?>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml))) {
    const a = attrs(m[1]!);
    // Strip quoted text and [colour]/[locale] blocks, then look for date tokens.
    const code = (a.formatCode ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/[dmyhs]/i.test(code)) customDate.add(Number(a.numFmtId));
  }

  const cellXfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(xml)?.[1] ?? '';
  const xfRe = new RegExp(`<${P}xf\\b([^>]*?)(?:/>|>)`, 'g');
  let i = 0;
  while ((m = xfRe.exec(cellXfs))) {
    const id = Number(attrs(m[1]!).numFmtId ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) dateStyles.add(i);
    i++;
  }
  return dateStyles;
}

/** Excel serial date -> "YYYY-MM-DD" (or with time). 1900 date system. */
export function excelDateToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

// ---------- worksheet ----------

function readSheet(
  xml: string,
  rels: Map<string, { target: string; external: boolean }>,
  shared: string[],
  dateStyles: Set<number>,
  rowBudget: { left: number },
): Map<number, Map<number, Cell>> {
  const rows = new Map<number, Map<number, Cell>>();
  const sheetData = new RegExp(`<${P}sheetData\\b[^>]*>([\\s\\S]*?)</${P}sheetData>`).exec(xml)?.[1] ?? '';

  const rowRe = new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, 'g');
  const cellRe = new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g');
  const vRe = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>`);
  const fRe = new RegExp(`<${P}f(?:\\s[^>]*)?>([\\s\\S]*?)</${P}f>`);
  const isRe = new RegExp(`<${P}is(?:\\s[^>]*)?>([\\s\\S]*?)</${P}is>`);

  let rm: RegExpExecArray | null;
  let lastRow = 0;
  while ((rm = rowRe.exec(sheetData))) {
    const rowNum = Number(attrs(rm[1]!).r) || lastRow + 1;
    lastRow = rowNum;
    const body = rm[2];
    if (!body) continue;

    const cells = new Map<number, Cell>();
    let cm: RegExpExecArray | null;
    let lastCol = -1;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(body))) {
      const a = attrs(cm[1]!);
      const col = a.r ? (parseRef(a.r)?.col ?? lastCol + 1) : lastCol + 1;
      lastCol = col;
      if (col >= LIMITS.maxColumns) continue;
      const inner = cm[2] ?? '';

      const v = vRe.exec(inner)?.[1];
      let text: string;
      switch (a.t) {
        case 's':
          text = shared[Number(v)] ?? '';
          break;
        case 'inlineStr':
          text = textRuns(isRe.exec(inner)?.[1] ?? '');
          break;
        case 'b':
          text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
          break;
        case 'str':
        case 'e':
          text = decodeXml(v ?? '');
          break;
        default: {
          const raw = decodeXml(v ?? '');
          const num = Number(raw);
          text = raw !== '' && dateStyles.has(Number(a.s ?? 0)) && Number.isFinite(num) ? excelDateToIso(num) : raw;
        }
      }

      const cell: Cell = { text };
      // =HYPERLINK("https://...", "label")
      const f = fRe.exec(inner)?.[1];
      if (f) {
        const link = /HYPERLINK\(\s*"((?:[^"]|"")+)"/i.exec(decodeXml(f))?.[1];
        if (link) cell.hyperlink = link.replace(/""/g, '"');
      }
      if (text !== '' || cell.hyperlink) cells.set(col, cell);
    }

    if (cells.size) {
      if (--rowBudget.left < 0) throw new XlsxError('TOO_MANY_ROWS');
      rows.set(rowNum, cells);
    }
  }

  // Hyperlinks inserted with Excel's "Insert link" live outside the cells.
  const hlRe = new RegExp(`<${P}hyperlink\\b([^>]*)/?>`, 'g');
  let hm: RegExpExecArray | null;
  while ((hm = hlRe.exec(xml))) {
    const a = attrs(hm[1]!);
    const rel = a.id ? rels.get(a.id) : undefined;
    if (!rel?.external || !a.ref) continue; // internal "#Sheet2!A1" links are not web links
    const [from, to] = a.ref.split(':');
    const start = from ? parseRef(from) : null;
    const end = to ? parseRef(to) : start;
    if (!start || !end) continue;
    for (let r = start.row; r <= end.row && r - start.row < 10_000; r++) {
      for (let c = start.col; c <= end.col && c < LIMITS.maxColumns; c++) {
        let row = rows.get(r);
        if (!row) {
          row = new Map();
          rows.set(r, row);
        }
        const cell = row.get(c) ?? { text: '' };
        cell.hyperlink = rel.target;
        row.set(c, cell);
      }
    }
  }
  return rows;
}

// ---------- entry point ----------

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

export function readXlsx(data: Uint8Array): Workbook {
  // Password-protected .xlsx files are wrapped in an OLE container, not a zip.
  if (OLE_SIGNATURE.every((b, i) => data[i] === b)) throw new XlsxError('PROTECTED');
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new XlsxError('NOT_XLSX'); // "PK"

  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        const wanted =
          f.name === 'xl/workbook.xml' ||
          f.name === 'xl/_rels/workbook.xml.rels' ||
          f.name === 'xl/sharedStrings.xml' ||
          f.name === 'xl/styles.xml' ||
          f.name.startsWith('xl/worksheets/');
        if (!wanted) return false;
        total += f.originalSize;
        if (total > LIMITS.maxUncompressedBytes) throw new XlsxError('TOO_LARGE');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError('NOT_XLSX');
  }

  const dec = new TextDecoder();
  const text = (path: string) => (files[path] ? dec.decode(files[path]) : undefined);

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new XlsxError('NOT_XLSX');

  const wbRels = readRels(text('xl/_rels/workbook.xml.rels'));
  const shared = readSharedStrings(text('xl/sharedStrings.xml'));
  const dateStyles = readDateStyles(text('xl/styles.xml'));
  const budget = { left: LIMITS.maxRows };

  const sheets: Sheet[] = [];
  const sheetRe = new RegExp(`<${P}sheet\\b([^>]*)/?>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(workbookXml))) {
    const a = attrs(m[1]!);
    const rel = a.id ? wbRels.get(a.id) : undefined;
    if (!rel) continue;
    const path = resolvePath('xl/workbook.xml', rel.target);
    const xml = text(path);
    if (!xml) continue; // chart sheets, dialog sheets, etc.
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    sheets.push({
      name: a.name ?? `Sheet ${sheets.length + 1}`,
      hidden: a.state === 'hidden' || a.state === 'veryHidden',
      rows: readSheet(xml, readRels(text(relsPath)), shared, dateStyles, budget),
    });
  }
  if (!sheets.length) throw new XlsxError('NOT_XLSX');
  return { sheets };
}
