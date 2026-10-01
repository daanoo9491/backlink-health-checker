/**
 * Background checking with Cloudflare Queues.
 *
 * One message = one batch of up to 8 links. After each batch the consumer
 * sends the next message for the same scan, so a scan runs as a single chain
 * and keeps going with the browser closed. Each start mints a chain id: a
 * message from an older chain (double click, a pause, a restart) is dropped,
 * so one scan never runs two chains at once.
 *
 * Free plan: 10,000 queue operations a day; a message costs about 3
 * (send, read, acknowledge), i.e. about 3 per 8 links.
 */
import type { Db } from './db/db';
import type { ScanRecord } from './db/scans';
import type { Env } from './env';
import { runCheckBatch } from './checker/run-batch';

export interface ScanMessage {
  scanId: string;
  chain: string;
  /**
   * Links per batch, when smaller than usual. Set to 1 after a batch in which
   * every link ran out of requests (e.g. long redirect chains checked side by
   * side), so the next link gets the whole budget to itself.
   */
  size?: number;
}

export interface QueueLike {
  send(body: ScanMessage, options?: { delaySeconds?: number }): Promise<unknown>;
}

/** A running scan whose heartbeat is older than this is restarted by the Cron safety net. */
export const STALL_MINUTES = 10;
/** A start request while a chain is alive within this window does nothing. */
const ALIVE_MINUTES = 3;
/** While only retries are waiting, wake up at least this often (keeps the heartbeat fresh). */
const MAX_IDLE_SECONDS = 300;
const MIN_IDLE_SECONDS = 5;
/** When links are held by a batch that may have been interrupted. */
const HELD_IDLE_SECONDS = 60;

export function idleDelaySeconds(nextDueInSec: number | null): number {
  if (nextDueInSec === null) return HELD_IDLE_SECONDS;
  return Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.ceil(nextDueInSec)));
}

/**
 * Starts (or resumes) background checking. Returns the scan, and whether a new
 * chain was started (false when one is already alive, e.g. a double click).
 */
export async function startChecking(
  db: Db,
  queue: QueueLike,
  scanId: string,
  appHost: string,
): Promise<{ started: boolean; scan: ScanRecord | null }> {
  const chain = crypto.randomUUID();
  const [scan] = await db.query<ScanRecord>(
    `UPDATE scans SET status = 'queued', chain_id = $2, heartbeat_at = now(), app_host = $3, completed_at = NULL
     WHERE id = $1
       AND status IN ('ready', 'paused', 'queued', 'running')
       AND (status IN ('ready', 'paused') OR heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(mins => $4))
     RETURNING *`,
    [scanId, chain, appHost, ALIVE_MINUTES],
  );
  if (!scan) return { started: false, scan: null };
  await queue.send({ scanId, chain });
  return { started: true, scan };
}

export async function pauseChecking(db: Db, scanId: string): Promise<ScanRecord | null> {
  const [scan] = await db.query<ScanRecord>(
    `UPDATE scans SET status = 'paused', chain_id = NULL
     WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING *`,
    [scanId],
  );
  return scan ?? null;
}

export type MessageOutcome =
  | { kind: 'dropped'; why: 'missing' | 'old-chain' | 'not-active' }
  | { kind: 'done' }
  | { kind: 'next'; delaySeconds: number };

/** Handles one message: checks one batch, then queues the next if there is more to do. */
export async function processScanMessage(
  db: Db,
  env: Env,
  queue: QueueLike,
  msg: ScanMessage,
): Promise<MessageOutcome> {
  const [scan] = await db.query<Pick<ScanRecord, 'status'> & { chain_id: string | null; app_host: string | null }>(
    'SELECT status, chain_id, app_host FROM scans WHERE id = $1',
    [msg.scanId],
  );
  if (!scan) return { kind: 'dropped', why: 'missing' }; // deleted meanwhile
  if (scan.chain_id !== msg.chain) return { kind: 'dropped', why: 'old-chain' };
  if (scan.status !== 'queued' && scan.status !== 'running') return { kind: 'dropped', why: 'not-active' };

  const outcome = await runCheckBatch(db, env, msg.scanId, { ownHost: scan.app_host ?? '', batchSize: msg.size });
  if (outcome.remaining === 0 || outcome.scan?.status === 'paused') return { kind: 'done' };

  const next: ScanMessage = { scanId: msg.scanId, chain: msg.chain };
  // Nothing finished because the request budget ran out: go on one link at a time.
  if (outcome.processed === 0 && outcome.cutShort) next.size = 1;
  const delaySeconds = outcome.processed > 0 || outcome.cutShort ? 0 : idleDelaySeconds(outcome.nextDueInSec);
  await queue.send(next, delaySeconds ? { delaySeconds } : undefined);
  return { kind: 'next', delaySeconds };
}

/**
 * Safety net (Cron): restarts scans that should be running but whose chain
 * went quiet, e.g. a message that failed all its retries. Returns how many.
 */
export async function reviveStalled(db: Db, queue: QueueLike): Promise<number> {
  const stalled = await db.query<{ id: string; chain_id: string }>(
    `UPDATE scans SET chain_id = gen_random_uuid(), heartbeat_at = now()
     WHERE id IN (
       SELECT id FROM scans
       WHERE status IN ('queued', 'running')
         AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(mins => $1))
       ORDER BY heartbeat_at NULLS FIRST
       LIMIT 20)
     RETURNING id, chain_id`,
    [STALL_MINUTES],
  );
  for (const s of stalled) await queue.send({ scanId: s.id, chain: s.chain_id });
  return stalled.length;
}
