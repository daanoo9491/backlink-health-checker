import { Client } from 'pg';
import type { Db } from './db';

/**
 * Opens one connection per request. Hyperdrive keeps the real connections to
 * Supabase warm and pooled, so connecting here is fast.
 * The connection is opened lazily: requests that don't touch the database
 * (health checks, static pages) never connect.
 */
export function pgDb(connectionString: string): Db {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  const get = () => {
    connecting ??= (async () => {
      const c = new Client({ connectionString });
      await c.connect();
      client = c;
      return c;
    })();
    return connecting;
  };

  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const c = await get();
      const res = await c.query(sql, params);
      return res.rows as T[];
    },
    async transaction(fn) {
      await db.query('BEGIN');
      try {
        const out = await fn(db);
        await db.query('COMMIT');
        return out;
      } catch (e) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    },
    async close() {
      if (client) await client.end().catch(() => undefined);
      client = null;
      connecting = null;
    },
  };
  return db;
}
