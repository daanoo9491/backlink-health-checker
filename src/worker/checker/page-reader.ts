/**
 * The one safe way to read a page's HTML, shared by every check that needs
 * page content (soft 404 now; robots/canonical and link presence later).
 *
 * - Only reads HTML (text/html, application/xhtml+xml, or no type given).
 * - Streams and stops at a size cap, so a huge page or an endless stream
 *   can't use up memory; the rest of the download is cancelled.
 * - Decodes with the page's own charset (header, then <meta>), falling back
 *   to UTF-8; bad bytes become replacement characters, never an error.
 * - Never throws: if reading fails half-way, what arrived so far is returned.
 * The caller's fetch timeout (AbortSignal) also covers reading the body.
 */

/** Enough for the <head> and the main content of nearly every page. */
export const MAX_PAGE_BYTES = 256 * 1024;

export interface PageRead {
  /** False when the response isn't HTML; `html` is then empty. */
  isHtml: boolean;
  html: string;
  /** Bytes read (at most the cap). */
  bytes: number;
  /** True when the page was longer than the cap and only its start was read. */
  truncated: boolean;
  contentType: string;
}

export function isHtmlType(contentType: string | null): boolean {
  if (!contentType || !contentType.trim()) return true; // many servers send none; sniffed later
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function charsetFromContentType(contentType: string): string | null {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType);
  return m ? m[1]!.toLowerCase() : null;
}

/** <meta charset="…"> or <meta http-equiv="Content-Type" content="…charset=…"> in the first 2 KB. */
export function charsetFromMeta(head: Uint8Array): string | null {
  // Byte-for-byte (latin1) view; enough to find an ASCII <meta> tag.
  const text = String.fromCharCode(...head.subarray(0, 2048));
  const m = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Every label the web standard maps to Windows-1252 (latin1 and ascii
 * included). Decoded by hand: some Node.js versions decode it as plain
 * ISO-8859-1, turning “smart quotes”, € and … (bytes 0x80–0x9F) into
 * invisible control characters.
 */
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968',
  'ascii',
  'cp1252',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso-8859-1',
  'iso-ir-100',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'iso_8859-1:1987',
  'l1',
  'latin1',
  'us-ascii',
  'windows-1252',
  'x-cp1252',
]);
/** Bytes 0x80–0x9F in Windows-1252 (the five unassigned ones stay as they are). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const codes = Array.from(bytes.subarray(i, i + CHUNK), (b) =>
      b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b,
    );
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

function decode(bytes: Uint8Array, charset: string | null): string {
  if (charset && WINDOWS_1252_LABELS.has(charset.trim().toLowerCase())) return decodeWindows1252(bytes);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      /* unknown label: fall through to UTF-8 */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Reads at most `maxBytes` of a body, cancelling the rest. Never throws. */
async function readBytes(res: Response, maxBytes: number): Promise<{ all: Uint8Array; truncated: boolean }> {
  if (!res.body) return { all: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        bytes += room;
        truncated = value.byteLength > room;
        if (!truncated) {
          // Exactly at the cap: is there more?
          const next = await reader.read();
          truncated = !next.done;
        }
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } catch {
    /* connection dropped or timed out while reading: keep what arrived */
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { all, truncated };
}

/** Any text body (e.g. robots.txt), size-capped, decoded as UTF-8 unless a charset is given. */
export async function readText(res: Response, maxBytes: number): Promise<string> {
  const { all } = await readBytes(res, maxBytes);
  return decode(all, charsetFromContentType(res.headers.get('Content-Type') ?? ''));
}

export async function readPage(res: Response, maxBytes = MAX_PAGE_BYTES): Promise<PageRead> {
  const contentType = res.headers.get('Content-Type') ?? '';
  if (!isHtmlType(contentType) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return { isHtml: false, html: '', bytes: 0, truncated: false, contentType };
  }

  const { all, truncated } = await readBytes(res, maxBytes);
  const bytes = all.byteLength;

  // No Content-Type at all: only treat it as a page if it looks like HTML.
  const charset = charsetFromContentType(contentType) ?? charsetFromMeta(all);
  const html = decode(all, charset);
  if (!contentType.trim() && !/^\s*(<!doctype html|<html|<head|<body|<meta|<title|<!--)/i.test(html.slice(0, 512))) {
    return { isHtml: false, html: '', bytes, truncated, contentType };
  }
  return { isHtml: true, html, bytes, truncated, contentType };
}
