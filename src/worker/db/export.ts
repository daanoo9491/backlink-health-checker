/**
 * Rows for the Excel/CSV download (Phase 11).
 *
 * The file itself is built in the browser: on the free plan a Worker gets
 * about 10 ms of CPU per request, too little to zip thousands of rows. The
 * Worker only hands out the rows in small pages, in the workbook's order.
 * Paging is by position in the workbook (seq), not OFFSET, so rows that change
 * while checking is still running are never skipped or repeated.
 */
import { EXPORT_PAGE_SIZE, type ExportPageResponse, type RowFilters } from '../../shared/api';
import type { IndexEvidence, IndexSource, IndexStatus } from '../../shared/index-status';
import { baseWhere, FROM, GROUP_SQL } from './scans';
import { iso, num, type Db } from './db';

interface ExportRecord {
  seq: string | number;
  sheet_name: string;
  row_number: number;
  original_value: string;
  cells_json: Record<string, string> | null;
  url: string | null;
  is_duplicate: boolean;
  invalid_reason: string | null;
  target_url: string | null;
  anchor_text: string | null;
  status: string | null;
  check_reason: string | null;
  retry_at: string | number | null;
  http_status: number | null;
  final_url: string | null;
  page_title: string | null;
  response_time_ms: number | null;
  checked_at: string | Date | null;
  index_status: string | null;
  index_reason: string | null;
  index_evidence: IndexEvidence[] | null;
  index_source: string | null;
  google_checked_at: string | Date | null;
}

/** `after` is the seq of the last row already sent ('' for the first page). */
export async function exportRows(
  db: Db,
  scanId: string,
  filters: RowFilters,
  after: string,
): Promise<ExportPageResponse> {
  const base = baseWhere(scanId, filters);
  const where = filters.group === 'all' ? base.sql : `${base.sql} AND ${GROUP_SQL[filters.group]}`;
  const params = [...base.params];
  let cursor = '';
  if (/^\d{1,18}$/.test(after)) {
    params.push(after);
    cursor = ` AND r.seq > $${params.length}::bigint`;
  }
  params.push(EXPORT_PAGE_SIZE + 1); // one extra tells us whether there is another page

  const [records, count] = await Promise.all([
    db.query<ExportRecord>(
      `SELECT r.seq, r.sheet_name, r.row_number, r.original_value, r.cells_json, u.url, r.is_duplicate,
              r.invalid_reason, r.target_url, r.anchor_text, u.status, u.check_reason, u.retry_at, u.http_status,
              u.final_url, u.page_title, u.response_time_ms, u.checked_at, u.index_status, u.index_reason,
              u.index_evidence, u.index_source, u.google_checked_at
       ${FROM} WHERE ${where}${cursor}
       ORDER BY r.seq LIMIT $${params.length}`,
      params,
    ),
    cursor
      ? Promise.resolve(null)
      : db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM} WHERE ${where}`, base.params),
  ]);

  const more = records.length > EXPORT_PAGE_SIZE;
  const page = more ? records.slice(0, EXPORT_PAGE_SIZE) : records;
  return {
    total: count ? num(count[0]?.n) : null,
    next: more ? String(page[page.length - 1]!.seq) : null,
    rows: page.map((r) => ({
      sheet: r.sheet_name,
      row: r.row_number,
      value: r.original_value,
      cells: r.cells_json ?? {},
      url: r.url,
      duplicate: r.is_duplicate,
      invalidReason: r.invalid_reason,
      targetUrl: r.target_url,
      anchorText: r.anchor_text,
      status: r.status,
      checkReason: r.check_reason,
      retryAt: r.retry_at === null ? null : new Date(Number(r.retry_at) * 1000).toISOString(),
      httpStatus: r.http_status,
      finalUrl: r.final_url,
      pageTitle: r.page_title,
      responseTimeMs: r.response_time_ms,
      checkedAt: iso(r.checked_at),
      indexStatus: (r.index_status as IndexStatus | null) ?? null,
      indexReason: r.index_reason,
      indexEvidence: r.index_evidence,
      indexSource: (r.index_source as IndexSource | null) ?? null,
      googleCheckedAt: iso(r.google_checked_at),
    })),
  };
}
