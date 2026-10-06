/**
 * Saving a scan happens in steps so every request stays small (free-plan CPU
 * and request limits):
 *   POST /scans              describe the scan          -> { id }   (status: uploading)
 *   POST /scans/:id/urls     unique URLs, in chunks     (safe to retry)
 *   POST /scans/:id/rows     source rows, in chunks     (safe to retry)
 *   POST /scans/:id/complete verify everything arrived  -> status: ready
 * Each chunk is written with ONE statement: the rows travel as a single JSON
 * value and Postgres unpacks it (jsonb_to_recordset).
 */
import { Hono } from 'hono';
import {
  ROW_FILTER_GROUPS,
  ROW_SORTS,
  type CreateScanResponse,
  type ExportPageResponse,
  type IndexCheckFromScanResponse,
  type ScanTool,
  type RowFilterGroup,
  type RowSort,
  type RowFilters,
  type ScanListResponse,
  type ScanRowsResponse,
} from '../../shared/api';
import type { AppContext } from '../env';
import { apiError } from '../errors';
import { requireAuth } from '../middleware/auth';
import { exportRows } from '../db/export';
import { getScan, listRows, listScans, toDetail, toSummary } from '../db/scans';
import { pauseChecking, startChecking } from '../queue';
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

scanRoutes.get('/', async (c) => {
  const tool: ScanTool = c.req.query('tool') === 'index' ? 'index' : 'links';
  return c.json<ScanListResponse>({ scans: await listScans(c.get('db'), c.get('user')!.id, tool) });
});

scanRoutes.post('/', async (c) => {
  const input = parseCreateScan(await readJson(c.req.raw));
  const id = crypto.randomUUID();
  await c.get('db').query(
    `INSERT INTO scans (id, user_id, file_name, file_size, status, worksheets, sheets_json, headers_json,
                        expected_rows, expected_urls, blank_rows, tool)
     VALUES ($1, $2, $3, $4, 'uploading', $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
    [
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
      input.tool ?? 'links',
    ],
  );
  return c.json<CreateScanResponse>({ id }, 201);
});

scanRoutes.post('/:id/urls', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return apiError(c, 409, 'ALREADY_SAVED', 'This scan is already saved.');
  const { offset, urls } = parseAddUrls(await readJson(c.req.raw), scan.expected_urls);
  await c.get('db').query(
    `INSERT INTO unique_urls (scan_id, url_index, url)
     SELECT $1, $2 + (t.ord - 1)::int, t.url
     FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY AS t(url, ord)
     ON CONFLICT DO NOTHING`,
    [scan.id, offset, JSON.stringify(urls)],
  );
  return c.json({ ok: true });
});

scanRoutes.post('/:id/rows', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return apiError(c, 409, 'ALREADY_SAVED', 'This scan is already saved.');
  const { rows } = parseAddRows(await readJson(c.req.raw), scan.expected_urls);
  await c.get('db').query(
    `INSERT INTO scan_rows (scan_id, sheet_name, row_number, original_value, url_index, is_duplicate,
                           invalid_reason, target_url, anchor_text, cells_json)
     SELECT $1, x.sheet, x.row, x.value, x."urlIndex", COALESCE(x.duplicate, false),
            x."invalidReason", x."targetUrl", x."anchorText", COALESCE(x.cells, '{}'::jsonb)
     FROM jsonb_to_recordset($2::jsonb) AS x(
       sheet text, row int, value text, "urlIndex" int, duplicate boolean,
       "invalidReason" text, "targetUrl" text, "anchorText" text, cells jsonb)
     ON CONFLICT DO NOTHING`,
    [scan.id, JSON.stringify(rows)],
  );
  return c.json({ ok: true });
});

scanRoutes.post('/:id/complete', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist.');
  if (scan.status !== 'uploading') return c.json(toDetail(scan)); // already done: idempotent

  const db = c.get('db');
  const [counts] = await db.query<{
    urls: number;
    rows: number;
    valid: number;
    invalid: number;
    dups: number;
    orphans: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM unique_urls WHERE scan_id = $1) AS urls,
       (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1) AS rows,
       (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1 AND url_index IS NOT NULL) AS valid,
       (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1 AND invalid_reason IS NOT NULL) AS invalid,
       (SELECT COUNT(*)::int FROM scan_rows WHERE scan_id = $1 AND is_duplicate) AS dups,
       (SELECT COUNT(*)::int FROM scan_rows r WHERE r.scan_id = $1 AND r.url_index IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM unique_urls u WHERE u.scan_id = r.scan_id AND u.url_index = r.url_index)) AS orphans`,
    [scan.id],
  );

  if (!counts || counts.urls !== scan.expected_urls || counts.rows !== scan.expected_rows || counts.orphans > 0) {
    return apiError(c, 409, 'UPLOAD_INCOMPLETE', 'Part of the file didn’t arrive. Please try again.');
  }

  const [saved] = await db.query<typeof scan>(
    `UPDATE scans SET status = 'ready', total_rows = $2, valid_urls = $3, invalid_rows = $4,
                      unique_urls = $5, duplicate_rows = $6
     WHERE id = $1 AND status = 'uploading'
     RETURNING *`,
    [scan.id, counts.rows, counts.valid, counts.invalid, counts.urls, counts.dups],
  );
  return c.json(toDetail(saved ?? scan));
});

