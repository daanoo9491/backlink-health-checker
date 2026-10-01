import type {
  RowFacets,
  RowFilterGroup,
  RowFilters,
  RowSort,
  ScanDetail,
  ScanRowView,
  ScanStatus,
  ScanSummary,
  SheetInfo,
  SortDir,
} from '../../shared/api';
import { ISSUE_CATEGORIES, REVIEW_STATUSES, STATUS_SORT_ORDER } from '../../shared/issues';
import { LINK_STATUSES, type LinkStatus } from '../../shared/status';
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
  heartbeat_at: string | Date | null;
  chain_id?: string | null;
  app_host?: string | null;
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
    heartbeatAt: iso(r.heartbeat_at),
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
  retry_at: string | number | null;
  http_status: number | null;
  final_url: string | null;
  response_time_ms: number | null;
  checked_at: string | Date | null;
}

/** Status names come from our own constant lists, never from user input. */
const inList = (statuses: readonly LinkStatus[]) => statuses.map((x) => `'${x}'`).join(', ');
const category = (key: string) => ISSUE_CATEGORIES.find((c) => c.key === key)!.statuses;

/**
 * SQL condition for each status group (rows joined to their unique URL as "u").
 * A link waiting for an automatic retry is only in "waiting", so the groups
 * don't overlap and add up.
 */
const GROUP_SQL: Record<Exclude<RowFilterGroup, 'all'>, string> = {
  active: `u.status = 'ACTIVE'`,
  dead: `u.status IN (${inList(category('dead'))})`,
  redirected: `u.status = 'REDIRECTED'`,
  review: `u.status IN (${inList(REVIEW_STATUSES)}) AND u.retry_at IS NULL`,
  unreachable: `u.status IN (${inList(category('unreachable'))}) AND u.retry_at IS NULL`,
  site_error: `u.status IN (${inList(category('site_error'))}) AND u.retry_at IS NULL`,
  refused: `u.status IN (${inList(category('refused'))}) AND u.retry_at IS NULL`,
  waiting: `(u.status IN ('PENDING', 'CHECKING') OR u.retry_at IS NOT NULL)`,
  skipped: `r.url_index IS NULL`,
};

/** Most urgent first; skipped rows (no link) last. */
const STATUS_RANK = `CASE u.status ${STATUS_SORT_ORDER.map((st, i) => `WHEN '${st}' THEN ${i}`).join(' ')} ELSE ${STATUS_SORT_ORDER.length} END`;

/** ORDER BY for each sort; ties keep workbook order. Only these fixed strings reach SQL. */
function orderBy(sort: RowSort, dir: SortDir): string {
  const d = dir === 'desc' ? 'DESC' : 'ASC';
  switch (sort) {
    case 'url':
      return `lower(COALESCE(u.url, r.original_value)) ${d}, r.seq`;
    case 'status': // skipped rows (no link) stay at the end either way
      return `(u.status IS NULL), ${STATUS_RANK} ${d}, r.seq`;
    case 'http':
      return `u.http_status ${d} NULLS LAST, r.seq`;
    default:
      return `r.seq ${d}`;
  }
}

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
  const [count, rows, facets, links] = await Promise.all([
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM} WHERE ${where}`, base.params),
    db.query<RowRecord>(
      `SELECT r.sheet_name, r.row_number, r.original_value, u.url, r.is_duplicate, r.invalid_reason,
              r.target_url, r.anchor_text, u.status, u.check_reason, u.retry_at, u.http_status, u.final_url,
              u.response_time_ms, u.checked_at
       ${FROM} WHERE ${where}
       ORDER BY ${orderBy(filters.sort, filters.dir)}
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...base.params, pageSize, (page - 1) * pageSize],
    ),
    db.query<Record<string, number>>(
      `SELECT COUNT(*)::int AS all_rows, ${groupCounts} ${FROM} WHERE ${base.sql}`,
      base.params,
    ),
    // One pass over the scan's links gives both the HTTP codes and the per-result counts.
    db.query<{ status: string; retrying: boolean; code: number | null; n: number }>(
      `SELECT status, (retry_at IS NOT NULL) AS retrying, http_status AS code, COUNT(*)::int AS n
       FROM unique_urls WHERE scan_id = $1
       GROUP BY 1, 2, 3`,
      [scanId],
    ),
  ]);

  const byStatus: Partial<Record<LinkStatus, number>> = {};
  let retrying = 0;
  const codes = new Set<number>();
  for (const l of links) {
    if (l.code !== null) codes.add(num(l.code));
    if (l.retrying) retrying += num(l.n);
    else if ((LINK_STATUSES as readonly string[]).includes(l.status)) {
      const st = l.status as LinkStatus;
      byStatus[st] = (byStatus[st] ?? 0) + num(l.n);
    }
  }

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
        unreachable: num(f.unreachable),
        site_error: num(f.site_error),
        refused: num(f.refused),
        waiting: num(f.waiting),
        skipped: num(f.skipped),
      },
      httpCodes: [...codes].sort((a, b) => a - b),
      sheets: sheetNames,
      links: { byStatus, retrying },
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
      retryAt: r.retry_at === null ? null : new Date(Number(r.retry_at) * 1000).toISOString(),
      httpStatus: r.http_status,
      finalUrl: r.final_url,
      responseTimeMs: r.response_time_ms,
      checkedAt: iso(r.checked_at),
    })),
  };
}
