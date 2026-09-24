export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Returns a friendly error, or null if the file can be used. */
export function checkUploadFile(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return 'This file isn’t an Excel workbook (.xlsx). Save it as .xlsx in Excel and upload it again.';
  }
  if (file.size === 0) return 'This file is empty. Choose another file.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'This file is larger than 10 MB. Split it into smaller files and upload them one at a time.';
  }
  return null;
}
