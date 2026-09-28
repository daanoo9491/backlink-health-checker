/**
 * The one way the Worker talks to the database.
 *
 * Production: Supabase Postgres through Cloudflare Hyperdrive (pooled, and
 * database calls don't use up the 50 outgoing requests per invocation that
 * link checks need). Tests: an in-process Postgres (PGlite) behind the same
 * interface, so every query is exercised against real Postgres.
 *
 * All values are passed as parameters ($1, $2, …), never concatenated.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbFactory = (connectionString: string) => Db;

/** Converts a timestamp column to an ISO string (or null) for the API. */
export const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

/** COUNT(*) and bigint come back as strings from Postgres drivers. */
export const num = (v: unknown): number => Number(v ?? 0);
