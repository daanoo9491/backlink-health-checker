import type { ImportErrorCode, ImportResult } from './backlink-import';
import type { XlsxErrorCode } from './xlsx-reader';

export interface WorkerRequest {
  buffer: ArrayBuffer;
  fileName: string;
  fileSize: number;
}

export type ImportFailureCode = XlsxErrorCode | ImportErrorCode | 'UNKNOWN';

export type WorkerResponse = { ok: true; result: ImportResult } | { ok: false; code: ImportFailureCode };
