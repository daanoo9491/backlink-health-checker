import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, ScanDetail, ScanListResponse } from '../../src/shared/api';
import type { Env } from '../../src/worker/env';
import { call, ORIGIN, signedIn, sql, testEnv } from './helpers';

let env: Env;
let api: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  env = await testEnv();
  api = await signedIn(env);
});

async function newScan(tool: 'links' | 'index' = 'links'): Promise<string> {
  const res = await api('/api/scans', {
    method: 'POST',
    json: {
      tool,
      fileName: 'Pasted links, 1 Oct 2026, 18:54',
      fileSize: 10,
      worksheets: 1,
      sheets: [],
      headers: ['Backlinks'],
      totalRows: 1,
      uniqueUrls: 1,
      blankRows: 0,
    },
  });
  return ((await res.json()) as { id: string }).id;
}

const rename = (id: string, fileName: unknown) => api(`/api/scans/${id}`, { method: 'PATCH', json: { fileName } });

describe('renaming a scan', () => {
  it('saves the new name and shows it everywhere', async () => {
    const id = await newScan();
    const res = await rename(id, '  Lanop  guest posts\n– October  ');
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScanDetail).fileName).toBe('Lanop guest posts – October');
    expect(((await (await api(`/api/scans/${id}`)).json()) as ScanDetail).fileName).toBe('Lanop guest posts – October');
    const list = (await (await api('/api/scans')).json()) as ScanListResponse;
    expect(list.scans.map((s) => s.fileName)).toEqual(['Lanop guest posts – October']);
  });

  it('works for index checks too, and changes nothing else', async () => {
    const id = await newScan('index');
    const [before] = await sql(`SELECT * FROM scans WHERE id = $1`, [id]);
    expect((await rename(id, 'Client X pages')).status).toBe(200);
    const [after] = await sql(`SELECT * FROM scans WHERE id = $1`, [id]);
    expect({ ...after, file_name: before!.file_name }).toEqual(before);
  });

  it('refuses an empty or too long name with a plain message', async () => {
    const id = await newScan();
    for (const bad of ['', '   ', '\n\t', 'x'.repeat(121), 42, null]) {
      const res = await rename(id, bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiError;
      expect(body.error).toMatchObject({ code: 'INVALID_NAME', message: 'Enter a name of 1 to 120 characters.' });
    }
    expect((await rename(id, 'x'.repeat(120))).status).toBe(200);
    expect((await rename(id, '😀'.repeat(120))).status).toBe(200); // counted as characters, not code units
    expect(
      (
        await api(`/api/scans/${id}`, {
          method: 'PATCH',
          body: 'not json',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(400);
  });

  it('removes control characters', async () => {
    const id = await newScan();
    const res = await rename(id, 'a\u0000b\u0007c');
    expect(((await res.json()) as ScanDetail).fileName).toBe('a b c');
  });

  it('only lets the owner rename, signed in, from the app itself', async () => {
    const id = await newScan();
    expect((await rename('00000000-0000-4000-8000-000000000000', 'x')).status).toBe(404);
    expect((await rename('not-an-id', 'x')).status).toBe(404);
    const anon = await call(env, `/api/scans/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ fileName: 'x' }),
    });
    expect(anon.status).toBe(401);
    const cross = await api(`/api/scans/${id}`, {
      method: 'PATCH',
      headers: { Origin: 'https://evil.example' },
      json: { fileName: 'hacked' },
    });
    expect(cross.status).toBe(403);
    const [row] = await sql<{ file_name: string }>(`SELECT file_name FROM scans WHERE id = $1`, [id]);
    expect(row!.file_name).toBe('Pasted links, 1 Oct 2026, 18:54');
  });
});
