/**
 * Indexing signals a page sends, read the way Google reads them:
 * - <meta name="robots"> and <meta name="googlebot"> in <head>: noindex / none;
 * - the X-Robots-Tag header, including "googlebot: noindex" forms;
 * - the canonical, from <link rel="canonical"> in <head> or the HTTP Link header.
 * Pure functions.
 */

export interface MetaTag {
  name: string;
  content: string;
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Attributes of one tag, names lower-cased. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** <meta name="robots|googlebot" content="…"> and canonical <link>s in a page's <head>. */
export function headSignals(head: string): { robotsMeta: MetaTag[]; canonicals: string[] } {
  const robotsMeta: MetaTag[] = [];
  const canonicals: string[] = [];
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const name = (a.name ?? '').trim().toLowerCase();
    if ((name === 'robots' || name === 'googlebot') && a.content !== undefined) {
      robotsMeta.push({ name, content: a.content });
    }
  }
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical') && a.href !== undefined) canonicals.push(a.href.trim());
  }
  return { robotsMeta, canonicals };
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
const isNoindex = (t: string) => t === 'noindex' || t === 'none';

/** The meta tag that says noindex to Googlebot, if any. */
export function metaNoindex(metas: MetaTag[]): MetaTag | null {
  return metas.find((m) => tokens(m.content).some(isNoindex)) ?? null;
}

/** Directives that take a value after a colon (so "x: y" is not a user-agent prefix). */
const VALUE_DIRECTIVES = new Set(['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview']);

/**
 * Does an X-Robots-Tag header (several headers arrive joined by ", ") tell
 * Googlebot noindex? "otherbot: noindex" doesn't; "googlebot: noindex",
 * plain "noindex" and "none" do.
 */
export function headerNoindex(header: string | null): boolean {
  if (!header) return false;
  let agent: string | null = null; // null = applies to every crawler
  for (const raw of header.split(',')) {
    let part = raw.trim();
    const colon = part.indexOf(':');
    if (colon > 0) {
      const before = part.slice(0, colon).trim().toLowerCase();
      if (!VALUE_DIRECTIVES.has(before)) {
        agent = before; // "googlebot: noindex" starts a section for that crawler
        part = part.slice(colon + 1);
      }
    }
    if ((agent === null || agent === 'googlebot') && tokens(part).some(isNoindex)) return true;
  }
  return false;
}

/** URLs from an HTTP Link header with rel="canonical". */
export function linkHeaderCanonicals(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!m) continue;
    const rel = /;\s*rel\s*=\s*("([^"]*)"|[^;\s]+)/i.exec(m[2]!);
    const values = (rel?.[2] ?? rel?.[1] ?? '').toLowerCase().split(/\s+/);
    if (values.includes('canonical')) out.push(m[1]!.trim());
  }
  return out;
}

/** Same page for canonical purposes: ignores http/https, "www." and a trailing slash. */
export function samePage(a: URL, b: URL): boolean {
  const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
  const path = (p: string) => p.replace(/\/+$/, '') || '/';
  return (
    host(a.hostname) === host(b.hostname) &&
    a.port === b.port &&
    path(a.pathname) === path(b.pathname) &&
    a.search === b.search
  );
}

export type CanonicalVerdict =
  | { kind: 'none' }
  | { kind: 'self'; url: string }
  | { kind: 'elsewhere'; url: string }
  | { kind: 'conflicting'; urls: string[] };

/**
 * Compares the declared canonical(s) with the page's own address. Several
 * different canonicals cancel out (Google ignores them all).
 */
export function judgeCanonical(pageUrl: string, declared: string[]): CanonicalVerdict {
  const base = new URL(pageUrl);
  const resolved: URL[] = [];
  for (const d of declared) {
    try {
      const u = new URL(d, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      if (!resolved.some((r) => r.href === u.href)) resolved.push(u);
    } catch {
      /* not a valid address: Google ignores it too */
    }
  }
  if (resolved.length === 0) return { kind: 'none' };
  if (resolved.length > 1 && !resolved.every((r) => samePage(r, resolved[0]!))) {
    return { kind: 'conflicting', urls: resolved.map((r) => r.href) };
  }
  const c = resolved[0]!;
  return samePage(c, base) ? { kind: 'self', url: c.href } : { kind: 'elsewhere', url: c.href };
}
