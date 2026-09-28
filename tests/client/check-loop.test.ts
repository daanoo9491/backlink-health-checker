import { describe, expect, it } from 'vitest';
import type { CheckBatchResponse } from '../../src/shared/api';
import { IDLE_MAX_MS, IDLE_MIN_MS, idleDelay, runCheckLoop } from '../../src/client/lib/check-loop';

const scan = {} as CheckBatchResponse['scan'];
const batch = (processed: number, remaining: number, retryAfterMs?: number): CheckBatchResponse => ({
  scan,
  processed,
  remaining,
  ...(retryAfterMs ? { retryAfterMs } : {}),
});

function harness(responses: (CheckBatchResponse | Error)[], opts: { stopAfterCalls?: number } = {}) {
  const sleeps: number[] = [];
  let calls = 0;
  const run = runCheckLoop({
    checkBatch: async () => {
      const r = responses[Math.min(calls, responses.length - 1)]!;
      calls++;
      if (r instanceof Error) throw r;
      return r;
    },
    onBatch: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    stopped: () => opts.stopAfterCalls !== undefined && calls >= opts.stopAfterCalls,
    isFatal: (e) => (e as Error).message === 'fatal',
  });
  return { run, sleeps, calls: () => calls };
}

describe('checking loop', () => {
  it('runs batches back to back while they make progress, and stops when done', async () => {
    const h = harness([batch(8, 16), batch(8, 8), batch(8, 0)]);
    expect(await h.run).toEqual({ kind: 'done' });
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([]);
  });

  it('never asks again immediately when a batch had nothing to check', async () => {
    const h = harness([batch(0, 5), batch(0, 5), batch(0, 5), batch(0, 5), batch(0, 5), batch(3, 2), batch(2, 0)]);
    await h.run;
    // Every idle round waited, growing 2s → 4s → 8s → 15s cap; progress resets the wait.
    expect(h.sleeps).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  it("respects the server's wait hint", async () => {
    const h = harness([batch(0, 5, 5_000), batch(1, 0)]);
    await h.run;
    expect(h.sleeps).toEqual([5_000]);
  });

  it('a busy server can’t cause more than a few calls a minute', async () => {
    // 100 idle rounds: total waiting must be long, i.e. no tight loop.
    const h = harness([batch(0, 5, 5_000)], { stopAfterCalls: 100 });
    await h.run;
    const waited = h.sleeps.reduce((a, b) => a + b, 0);
    expect(h.calls()).toBe(100);
    expect(waited / 60_000).toBeGreaterThan(20); // > 20 minutes for 100 calls
  });

  it('backs off on temporary errors and gives up after 5 in a row', async () => {
    const h = harness([new Error('network')]);
    expect((await h.run).kind).toBe('gave-up');
    expect(h.calls()).toBe(5);
    expect(h.sleeps).toEqual([2_000, 4_000, 8_000, 15_000]);
  });

  it('stops at once on a fatal error', async () => {
    const h = harness([new Error('fatal')]);
    expect((await h.run).kind).toBe('fatal');
    expect(h.calls()).toBe(1);
  });
});

describe('idleDelay', () => {
  it('stays between the minimum and maximum', () => {
    expect(idleDelay(1)).toBe(IDLE_MIN_MS);
    expect(idleDelay(50)).toBe(IDLE_MAX_MS);
    expect(idleDelay(1, 60_000)).toBe(IDLE_MAX_MS);
  });
});
