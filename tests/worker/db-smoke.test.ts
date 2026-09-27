import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers';

describe('D1 test database', () => {
  it('applies migrations and supports json_each bulk inserts', async () => {
    const db = await freshDb();
    await db.prepare(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@b.c', 'now')`).run();
    await db
      .prepare(
        `INSERT INTO scans (id, user_id, file_name, file_size, created_at) VALUES ('s1', 'u1', 'f.xlsx', 1, 'now')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO unique_urls (scan_id, url_index, url) SELECT 's1', CAST(key AS INTEGER), value FROM json_each(?1)`,
      )
      .bind(JSON.stringify(['https://a.example', 'https://b.example']))
      .run();
    const { results } = await db.prepare('SELECT url_index, url, status FROM unique_urls ORDER BY url_index').all();
    expect(results).toEqual([
      { url_index: 0, url: 'https://a.example', status: 'PENDING' },
      { url_index: 1, url: 'https://b.example', status: 'PENDING' },
    ]);
  });
});
