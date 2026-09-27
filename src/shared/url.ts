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

/**
 * True for any IP address that isn't a normal public internet address:
 * loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 * carrier-grade NAT, multicast/reserved, and their IPv6 equivalents.
 * Accepts IPv6 with or without [brackets].
 */
export function isInternalIp(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number) as [number, number];
    return (
      o1 === 0 ||
      o1 === 10 ||
      o1 === 127 ||
      (o1 === 100 && o2 >= 64 && o2 <= 127) || // carrier-grade NAT
      (o1 === 169 && o2 === 254) || // link-local / cloud metadata
      (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 168) ||
      (o1 === 192 && o2 === 0) || // 192.0.0.0/24 IETF + 192.0.2.0/24 docs
      (o1 === 198 && (o2 === 18 || o2 === 19)) || // benchmarking
      o1 >= 224 // multicast / reserved / broadcast
    );
  }
  if (!a.includes(':')) return false;
  if (a === '::' || a === '::1') return true;
  // IPv4-mapped / translated forms can hide a private IPv4.
  if (a.startsWith('::ffff:') || a.startsWith('64:ff9b:')) return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    (first === 0x2001 && parseInt(a.split(':')[1] || '0', 16) === 0x0db8) // 2001:db8::/32 documentation
  );
}

export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isIPv4(h) || h.startsWith('[')) return isInternalIp(h);
  return false;
}
