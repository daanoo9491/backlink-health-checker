import { createApp } from './app';
import { pgDb } from './db/pg';
import type { Env } from './env';
import { keepAlive } from './keep-alive';
import { processScanMessage, reviveStalled, type ScanMessage } from './queue';

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  /** Background checking: one message = one batch of links for one scan. */
  async queue(batch, env) {
    const db = pgDb(env.HYPERDRIVE.connectionString);
    try {
      for (const msg of batch.messages) {
        try {
          await processScanMessage(db, env, env.SCAN_QUEUE, msg.body);
          msg.ack();
        } catch (e) {
          console.error(
            JSON.stringify({ level: 'error', where: 'queue', scanId: msg.body.scanId, message: String(e) }),
          );
          msg.retry({ delaySeconds: 30 }); // the Cron safety net takes over if every retry fails
        }
      }
    } finally {
      await db.close();
    }
  },

  /** Every 10 minutes: restart stalled scans, and keep the Supabase project awake. */
  async scheduled(_event, env) {
    const db = pgDb(env.HYPERDRIVE.connectionString);
    try {
      await reviveStalled(db, env.SCAN_QUEUE);
      await keepAlive(db);
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env, ScanMessage>;
