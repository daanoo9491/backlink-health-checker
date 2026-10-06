/**
 * Turns a scan's rows into the table that goes into the Excel/CSV download:
 * every original column first, exactly as uploaded, then LinkLedger's results.
 */
import type { ExportRow, RowFilters, ScanDetail } from '../../shared/api';
import { TOOLS } from '../../shared/brand';
import { INDEX_STATUS_INFO, type IndexSource } from '../../shared/index-status';
import { STATUS_INFO, type LinkStatus } from '../../shared/status';
import { INVALID_REASON_TEXT, type InvalidReason } from '../../shared/url';
import { groupLabel } from '../lib/group-labels';

export type CellValue = string | number | Date | null;

export interface Table {
  /** Empty = no header row. */
  headers: string[];
  rows: CellValue[][];
}

export const SOURCE_LABEL: Record<IndexSource, string> = {
  search_console: 'Google Search Console',
  google_search: 'Google search (browser helper)',
  signals: 'Our crawler',
};

const date = (iso: string | null): Date | null => (iso ? new Date(iso) : null);

/** A friendly link result, never a raw code. */
export function linkResult(r: ExportRow): string {
  if (r.url === null) return 'Skipped';
  const info = STATUS_INFO[r.status as LinkStatus];
  const label = info?.label ?? r.status ?? 'Waiting';
  return r.retryAt ? `${label} (retrying automatically)` : label;
}

export function indexResult(r: ExportRow): string {
  if (r.url === null) return 'Skipped';
  if (!r.indexStatus) return 'Waiting';
  const label = INDEX_STATUS_INFO[r.indexStatus]?.label ?? r.indexStatus;
  return r.retryAt ? `${label} (retrying automatically)` : label;
}

export function note(r: ExportRow): string | null {
  if (r.invalidReason) return INVALID_REASON_TEXT[r.invalidReason as InvalidReason] ?? r.invalidReason;
  if (r.duplicate) return 'Same link as an earlier row (checked once)';
  return null;
}

const evidence = (r: ExportRow) =>
  r.indexEvidence?.length ? r.indexEvidence.map((e) => (e.bad ? `✗ ${e.text}` : e.text)).join('; ') : null;

interface Column {
  name: string;
  value: (r: ExportRow) => CellValue;
}

const LINK_COLUMNS: Column[] = [
  { name: 'Link status', value: linkResult },
  { name: 'Status details', value: (r) => r.checkReason },
  { name: 'HTTP code', value: (r) => r.httpStatus },
  { name: 'Final URL', value: (r) => (r.finalUrl && r.finalUrl !== r.url ? r.finalUrl : null) },
  { name: 'Page title', value: (r) => r.pageTitle },
  { name: 'Response time (ms)', value: (r) => r.responseTimeMs },
  { name: 'Checked at', value: (r) => date(r.checkedAt) },
];

const INDEX_COLUMNS: Column[] = [
  { name: 'Index status', value: indexResult },
  { name: 'Answer from', value: (r) => (r.indexSource ? SOURCE_LABEL[r.indexSource] : null) },
  { name: 'Index reason', value: (r) => r.indexReason },
  { name: 'Evidence', value: evidence },
  { name: 'Google checked at', value: (r) => date(r.googleCheckedAt) },
];

/** Where each row came from, and what was checked. */
const SOURCE_COLUMNS: Column[] = [
  { name: 'Sheet', value: (r) => r.sheet },
  { name: 'Row', value: (r) => r.row },
  { name: 'Checked URL', value: (r) => r.url },
  { name: 'Note', value: note },
];

export function exportColumns(tool: ScanDetail['tool']): Column[] {
  return tool === 'index'
    ? [...SOURCE_COLUMNS, ...INDEX_COLUMNS, ...LINK_COLUMNS]
    : [...SOURCE_COLUMNS, ...LINK_COLUMNS];
}

/** A result column never hides an original one: on a clash it is renamed. */
function uniqueNames(original: string[], added: string[]): string[] {
  const taken = new Set(original.map((h) => h.trim().toLowerCase()));
  return added.map((name) => {
    let n = name;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = i === 2 ? `${name} (LinkLedger)` : `${name} (LinkLedger ${i})`;
    taken.add(n.toLowerCase());
    return n;
  });
}

export function buildTable(scan: Pick<ScanDetail, 'headers' | 'tool'>, rows: ExportRow[]): Table {
  const original = scan.headers;
  const columns = exportColumns(scan.tool);
  return {
    headers: [
      ...original,
      ...uniqueNames(
        original,
        columns.map((c) => c.name),
      ),
    ],
    rows: rows.map((r) => [
      ...original.map((h) => {
        const v = r.cells[h];
        return v === undefined || v === '' ? null : v;
      }),
      ...columns.map((c) => c.value(r)),
    ]),
  };
}

/** Second sheet: what this file is, and how many rows have each result. */
export function buildSummary(
  scan: Pick<ScanDetail, 'fileName' | 'tool' | 'createdAt' | 'completedAt' | 'uniqueUrls' | 'status'>,
  rows: ExportRow[],
  filters: RowFilters | null,
  exportedAt: Date,
): Table {
  const isIndex = scan.tool === 'index';
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = isIndex ? indexResult(r) : linkResult(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const lines: CellValue[][] = [
    ['File', scan.fileName],
    ['Tool', isIndex ? TOOLS.indexChecker : TOOLS.linkHealth],
    ['Uploaded', new Date(scan.createdAt)],
    ['Checking finished', scan.completedAt ? new Date(scan.completedAt) : 'Not finished yet'],
    ['Downloaded', exportedAt],
    ['Rows in this file', rows.length],
    ['Unique links in the scan', scan.uniqueUrls],
    ['Filters', filters ? describeFilters(filters, scan.tool) : 'None: every row'],
    [null, null],
    [isIndex ? 'Index status' : 'Link status', 'Rows'],
    ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n] as CellValue[]),
  ];
  return { headers: [], rows: lines };
}

export function describeFilters(f: RowFilters, tool: ScanDetail['tool']): string {
  const parts: string[] = [];
  if (f.group !== 'all') parts.push(`Result: ${groupLabel(f.group, tool)}`);
  if (f.sheet) parts.push(`Sheet: ${f.sheet}`);
  if (f.http) parts.push(`HTTP code: ${f.http === 'none' ? 'no response' : f.http}`);
  if (f.q) parts.push(`Search: “${f.q}”`);
  return parts.length ? parts.join(' · ') : 'None: every row';
}

export const hasFilters = (f: RowFilters) => f.group !== 'all' || !!f.sheet || !!f.http || !!f.q;

/** "Backlinks Q3.xlsx" -> "Backlinks Q3 - LinkLedger results 2026-10-06" (safe on Windows too). */
export function exportFileName(fileName: string, tool: ScanDetail['tool'], when: Date, filtered: boolean): string {
  const base =
    fileName
      .replace(/\.(xlsx|xlsm|xls|csv|txt)$/i, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'scan';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `${base} - LinkLedger ${tool === 'index' ? 'index' : 'link'} results${filtered ? ' (filtered)' : ''} ${day}`;
}
