import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../env';
import type { LoginRequest, MeResponse } from '../../shared/api';
import { apiError } from '../errors';
import { requireAuth } from '../middleware/auth';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, safeEqual, signSession } from '../auth/session';

const MIN_SECRET_LENGTH = 32;

function isLoginRequest(v: unknown): v is LoginRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.email === 'string' && typeof r.password === 'string';
}

export const authRoutes = new Hono<AppContext>()
  .post('/login', async (c) => {
    const { AUTH_EMAIL, AUTH_PASSWORD, SESSION_SECRET } = c.env;
    if (!AUTH_EMAIL || !AUTH_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < MIN_SECRET_LENGTH) {
      console.error(JSON.stringify({ level: 'error', message: 'Auth secrets missing or SESSION_SECRET too short' }));
      return apiError(c, 503, 'AUTH_NOT_CONFIGURED', 'Sign-in is not set up yet. Ask your administrator.');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'INVALID_REQUEST', 'Enter your email and password.');
    }
    if (!isLoginRequest(body) || body.email.length > 254 || body.password.length > 1024) {
      return apiError(c, 400, 'INVALID_REQUEST', 'Enter your email and password.');
    }

    const email = body.email.trim().toLowerCase();
    // Check both fields every time so response time doesn't reveal which was wrong.
    const [emailOk, passwordOk] = await Promise.all([
      safeEqual(email, AUTH_EMAIL.trim().toLowerCase()),
      safeEqual(body.password, AUTH_PASSWORD),
    ]);
    if (!emailOk || !passwordOk) {
      return apiError(c, 401, 'INVALID_CREDENTIALS', 'That email and password don’t match. Check them and try again.');
    }

    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const token = await signSession({ sub: email, exp }, SESSION_SECRET);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json<MeResponse>({ user: { email } });
  })
  .post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  })
  .get('/me', requireAuth(), (c) => c.json<MeResponse>({ user: c.get('user')! }));
