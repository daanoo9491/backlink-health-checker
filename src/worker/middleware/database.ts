import type { MiddlewareHandler } from 'hono';
import type { DbFactory } from '../db/db';
import type { AppContext } from '../env';

/**
 * Gives every request a database handle (c.get('db')). The connection opens
 * only if a query runs, and is closed after the response is sent.
 */
export const database =
  (factory: DbFactory): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    const db = factory(c.env.HYPERDRIVE?.connectionString ?? '');
    c.set('db', db);
    try {
      await next();
    } finally {
      const closing = db.close();
      try {
        c.executionCtx.waitUntil(closing);
      } catch {
        await closing; // no execution context (tests)
      }
    }
  };
