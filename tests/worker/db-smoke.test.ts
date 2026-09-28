import { describe, expect, it } from 'vitest';
import { freshDb, sql } from './helpers';

describe('Postgres test database', () => {
  it('applies the migration and supports the bulk-insert pattern', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'a@b.c')`);
    await db.query(
      `INSERT INTO scans (id, user_id, file_name, file_size)
       VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'f.xlsx', 1)`,
    );
    await db.query(
      `INSERT INTO unique_urls (scan_id, url_index, url)
       SELECT '00000000-0000-0000-0000-00000000000a', (t.ord - 1)::int, t.url
       FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS t(url, ord)`,
      [JSON.stringify(['https://a.example', 'https://b.example'])],
    );
    expect(await sql('SELECT url_index, url, status FROM unique_urls ORDER BY url_index')).toEqual([
      { url_index: 0, url: 'https://a.example', status: 'PENDING' },
      { url_index: 1, url: 'https://b.example', status: 'PENDING' },
    ]);
  });

  it('switches on row level security for every table (Supabase web API sees nothing)', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});

describe('daily keep-alive', () => {
  it('writes a heartbeat and clears expired sign-in counters', async () => {
    const { keepAlive } = await import('../../src/worker/keep-alive');
    const db = await freshDb();
    await sql(`INSERT INTO login_attempts (key, failures, window_start) VALUES ('ip:old', 3, 1), ('ip:new', 3, $1)`, [
      Math.floor(Date.now() / 1000),
    ]);
    await keepAlive(db);
    await keepAlive(db); // twice is fine
    expect(await sql('SELECT id FROM heartbeat')).toEqual([{ id: 1 }]);
    expect(await sql('SELECT key FROM login_attempts')).toEqual([{ key: 'ip:new' }]);
  });
});
