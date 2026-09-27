/**
 * Saving a scan happens in steps so every request stays small (free-plan CPU
 * and D1 query limits):
 *   POST /scans              describe the scan          -> { id }   (status: uploading)
 *   POST /scans/:id/urls     unique URLs, in chunks     (safe to retry)
 *   POST /scans/:id/rows     source rows, in chunks     (safe to retry)
 *   POST /scans/:id/complete verify everything arrived  -> status: ready
 * Each chunk is written with ONE statement: the rows travel as a single JSON
 * value and SQLite unpacks them with json_each().
 */
import { Hono } from 'hono';
import {
  ROW_FILTER_GROUPS,
  type CheckBatchResponse,
  type CreateScanResponse,
  type RowFilterGroup,
  type RowFilters,
  type ScanListResponse,
  type ScanRowsResponse,
} from '../../shared/api';
import type { AppContext } from '../env';
import { apiError } from '../errors';
import { requireAuth } from '../middleware/auth';
import { getScan, listRows, listScans, toDetail, toSummary } from '../db/scans';
import { runCheckBatch } from '../checker/run-batch';
import { parseAddRows, parseAddUrls, parseCreateScan, ValidationError } from '../validation';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new ValidationError('body too large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ValidationError('body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('invalid JSON');
  }
}

export const scanRoutes = new Hono<AppContext>();
scanRoutes.use('*', requireAuth());

scanRoutes.onError((err, c) => {
  if (err instanceof ValidationError) {
    return apiError(
      c,
      400,
      'INVALID_SCAN_DATA',
      'Some of the file’s data couldn’t be saved. Please upload the file again.',
    );
  }
  throw err;
});

scanRoutes.get('/', async (c) => c.json<ScanListResponse>({ scans: await listScans(c.env, c.get('user')!.id) }));

scanRoutes.post('/', async (c) => {
  const input = parseCreateScan(await readJson(c.req.raw));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO scans (id, user_id, file_name, file_size, status, worksheets, sheets_json, headers_json,
                        expected_rows, expected_urls, blank_rows, created_at)
     VALUES (?1, ?2, ?3, ?4, 'uploading', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      c.get('user')!.id,
      input.fileName,
      input.fileSize,
      input.worksheets,
      JSON.stringify(input.sheets),
      JSON.stringify(input.headers),
      input.totalRows,
      input.uniqueUrls,
      input.blankRows,
      new Date().toISOString(),
    )
    .run();
  return c.json<CreateScanResponse>({ id }, 201);
});

scanRoutes.post('/:id/urls', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return apiError(c, 409, 'ALREADY_SAVED', 'This scan is already saved.');
  const { offset, urls } = parseAddUrls(await readJson(c.req.raw), scan.expected_urls);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO unique_urls (scan_id, url_index, url)
     SELECT ?1, ?2 + CAST(key AS INTEGER), value FROM json_each(?3)`,
  )
    .bind(scan.id, offset, JSON.stringify(urls))
    .run();
  return c.json({ ok: true });
});

scanRoutes.post('/:id/rows', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return apiError(c, 409, 'ALREADY_SAVED', 'This scan is already saved.');
  const { rows } = parseAddRows(await readJson(c.req.raw), scan.expected_urls);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO scan_rows (scan_id, sheet_name, row_number, original_value, url_index, is_duplicate,
                                      invalid_reason, target_url, anchor_text, cells_json)
     SELECT ?1,
            json_extract(value, '$.sheet'),
            json_extract(value, '$.row'),
            json_extract(value, '$.value'),
            json_extract(value, '$.urlIndex'),
            CASE WHEN json_extract(value, '$.duplicate') THEN 1 ELSE 0 END,
            json_extract(value, '$.invalidReason'),
            json_extract(value, '$.targetUrl'),
            json_extract(value, '$.anchorText'),
            json_extract(value, '$.cells')
     FROM json_each(?2)`,
  )
    .bind(scan.id, JSON.stringify(rows))
    .run();
  return c.json({ ok: true });
});

