/**
 * Worker bindings and secrets. Extend as later phases add resources:
 *   Phase 5: SCAN_QUEUE: Queue
 *   Phase 8: EXPORTS: R2Bucket (optional)
 */
export interface Env {
  APP_ENV: string;
  APP_NAME: string;
  ASSETS?: Fetcher;
  DB: D1Database;

  // Secrets — set in Cloudflare (Worker → Settings → Variables and Secrets)
  // or locally in .dev.vars. The account row itself lives in the users table.
  AUTH_EMAIL?: string;
  AUTH_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export interface AppVariables {
  requestId: string;
  user?: { id: string; email: string };
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
