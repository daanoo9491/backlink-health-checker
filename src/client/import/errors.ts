import type { ImportErrorCode } from './backlink-import';
import type { XlsxErrorCode } from './xlsx-reader';

/** Plain-English messages for every way an import can fail. */
export const IMPORT_ERROR_TEXT: Record<XlsxErrorCode | ImportErrorCode | 'UNKNOWN', { title: string; help: string }> = {
  NO_BACKLINKS_COLUMN: {
    title: 'We couldn’t find a “Backlinks” column.',
    help: 'Please add a column named “Backlinks” and upload the file again.',
  },
  NO_VALID_URLS: {
    title: 'We found the “Backlinks” column, but no web addresses in it.',
    help: 'Check that the cells contain full links, for example https://example.com/post.',
  },
  NOT_XLSX: {
    title: 'We couldn’t open this file.',
    help: 'It may be damaged or not a real Excel workbook. Open it in Excel, choose Save As → Excel Workbook (.xlsx), and try again.',
  },
  PROTECTED: {
    title: 'This workbook is password-protected.',
    help: 'Remove the password in Excel (File → Info → Protect Workbook), save, and upload it again.',
  },
  TOO_LARGE: {
    title: 'This workbook is too large to read.',
    help: 'Split it into smaller files and upload them one at a time.',
  },
  TOO_MANY_ROWS: {
    title: 'This workbook has more than 100,000 rows.',
    help: 'Split it into smaller files and upload them one at a time.',
  },
  UNKNOWN: {
    title: 'Something went wrong while reading this file.',
    help: 'Try again. If it keeps happening, save a fresh copy of the workbook and upload that.',
  },
};
