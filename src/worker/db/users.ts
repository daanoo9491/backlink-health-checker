import type { Env } from '../env';

/** Creates the user on first sign-in; returns their id either way. */
export async function upsertUser(env: Env, email: string): Promise<string> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO users (id, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(email) DO UPDATE SET last_login_at = excluded.last_login_at
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), email, now)
    .first<{ id: string }>();
  if (!row) throw new Error('User upsert returned no row');
  return row.id;
}
