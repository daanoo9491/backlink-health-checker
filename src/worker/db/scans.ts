import type { ScanDetail, ScanRowView, ScanStatus, ScanSummary, SheetInfo } from '../../shared/api';
import type { Env } from '../env';

export interface ScanRecord {
  id: string;
  user_id: string;
  file_name: string;
  file_size: number;
  status: ScanStatus;
  worksheets: number;
  sheets_json: string;
  headers_json: string;
  expected_rows: number;
  expected_urls: number;
  total_rows: number;
  valid_urls: number;
  invalid_rows: number;
  blank_rows: number;
  unique_urls: number;
  duplicate_rows: number;
  checked_count: number;
  active_count: number;
  dead_count: number;
  soft_404_count: number;
  redirected_count: number;
  blocked_count: number;
  error_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export function toSummary(r: ScanRecord): ScanSummary {
  return {
    id: r.id,
    fileName: r.file_name,
    fileSize: r.file_size,
    status: r.status,
    worksheets: r.worksheets,
    totalRows: r.total_rows,
    validUrls: r.valid_urls,
    invalidRows: r.invalid_rows,
    blankRows: r.blank_rows,
    uniqueUrls: r.unique_urls,
    duplicateRows: r.duplicate_rows,
    checkedCount: r.checked_count,
    activeCount: r.active_count,
    deadCount: r.dead_count,
    soft404Count: r.soft_404_count,
    redirectedCount: r.redirected_count,
    blockedCount: r.blocked_count,
    errorCount: r.error_count,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export function toDetail(r: ScanRecord): ScanDetail {
  return {
    ...toSummary(r),
    sheets: JSON.parse(r.sheets_json) as SheetInfo[],
    headers: JSON.parse(r.headers_json) as string[],
  };
}

/** Always scoped to the owner: another user's scan simply "doesn't exist". */
export function getScan(env: Env, userId: string, scanId: string) {
  return env.DB.prepare('SELECT * FROM scans WHERE id = ?1 AND user_id = ?2').bind(scanId, userId).first<ScanRecord>();
}

export async function listScans(env: Env, userId: string, limit = 100): Promise<ScanSummary[]> {
  const { results } = await env.DB.prepare('SELECT * FROM scans WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2')
    .bind(userId, limit)
    .all<ScanRecord>();
  return results.map(toSummary);
}

interface RowRecord {
  sheet_name: string;
  row_number: number;
  original_value: string;
  url: string | null;
  is_duplicate: number;
  invalid_reason: string | null;
  target_url: string | null;
  anchor_text: string | null;
  status: string | null;
  http_status: number | null;
  final_url: string | null;
  response_time_ms: number | null;
  checked_at: string | null;
}

export async function listRows(
  env: Env,
  scanId: string,
  page: number,
  pageSize: number,
): Promise<{ rows: ScanRowView[]; total: number }> {
  const [count, rows] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM scan_rows WHERE scan_id = ?1').bind(scanId),
    env.DB.prepare(
      `SELECT r.sheet_name, r.row_number, r.original_value, u.url, r.is_duplicate, r.invalid_reason,
              r.target_url, r.anchor_text, u.status, u.http_status, u.final_url, u.response_time_ms, u.checked_at
       FROM scan_rows r
       LEFT JOIN unique_urls u ON u.scan_id = r.scan_id AND u.url_index = r.url_index
       WHERE r.scan_id = ?1
       ORDER BY r.rowid
       LIMIT ?2 OFFSET ?3`,
    ).bind(scanId, pageSize, (page - 1) * pageSize),
  ]);
  const total = (count!.results[0] as { n: number }).n;
  return {
    total,
    rows: (rows!.results as RowRecord[]).map((r) => ({
      sheet: r.sheet_name,
      row: r.row_number,
      value: r.original_value,
      url: r.url,
      duplicate: r.is_duplicate === 1,
      invalidReason: r.invalid_reason,
      targetUrl: r.target_url,
      anchorText: r.anchor_text,
      status: r.status,
      httpStatus: r.http_status,
      finalUrl: r.final_url,
      responseTimeMs: r.response_time_ms,
      checkedAt: r.checked_at,
    })),
  };
}
