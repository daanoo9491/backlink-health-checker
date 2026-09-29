#!/usr/bin/env node
/**
 * One-off: copies scans from the old Cloudflare D1 database into Supabase.
 *
 *   $env:DATABASE_URL="<staging Session pooler string>"
 *   npm run import:d1 -- --from staging            # copy
 *   npm run import:d1 -- --from staging --dry-run  # just count what would be copied
 *
 * Reads D1 through Wrangler (uses your existing `npx wrangler login`), writes
 * Supabase in small batches, one scan at a time, each scan in a transaction.
 * Safe to run again: anything already copied is skipped.
 *
 * Users are matched by email, so scans attach to the account you already
 * signed in with on the new database.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The old D1 databases (from wrangler.jsonc before the move to Supabase).
const D1 = {
  production: { name: 'backlink-health-checker-db', id: '3328d067-f9a5-4c5f-9f5b-21e849ca90de' },
  staging: { name: 'backlink-health-checker-db-staging', id: '7290b7e4-a840-480a-90e4-0cccc623f850' },
};
const PAGE = 500;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const from = opt('from');
const dryRun = flag('dry-run');
const local = flag('local'); // testing only: read a local D1 instead of Cloudflare's
if (!D1[from]) {
  console.error('Say which D1 database to copy from: --from staging  or  --from production');
  process.exit(1);
}
if (!process.env.DATABASE_URL && !dryRun) {
  console.error('DATABASE_URL is not set. Use the Supabase Session pooler string for the SAME environment.');
  process.exit(1);
}

// ---------- reading D1 through Wrangler ----------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

// A temporary Wrangler config that only knows about the old D1 database.
const tmpDir = join(root, '.wrangler');
mkdirSync(tmpDir, { recursive: true });
const configPath = join(tmpDir, 'd1-import.json');
writeFileSync(
  configPath,
  JSON.stringify({
    name: 'd1-import',
    compatibility_date: '2026-09-01',
    d1_databases: [{ binding: 'OLD', database_name: D1[from].name, database_id: D1[from].id }],
  }),
);

/** Runs one SELECT on D1 and returns its rows. Values are inlined safely (numbers/uuids only). */
function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [
      wranglerBin,
      'd1',
      'execute',
      'OLD',
      local ? '--local' : '--remote',
      '--config',
      configPath,
      '--json',
      '--command',
      sql,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`Unexpected Wrangler output:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (s) => {
  if (!UUID.test(s)) throw new Error(`Unexpected id: ${s}`);
  return `'${s}'`;
};
const clean = (v) => (typeof v === 'string' && v.includes('\u0000') ? v.split('\u0000').join('') : v);

// ---------- main ----------

console.log(`Reading the ${from} D1 database (${D1[from].name})${local ? ' [local]' : ''} …`);
const users = d1('SELECT id, email, created_at, last_login_at FROM users');
const scans = d1(`SELECT * FROM scans WHERE status <> 'uploading' ORDER BY created_at`);
console.log(`Found ${users.length} user(s) and ${scans.length} saved scan(s).`);
for (const s of scans) console.log(`  • ${s.file_name}  (${s.total_rows} rows, ${s.unique_urls} links, ${s.status})`);

if (dryRun) {
  console.log('\nDry run: nothing was written.');
  process.exit(0);
}
if (scans.length === 0) {
  console.log('Nothing to copy.');
  process.exit(0);
}

const url = process.env.DATABASE_URL;
const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: !!process.env.PGSSLROOTCERT };
const db = new pg.Client({ connectionString: url, ssl });
await db.connect();

try {
  const [{ ok }] = (await db.query(`SELECT to_regclass('public.scan_rows') IS NOT NULL AS ok`)).rows;
  if (!ok)
    throw new Error('The Supabase tables are missing. Run `npm run db:migrate` with the same DATABASE_URL first.');

  // Users: match by email; keep the new database's id if the account already exists there.
  const userIdMap = new Map();
  for (const u of users) {
    const { rows } = await db.query(
      `INSERT INTO users (id, email, created_at, last_login_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET email = excluded.email
       RETURNING id`,
      [u.id, u.email, u.created_at, u.last_login_at],
    );
    userIdMap.set(u.id, rows[0].id);
  }

  let copied = 0;
  let skipped = 0;
  for (const s of scans) {
    const exists = await db.query('SELECT 1 FROM scans WHERE id = $1', [s.id]);
    if (exists.rowCount) {
      console.log(`  = ${s.file_name}: already copied, skipped`);
      skipped++;
      continue;
    }
    const userId = userIdMap.get(s.user_id);
    if (!userId) {
      console.log(`  ! ${s.file_name}: its user is missing in D1, skipped`);
      skipped++;
      continue;
    }

    // Read this scan's links and rows from D1, page by page (keyset paging keeps D1 reads low).
    const links = [];
    for (let last = -1; ;) {
      const page = d1(
        `SELECT url_index, url, status, http_status, final_url, redirected, response_time_ms, error_message,
                check_reason, attempts, checked_at
         FROM unique_urls WHERE scan_id = ${q(s.id)} AND url_index > ${last} ORDER BY url_index LIMIT ${PAGE}`,
      );
      links.push(...page);
      if (page.length < PAGE) break;
      last = page[page.length - 1].url_index;
    }
    const rows = [];
    for (let last = 0; ;) {
      const page = d1(
        `SELECT rowid AS rid, sheet_name, row_number, original_value, url_index, is_duplicate, invalid_reason,
                target_url, anchor_text, backlink_found, cells_json
         FROM scan_rows WHERE scan_id = ${q(s.id)} AND rowid > ${last} ORDER BY rowid LIMIT ${PAGE}`,
      );
      rows.push(...page);
      if (page.length < PAGE) break;
      last = page[page.length - 1].rid;
    }

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO scans (id, user_id, file_name, file_size, status, worksheets, sheets_json, headers_json,
            expected_rows, expected_urls, total_rows, valid_urls, invalid_rows, blank_rows, unique_urls,
            duplicate_rows, checked_count, active_count, dead_count, soft_404_count, redirected_count,
            blocked_count, error_count, created_at, started_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          s.id,
          userId,
          clean(s.file_name),
          s.file_size,
          // A check that was mid-way when D1 stopped simply continues on the new database.
          s.status === 'queued' ? 'ready' : s.status,
          s.worksheets,
          s.sheets_json || '[]',
          s.headers_json || '[]',
          s.expected_rows,
          s.expected_urls,
          s.total_rows,
          s.valid_urls,
          s.invalid_rows,
          s.blank_rows,
          s.unique_urls,
          s.duplicate_rows,
          s.checked_count,
          s.active_count,
          s.dead_count,
          s.soft_404_count,
          s.redirected_count,
          s.blocked_count,
          s.error_count,
          s.created_at,
          s.started_at,
          s.completed_at,
        ],
      );
      for (let i = 0; i < links.length; i += PAGE) {
        const chunk = links.slice(i, i + PAGE).map((l) => ({
          ...l,
          url: clean(l.url),
          status: l.status === 'CHECKING' ? 'PENDING' : l.status, // reservations don't carry over
          redirected: !!l.redirected,
        }));
        await db.query(
          `INSERT INTO unique_urls (scan_id, url_index, url, status, http_status, final_url, redirected,
              response_time_ms, error_message, check_reason, attempts, checked_at)
           SELECT $1, x.url_index, x.url, x.status, x.http_status, x.final_url, x.redirected, x.response_time_ms,
                  x.error_message, x.check_reason, x.attempts, x.checked_at::timestamptz
           FROM jsonb_to_recordset($2::jsonb) AS x(url_index int, url text, status text, http_status int,
              final_url text, redirected boolean, response_time_ms int, error_message text, check_reason text,
              attempts int, checked_at text)`,
          [s.id, JSON.stringify(chunk)],
        );
      }
      for (let i = 0; i < rows.length; i += PAGE) {
        const chunk = rows.slice(i, i + PAGE).map((r, n) => ({
          ord: n,
          sheet_name: clean(r.sheet_name),
          row_number: r.row_number,
          original_value: clean(r.original_value),
          url_index: r.url_index,
          is_duplicate: !!r.is_duplicate,
          invalid_reason: r.invalid_reason,
          target_url: clean(r.target_url),
          anchor_text: clean(r.anchor_text),
          backlink_found: r.backlink_found,
          cells: JSON.parse(clean(r.cells_json || '{}')),
        }));
        // Inserted in the workbook's original order, so the new database keeps it.
        await db.query(
          `INSERT INTO scan_rows (scan_id, sheet_name, row_number, original_value, url_index, is_duplicate,
              invalid_reason, target_url, anchor_text, backlink_found, cells_json)
           SELECT $1, x.sheet_name, x.row_number, x.original_value, x.url_index, x.is_duplicate,
                  x.invalid_reason, x.target_url, x.anchor_text, x.backlink_found, COALESCE(x.cells, '{}'::jsonb)
           FROM jsonb_to_recordset($2::jsonb) AS x(ord int, sheet_name text, row_number int,
              original_value text, url_index int, is_duplicate boolean, invalid_reason text, target_url text,
              anchor_text text, backlink_found text, cells jsonb)
           ORDER BY x.ord`,
          [s.id, JSON.stringify(chunk)],
        );
      }
      // Check nothing went missing before committing.
      const [c] = (
        await db.query(
          `SELECT (SELECT COUNT(*)::int FROM unique_urls WHERE scan_id = $1) AS links,
                  (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1) AS rows`,
          [s.id],
        )
      ).rows;
      if (c.links !== links.length || c.rows !== rows.length) {
        throw new Error(`count mismatch (links ${c.links}/${links.length}, rows ${c.rows}/${rows.length})`);
      }
      await db.query('COMMIT');
      console.log(`  ✓ ${s.file_name}: ${rows.length} rows, ${links.length} links`);
      copied++;
    } catch (e) {
      await db.query('ROLLBACK');
      throw new Error(`${s.file_name}: ${e.message}`, { cause: e });
    }
  }
  console.log(`\n✅ Done. Copied ${copied} scan(s)${skipped ? `, skipped ${skipped}` : ''}.`);
} catch (e) {
  console.error(
    `\nImport stopped: ${e.message}\nNothing from the failed scan was saved; run the command again after fixing.`,
  );
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
