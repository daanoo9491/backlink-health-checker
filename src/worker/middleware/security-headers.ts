import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env';

/**
 * Security headers for API responses. Static assets get the same headers
 * via public/_headers.
 */
export const securityHeaders = (): MiddlewareHandler<AppContext> => async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  // API responses are JSON; nothing should ever execute from them.
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
};
