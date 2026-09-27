/**
 * Backlink URL validation and safe normalisation.
 * Shared so the browser (import preview) and the Worker (Phase 3+) apply
 * exactly the same rules. Full SSRF protection with DNS checks is Phase 4;
 * this layer already rejects obviously internal addresses.
 */

export type InvalidReason = 'NOT_A_URL' | 'UNSUPPORTED_PROTOCOL' | 'HAS_CREDENTIALS' | 'INTERNAL_ADDRESS' | 'TOO_LONG';

export const INVALID_REASON_TEXT: Record<InvalidReason, string> = {
  NOT_A_URL: 'Not a web address',
  UNSUPPORTED_PROTOCOL: 'Must start with http:// or https://',
  HAS_CREDENTIALS: 'Contains a username or password',
  INTERNAL_ADDRESS: 'Points to a private or local address',
  TOO_LONG: 'Longer than 2,048 characters',
};

export type UrlCheck =
  | {
      ok: true;
      /** The address as it will be requested. */
      url: string;
      /** Key used to detect duplicates. */
      normalized: string;
      /** True when we added https:// to a value starting with "www.". */
      addedScheme: boolean;
    }
  | { ok: false; reason: InvalidReason };

export const MAX_URL_LENGTH = 2048;

// Whitespace Excel users paste in: normal, non-breaking, zero-width, BOM.
const INVISIBLE = /[\s\u00a0\u200b-\u200d\u2060\ufeff]+/g;

export function cleanCellValue(value: string): string {
  return value
    .replace(INVISIBLE, ' ')
    .trim()
    .replace(/^[<"'“‘]+|[>"'”’]+$/g, '')
    .trim();
}

export function checkUrl(raw: string): UrlCheck {
  let value = cleanCellValue(raw);
  if (!value || /\s/.test(value)) return { ok: false, reason: 'NOT_A_URL' };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: 'TOO_LONG' };

  let addedScheme = false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) {
    // "www.example.com/post" is unambiguous enough to fix; anything else isn't.
    if (!/^www\.[^/]+\.[a-z]{2,}/i.test(value)) return { ok: false, reason: 'NOT_A_URL' };
    value = `https://${value}`;
    addedScheme = true;
  } else if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
  }

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: 'NOT_A_URL' };
  }
  if (u.username || u.password) return { ok: false, reason: 'HAS_CREDENTIALS' };

  const host = u.hostname.replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'NOT_A_URL' };
  if (isInternalHost(host)) return { ok: false, reason: 'INTERNAL_ADDRESS' };
  if (!host.startsWith('[') && !isIPv4(host) && !/\.[a-z0-9-]{2,}$/i.test(host)) {
    return { ok: false, reason: 'NOT_A_URL' }; // e.g. "http://intranet"
  }

  const url = u.href;
  return { ok: true, url, normalized: normalizeUrl(u), addedScheme };
}

/**
 * Only changes that can't alter which page is served:
 * lower-case scheme/host (done by URL), drop default port (done by URL),
 * drop trailing dot on host, drop #fragment (never sent to the server).
 */
function normalizeUrl(u: URL): string {
  const copy = new URL(u.href);
  copy.hash = '';
  copy.hostname = copy.hostname.replace(/\.$/, '');
  return copy.href;
}

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / reserved
    );
  }

  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return (
      v6 === '::' ||
      v6 === '::1' ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') ||
      v6.startsWith('fe8') ||
      v6.startsWith('fe9') ||
      v6.startsWith('fea') ||
      v6.startsWith('feb') ||
      v6.startsWith('::ffff:') // IPv4-mapped: could hide a private IPv4
    );
  }
  return false;
}
