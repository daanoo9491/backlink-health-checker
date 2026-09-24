/**
 * Worker bindings. Extend this as later phases add resources:
 *   Phase 3: DB: D1Database
 *   Phase 5: SCAN_QUEUE: Queue
 *   Phase 8: EXPORTS: R2Bucket (optional)
 * Secrets (set with `wrangler secret put`) are also declared here.
 */
export interface Env {
  APP_ENV: string;
  APP_NAME: string;
  ASSETS?: Fetcher;
}

export interface AppVariables {
  requestId: string;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
