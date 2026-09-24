import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env';

/** Tags each request with an ID so a user-reported error can be found in logs. */
export const requestId = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const id = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.res.headers.set('X-Request-Id', id);
};
