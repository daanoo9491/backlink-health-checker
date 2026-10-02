/**
 * Turns a parsed workbook into a backlink import:
 * finds the "Backlinks" column on every sheet, validates each value,
 * de-duplicates, and keeps the original sheet/row/columns for export.
 */
import { checkUrl, cleanCellValue, type InvalidReason } from '../../shared/url';
import type { Cell, Sheet, Workbook } from './xlsx-reader';

/** How many rows from the top we search for the header row. */
const HEADER_SEARCH_ROWS = 20;

export type OptionalColumn = 'targetUrl' | 'anchorText' | 'date' | 'status' | 'da';

export const OPTIONAL_COLUMN_LABELS: Record<OptionalColumn, string> = {
  targetUrl: 'Target URL',
  anchorText: 'Anchor Text',
  date: 'Date',
  status: 'Status',
  da: 'DA',
};

const HEADER_ALIASES: Record<'backlinks' | OptionalColumn, string[]> = {
  backlinks: ['backlinks', 'backlink'],
  targetUrl: ['target url', 'target link', 'target page', 'target'],
  anchorText: ['anchor text', 'anchor'],
  date: ['date'],
  status: ['status'],
  da: ['da', 'domain authority'],
};

/**
 * Index Checker sheets are often plain URL lists, so their link column may
 * also be called URL, Page, Address or Link. (Link Health keeps "Backlinks",
 * so a sheet with both a Backlinks and a URL column stays unambiguous.)
 */
const INDEX_LINK_ALIASES = [
  'backlinks',
  'backlink',
  'url',
  'urls',
  'page',
  'pages',
  'page url',
  'page urls',
  'address',
  'web address',
  'link',
  'links',
];

export interface ImportOptions {
  /** 'index': accept the extra column names above. Defaults to Link Health. */
  tool?: 'links' | 'index';
}

export function normalizeHeader(text: string): string {
  return cleanCellValue(text).replace(/:$/, '').replace(/\s+/g, ' ').toLowerCase();
}

export interface ImportRow {
  sheet: string;
  /** Row number as shown in Excel. */
  rowNumber: number;
  /** Exactly what was in the Backlinks cell (or its hyperlink). */
  originalValue: string;
  /** Present when the row is usable. */
  url?: string;
  normalizedUrl?: string;
  /** Index into ImportResult.uniqueUrls. */
  uniqueIndex?: number;
  /** True for the 2nd, 3rd… appearance of the same link. */
  duplicate?: boolean;
  addedScheme?: boolean;
  invalidReason?: InvalidReason;
  targetUrl?: string;
  anchorText?: string;
  /** Every original column (header -> text), kept for export. */
  cells: Record<string, string>;
}

export interface SheetSummary {
  name: string;
  hidden: boolean;
  status: 'used' | 'no-backlinks-column' | 'empty';
  headerRow?: number;
  backlinksHeader?: string;
  rows: number;
  valid: number;
  invalid: number;
  blank: number;
  optionalColumns: OptionalColumn[];
}

export interface ImportResult {
  fileName: string;
  fileSize: number;
  worksheets: number;
  sheets: SheetSummary[];
  /** Headers in first-seen order across all used sheets (for export). */
  headers: string[];
  rows: ImportRow[];
  uniqueUrls: string[];
  totals: {
    /** Rows with something in the Backlinks column. */
    rows: number;
    valid: number;
    invalid: number;
    /** Rows with data elsewhere but an empty Backlinks cell. */
    blank: number;
    unique: number;
    duplicates: number;
    addedScheme: number;
  };
  optionalColumns: OptionalColumn[];
}

export type ImportErrorCode = 'NO_BACKLINKS_COLUMN' | 'NO_VALID_URLS';

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

function matchColumn(header: string, opts: ImportOptions = {}): 'backlinks' | OptionalColumn | null {
  const h = normalizeHeader(header);
  if (opts.tool === 'index' && INDEX_LINK_ALIASES.includes(h)) return 'backlinks';
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return key as 'backlinks' | OptionalColumn;
  }
  return null;
}

function findHeaderRow(sheet: Sheet, opts: ImportOptions): number | null {
  const rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b).slice(0, HEADER_SEARCH_ROWS);
  for (const r of rowNumbers) {
    for (const cell of sheet.rows.get(r)!.values()) {
      if (matchColumn(cell.text, opts) === 'backlinks') return r;
    }
  }
  return null;
}

/** Prefer the cell's hyperlink when it is a valid URL (e.g. text "View post"). */
function linkValue(cell: Cell | undefined): { value: string; check: ReturnType<typeof checkUrl> } {
  const text = cleanCellValue(cell?.text ?? '');
  const link = cleanCellValue(cell?.hyperlink ?? '');
  if (link) {
    const check = checkUrl(link);
    if (check.ok || !text) return { value: link, check };
  }
  return { value: text, check: checkUrl(text) };
}

