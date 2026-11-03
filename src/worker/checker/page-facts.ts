/**
 * Cheap facts about a page, from its HTML: title, first heading and a sample
 * of its visible text. Pure, no DOM, and deliberately bounded: it scans at
 * most a fixed slice of the page, because the free plan allows ~10 ms of CPU
 * for a whole batch of pages.
 */

import { headSignals, type MetaTag } from '../indexing/signals';

export interface PageFacts {
  title: string | null;
  h1: string | null;
  /** Every <h1> on the page (at most MAX_HEADINGS), in order. Some sites keep the
   *  post's title as the first heading and put a notice in a second one. */
  headings: string[];
  /** Visible text from the start of <body>, whitespace collapsed, at most TEXT_SAMPLE chars. */
  text: string;
  /** Length of the visible text in the scanned slice (capped at TEXT_COUNT_CAP). */
  textLength: number;
  /** <meta name="robots|googlebot"> tags in <head>. */
  robotsMeta: MetaTag[];
  /** <link rel="canonical"> hrefs in <head>, as written. */
  canonicals: string[];
}

/** How much HTML after <body> is turned into text. */
const BODY_SLICE = 48 * 1024;
const TEXT_SAMPLE = 2_000;
const TEXT_COUNT_CAP = 20_000;
const MAX_LABEL = 200;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  raquo: '»',
  laquo: '«',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Text inside an element, tags removed. */
function innerText(html: string): string {
  return squash(decodeEntities(html.replace(/<[^>]*>/g, ' ')));
}

const MAX_HEADINGS = 5;

/** The text of every <tag> element, in order (at most `max`). */
function allElements(html: string, tag: string, max: number): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
  for (let m = open.exec(html); m && out.length < max; m = open.exec(html)) {
    const start = m.index + m[0].length;
    const inner = html.slice(start, start + 4096);
    const end = new RegExp(`</${tag}\\s*>`, 'i').exec(inner);
    if (!end) break;
    const text = innerText(inner.slice(0, end.index));
    if (text) out.push(text.slice(0, MAX_LABEL));
  }
  return out;
}

function firstElement(rest: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i');
  const m = open.exec(rest);
  if (!m) return null;
  const start = m.index + m[0].length;
  const inner = rest.slice(start, start + 4096);
  const end = new RegExp(`</${tag}\\s*>`, 'i').exec(inner);
  if (!end) return null;
  const text = innerText(inner.slice(0, end.index));
  return text ? text.slice(0, MAX_LABEL) : null;
}

/** Removes blocks whose content is never visible text. */
const INVISIBLE = /<(script|style|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

/**
 * Elements a visitor never sees: style="display:none" / "visibility:hidden" or
 * the hidden attribute. Some sites hide hundreds of spam links this way, which
 * would otherwise make a one-line notice look like a long page. Removed up to
 * the first matching closing tag; a nested element of the same kind just
 * leaves some hidden text in (never removes visible text).
 */
const HIDDEN =
  /<(div|span|p|ul|ol|section|aside|nav)\b[^>]*?(?:\sstyle\s*=\s*["'][^"']*?(?:display\s*:\s*none|visibility\s*:\s*hidden)|\shidden(?=[\s>=/]))[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Without a <body> tag, this much of the page is treated as its <head>. */
const HEAD_FALLBACK = 64 * 1024;

export function extractFacts(html: string): PageFacts {
  const bodyAt = html.search(/<body[\s>]/i);
  const head = bodyAt > 0 ? html.slice(0, bodyAt) : html.slice(0, HEAD_FALLBACK);
  // The page title lives in <head>; ignore <title> inside inline SVGs in the body.
  const title = firstElement(head, 'title');
  // Google only honours robots meta tags and canonicals in <head>.
  const { robotsMeta, canonicals } = headSignals(head.replace(/<!--[\s\S]*?-->/g, ' '));

  const slice = html.slice(Math.max(0, bodyAt), Math.max(0, bodyAt) + BODY_SLICE);
  // …and a script cut off by the size cap runs to the end of the slice.
  const visible = slice
    .replace(INVISIBLE, ' ')
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(HIDDEN, ' ');
  const h1 = firstElement(visible, 'h1');
  const headings = allElements(visible, 'h1', MAX_HEADINGS);
  const text = squash(decodeEntities(visible.replace(/<[^>]*>/g, ' ')));
  return {
    title,
    h1,
    headings,
    text: text.slice(0, TEXT_SAMPLE),
    textLength: Math.min(text.length, TEXT_COUNT_CAP),
    robotsMeta,
    canonicals,
  };
}
