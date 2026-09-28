import type { Db } from './db';

/** Creates the user on first sign-in; returns their id either way. */
export async function upsertUser(db: Db, email: string): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, created_at, last_login_at) VALUES ($1, $2, now(), now())
     ON CONFLICT (email) DO UPDATE SET last_login_at = excluded.last_login_at
     RETURNING id`,
    [crypto.randomUUID(), email],
  );
  if (!row) throw new Error('User upsert returned no row');
  return row.id;
}
