import type { Db } from './db';

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

export async function isLockedOut(db: Db, keys: string[]): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM login_attempts
     WHERE key = ANY($1::text[]) AND window_start > $2
       AND ((key LIKE 'ip:%' AND failures >= $3) OR (key LIKE 'email:%' AND failures >= $4))
     LIMIT 1`,
    [keys, now() - WINDOW_SECONDS, MAX_FAILURES_PER_IP, MAX_FAILURES_PER_EMAIL],
  );
  return rows.length > 0;
}

export async function recordFailure(db: Db, keys: string[]): Promise<void> {
  const t = now();
  await db.query(
    `INSERT INTO login_attempts (key, failures, window_start)
     SELECT k, 1, $2 FROM unnest($1::text[]) AS k
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_attempts.window_start <= $3 THEN 1 ELSE login_attempts.failures + 1 END,
       window_start = CASE WHEN login_attempts.window_start <= $3 THEN $2 ELSE login_attempts.window_start END`,
    [keys, t, t - WINDOW_SECONDS],
  );
}

export async function clearFailures(db: Db, keys: string[]): Promise<void> {
  await db.query('DELETE FROM login_attempts WHERE key = ANY($1::text[])', [keys]);
}
