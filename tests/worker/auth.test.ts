import { describe, expect, it } from 'vitest';
import type { ApiError, MeResponse } from '../../src/shared/api';
import { call, cookieFrom, env, login, ORIGIN } from './helpers';

describe('POST /api/auth/login', () => {
  it('signs in with the right email (any case) and password', async () => {
    const res = await login('  marketing@example.COM ', env.AUTH_PASSWORD!);
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).user.email).toBe('marketing@example.com');

    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/^__Host-bhc_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('rejects a wrong password with a friendly message and no cookie', async () => {
    const res = await login('marketing@example.com', 'wrong');
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a wrong email', async () => {
    expect((await login('someone@else.com', env.AUTH_PASSWORD!)).status).toBe(401);
  });

  it('rejects malformed bodies', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('reports when sign-in is not configured instead of letting anyone in', async () => {
    const res = await login('a@b.com', 'x', { ...env, AUTH_PASSWORD: undefined });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('refuses a SESSION_SECRET that is too short', async () => {
    const res = await login('marketing@example.com', env.AUTH_PASSWORD!, { ...env, SESSION_SECRET: 'short' });
    expect(res.status).toBe(503);
  });
});

describe('CSRF protection', () => {
  it('blocks POSTs from another site', async () => {
    const res = await login('marketing@example.com', env.AUTH_PASSWORD!, env, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('blocks POSTs with no Origin header', async () => {
    const res = await call('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('protected routes', () => {
  it('GET /api/auth/me is 401 without a session', async () => {
    expect((await call('/api/auth/me')).status).toBe(401);
  });

  it('GET /api/auth/me returns the user with a valid session', async () => {
    const cookie = cookieFrom(await login('marketing@example.com', env.AUTH_PASSWORD!));
    const res = await call('/api/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).user.email).toBe('marketing@example.com');
  });

  it('rejects a tampered cookie', async () => {
    const cookie = cookieFrom(await login('marketing@example.com', env.AUTH_PASSWORD!));
    const [name, value] = cookie.split('=');
    const [body, sig] = value!.split('.');
    const forgedBody = btoa(JSON.stringify({ sub: 'attacker@evil.com', exp: 9999999999 })).replace(/=+$/, '');
    const res = await call('/api/auth/me', { headers: { Cookie: `${name}=${forgedBody}.${sig}` } });
    expect(res.status).toBe(401);
    expect(body).not.toBe(forgedBody);
  });

  it('rejects sessions signed with a different secret', async () => {
    const cookie = cookieFrom(await login('marketing@example.com', env.AUTH_PASSWORD!));
    const res = await call('/api/auth/me', { headers: { Cookie: cookie } }, { ...env, SESSION_SECRET: 'y'.repeat(40) });
    expect(res.status).toBe(401);
  });

  it('GET /api/dashboard requires sign-in and returns zeroed totals', async () => {
    expect((await call('/api/dashboard')).status).toBe(401);
    const cookie = cookieFrom(await login('marketing@example.com', env.AUTH_PASSWORD!));
    const res = await call('/api/dashboard', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totalScans: 0, recentScans: [] });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await call('/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-bhc_session=;.*Max-Age=0/i);
  });
});
