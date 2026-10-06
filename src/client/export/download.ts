/**
 * Fetches every row of a scan for the download, a page at a time. The file is
 * then built in the browser (build-file.ts); nothing is stored on the server.
 */
import type { ExportPageResponse, ExportRow, RowFilters } from '../../shared/api';
import { api } from '../api/client';

/** Stops a runaway loop if the server ever repeats a page. */
const MAX_PAGES = 400;

export async function fetchAllRows(
  scanId: string,
  filters: RowFilters | null,
  onProgress?: (done: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  let after = '';
  let total: number | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const q = new URLSearchParams({
      ...(after ? { after } : {}),
      ...(filters && filters.group !== 'all' ? { status: filters.group } : {}),
      ...(filters?.sheet ? { sheet: filters.sheet } : {}),
      ...(filters?.http ? { http: filters.http } : {}),
      ...(filters?.q ? { q: filters.q } : {}),
    });
    const page = await api<ExportPageResponse>(`/scans/${scanId}/export?${q}`, { signal });
    total ??= page.total;
    rows.push(...page.rows);
    onProgress?.(rows.length, total);
    if (!page.next || page.next === after) break;
    after = page.next;
  }
  return rows;
}
