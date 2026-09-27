/**
 * Checks the next few waiting links of a scan, then updates the scan's totals.
 * Used by POST /api/scans/:id/check now, and by the queue consumer in Phase 5.
 */
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
  env: Env,
  scanId: string,
  opts: { ownHost: string; batchSize?: number },
): Promise<BatchOutcome> {
  const now = Math.floor(Date.now() / 1000);

  // Reserve the next links. Old reservations (tab closed mid-batch) are taken over.
  const { results: claimed } = await env.DB.prepare(
    `UPDATE unique_urls SET status = 'CHECKING', claimed_at = ?2
     WHERE scan_id = ?1 AND url_index IN (
       SELECT url_index FROM unique_urls
       WHERE scan_id = ?1 AND (status = 'PENDING' OR (status = 'CHECKING' AND claimed_at < ?3))
       ORDER BY url_index LIMIT ?4)
     RETURNING url_index, url`,
  )
    .bind(scanId, now, now - CLAIM_STALE_SECONDS, opts.batchSize ?? BATCH_SIZE)
    .all<Claimed>();

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
          redirected: r.redirected ? 1 : 0,
          ms: r.responseTimeMs,
          error: r.error,
          reason: r.reason,
          counted: 1,
        }
      : { i: c.url_index, status: 'PENDING', counted: 0 };
  });
  const checkedAt = new Date().toISOString();

  const statements = [];
  if (payload.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE unique_urls SET
           status = json_extract(j.value, '$.status'),
           http_status = json_extract(j.value, '$.http'),
           final_url = json_extract(j.value, '$.final'),
           redirected = COALESCE(json_extract(j.value, '$.redirected'), 0),
           response_time_ms = json_extract(j.value, '$.ms'),
           error_message = json_extract(j.value, '$.error'),
           check_reason = json_extract(j.value, '$.reason'),
           attempts = attempts + json_extract(j.value, '$.counted'),
           checked_at = CASE WHEN json_extract(j.value, '$.counted') = 1 THEN ?3 ELSE checked_at END,
           claimed_at = NULL
         FROM json_each(?2) AS j
         WHERE unique_urls.scan_id = ?1 AND unique_urls.url_index = json_extract(j.value, '$.i')`,
      ).bind(scanId, JSON.stringify(payload), checkedAt),
    );
  }
  // Recount the scan's totals from the source of truth and move its status on.
  statements.push(
    env.DB.prepare(
      `UPDATE scans SET
         checked_count   = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status NOT IN ('PENDING', 'CHECKING')),
         active_count    = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status = 'ACTIVE'),
         dead_count      = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status = 'DEAD'),
         soft_404_count  = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status = 'SOFT_404'),
         redirected_count= (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status = 'REDIRECTED'),
         blocked_count   = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1 AND status = 'BLOCKED'),
         error_count     = (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1
                              AND status IN ('RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR')),
         started_at      = COALESCE(started_at, ?2),
         status = CASE WHEN EXISTS (SELECT 1 FROM unique_urls WHERE scan_id = ?1 AND status IN ('PENDING', 'CHECKING'))
                       THEN 'running' ELSE 'completed' END,
         completed_at = CASE WHEN EXISTS (SELECT 1 FROM unique_urls WHERE scan_id = ?1 AND status IN ('PENDING', 'CHECKING'))
                       THEN NULL ELSE ?2 END
       WHERE id = ?1`,
    ).bind(scanId, checkedAt),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM unique_urls WHERE scan_id = ?1 AND status IN ('PENDING', 'CHECKING')`,
    ).bind(scanId),
  );
  const out = await env.DB.batch(statements);
  const remaining = (out[out.length - 1]!.results[0] as { n: number }).n;
  return { processed: results.size, remaining };
}
