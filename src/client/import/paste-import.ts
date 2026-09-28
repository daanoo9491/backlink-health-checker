/**
 * Turns pasted or dropped text into a backlink import.
 *
 * Each line may hold one or more links (one per line is typical, but a line
 * copied from an email or a chat with several links works too). A line with
 * no link in it is kept as-is so the preview can say why it was skipped.
 * The text becomes a one-sheet "workbook" and goes through exactly the same
 * validation and de-duplication as an Excel upload.
 */
import { SCAN_LIMITS } from '../../shared/api';
import { importBacklinks, ImportError, type ImportResult } from './backlink-import';
import type { Cell, Workbook } from './xlsx-reader';

export const PASTED_SHEET = 'Pasted links';

const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;

/** Removes sentence punctuation stuck to the end of a link ("…/post." or "(…/post)"). */
function trimLink(link: string): string {
  let out = link.replace(/[.,;:!?'"]+$/, '');
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return out;
}

/** The values found in the text, in order: links, plus any non-empty line without one. */
export function extractValues(text: string): string[] {
  const values: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // blank, or a comment in a dropped "uri-list"
    const links = line.match(LINK);
    if (links) values.push(...links.map(trimLink));
    else values.push(line);
  }
  return values;
}

export class TooManyLinksError extends Error {}

export function importPastedText(text: string, name: string): ImportResult {
  const values = extractValues(text);
  if (values.length === 0) throw new ImportError('NO_VALID_URLS');
  if (values.length > SCAN_LIMITS.maxRows) throw new TooManyLinksError();

  const rows = new Map<number, Map<number, Cell>>();
  rows.set(1, new Map([[0, { text: 'Backlinks' }]]));
  values.forEach((v, i) => rows.set(i + 2, new Map([[0, { text: v }]])));
  const workbook: Workbook = { sheets: [{ name: PASTED_SHEET, hidden: false, rows }] };

  const bytes = new TextEncoder().encode(text).length;
  return { ...importBacklinks(workbook, name, bytes), worksheets: 1 };
}
