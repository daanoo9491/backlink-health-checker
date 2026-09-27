import { SCAN_LIMITS, type CreateScanRequest, type CreateScanResponse, type ScanRowInput } from '../../shared/api';
import { api, RequestError } from '../api/client';
import type { ImportResult } from './backlink-import';

export interface SaveProgress {
  done: number;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries network blips and server hiccups; gives up at once on "your data is wrong" answers. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = !(e instanceof RequestError) || e.status === 0 || e.status >= 500 || e.status === 429;
      if (!retryable || attempt >= 4) throw e;
      await sleep(500 * 2 ** (attempt - 1)); // 0.5s, 1s, 2s
    }
  }
}

export function tooBigForOneScan(result: ImportResult): boolean {
  return result.totals.rows > SCAN_LIMITS.maxRows || result.totals.unique > SCAN_LIMITS.maxUniqueUrls;
}

/**
 * Saves an import as a scan, in small chunks. Pass `existingId` to resume a
 * failed save: every chunk is safe to send again.
 */
export async function saveScan(
  result: ImportResult,
  opts: { onProgress: (p: SaveProgress) => void; onCreated: (id: string) => void; resumeId?: string },
): Promise<string> {
  const { onProgress, onCreated, resumeId } = opts;
  const urlChunks: string[][] = [];
  for (let i = 0; i < result.uniqueUrls.length; i += SCAN_LIMITS.urlsPerRequest) {
    urlChunks.push(result.uniqueUrls.slice(i, i + SCAN_LIMITS.urlsPerRequest));
  }
  const rows: ScanRowInput[] = result.rows.map((r) => ({
    sheet: r.sheet,
    row: r.rowNumber,
    value: r.originalValue,
    ...(r.uniqueIndex !== undefined ? { urlIndex: r.uniqueIndex } : { invalidReason: r.invalidReason }),
    ...(r.duplicate ? { duplicate: true } : {}),
    ...(r.targetUrl ? { targetUrl: r.targetUrl } : {}),
    ...(r.anchorText ? { anchorText: r.anchorText } : {}),
    cells: r.cells,
  }));
  const rowChunks: ScanRowInput[][] = [];
  for (let i = 0; i < rows.length; i += SCAN_LIMITS.rowsPerRequest) {
    rowChunks.push(rows.slice(i, i + SCAN_LIMITS.rowsPerRequest));
  }

  const total = 2 + urlChunks.length + rowChunks.length;
  let done = 0;
  const tick = () => onProgress({ done: ++done, total });
  onProgress({ done, total });

  let id = resumeId;
  if (!id) {
    const meta: CreateScanRequest = {
      fileName: result.fileName,
      fileSize: result.fileSize,
      worksheets: result.worksheets,
      sheets: result.sheets.map((s) => ({
        name: s.name,
        hidden: s.hidden,
        status: s.status,
        headerRow: s.headerRow,
        backlinksHeader: s.backlinksHeader,
        rows: s.rows,
        valid: s.valid,
        invalid: s.invalid,
        blank: s.blank,
      })),
      headers: result.headers,
      totalRows: result.totals.rows,
      uniqueUrls: result.totals.unique,
      blankRows: result.totals.blank,
    };
    id = (await withRetry(() => api<CreateScanResponse>('/scans', { method: 'POST', body: JSON.stringify(meta) }))).id;
    onCreated(id);
  }
  tick();

  let offset = 0;
  for (const chunk of urlChunks) {
    const start = offset;
    await withRetry(() =>
      api(`/scans/${id}/urls`, { method: 'POST', body: JSON.stringify({ offset: start, urls: chunk }) }),
    );
    offset += chunk.length;
    tick();
  }
  for (const chunk of rowChunks) {
    await withRetry(() => api(`/scans/${id}/rows`, { method: 'POST', body: JSON.stringify({ rows: chunk }) }));
    tick();
  }
  await withRetry(() => api(`/scans/${id}/complete`, { method: 'POST' }));
  tick();
  return id;
}
