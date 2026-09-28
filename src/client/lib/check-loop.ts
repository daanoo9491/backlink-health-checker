/**
 * Drives link checking from the scan page, one batch at a time.
 *
 * Rules that keep database and Worker usage low:
 *  - When a batch finds nothing it can check yet (links reserved by another
 *    tab, or by a batch that was interrupted), WAIT before asking again —
 *    the server says how long; otherwise 2 s, 4 s, 8 s … up to 15 s.
 *    Never ask again immediately.
 *  - Temporary errors back off the same way; after 5 in a row, pause.
 *  - A clear "no" from the server (4xx other than 429) stops at once.
 */
import type { CheckBatchResponse } from '../../shared/api';

export const IDLE_MIN_MS = 2_000;
export const IDLE_MAX_MS = 15_000;
export const MAX_FAILURES = 5;

export interface LoopDeps {
  checkBatch: () => Promise<CheckBatchResponse>;
  onBatch: (r: CheckBatchResponse) => void;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  /** Errors the loop should give up on straight away (e.g. 404, 409). */
  isFatal: (e: unknown) => boolean;
}

export type LoopOutcome =
  { kind: 'done' } | { kind: 'stopped' } | { kind: 'fatal'; error: unknown } | { kind: 'gave-up'; error: unknown };

export function idleDelay(idleRounds: number, serverHintMs?: number): number {
  const backoff = Math.min(IDLE_MAX_MS, IDLE_MIN_MS * 2 ** Math.max(0, idleRounds - 1));
  return Math.max(backoff, Math.min(serverHintMs ?? 0, IDLE_MAX_MS));
}

export async function runCheckLoop(deps: LoopDeps): Promise<LoopOutcome> {
  let failures = 0;
  let idleRounds = 0;
  while (!deps.stopped()) {
    let r: CheckBatchResponse;
    try {
      r = await deps.checkBatch();
    } catch (e) {
      if (deps.isFatal(e)) return { kind: 'fatal', error: e };
      if (++failures >= MAX_FAILURES) return { kind: 'gave-up', error: e };
      await deps.sleep(Math.min(IDLE_MAX_MS, 1000 * 2 ** failures));
      continue;
    }
    failures = 0;
    deps.onBatch(r);
    if (r.remaining === 0) return { kind: 'done' };
    if (r.processed === 0) {
      idleRounds++;
      await deps.sleep(idleDelay(idleRounds, r.retryAfterMs));
    } else {
      idleRounds = 0;
    }
  }
  return { kind: 'stopped' };
}