scanRoutes.post('/:id/complete', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return c.json(toDetail(scan)); // already done: idempotent

  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM unique_urls WHERE scan_id = ?1) AS urls,
       (SELECT COUNT(*) FROM scan_rows WHERE scan_id = ?1) AS rows,
       (SELECT COUNT(*) FROM scan_rows WHERE scan_id = ?1 AND url_index IS NOT NULL) AS valid,
       (SELECT COUNT(*) FROM scan_rows WHERE scan_id = ?1 AND invalid_reason IS NOT NULL) AS invalid,
       (SELECT COUNT(*) FROM scan_rows WHERE scan_id = ?1 AND is_duplicate = 1) AS dups,
       (SELECT COUNT(*) FROM scan_rows r WHERE r.scan_id = ?1 AND r.url_index IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM unique_urls u WHERE u.scan_id = r.scan_id AND u.url_index = r.url_index)) AS orphans`,
  )
    .bind(scan.id)
    .first<{ urls: number; rows: number; valid: number; invalid: number; dups: number; orphans: number }>();

  if (!counts || counts.urls !== scan.expected_urls || counts.rows !== scan.expected_rows || counts.orphans > 0) {
    return apiError(c, 409, 'UPLOAD_INCOMPLETE', 'Part of the file didn’t arrive. Please try again.');
  }

  const saved = await c.env.DB.prepare(
    `UPDATE scans SET status = 'ready', total_rows = ?2, valid_urls = ?3, invalid_rows = ?4,
                      unique_urls = ?5, duplicate_rows = ?6
     WHERE id = ?1 AND status = 'uploading'
     RETURNING *`,
  )
    .bind(scan.id, counts.rows, counts.valid, counts.invalid, counts.urls, counts.dups)
    .first<typeof scan>();
  return c.json(toDetail(saved ?? scan));
});

/**
 * Checks the next batch of links. The scan page calls this repeatedly while
 * it is open (Phase 5 moves this to a background queue).
 */
scanRoutes.post('/:id/check', async (c) => {
  const userId = c.get('user')!.id;
  const scan = await getScan(c.env, userId, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  if (scan.status === 'uploading') {
    return apiError(c, 409, 'NOT_READY', 'This upload didn’t finish. Delete it and upload the file again.');
  }
  const outcome = await runCheckBatch(c.env, scan.id, { ownHost: new URL(c.req.url).hostname });
  const updated = (await getScan(c.env, userId, scan.id))!;
  return c.json<CheckBatchResponse>({ scan: toSummary(updated), ...outcome });
});

scanRoutes.get('/:id', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  return c.json(toDetail(scan));
});

scanRoutes.get('/:id/rows', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  const page = Math.max(1, Math.min(10_000, Number(c.req.query('page')) || 1));
  const pageSize = [25, 50, 100].includes(Number(c.req.query('pageSize'))) ? Number(c.req.query('pageSize')) : 50;
  const { rows, total, facets } = await listRows(c.env, scan.id, page, pageSize, readFilters(c.req.query()));
  return c.json<ScanRowsResponse>({ rows, total, page, pageSize, facets });
});

/** Unknown or oversized filter values are ignored rather than rejected. */
function readFilters(q: Record<string, string>): RowFilters {
  const group = (ROW_FILTER_GROUPS as readonly string[]).includes(q.status ?? '')
    ? (q.status as RowFilterGroup)
    : 'all';
  const http = q.http === 'none' || /^[1-5]\d\d$/.test(q.http ?? '') ? q.http! : '';
  return {
    group,
    sheet: (q.sheet ?? '').slice(0, 100),
    http,
    q: (q.q ?? '').trim().slice(0, 200),
  };
}

scanRoutes.delete('/:id', async (c) => {
  const scan = await getScan(c.env, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was already deleted.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM scan_rows WHERE scan_id = ?1').bind(scan.id),
    c.env.DB.prepare('DELETE FROM unique_urls WHERE scan_id = ?1').bind(scan.id),
    c.env.DB.prepare('DELETE FROM scans WHERE id = ?1').bind(scan.id),
  ]);
  return c.json({ ok: true });
});
