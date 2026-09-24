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
