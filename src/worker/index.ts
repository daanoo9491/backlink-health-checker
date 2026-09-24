import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  // Phase 5 adds: queue(batch, env, ctx) { ... }
  // Phase 11 adds: scheduled(event, env, ctx) { ... }
} satisfies ExportedHandler<Env>;