export function importBacklinks(
  workbook: Workbook,
  fileName: string,
  fileSize: number,
  opts: ImportOptions = {},
): ImportResult {
  const rows: ImportRow[] = [];
  const sheets: SheetSummary[] = [];
  const headers: string[] = [];
  const headerSeen = new Set<string>();
  const uniqueIndex = new Map<string, number>();
  const uniqueUrls: string[] = [];
  const optionalAll = new Set<OptionalColumn>();

  for (const sheet of workbook.sheets) {
    const summary: SheetSummary = {
      name: sheet.name,
      hidden: sheet.hidden,
      status: 'used',
      rows: 0,
      valid: 0,
      invalid: 0,
      blank: 0,
      optionalColumns: [],
    };
    sheets.push(summary);

    if (sheet.rows.size === 0) {
      summary.status = 'empty';
      continue;
    }
    const headerRow = findHeaderRow(sheet, opts);
    if (headerRow === null) {
      summary.status = 'no-backlinks-column';
      continue;
    }
    summary.headerRow = headerRow;

    // Column names for this sheet; blanks and repeats get unique names.
    const names = new Map<number, string>();
    const used = new Set<string>();
    const roles = new Map<OptionalColumn | 'backlinks', number>();
    const headerCells = [...sheet.rows.get(headerRow)!.entries()].sort((a, b) => a[0] - b[0]);
    for (const [col, cell] of headerCells) {
      let name = cleanCellValue(cell.text) || `Column ${col + 1}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${cleanCellValue(cell.text)} (${n})`;
      used.add(name.toLowerCase());
      names.set(col, name);
      const role = matchColumn(cell.text, opts);
      if (role && !roles.has(role)) roles.set(role, col);
    }
    const backlinkCol = roles.get('backlinks')!;
    summary.backlinksHeader = names.get(backlinkCol);
    for (const role of roles.keys()) if (role !== 'backlinks') summary.optionalColumns.push(role);
    summary.optionalColumns.forEach((c) => optionalAll.add(c));

    const dataRows = [...sheet.rows.entries()].filter(([r]) => r > headerRow).sort((a, b) => a[0] - b[0]);
    for (const [rowNumber, cells] of dataRows) {
      const record: Record<string, string> = {};
      for (const [col, cell] of cells) {
        const name = names.get(col) ?? `Column ${col + 1}`;
        if (!names.has(col)) names.set(col, name);
        record[name] = cell.text || cell.hyperlink || '';
      }
      for (const name of names.values()) {
        if (!headerSeen.has(name)) {
          headerSeen.add(name);
          headers.push(name);
        }
      }

      const { value, check } = linkValue(cells.get(backlinkCol));
      if (!value) {
        summary.blank++;
        continue;
      }
      summary.rows++;

      const row: ImportRow = { sheet: sheet.name, rowNumber, originalValue: value, cells: record };
      const targetCol = roles.get('targetUrl');
      if (targetCol !== undefined) {
        const t = linkValue(cells.get(targetCol));
        if (t.value) row.targetUrl = t.check.ok ? t.check.url : t.value;
      }
      const anchorCol = roles.get('anchorText');
      if (anchorCol !== undefined) {
        const a = cleanCellValue(cells.get(anchorCol)?.text ?? '');
        if (a) row.anchorText = a;
      }

      if (check.ok) {
        summary.valid++;
        row.url = check.url;
        row.normalizedUrl = check.normalized;
        if (check.addedScheme) row.addedScheme = true;
        const existing = uniqueIndex.get(check.normalized);
        if (existing === undefined) {
          row.uniqueIndex = uniqueUrls.length;
          uniqueIndex.set(check.normalized, uniqueUrls.length);
          uniqueUrls.push(check.url);
        } else {
          row.uniqueIndex = existing;
          row.duplicate = true;
        }
      } else {
        summary.invalid++;
        row.invalidReason = check.reason;
      }
      rows.push(row);
    }
  }

  if (!sheets.some((s) => s.status === 'used')) throw new ImportError('NO_BACKLINKS_COLUMN');

  const valid = rows.filter((r) => r.url).length;
  if (valid === 0) throw new ImportError('NO_VALID_URLS');

  return {
    fileName,
    fileSize,
    worksheets: workbook.sheets.length,
    sheets,
    headers,
    rows,
    uniqueUrls,
    totals: {
      rows: rows.length,
      valid,
      invalid: rows.length - valid,
      blank: sheets.reduce((n, s) => n + s.blank, 0),
      unique: uniqueUrls.length,
      duplicates: valid - uniqueUrls.length,
      addedScheme: rows.filter((r) => r.addedScheme).length,
    },
    optionalColumns: [...optionalAll],
  };
}
