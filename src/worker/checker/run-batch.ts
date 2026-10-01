/**
 * Checks the next few waiting links of a scan, then updates the scan's totals.
 * Called by the queue consumer (one message = one batch).
 *
 * Temporary failures (timeouts, 429, 5xx, dropped connections) are retried
 * automatically: up to MAX_ATTEMPTS in total, waiting 1 minute, then 4
 * (longer if the site sent Retry-After, at most 15). Until the last attempt,
 * the link keeps its latest result and counts as "still to do".
 */
import type { Db } from '../db/db';
import type { ScanRecord } from '../db/scans';
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

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 15 * 60;

export interface BatchOutcome {
  processed: number;
  /** Links still to do: waiting, being checked, or due a retry later. */
  remaining: number;
  /** When nothing could be checked now: seconds until the next retry falls due (null if none). */
  nextDueInSec: number | null;
  /** The scan after this batch, when its totals were recounted (null if nothing was checked). */
  scan: ScanRecord | null;
  /** Some links ran out of the per-invocation request budget and went back to waiting. */
  cutShort: boolean;
}

/** Wait before attempt n+1 (n = attempts made so far, 1-based). */
export function retryDelaySeconds(attemptsMade: number, retryAfterSec?: number): number {
  const backoff = RETRY_BASE_SECONDS * 4 ** Math.max(0, attemptsMade - 1); // 60 s, 240 s, …
  return Math.min(RETRY_MAX_SECONDS, Math.max(backoff, retryAfterSec ?? 0));
}

interface Claimed {
  url_index: number;
  url: string;
  attempts: number;
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

  // Reserve the next links: waiting ones, retries that are due, and reservations
  // left behind by a batch that was interrupted.
  const claimed = await db.query<Claimed>(
    `UPDATE unique_urls SET status = 'CHECKING', claimed_at = $2, retry_at = NULL
     WHERE scan_id = $1 AND url_index IN (
       SELECT url_index FROM unique_urls
       WHERE scan_id = $1 AND (status = 'PENDING'
                               OR (status = 'CHECKING' AND claimed_at < $3)
                               OR retry_at <= $2)
       ORDER BY url_index LIMIT $4
       FOR UPDATE SKIP LOCKED)
     RETURNING url_index, url, attempts`,
    [scanId, now, now - CLAIM_STALE_SECONDS, opts.batchSize ?? BATCH_SIZE],
  );

  // Nothing to check right now (only retries that aren't due yet, or links another
  // batch holds): one small query that also keeps the heartbeat fresh, no recount.
  if (claimed.length === 0) {
    const [c] = await db.query<{ remaining: number; next_due: string | number | null }>(
      `WITH c AS (
         SELECT COUNT(*) FILTER (WHERE status IN ('PENDING', 'CHECKING') OR retry_at IS NOT NULL)::int AS remaining,
                MIN(retry_at) AS next_due
         FROM unique_urls WHERE scan_id = $1)
       UPDATE scans s SET
         heartbeat_at = now(),
         -- Waiting for retries counts as running; nothing left at all means done
         -- (e.g. resumed after a pause that came in during the final batch).
         status = CASE WHEN s.status = 'paused' THEN 'paused' WHEN c.remaining > 0 THEN 'running' ELSE 'completed' END,
         started_at = COALESCE(s.started_at, now()),
         completed_at = CASE WHEN c.remaining = 0 AND s.status <> 'paused' THEN now() ELSE s.completed_at END
       FROM c WHERE s.id = $1
       RETURNING c.remaining, c.next_due`,
      [scanId],
    );
    const nextDue = c?.next_due === null || c?.next_due === undefined ? null : Number(c.next_due);
    return {
      processed: 0,
      remaining: c?.remaining ?? 0,
      nextDueInSec: nextDue === null ? null : Math.max(0, nextDue - now),
      scan: null,
      cutShort: false,
    };
  }

  const results = new Map<number, CheckResult>();
  {
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

  // One statement saves every result; unfinished links go back to waiting,
  // and temporary failures with attempts left get a retry time.
  const payload = claimed.map((c) => {
    const r = results.get(c.url_index);
    if (!r) return { i: c.url_index, status: 'PENDING', counted: 0, retry: null };
    const attemptsMade = c.attempts + 1;
    const retry =
      r.retryable && attemptsMade < MAX_ATTEMPTS ? now + retryDelaySeconds(attemptsMade, r.retryAfterSec) : null;
    return {
      i: c.url_index,
      status: r.status,
      http: r.httpStatus,
      final: r.finalUrl,
      redirected: r.redirected,
      ms: r.responseTimeMs,
      error: r.error,
      reason: r.reason,
      counted: 1,
      retry,
    };
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
         claimed_at = NULL,
         retry_at = j.retry
       FROM jsonb_to_recordset($2::jsonb) AS j(
         i int, status text, http int, final text, redirected boolean, ms int,
         error text, reason text, counted int, retry bigint)
       WHERE u.scan_id = $1 AND u.url_index = j.i`,
      [scanId, JSON.stringify(payload), checkedAt],
    );
  }

  // Recount the scan's totals from the source of truth and move its status on.
  const [row] = await db.query<ScanRecord & { remaining: number }>(
    `WITH c AS (
       SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('PENDING', 'CHECKING'))::int AS checked,
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (WHERE status = 'DEAD')::int AS dead,
         COUNT(*) FILTER (WHERE status = 'SOFT_404')::int AS soft404,
         COUNT(*) FILTER (WHERE status = 'REDIRECTED')::int AS redirected,
         COUNT(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
         COUNT(*) FILTER (WHERE status IN ('RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'))::int AS errors,
         COUNT(*) FILTER (WHERE status IN ('PENDING', 'CHECKING') OR retry_at IS NOT NULL)::int AS remaining
       FROM unique_urls WHERE scan_id = $1)
     UPDATE scans s SET
       checked_count = c.checked, active_count = c.active, dead_count = c.dead, soft_404_count = c.soft404,
       redirected_count = c.redirected, blocked_count = c.blocked, error_count = c.errors,
       started_at = COALESCE(s.started_at, $2::timestamptz),
       heartbeat_at = now(),
       -- A pause pressed while this batch ran wins; otherwise running until nothing is left.
       status = CASE WHEN s.status = 'paused' THEN 'paused' WHEN c.remaining > 0 THEN 'running' ELSE 'completed' END,
       completed_at = CASE WHEN c.remaining > 0 OR s.status = 'paused' THEN NULL ELSE $2::timestamptz END
     FROM c WHERE s.id = $1
     RETURNING s.*, c.remaining`,
    [scanId, checkedAt],
  );
  return {
    processed: results.size,
    remaining: row?.remaining ?? 0,
    nextDueInSec: null,
    scan: row ?? null,
    cutShort: results.size < claimed.length,
  };
}
