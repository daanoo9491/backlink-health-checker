import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppContext } from '../env';
import { apiError } from '../errors';
import { SESSION_COOKIE, verifySession } from '../auth/session';

/** Blocks the route unless the request carries a valid session cookie. */
export const requireAuth = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const secret = c.env.SESSION_SECRET;
  const token = getCookie(c, SESSION_COOKIE);
  const session = secret && token ? await verifySession(token, secret) : null;
  if (!session) return apiError(c, 401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  c.set('user', { email: session.sub });
  return next();
};
