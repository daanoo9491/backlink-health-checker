#!/usr/bin/env node
/**
 * Copies every scan and index check from one Supabase database (FROM) into
 * another (TO), with all rows, links, results and evidence. Used to bring the
 * old production project's scans into the live database before deleting it.
 *
 *   $env:FROM_DATABASE_URL="<Session pooler string of the database to copy from>"
 *   $env:TO_DATABASE_URL="<Session pooler string of the database to copy into>"
 *   npm run db:copy -- --dry-run   # shows what would be copied, writes nothing
 *   npm run db:copy                # copies
 *
 * - Adds to the target; nothing there is changed or deleted. Safe to run again:
 *   scans already copied are skipped.
 * - Each scan is copied in one transaction and its counts are checked before
 *   it is saved, so a failure never leaves half a scan behind.
 * - Users are matched by email, so scans attach to the account you already
 *   already use on the target.
 * - A scan that was checking is copied as "Paused": press Resume on
 *   the target to carry on. Unfinished uploads are left out.
 * - Not copied: browser-helper connection codes (create a new one on
 *   the target), sign-in throttling, Search Console usage, robots.txt cache.
 * - The target must have every migration the source has (it may have more:
 *   newer columns simply get their defaults).
 */
import pg from 'pg';

const dryRun = process.argv.includes('--dry-run');
const fromUrl = process.env.FROM_DATABASE_URL;
const toUrl = process.env.TO_DATABASE_URL;
const LINK_PAGE = 2000;
const ROW_PAGE = 1000;

if (!fromUrl || !toUrl) {
  console.error(
    'Set both connection strings first:\n' +
      '  $env:FROM_DATABASE_URL="<database to copy from>"\n' +
      '  $env:TO_DATABASE_URL="<database to copy into>"',
  );
  process.exit(1);
}

/** host + port + database + user: Supabase projects share pooler hosts but not users. */
function identity(url) {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.username)}@${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    console.error('A connection string is not valid. Copy it again from Supabase (Connect → Session pooler).');
    process.exit(1);
  }
}
if (identity(fromUrl) === identity(toUrl)) {
  console.error('FROM and TO are the same database. Use two different Supabase projects.');
  process.exit(1);
}

// Keep timestamps exactly as stored (microseconds included): read them as text, not as JS dates.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v);

const sslFor = (url) =>
  /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: !!process.env.PGSSLROOTCERT };
const from = new pg.Client({ connectionString: fromUrl, ssl: sslFor(fromUrl) });
const to = new pg.Client({ connectionString: toUrl, ssl: sslFor(toUrl) });

/**
 * Columns to copy: those both databases have (the target may be newer; its
 * extra columns get their defaults). Generated identity columns are left out.
 */
async function columns(table) {
  const src = new Set(
    (
      await from.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
    ).rows.map((r) => r.column_name),
  );
  return (await targetColumns(table)).filter((c) => src.has(c));
}

