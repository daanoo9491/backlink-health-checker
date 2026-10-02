/**
 * Web Worker: reads the workbook off the main thread so the page never
 * freezes, even for large files.
 */
import { importBacklinks, ImportError } from './backlink-import';
import { readXlsx, XlsxError } from './xlsx-reader';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

ctx.onmessage = (e) => {
  const { buffer, fileName, fileSize, tool } = e.data;
  try {
    const workbook = readXlsx(new Uint8Array(buffer));
    ctx.postMessage({ ok: true, result: importBacklinks(workbook, fileName, fileSize, { tool }) });
  } catch (err) {
    const code = err instanceof XlsxError || err instanceof ImportError ? err.code : 'UNKNOWN';
    if (code === 'UNKNOWN') console.error(err);
    ctx.postMessage({ ok: false, code });
  }
};
