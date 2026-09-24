import { describe, expect, it } from 'vitest';
import { checkUploadFile, MAX_UPLOAD_BYTES } from '../../src/client/lib/upload-rules';

describe('upload file checks', () => {
  it('accepts .xlsx files (any case)', () => {
    expect(checkUploadFile({ name: 'Backlinks.xlsx', size: 5000 })).toBeNull();
    expect(checkUploadFile({ name: 'LINKS.XLSX', size: 5000 })).toBeNull();
  });

  it('rejects other file types with a helpful message', () => {
    for (const name of ['links.csv', 'links.xls', 'links.xlsx.exe', 'links']) {
      expect(checkUploadFile({ name, size: 5000 })).toMatch(/xlsx/);
    }
  });

  it('rejects empty and oversized files', () => {
    expect(checkUploadFile({ name: 'a.xlsx', size: 0 })).toMatch(/empty/);
    expect(checkUploadFile({ name: 'a.xlsx', size: MAX_UPLOAD_BYTES + 1 })).toMatch(/10 MB/);
  });
});
