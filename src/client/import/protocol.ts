import type { ImportErrorCode, ImportResult } from './backlink-import';
import type { XlsxErrorCode } from './xlsx-reader';

export interface WorkerRequest {
  buffer: ArrayBuffer;
  fileName: string;
  fileSize: number;
  tool: 'links' | 'index';
}

export type ImportFailureCode = XlsxErrorCode | ImportErrorCode | 'UNKNOWN';

export type WorkerResponse = { ok: true; result: ImportResult } | { ok: false; code: ImportFailureCode };
