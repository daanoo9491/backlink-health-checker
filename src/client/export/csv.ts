/**
 * CSV for the download. Opens correctly in Excel (UTF-8 marker, CRLF line
 * ends) and in Google Sheets.
 */
import type { CellValue, Table } from './table';

/** Tells Excel the file is UTF-8, so accents and non-Latin text show correctly. */
const BOM = String.fromCharCode(0xfeff);

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time, the way people read it: 2026-10-06 15:45. */
export function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Spreadsheet apps run a cell that starts with = + - @ (or a tab / CR) as a
 * formula. Text from uploaded files and from the pages we checked is not
 * trusted, so such text gets a leading apostrophe, which shows it as plain text.
 */
export function neutralise(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function field(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  const text = v instanceof Date ? localDateTime(v) : neutralise(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(table: Table): string {
  const lines = [...(table.headers.length ? [table.headers] : []), ...table.rows].map((row) =>
    row.map(field).join(','),
  );
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