async function targetColumns(table) {
  const { rows } = await to.query(
    `SELECT column_name, is_generated, identity_generation FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  // seq is GENERATED ALWAYS: the target numbers rows itself, in the order we insert them.
  return rows
    .filter((c) => c.is_generated !== 'ALWAYS' && c.identity_generation !== 'ALWAYS')
    .map((c) => c.column_name);
}

/** INSERT … SELECT from a JSON array, matching columns by name. */
function insertSql(table, cols, orderBy) {
  const list = cols.map((c) => `"${c}"`).join(', ');
  return `INSERT INTO ${table} (${list})
          SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) WITH ORDINALITY AS x
          ${orderBy ? 'ORDER BY x.ordinality' : ''}`;
}

const clean = (v) => (typeof v === 'string' && v.includes('\u0000') ? v.split('\u0000').join('') : v);
const cleanRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clean(v)]));

try {
  await from.connect();
  await to.connect();

  // Same migrations on both sides, so every column lines up.
  const migrations = async (db) => {
    const exists = (await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`)).rows[0].ok;
    if (!exists) return [];
    return (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  };
  const [mFrom, mTo] = [await migrations(from), await migrations(to)];
  const missing = mFrom.filter((m) => !mTo.includes(m));
  if (missing.length) {
    throw new Error(
      `The target (TO) database is missing updates the source has (${missing.join(', ')}).\n` +
        'Deploy the app that uses the target database first, wait for it to finish, then run this again.',
    );
  }

  const users = (await from.query('SELECT * FROM users ORDER BY created_at')).rows;
  const scans = (await from.query(`SELECT * FROM scans WHERE status <> 'uploading' ORDER BY created_at, id`)).rows;
  const already = new Set(
    (await to.query('SELECT id FROM scans WHERE id = ANY($1::uuid[])', [scans.map((s) => s.id)])).rows.map((r) => r.id),
  );
  const todo = scans.filter((s) => !already.has(s.id));

  console.log(`The source (FROM) has ${users.length} user(s) and ${scans.length} saved scan(s)/index check(s).`);
  for (const s of scans) {
    const kind = s.tool === 'index' ? 'index check' : 'scan';
    const mark = already.has(s.id) ? '=' : '+';
    console.log(`  ${mark} ${s.file_name}  (${kind}, ${s.total_rows} rows, ${s.unique_urls} links, ${s.status})`);
  }
  console.log(`\n${todo.length} to copy, ${already.size} already on the target (= skipped).`);

  if (dryRun) {
    console.log('\nDry run: nothing was written.');
  } else if (todo.length === 0) {
    console.log('Nothing to copy.');
  } else {
    // Users: matched by email; the target keeps its own id for an account it already has.
    const userIds = new Map();
    for (const u of users) {
      const { rows } = await to.query(
        `INSERT INTO users (id, email, created_at, last_login_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET email = excluded.email
         RETURNING id`,
        [u.id, u.email, u.created_at, u.last_login_at],
      );
      userIds.set(u.id, rows[0].id);
    }

    const scanCols = await columns('scans');
    const linkCols = await columns('unique_urls');
    const rowCols = await columns('scan_rows');
    const copiedIds = new Set(already);
    let copied = 0;

    for (const s of todo) {
      await to.query('BEGIN');
      try {
        const scan = {
          ...cleanRow(s),
          user_id: userIds.get(s.user_id),
          // Checking doesn't carry over a live queue chain: it waits for Resume.
          status: s.status === 'queued' || s.status === 'running' ? 'paused' : s.status,
          chain_id: null,
          heartbeat_at: null,
          // An index check keeps its link to the scan it came from, if that came over too.
          source_scan_id: s.source_scan_id && copiedIds.has(s.source_scan_id) ? s.source_scan_id : null,
        };
        await to.query(insertSql('scans', scanCols), [JSON.stringify([scan])]);

        let links = 0;
        for (let last = -1; ;) {
          const page = (
            await from.query(
              `SELECT * FROM unique_urls WHERE scan_id = $1 AND url_index > $2 ORDER BY url_index LIMIT ${LINK_PAGE}`,
              [s.id, last],
            )
          ).rows;
          if (!page.length) break;
          const data = page.map((l) => ({
            ...cleanRow(l),
            status: l.status === 'CHECKING' ? 'PENDING' : l.status, // reservations don't carry over
            claimed_at: null,
            google_claimed_at: null,
          }));
          await to.query(insertSql('unique_urls', linkCols), [JSON.stringify(data)]);
          links += page.length;
          last = page[page.length - 1].url_index;
          if (page.length < LINK_PAGE) break;
        }

        let rows = 0;
        for (let last = '0'; ;) {
          const page = (
            await from.query(
              `SELECT * FROM scan_rows WHERE scan_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT ${ROW_PAGE}`,
              [s.id, last],
            )
          ).rows;
          if (!page.length) break;
          // Inserted in workbook order, so the target keeps it.
          await to.query(insertSql('scan_rows', rowCols, true), [JSON.stringify(page.map(cleanRow))]);
          rows += page.length;
          last = String(page[page.length - 1].seq);
          if (page.length < ROW_PAGE) break;
        }

        // Check nothing went missing before saving.
        const [want] = (
          await from.query(
            `SELECT (SELECT COUNT(*)::int FROM unique_urls WHERE scan_id = $1) AS links,
                    (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1) AS rows`,
            [s.id],
          )
        ).rows;
        const [got] = (
          await to.query(
            `SELECT (SELECT COUNT(*)::int FROM unique_urls WHERE scan_id = $1) AS links,
                    (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1) AS rows`,
            [s.id],
          )
        ).rows;
        if (got.links !== want.links || got.rows !== want.rows || got.links !== links || got.rows !== rows) {
          throw new Error(`count mismatch (links ${got.links}/${want.links}, rows ${got.rows}/${want.rows})`);
        }
        await to.query('COMMIT');
        copiedIds.add(s.id);
        copied++;
        console.log(`  ✓ ${s.file_name}: ${rows} rows, ${links} links`);
      } catch (e) {
        await to.query('ROLLBACK').catch(() => {});
        throw new Error(`${s.file_name}: ${e.message}`, { cause: e });
      }
    }
    console.log(`\n✅ Done. Copied ${copied} scan(s)/index check(s) to the target.`);
  }
} catch (e) {
  console.error(
    `\nCopy stopped: ${e.message}\nNothing from the failed scan was saved; scans already copied stay. ` +
      'Fix the problem and run the same command again.',
  );
  process.exitCode = 1;
} finally {
  await from.end().catch(() => {});
  await to.end().catch(() => {});
}
