import type { Db } from './db/db';
import { WINDOW_SECONDS } from './db/login-throttle';

/**
 * Runs with the 10-minute Cron Trigger. Supabase pauses free projects after
 * about a week without activity; this small write keeps it awake even when
 * nobody uses the app. Also clears expired sign-in counters and old robots.txt copies.
 */
export async function keepAlive(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO heartbeat (id, beat_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at`,
  );
  await db.query(`DELETE FROM robots_cache WHERE fetched_at < now() - interval '2 days'`);
  await db.query('DELETE FROM login_attempts WHERE window_start < $1', [
    Math.floor(Date.now() / 1000) - WINDOW_SECONDS,
  ]);
}
