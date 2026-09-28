import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, MeResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { MAX_FAILURES_PER_IP } from '../../src/worker/db/login-throttle';
import { call, cookieFrom, EMAIL, login, ORIGIN, PASSWORD, sql, testEnv } from './helpers';

let env: Env;
beforeEach(async () => {
  env = await testEnv();
});

describe('POST /api/auth/login', () => {
  it('signs in with the right email (any case) and password, and creates the user once', async () => {
    const res = await login(env, '  marketing@example.COM ', PASSWORD);
    expect(res.status).toBe(200);
    const me = (await res.json()) as MeResponse;
    expect(me.user.email).toBe('marketing@example.com');
    expect(me.user.id).toMatch(/^[0-9a-f-]{36}$/);

    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/^__Host-bhc_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // Second sign-in reuses the same user row.
    const again = (await (await login(env, EMAIL, PASSWORD)).json()) as MeResponse;
    expect(again.user.id).toBe(me.user.id);
    const [count] = await sql<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
    expect(count?.n).toBe(1);
  });

  it('rejects a wrong password with a friendly message and no cookie', async () => {
    const res = await login(env, EMAIL, 'wrong');
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(((await res.json()) as ApiError).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a wrong email', async () => {
    expect((await login(env, 'someone@else.com', PASSWORD)).status).toBe(401);
  });

  it('rejects malformed bodies', async () => {
    const res = await call(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('reports when sign-in is not configured instead of letting anyone in', async () => {
    const res = await login({ ...env, AUTH_PASSWORD: undefined }, 'a@b.com', 'x');
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('refuses a SESSION_SECRET that is too short', async () => {
    expect((await login({ ...env, SESSION_SECRET: 'short' }, EMAIL, PASSWORD)).status).toBe(503);
  });
});

describe('sign-in throttling', () => {
  it(`locks an IP out after ${MAX_FAILURES_PER_IP} wrong passwords, even for the right password`, async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      expect((await login(env, EMAIL, 'wrong', { ip: '198.51.100.1' })).status).toBe(401);
    }
    const locked = await login(env, EMAIL, PASSWORD, { ip: '198.51.100.1' });
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as ApiError).error.message).toMatch(/15 minutes/);
  });

  it('does not lock the real user out because someone else guessed from another IP', async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) await login(env, EMAIL, 'wrong', { ip: '198.51.100.2' });
    expect((await login(env, EMAIL, PASSWORD, { ip: '203.0.113.50' })).status).toBe(200);
  });

  it('a successful sign-in clears earlier failures', async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP - 1; i++) await login(env, EMAIL, 'wrong', { ip: '198.51.100.3' });
    expect((await login(env, EMAIL, PASSWORD, { ip: '198.51.100.3' })).status).toBe(200);
    expect((await login(env, EMAIL, 'wrong', { ip: '198.51.100.3' })).status).toBe(401); // not 429
  });
});

describe('CSRF protection', () => {
  it('blocks POSTs from another site', async () => {
    const res = await login(env, EMAIL, PASSWORD, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('blocks POSTs with no Origin header', async () => {
    expect((await call(env, '/api/auth/logout', { method: 'POST' })).status).toBe(403);
  });
});

describe('protected routes', () => {
  it('GET /api/auth/me is 401 without a session and 200 with one', async () => {
    expect((await call(env, '/api/auth/me')).status).toBe(401);
    const cookie = cookieFrom(await login(env, EMAIL, PASSWORD));
    const res = await call(env, '/api/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).user.email).toBe('marketing@example.com');
  });

  it('rejects a tampered cookie', async () => {
    const cookie = cookieFrom(await login(env, EMAIL, PASSWORD));
    const [name, value] = cookie.split('=');
    const sig = value!.split('.')[1];
    const forged = btoa(JSON.stringify({ sub: 'attacker@evil.com', uid: 'x', exp: 9999999999 })).replace(/=+$/, '');
    expect((await call(env, '/api/auth/me', { headers: { Cookie: `${name}=${forged}.${sig}` } })).status).toBe(401);
  });

  it('rejects sessions signed with a different secret', async () => {
    const cookie = cookieFrom(await login(env, EMAIL, PASSWORD));
    const res = await call({ ...env, SESSION_SECRET: 'y'.repeat(40) }, '/api/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await call(env, '/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-bhc_session=;.*Max-Age=0/i);
  });
});
