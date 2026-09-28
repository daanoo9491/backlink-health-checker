#!/usr/bin/env node
/**
 * Applies migrations/*.sql to a Postgres database (Supabase), in order, once.
 * Each file runs in its own transaction and is recorded in schema_migrations.
 *
 *   DATABASE_URL="postgres://…" npm run db:migrate
 *
 * Use Supabase's "Session pooler" connection string (works over IPv4,
 * including from GitHub Actions).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See README → Database setup.');
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = readdirSync(dir)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort();

// Supabase requires TLS. Its certificate chain is not in Node's default store,
// so encrypt without pinning the CA unless PGSSLROOTCERT is provided.
const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: !!process.env.PGSSLROOTCERT };
const client = new pg.Client({ connectionString: url, ssl });

try {
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    process.stdout.write(`Applying ${file} … `);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied++;
      console.log('done');
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw e;
    }
  }
  console.log(applied ? `✅ ${applied} migration(s) applied.` : '✅ Database is up to date.');
} catch (e) {
  console.error(`\nMigration failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
