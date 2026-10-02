import type { Db } from './db/db';
import type { ScanMessage } from './queue';

/**
 * Worker bindings and secrets. Extend as later phases add resources:
 *   Phase 8: EXPORTS: R2Bucket (optional)
 */
export interface Env {
  APP_ENV: string;
  APP_NAME: string;
  ASSETS?: Fetcher;
  /** Supabase Postgres, reached through Cloudflare Hyperdrive. */
  HYPERDRIVE: Hyperdrive;
  /** Background checking: one message = one batch of links (see queue.ts). */
  SCAN_QUEUE: Queue<ScanMessage>;

  // Secrets — set in Cloudflare (Worker → Settings → Variables and Secrets)
  // or locally in .dev.vars. The account row itself lives in the users table.
  AUTH_EMAIL?: string;
  AUTH_PASSWORD?: string;
  SESSION_SECRET?: string;

  /**
   * Index Checker, Search Console (optional): the Google service-account key
   * file (JSON), pasted whole. Without it, index checks use signals only.
   */
  GSC_SERVICE_ACCOUNT?: string;

  /** Development only ("true" with APP_ENV=development): skip the DNS safety check. */
  CHECKER_SKIP_DNS?: string;
}

export interface AppVariables {
  requestId: string;
  user?: { id: string; email: string };
  db: Db;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
