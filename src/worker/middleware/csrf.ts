import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env';
import { apiError } from '../errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-based sessions: any request that changes data
 * must come from our own origin. Works together with SameSite=Lax cookies.
 */
export const csrfProtection = (): MiddlewareHandler<AppContext> => async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  // The browser helper authenticates with a Bearer code, never cookies, so a
  // forged cross-site request can't carry its credentials. (Browsers can't add
  // an Authorization header cross-site without CORS, which the API never allows.)
  if (new URL(c.req.url).pathname.startsWith('/api/helper/') && c.req.header('Authorization')?.startsWith('Bearer ')) {
    return next();
  }
  const origin = c.req.header('Origin');
  const expected = new URL(c.req.url).origin;
  if (!origin || origin !== expected) {
    return apiError(
      c,
      403,
      'FORBIDDEN_ORIGIN',
      'This request was blocked for your security. Reload the page and try again.',
    );
  }
  return next();
};
