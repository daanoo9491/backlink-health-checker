import { describe, expect, it } from 'vitest';
import { LINK_STATUSES, STATUS_INFO } from '../../src/shared/status';

describe('status model', () => {
  it('has a label, tone and description for every status', () => {
    for (const s of LINK_STATUSES) {
      const info = STATUS_INFO[s];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });

  it('never treats temporary problems as dead', () => {
    for (const s of ['BLOCKED', 'RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'] as const) {
      expect(STATUS_INFO[s].tone).not.toBe('dead');
      expect(STATUS_INFO[s].retryable).toBe(true);
    }
  });

  it('keeps confirmed results non-retryable by default', () => {
    expect(STATUS_INFO.ACTIVE.retryable).toBe(false);
    expect(STATUS_INFO.DEAD.retryable).toBe(false);
  });
});