/**
 * Starts (or resumes) checking in the background. Safe to press twice: if a
 * chain is already running, nothing new is started.
 */
scanRoutes.post('/:id/start', async (c) => {
  const db = c.get('db');
  const scan = await getScan(db, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  if (scan.status === 'uploading') {
    return apiError(c, 409, 'NOT_READY', 'This upload didn’t finish. Delete it and upload the file again.');
  }
  if (scan.status === 'completed') return c.json(toSummary(scan));
  const { scan: updated } = await startChecking(db, c.env.SCAN_QUEUE, scan.id, new URL(c.req.url).hostname);
  return c.json(toSummary(updated ?? scan));
});

/**
 * Index Checker on a Link Health scan: copies its links and rows into a new
 * index check (the original scan is left as it is) and starts checking.
 */
scanRoutes.post('/:id/index-check', async (c) => {
  const db = c.get('db');
  const source = await getScan(db, c.get('user')!.id, c.req.param('id'));
  if (!source) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  if (source.status === 'uploading') {
    return apiError(c, 409, 'NOT_READY', 'This upload didn’t finish. Delete it and upload the file again.');
  }
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO scans (id, user_id, tool, source_scan_id, file_name, file_size, status, worksheets, sheets_json,
                          headers_json, expected_rows, expected_urls, total_rows, valid_urls, invalid_rows,
                          blank_rows, unique_urls, duplicate_rows)
       SELECT $1, user_id, 'index', id, file_name, file_size, 'ready', worksheets, sheets_json,
              headers_json, expected_rows, expected_urls, total_rows, valid_urls, invalid_rows,
              blank_rows, unique_urls, duplicate_rows
       FROM scans WHERE id = $2`,
      [id, source.id],
    );
    await tx.query(
      `INSERT INTO unique_urls (scan_id, url_index, url)
       SELECT $1, url_index, url FROM unique_urls WHERE scan_id = $2`,
      [id, source.id],
    );
    await tx.query(
      `INSERT INTO scan_rows (scan_id, sheet_name, row_number, original_value, url_index, is_duplicate,
                             invalid_reason, target_url, anchor_text, cells_json)
       SELECT $1, sheet_name, row_number, original_value, url_index, is_duplicate,
              invalid_reason, target_url, anchor_text, cells_json
       FROM scan_rows WHERE scan_id = $2 ORDER BY seq`,
      [id, source.id],
    );
  });
  await startChecking(db, c.env.SCAN_QUEUE, id, new URL(c.req.url).hostname);
  return c.json<IndexCheckFromScanResponse>({ id }, 201);
});

/** Pauses background checking; Start resumes from where it stopped. */
scanRoutes.post('/:id/pause', async (c) => {
  const db = c.get('db');
  const scan = await getScan(db, c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  return c.json(toSummary((await pauseChecking(db, scan.id)) ?? scan));
});

scanRoutes.get('/:id', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  return c.json(toDetail(scan));
});

scanRoutes.get('/:id/rows', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  const page = Math.max(1, Math.min(10_000, Number(c.req.query('page')) || 1));
  const pageSize = [25, 50, 100].includes(Number(c.req.query('pageSize'))) ? Number(c.req.query('pageSize')) : 50;
  const sheetNames = scan.sheets_json.filter((s) => s.status === 'used').map((s) => s.name);
  const { rows, total, facets } = await listRows(
    c.get('db'),
    scan.id,
    page,
    pageSize,
    readFilters(c.req.query()),
    sheetNames,
    scan.tool,
  );
  return c.json<ScanRowsResponse>({ rows, total, page, pageSize, facets });
});

/**
 * Rows for the Excel/CSV download, a page at a time in the workbook's order
 * (the browser builds the file). Same filters as /rows; sorting is ignored.
 */
scanRoutes.get('/:id/export', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was deleted.');
  if (scan.status === 'uploading') {
    return apiError(c, 409, 'NOT_READY', 'This upload didn’t finish, so there is nothing to download.');
  }
  const page = await exportRows(c.get('db'), scan.id, readFilters(c.req.query()), c.req.query('after') ?? '');
  c.header('Cache-Control', 'no-store');
  return c.json<ExportPageResponse>(page);
});

/** Unknown or oversized filter values are ignored rather than rejected. */
function readFilters(q: Record<string, string>): RowFilters {
  const group = (ROW_FILTER_GROUPS as readonly string[]).includes(q.status ?? '')
    ? (q.status as RowFilterGroup)
    : 'all';
  const http = q.http === 'none' || /^[1-5]\d\d$/.test(q.http ?? '') ? q.http! : '';
  const sort = (ROW_SORTS as readonly string[]).includes(q.sort ?? '') ? (q.sort as RowSort) : 'row';
  return {
    group,
    sheet: (q.sheet ?? '').slice(0, 100),
    http,
    q: (q.q ?? '').trim().slice(0, 200),
    sort,
    dir: q.dir === 'desc' ? 'desc' : 'asc',
  };
}

scanRoutes.delete('/:id', async (c) => {
  const scan = await getScan(c.get('db'), c.get('user')!.id, c.req.param('id'));
  if (!scan) return apiError(c, 404, 'NOT_FOUND', 'This scan doesn’t exist, or it was already deleted.');
  await c.get('db').query('DELETE FROM scans WHERE id = $1', [scan.id]); // rows and links cascade
  return c.json({ ok: true });
});
