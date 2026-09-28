/**
 * Checks the next few waiting links of a scan, then updates the scan's totals.
 * Used by POST /api/scans/:id/check now, and by the queue consumer in Phase 5.
 */
import type { Db } from '../db/db';
import type { Env } from '../env';
import { BudgetExhausted, SubrequestBudget } from './budget';
import { checkLink, type CheckResult } from './check-link';
import { createResolver } from './dns';

export const BATCH_SIZE = 8;
/** Free plan allows 50; keep a margin. */
export const SUBREQUEST_LIMIT = 45;
const CLAIM_STALE_SECONDS = 120;
const SAME_HOST_DELAY_MS = 800;
const HOST_CONCURRENCY = 4;

export interface BatchOutcome {
  processed: number;
  remaining: number;
}

interface Claimed {
  url_index: number;
  url: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return u;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs groups (one per website) with limited concurrency; each group runs one request at a time. */
async function politely<T>(groups: T[][], run: (item: T) => Promise<void>) {
  const queue = [...groups];
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      for (let i = 0; i < g.length; i++) {
        if (i > 0) await sleep(SAME_HOST_DELAY_MS);
        await run(g[i]!);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, queue.length) }, worker));
}

export async function runCheckBatch(
  db: Db,
  env: Env,
  scanId: string,
  opts: { ownHost: string; batchSize?: number },
): Promise<BatchOutcome> {
  const now = Math.floor(Date.now() / 1000);

  // Reserve the next links. Old reservations (tab closed mid-batch) are taken over.
  const claimed = await db.query<Claimed>(
    `UPDATE unique_urls SET status = 'CHECKING', claimed_at = $2
     WHERE scan_id = $1 AND url_index IN (
       SELECT url_index FROM unique_urls
       WHERE scan_id = $1 AND (status = 'PENDING' OR (status = 'CHECKING' AND claimed_at < $3))
       ORDER BY url_index LIMIT $4
       FOR UPDATE SKIP LOCKED)
     RETURNING url_index, url`,
    [scanId, now, now - CLAIM_STALE_SECONDS, opts.batchSize ?? BATCH_SIZE],
  );

  const results = new Map<number, CheckResult>();
  if (claimed.length) {
    const budget = new SubrequestBudget(SUBREQUEST_LIMIT);
    const deps = {
      resolver: createResolver(),
      budget,
      blockedHosts: new Set([opts.ownHost.toLowerCase()]),
      skipDns: env.APP_ENV === 'development' && env.CHECKER_SKIP_DNS === 'true',
    };
    const byHost = new Map<string, Claimed[]>();
    for (const c of claimed) byHost.set(hostOf(c.url), [...(byHost.get(hostOf(c.url)) ?? []), c]);

    await politely([...byHost.values()], async (c) => {
      try {
        results.set(c.url_index, await checkLink(c.url, deps));
      } catch (e) {
        if (!(e instanceof BudgetExhausted)) throw e;
        // Out of requests for this invocation: leave it for the next batch.
      }
    });
  }

  // One statement saves every result; unfinished links go back to waiting.
  const payload = claimed.map((c) => {
    const r = results.get(c.url_index);
    return r
      ? {
          i: c.url_index,
          status: r.status,
          http: r.httpStatus,
          final: r.finalUrl,
          redirected: r.redirected,
          ms: r.responseTimeMs,
          error: r.error,
          reason: r.reason,
          counted: 1,
        }
      : { i: c.url_index, status: 'PENDING', counted: 0 };
  });
  const checkedAt = new Date().toISOString();

  if (payload.length) {
    await db.query(
      `UPDATE unique_urls u SET
         status = j.status,
         http_status = j.http,
         final_url = j.final,
         redirected = COALESCE(j.redirected, false),
         response_time_ms = j.ms,
         error_message = j.error,
         check_reason = j.reason,
         attempts = u.attempts + j.counted,
         checked_at = CASE WHEN j.counted = 1 THEN $3::timestamptz ELSE u.checked_at END,
         claimed_at = NULL
       FROM jsonb_to_recordset($2::jsonb) AS j(
         i int, status text, http int, final text, redirected boolean, ms int,
         error text, reason text, counted int)
       WHERE u.scan_id = $1 AND u.url_index = j.i`,
      [scanId, JSON.stringify(payload), checkedAt],
    );
  }

  // Recount the scan's totals from the source of truth and move its status on.
  const [row] = await db.query<{ remaining: number }>(
    `WITH c AS (
       SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('PENDING', 'CHECKING'))::int AS checked,
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (WHERE status = 'DEAD')::int AS dead,
         COUNT(*) FILTER (WHERE status = 'SOFT_404')::int AS soft404,
         COUNT(*) FILTER (WHERE status = 'REDIRECTED')::int AS redirected,
         COUNT(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
         COUNT(*) FILTER (WHERE status IN ('RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'))::int AS errors,
         COUNT(*) FILTER (WHERE status IN ('PENDING', 'CHECKING'))::int AS remaining
       FROM unique_urls WHERE scan_id = $1)
     UPDATE scans s SET
       checked_count = c.checked, active_count = c.active, dead_count = c.dead, soft_404_count = c.soft404,
       redirected_count = c.redirected, blocked_count = c.blocked, error_count = c.errors,
       started_at = COALESCE(s.started_at, $2::timestamptz),
       status = CASE WHEN c.remaining > 0 THEN 'running' ELSE 'completed' END,
       completed_at = CASE WHEN c.remaining > 0 THEN NULL ELSE $2::timestamptz END
     FROM c WHERE s.id = $1
     RETURNING c.remaining`,
    [scanId, checkedAt],
  );
  return { processed: results.size, remaining: row?.remaining ?? 0 };
}
