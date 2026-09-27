import type { Env } from '../env';

/**
 * Slows down password guessing. Limits apply within a 15-minute window:
 *  - per IP address: 10 failures (stops one attacker quickly)
 *  - per email: 50 failures (stops spread-out guessing without letting a
 *    stranger lock the real user out after a handful of tries)
 */
export const MAX_FAILURES_PER_IP = 10;
export const MAX_FAILURES_PER_EMAIL = 50;
export const WINDOW_SECONDS = 15 * 60;

const now = () => Math.floor(Date.now() / 1000);

export const throttleKeys = (ip: string, email: string) => [`ip:${ip}`, `email:${email}`];

export async function isLockedOut(env: Env, keys: string[]): Promise<boolean> {
  const placeholders = keys.map((_, i) => `?${i + 2}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT 1 AS locked FROM login_attempts
     WHERE key IN (${placeholders}) AND window_start > ?1
       AND ((key LIKE 'ip:%' AND failures >= ${MAX_FAILURES_PER_IP})
         OR (key LIKE 'email:%' AND failures >= ${MAX_FAILURES_PER_EMAIL}))
     LIMIT 1`,
  )
    .bind(now() - WINDOW_SECONDS, ...keys)
    .first<{ locked: number }>();
  return !!row;
}

export async function recordFailure(env: Env, keys: string[]): Promise<void> {
  const t = now();
  const stmt = env.DB.prepare(
    `INSERT INTO login_attempts (key, failures, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE WHEN window_start <= ?3 THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`,
  );
  await env.DB.batch(keys.map((k) => stmt.bind(k, t, t - WINDOW_SECONDS)));
}

export async function clearFailures(env: Env, keys: string[]): Promise<void> {
  const stmt = env.DB.prepare('DELETE FROM login_attempts WHERE key = ?1');
  await env.DB.batch(keys.map((k) => stmt.bind(k)));
}
