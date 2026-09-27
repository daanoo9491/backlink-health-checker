import type { ImportResult } from './backlink-import';
import type { ImportFailureCode, WorkerRequest, WorkerResponse } from './protocol';

export class ReadFileError extends Error {
  constructor(readonly code: ImportFailureCode) {
    super(code);
  }
}

/** Reads a workbook in a background worker. Rejects with ReadFileError. */
export async function readBacklinkFile(file: File): Promise<ImportResult> {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<ImportResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        e.data.ok ? resolve(e.data.result) : reject(new ReadFileError(e.data.code));
      worker.onerror = () => reject(new ReadFileError('UNKNOWN'));
      const msg: WorkerRequest = { buffer, fileName: file.name, fileSize: file.size };
      worker.postMessage(msg, [buffer]);
    });
  } finally {
    worker.terminate();
  }
}
