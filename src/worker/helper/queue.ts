/**
 * The Google-check queue for the browser helper. The helper (a Chrome
 * extension in a team member's own browser) takes a few links at a time,
 * searches Google for each, and reports what it saw. All SQL here is scoped
 * to the helper's own user.
 */
import type { Db } from '../db/db';

/** Links still waiting for a Google search ("u" = unique_urls, "s" = scans). */
export const GOOGLE_QUEUE_SQL = `s.tool = 'index'
  AND u.google_status IS NULL
  AND u.index_status IS NOT NULL
  AND u.index_status <> 'NOT_REACHABLE'
  AND u.retry_at IS NULL
  AND u.index_source IS DISTINCT FROM 'search_console'`;

/** A taken link goes back to the queue if no answer arrives within this time. */
const CLAIM_MINUTES = 10;
/** After this many failed searches a link is marked ERROR and not tried again. */
export const MAX_GOOGLE_ATTEMPTS = 3;

/** Index counters for the scan lists; same rules as the batch recount. */
export const INDEX_COUNT_SQL = `
  COUNT(*) FILTER (WHERE index_status IN ('INDEXABLE', 'INDEXED'))::int AS indexable,
  COUNT(*) FILTER (WHERE index_status IN ('NOT_INDEXED', 'NOINDEX', 'ROBOTS_BLOCKED', 'CANONICAL_ELSEWHERE', 'NOT_REACHABLE')
                    AND retry_at IS NULL)::int AS idx_issues,
  COUNT(*) FILTER (WHERE index_status = 'UNKNOWN' AND retry_at IS NULL)::int AS idx_unknown`;

export interface HelperJob {
  id: string;
  url: string;
}

/** Takes up to `max` links, newest index check first. */
export async function claimJobs(db: Db, userId: string, max: number): Promise<HelperJob[]> {
  const rows = await db.query<{ scan_id: string; url_index: number; url: string }>(
    `WITH picked AS MATERIALIZED (
       SELECT u.scan_id, u.url_index
       FROM unique_urls u JOIN scans s ON s.id = u.scan_id
       WHERE s.user_id = $1 AND ${GOOGLE_QUEUE_SQL}
         AND (u.google_claimed_at IS NULL OR u.google_claimed_at < now() - make_interval(mins => $3))
       ORDER BY s.created_at DESC, u.url_index
       LIMIT $2
       FOR UPDATE OF u SKIP LOCKED)
     UPDATE unique_urls u SET google_claimed_at = now()
     FROM picked p WHERE u.scan_id = p.scan_id AND u.url_index = p.url_index
     RETURNING u.scan_id, u.url_index, u.url`,
    [userId, max, CLAIM_MINUTES],
  );
  return rows.map((r) => ({ id: `${r.scan_id}:${r.url_index}`, url: r.url }));
}

export interface HelperResult {
  scanId: string;
  urlIndex: number;
  /** SKIP: not searched (Google unreachable or asking for a human check): back to the queue, no try counted. */
  outcome: 'FOUND' | 'NOT_FOUND' | 'ERROR' | 'SKIP';
  /** Shown as evidence; built on the server from the helper's report. */
  detail: string;
}

/**
 * Saves the helper's answers. A Google answer replaces the signal-based
 * result (the crawler's evidence stays underneath); Search Console answers
 * are never overwritten. Returns how many links were updated.
 */
export async function saveResults(db: Db, userId: string, results: HelperResult[]): Promise<number> {
  if (results.length === 0) return 0;
  const touched = await db.query<{ scan_id: string }>(
    `WITH j AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS j(scan_id uuid, i int, outcome text, detail text)
     )
     UPDATE unique_urls u SET
       google_attempts = u.google_attempts + CASE WHEN j.outcome = 'SKIP' THEN 0 ELSE 1 END,
       google_claimed_at = NULL,
       google_detail = CASE WHEN j.outcome = 'SKIP' THEN u.google_detail ELSE j.detail END,
       google_status = CASE WHEN j.outcome IN ('FOUND', 'NOT_FOUND') THEN j.outcome
                            WHEN j.outcome = 'ERROR' AND u.google_attempts + 1 >= $3 THEN 'ERROR' ELSE NULL END,
       google_checked_at = CASE WHEN j.outcome IN ('FOUND', 'NOT_FOUND') THEN now() ELSE u.google_checked_at END,
       index_status = CASE j.outcome WHEN 'FOUND' THEN 'INDEXED' WHEN 'NOT_FOUND' THEN 'NOT_INDEXED' ELSE u.index_status END,
       index_source = CASE WHEN j.outcome IN ('FOUND', 'NOT_FOUND') THEN 'google_search' ELSE u.index_source END,
       index_reason = CASE j.outcome
                        WHEN 'FOUND' THEN 'Found in Google for this exact URL'
                        WHEN 'NOT_FOUND' THEN 'Not found in Google for this exact URL'
                        ELSE u.index_reason END,
       index_evidence = CASE WHEN j.outcome IN ('FOUND', 'NOT_FOUND')
         THEN jsonb_build_array(
                jsonb_build_object('signal', 'google', 'text', j.detail, 'bad', j.outcome = 'NOT_FOUND'),
                jsonb_build_object('signal', 'page', 'text', 'Our own check:'))
              || COALESCE(u.index_evidence, '[]'::jsonb)
         ELSE u.index_evidence END
     FROM j, scans s
     WHERE u.scan_id = j.scan_id AND u.url_index = j.i
       AND s.id = u.scan_id AND s.user_id = $1
       AND u.google_status IS NULL
       AND u.index_source IS DISTINCT FROM 'search_console'
     RETURNING u.scan_id`,
    [
      userId,
      JSON.stringify(results.map((r) => ({ scan_id: r.scanId, i: r.urlIndex, outcome: r.outcome, detail: r.detail }))),
      MAX_GOOGLE_ATTEMPTS,
    ],
  );
  const scans = [...new Set(touched.map((t) => t.scan_id))];
  if (scans.length) {
    await db.query(
      `UPDATE scans s SET indexable_count = c.indexable, index_issue_count = c.idx_issues,
                          index_unknown_count = c.idx_unknown
       FROM (SELECT scan_id, ${INDEX_COUNT_SQL} FROM unique_urls WHERE scan_id = ANY($1::uuid[]) GROUP BY scan_id) c
       WHERE s.id = c.scan_id`,
      [scans],
    );
  }
  return touched.length;
}

export async function helperStatus(db: Db, userId: string): Promise<{ pending: number; checkedToday: number }> {
  const [r] = await db.query<{ pending: number; today: number }>(
    `SELECT COUNT(*) FILTER (WHERE ${GOOGLE_QUEUE_SQL})::int AS pending,
            COUNT(*) FILTER (WHERE u.google_checked_at >= date_trunc('day', now()))::int AS today
     FROM unique_urls u JOIN scans s ON s.id = u.scan_id
     WHERE s.user_id = $1 AND s.tool = 'index'`,
    [userId],
  );
  return { pending: r?.pending ?? 0, checkedToday: r?.today ?? 0 };
}
