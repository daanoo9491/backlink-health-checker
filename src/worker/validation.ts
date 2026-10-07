/**
 * Small hand-written validators for request bodies. Kept deliberately cheap:
 * a Worker on the free plan has ~10 ms of CPU per request.
 */
import { MAX_URL_LENGTH } from '../shared/url';
import {
  SCAN_LIMITS,
  type AddRowsRequest,
  type AddUrlsRequest,
  SCAN_NAME_MAX,
  type CreateScanRequest,
  type ScanRowInput,
  type SheetInfo,
} from '../shared/api';

export class ValidationError extends Error {}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Postgres can't store the NUL character; it never belongs in a spreadsheet cell anyway. */
const clean = (v: string) => (v.includes('\u0000') ? v.split('\u0000').join('') : v);
const str = (v: unknown, max: number, what: string): string =>
  typeof v === 'string' && v.length <= max ? clean(v) : fail(`${what} is invalid`);
const optStr = (v: unknown, max: number, what: string): string | undefined =>
  v === undefined || v === null ? undefined : str(v, max, what);
const int = (v: unknown, min: number, max: number, what: string): number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fail(`${what} is invalid`);

const INVALID_REASONS = new Set([
  'NOT_A_URL',
  'UNSUPPORTED_PROTOCOL',
  'HAS_CREDENTIALS',
  'INTERNAL_ADDRESS',
  'TOO_LONG',
]);

/**
 * Cheap shape check for a stored URL. The full rules (and DNS-level SSRF
 * checks) run again right before any request is made, in the checker.
 */
export function isStorableUrl(u: unknown): u is string {
  return typeof u === 'string' && u.length <= MAX_URL_LENGTH && /^https?:\/\/[^\s/?#]+/i.test(u);
}

export function parseCreateScan(body: unknown): CreateScanRequest {
  if (!isObj(body)) fail('body');
  const b = body as Record<string, unknown>;
  const sheets = Array.isArray(b.sheets) && b.sheets.length <= SCAN_LIMITS.maxSheets ? b.sheets : fail('sheets');
  const headers =
    Array.isArray(b.headers) && b.headers.length <= SCAN_LIMITS.maxHeaderCount ? b.headers : fail('headers');
  const tool = b.tool === undefined ? 'links' : b.tool === 'links' || b.tool === 'index' ? b.tool : fail('tool');
  return {
    tool,
    fileName: str(b.fileName, 255, 'fileName'),
    fileSize: int(b.fileSize, 0, 50 * 1024 * 1024, 'fileSize'),
    worksheets: int(b.worksheets, 0, 10_000, 'worksheets'),
    sheets: sheets.map(parseSheet),
    headers: headers.map((h) => str(h, 255, 'header')),
    totalRows: int(b.totalRows, 1, SCAN_LIMITS.maxRows, 'totalRows'),
    uniqueUrls: int(b.uniqueUrls, 1, SCAN_LIMITS.maxUniqueUrls, 'uniqueUrls'),
    blankRows: int(b.blankRows, 0, 1_000_000, 'blankRows'),
  };
}

function parseSheet(v: unknown): SheetInfo {
  if (!isObj(v)) fail('sheet');
  const s = v as Record<string, unknown>;
  const status =
    s.status === 'used' || s.status === 'no-backlinks-column' || s.status === 'empty' ? s.status : fail('sheet status');
  return {
    name: str(s.name, 100, 'sheet name'),
    hidden: s.hidden === true,
    status,
    headerRow: s.headerRow === undefined ? undefined : int(s.headerRow, 1, 1_048_576, 'headerRow'),
    backlinksHeader: optStr(s.backlinksHeader, 255, 'backlinksHeader'),
    rows: int(s.rows, 0, 1_000_000, 'rows'),
    valid: int(s.valid, 0, 1_000_000, 'valid'),
    invalid: int(s.invalid, 0, 1_000_000, 'invalid'),
    blank: int(s.blank, 0, 1_000_000, 'blank'),
  };
}

export function parseAddUrls(body: unknown, expectedTotal: number): AddUrlsRequest {
  if (!isObj(body)) fail('body');
  const b = body as Record<string, unknown>;
  const offset = int(b.offset, 0, expectedTotal - 1, 'offset');
  const urls =
    Array.isArray(b.urls) && b.urls.length > 0 && b.urls.length <= SCAN_LIMITS.urlsPerRequest ? b.urls : fail('urls');
  if (offset + urls.length > expectedTotal) fail('urls exceed declared total');
  for (const u of urls) if (!isStorableUrl(u)) fail('url');
  return { offset, urls: urls as string[] };
}

export function parseAddRows(body: unknown, uniqueTotal: number): AddRowsRequest {
  if (!isObj(body)) fail('body');
  const b = body as Record<string, unknown>;
  const rows =
    Array.isArray(b.rows) && b.rows.length > 0 && b.rows.length <= SCAN_LIMITS.rowsPerRequest ? b.rows : fail('rows');
  return { rows: rows.map((r) => parseRow(r, uniqueTotal)) };
}

function parseRow(v: unknown, uniqueTotal: number): ScanRowInput {
  if (!isObj(v)) fail('row');
  const r = v as Record<string, unknown>;
  const row: ScanRowInput = {
    sheet: str(r.sheet, 100, 'sheet'),
    row: int(r.row, 1, 1_048_576, 'row number'),
    value: str(r.value, SCAN_LIMITS.maxCellLength * 4, 'value'),
    cells: {},
  };
  if (r.urlIndex !== undefined) {
    row.urlIndex = int(r.urlIndex, 0, uniqueTotal - 1, 'urlIndex');
    if (r.duplicate === true) row.duplicate = true;
  } else {
    const reason = str(r.invalidReason, 40, 'invalidReason');
    if (!INVALID_REASONS.has(reason)) fail('invalidReason');
    row.invalidReason = reason;
  }
  const target = optStr(r.targetUrl, MAX_URL_LENGTH, 'targetUrl');
  if (target) row.targetUrl = target;
  const anchor = optStr(r.anchorText, SCAN_LIMITS.maxCellLength, 'anchorText');
  if (anchor) row.anchorText = anchor;

  if (!isObj(r.cells)) fail('cells');
  const entries = Object.entries(r.cells as Record<string, unknown>);
  if (entries.length > SCAN_LIMITS.maxCellsPerRow) fail('too many cells');
  for (const [k, val] of entries) {
    if (k.length > 255 || typeof val !== 'string') fail('cell');
    // Long cells are trimmed rather than rejected: they are only kept for export.
    row.cells[clean(k)] = clean(val as string).slice(0, SCAN_LIMITS.maxCellLength);
  }
  return row;
}

/**
 * A new display name: trimmed, inner spaces and line breaks collapsed, control
 * characters removed. 1–SCAN_NAME_MAX characters after cleaning.
 */
export function parseRename(body: unknown): string {
  if (!isObj(body) || typeof body.fileName !== 'string' || body.fileName.length > 1000) fail('fileName');
  const name = (body as { fileName: string }).fileName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length >= 1 && [...name].length <= SCAN_NAME_MAX ? name : fail('fileName');
}
