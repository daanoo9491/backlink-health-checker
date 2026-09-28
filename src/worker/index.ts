import { createApp } from './app';
import { pgDb } from './db/pg';
import type { Env } from './env';
import { keepAlive } from './keep-alive';

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event, env) {
    const db = pgDb(env.HYPERDRIVE.connectionString);
    try {
      await keepAlive(db);
    } finally {
      await db.close();
    }
  },
  // Phase 5 adds: queue(batch, env, ctx) { ... }
} satisfies ExportedHandler<Env>;
