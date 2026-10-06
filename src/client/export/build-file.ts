/** Builds the Excel or CSV download from a scan's rows. Runs in the browser. */
import type { ExportRow, RowFilters, ScanDetail } from '../../shared/api';
import { toCsv } from './csv';
import { buildSummary, buildTable, exportFileName, hasFilters } from './table';
import { toXlsx } from './xlsx-writer';

export type ExportFormat = 'xlsx' | 'csv';

export function buildFile(
  scan: ScanDetail,
  rows: ExportRow[],
  filters: RowFilters | null,
  format: ExportFormat,
  now = new Date(),
): { name: string; blob: Blob } {
  const filtered = filters !== null && hasFilters(filters);
  const name = `${exportFileName(scan.fileName, scan.tool, now, filtered)}.${format}`;
  const table = buildTable(scan, rows);
  if (format === 'csv') return { name, blob: new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' }) };
  const bytes = toXlsx([
    { name: 'Results', table },
    { name: 'Summary', table: buildSummary(scan, rows, filtered ? filters : null, now) },
  ]);
  return {
    name,
    blob: new Blob([new Uint8Array(bytes)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  };
}
