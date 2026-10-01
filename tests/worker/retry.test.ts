import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/worker/checker/check-link';
import { retryDelaySeconds } from '../../src/worker/checker/run-batch';
import { idleDelaySeconds } from '../../src/worker/queue';

describe('retry timing', () => {
  it('waits 1 minute, then 4, never more than 15', () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(240);
    expect(retryDelaySeconds(3)).toBe(900);
    expect(retryDelaySeconds(9)).toBe(900);
  });

  it('respects Retry-After within the 15-minute cap', () => {
    expect(retryDelaySeconds(1, 120)).toBe(120);
    expect(retryDelaySeconds(1, 10)).toBe(60);
    expect(retryDelaySeconds(1, 86_400)).toBe(900);
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('idle waits stay between 5 seconds and 5 minutes', () => {
    expect(idleDelaySeconds(null)).toBe(60);
    expect(idleDelaySeconds(0)).toBe(5);
    expect(idleDelaySeconds(42.2)).toBe(43);
    expect(idleDelaySeconds(10_000)).toBe(300);
  });
});
