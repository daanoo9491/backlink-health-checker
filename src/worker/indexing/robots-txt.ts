/**
 * robots.txt, read the way Google reads it (RFC 9309 plus Google's documented
 * behaviour), for one question: may Googlebot crawl this URL?
 *
 * - Googlebot follows the group(s) naming "googlebot"; only if there are none,
 *   the "*" group(s). Groups for the same agent are merged.
 * - The longest matching rule wins; on a tie, Allow wins.
 * - "*" matches any characters, "$" anchors the end. Paths include the query.
 * - An empty "Disallow:" allows everything; /robots.txt itself is always allowed.
 * - Only the first 500 KiB count (Google's limit).
 * Pure functions, no network.
 */

export const ROBOTS_MAX_BYTES = 500 * 1024;

export interface RobotsRule {
  allow: boolean;
  path: string;
  /** The line as written, for evidence ("Disallow: /private/"). */
  line: string;
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let inRules = false;

  for (const rawLine of text.slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase().replace(/[\s_]/g, '-');
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent' || key === 'useragent') {
      // A user-agent line after rules starts a new group; consecutive ones share a group.
      if (!current || inRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        inRules = false;
      }
      // Only the product token counts: "Googlebot/2.1 (+http://…)" is "googlebot".
      current.agents.push(/^(\*|[a-z_-]+)/i.exec(value)?.[1]!.toLowerCase() ?? '');
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) continue; // rules before any user-agent are ignored
      inRules = true;
      current.rules.push({
        allow: key === 'allow',
        path: value,
        line: `${key === 'allow' ? 'Allow' : 'Disallow'}: ${value}`,
      });
    }
    // Other lines (Sitemap, Crawl-delay, unknown) neither start nor end a group.
  }
  return groups;
}

/** The rules that apply to an agent: its own groups, or else "*". */
export function rulesFor(groups: Group[], agent = 'googlebot'): RobotsRule[] {
  const own = groups.filter((g) => g.agents.includes(agent));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/** Same percent-encoding on both sides: non-ASCII encoded, %xx upper-cased. */
function normalisePath(p: string): string {
  let out: string;
  try {
    out = encodeURI(p);
  } catch {
    out = p;
  }
  // encodeURI also escapes existing "%" signs; undo that, then upper-case escapes.
  return out.replace(/%25([0-9a-f]{2})/gi, '%$1').replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path);
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided it, if any. */
  rule: RobotsRule | null;
}

export function isAllowed(rules: RobotsRule[], pathAndQuery: string): RobotsDecision {
  const path = normalisePath(pathAndQuery || '/');
  if (path === '/robots.txt') return { allowed: true, rule: null };
  let best: RobotsRule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    if (!r.path) continue; // "Disallow:" with nothing = allow everything
    const pattern = normalisePath(r.path);
    if (!matches(pattern, path)) continue;
    const len = pattern.length;
    if (len > bestLen || (len === bestLen && r.allow && best && !best.allow)) {
      best = r;
      bestLen = len;
    }
  }
  return { allowed: best ? best.allow : true, rule: best };
}

/** Convenience: may Googlebot crawl `url` under this robots.txt text? */
export function googlebotMayCrawl(robotsText: string, url: URL): RobotsDecision {
  return isAllowed(rulesFor(parseRobots(robotsText)), url.pathname + url.search);
}
