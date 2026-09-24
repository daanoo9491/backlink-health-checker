import { describe, expect, it } from 'vitest';
import { safeEqual, signSession, verifySession } from '../../src/worker/auth/session';

const SECRET = 's'.repeat(40);

describe('session tokens', () => {
  it('round-trips a valid session', async () => {
    const token = await signSession({ sub: 'a@b.com', exp: 2_000_000_000 }, SECRET);
    expect(await verifySession(token, SECRET, 1_000)).toEqual({ sub: 'a@b.com', exp: 2_000_000_000 });
  });

  it('rejects expired sessions', async () => {
    const token = await signSession({ sub: 'a@b.com', exp: 100 }, SECRET);
    expect(await verifySession(token, SECRET, 101)).toBeNull();
  });

  it('rejects garbage', async () => {
    for (const t of ['', 'abc', 'a.b', '..', 'x.y.z']) {
      expect(await verifySession(t, SECRET)).toBeNull();
    }
  });
});

describe('safeEqual', () => {
  it('compares strings correctly', async () => {
    expect(await safeEqual('same', 'same')).toBe(true);
    expect(await safeEqual('same', 'Same')).toBe(false);
    expect(await safeEqual('short', 'much longer value')).toBe(false);
  });
});
