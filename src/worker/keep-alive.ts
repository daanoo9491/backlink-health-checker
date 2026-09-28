import type { Db } from './db/db';
import { WINDOW_SECONDS } from './db/login-throttle';

/**
 * Runs once a day (Cron Trigger). Supabase pauses free projects after about
 * a week without activity; a small write each day keeps it awake even when
 * nobody uses the app. Also clears sign-in counters that have expired.
 */
export async function keepAlive(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO heartbeat (id, beat_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at`,
  );
  await db.query('DELETE FROM login_attempts WHERE window_start < $1', [
    Math.floor(Date.now() / 1000) - WINDOW_SECONDS,
  ]);
}
