import type {
  RowFacets,
  RowFilterGroup,
  RowFilters,
  ScanDetail,
  ScanRowView,
  ScanStatus,
  ScanSummary,
  SheetInfo,
} from '../../shared/api';
import { iso, num, type Db } from './db';

export interface ScanRecord {
  id: string;
  user_id: string;
  file_name: string;
  file_size: number;
  status: ScanStatus;
  worksheets: number;
  sheets_json: SheetInfo[];
  headers_json: string[];
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
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
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
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
  };
}

export function toDetail(r: ScanRecord): ScanDetail {
  return { ...toSummary(r), sheets: r.sheets_json, headers: r.headers_json };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Always scoped to the owner: another user's scan simply "doesn't exist". */
export async function getScan(db: Db, userId: string, scanId: string): Promise<ScanRecord | null> {
  if (!UUID.test(scanId)) return null; // a mistyped address is "not found", not a database error
  const [row] = await db.query<ScanRecord>('SELECT * FROM scans WHERE id = $1 AND user_id = $2', [scanId, userId]);
  return row ?? null;
}

export async function listScans(db: Db, userId: string, limit = 100): Promise<ScanSummary[]> {
  const rows = await db.query<ScanRecord>('SELECT * FROM scans WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [
    userId,
    limit,
  ]);
  return rows.map(toSummary);
}

interface RowRecord {
  sheet_name: string;
  row_number: number;
  original_value: string;
  url: string | null;
  is_duplicate: boolean;
  invalid_reason: string | null;
  target_url: string | null;
  anchor_text: string | null;
  status: string | null;
  check_reason: string | null;
  http_status: number | null;
  final_url: string | null;
  response_time_ms: number | null;
  checked_at: string | Date | null;
}

/** SQL condition for each status group (rows joined to their unique URL as "u"). */
const GROUP_SQL: Record<Exclude<RowFilterGroup, 'all'>, string> = {
  active: `u.status = 'ACTIVE'`,
  dead: `u.status IN ('DEAD', 'SOFT_404')`,
  redirected: `u.status = 'REDIRECTED'`,
  review: `u.status IN ('BLOCKED', 'RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR')`,
  waiting: `u.status IN ('PENDING', 'CHECKING')`,
  skipped: `r.url_index IS NULL`,
};

const FROM = `FROM scan_rows r LEFT JOIN unique_urls u ON u.scan_id = r.scan_id AND u.url_index = r.url_index`;

/**
 * WHERE clause for everything except the status group, so the group buttons
 * can show counts that respect the other filters. User input is always a
 * bound parameter; strpos() makes % and _ in the search text literal.
 */
function baseWhere(scanId: string, f: RowFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [scanId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const parts = ['r.scan_id = $1'];
  if (f.sheet) parts.push(`r.sheet_name = ${p(f.sheet)}`);
  if (f.http === 'none') parts.push('u.http_status IS NULL');
  else if (f.http) parts.push(`u.http_status = ${p(Number(f.http))}`);
  if (f.q) {
    const q = p(f.q.toLowerCase());
    parts.push(
      `(strpos(lower(r.original_value), ${q}) > 0 OR strpos(lower(COALESCE(u.url, '')), ${q}) > 0
        OR strpos(lower(COALESCE(r.target_url, '')), ${q}) > 0)`,
    );
  }
  return { sql: parts.join(' AND '), params };
}

export async function listRows(
  db: Db,
  scanId: string,
  page: number,
  pageSize: number,
  filters: RowFilters,
  /** Worksheet names, from the scan record (saves reading every row to list them). */
  sheetNames: string[],
): Promise<{ rows: ScanRowView[]; total: number; facets: RowFacets }> {
  const base = baseWhere(scanId, filters);
  const where = filters.group === 'all' ? base.sql : `${base.sql} AND ${GROUP_SQL[filters.group]}`;
  const n = base.params.length;
  const groupCounts = Object.entries(GROUP_SQL)
    .map(([g, cond]) => `COUNT(*) FILTER (WHERE ${cond})::int AS ${g}`)
    .join(', ');

  // Independent reads: run them together over the same connection.
  const [count, rows, facets, codes] = await Promise.all([
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM} WHERE ${where}`, base.params),
    db.query<RowRecord>(
      `SELECT r.sheet_name, r.row_number, r.original_value, u.url, r.is_duplicate, r.invalid_reason,
              r.target_url, r.anchor_text, u.status, u.check_reason, u.http_status, u.final_url,
              u.response_time_ms, u.checked_at
       ${FROM} WHERE ${where}
       ORDER BY r.seq
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...base.params, pageSize, (page - 1) * pageSize],
    ),
    db.query<Record<string, number>>(
      `SELECT COUNT(*)::int AS all_rows, ${groupCounts} ${FROM} WHERE ${base.sql}`,
      base.params,
    ),
    db.query<{ code: number }>(
      `SELECT DISTINCT http_status AS code FROM unique_urls
       WHERE scan_id = $1 AND http_status IS NOT NULL ORDER BY http_status`,
      [scanId],
    ),
  ]);

  const f = facets[0] ?? {};
  return {
    total: num(count[0]?.n),
    facets: {
      groups: {
        all: num(f.all_rows),
        active: num(f.active),
        dead: num(f.dead),
        redirected: num(f.redirected),
        review: num(f.review),
        waiting: num(f.waiting),
        skipped: num(f.skipped),
      },
      httpCodes: codes.map((r) => r.code),
      sheets: sheetNames,
    },
    rows: rows.map((r) => ({
      sheet: r.sheet_name,
      row: r.row_number,
      value: r.original_value,
      url: r.url,
      duplicate: r.is_duplicate,
      invalidReason: r.invalid_reason,
      targetUrl: r.target_url,
      anchorText: r.anchor_text,
      status: r.status,
      checkReason: r.check_reason,
      httpStatus: r.http_status,
      finalUrl: r.final_url,
      responseTimeMs: r.response_time_ms,
      checkedAt: iso(r.checked_at),
    })),
  };
}
