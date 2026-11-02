/**
 * Suspended-site detection: pages that load (often with "200 OK") but only say
 * the website or hosting account is suspended, deactivated or expired. Such a
 * backlink is lost even though the server answers.
 *
 * Built-in phrases cover the common hosting panels and site builders; the team
 * can add more in Settings (stored in `detection_rules`). Every phrase is plain
 * text, never a regular expression, so a rule can't slow the checker down.
 *
 * To avoid false alarms (a blog post *about* suspended accounts is a real page)
 * a phrase only counts when:
 *  - it is the page's whole title or main heading, or one whole part of the
 *    title ("Account Suspended | Host"), allowing "Error:" / "!" around it; or
 *  - it appears anywhere in the text of a short page (suspension pages are
 *    a sentence or two; articles are long).
 */
import type { PageFacts } from './page-facts';

/** A not-found or suspension sentence only counts on a page with at most this much text. */
export const SHORT_PAGE_CHARS = 2_500;

export const BUILT_IN_SUSPENSION_PHRASES: readonly string[] = [
  'Account Suspended',
  'This Account Has Been Suspended',
  'Account has been suspended',
  'Hosting Account Suspended',
  'Hosting account has been suspended',
  'Website Suspended',
  'This website has been suspended',
  'Website is suspended',
  'Site Suspended',
  'This site has been suspended',
  'This site has been archived or suspended',
  'Domain Suspended',
  'This domain has been suspended',
  'Account Disabled by Server Administrator',
  'This account has been disabled',
  'Website Expired',
  'This website has expired',
  'This domain has expired',
  'Domain Expired',
  'Hosting has expired',
  'Bandwidth Limit Exceeded',
  'This store is unavailable',
  'This shop is currently unavailable',
  'Site Not Available',
  'Website Unavailable',
  'This website is no longer available',
  'This site is no longer available',
];

/** Limits for team-added phrases (also enforced by the API). */
export const CUSTOM_PHRASE_MIN = 3;
export const CUSTOM_PHRASE_MAX = 100;
export const CUSTOM_PHRASE_LIMIT = 100;

export interface SuspensionRules {
  /** Matches a whole title part or heading. */
  label: RegExp;
  /** Matches anywhere in a short page's text. */
  text: RegExp;
}

/** Lower-case, straight apostrophes, single spaces: how pages and phrases are compared. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A phrase as a pattern: spaces match any whitespace, punctuation matches itself. */
function phrasePattern(phrase: string): string | null {
  const p = normalise(phrase).replace(/[\s!.…:-]+$/, '');
  if (p.length < CUSTOM_PHRASE_MIN) return null;
  return escape(p).replace(/ /g, '\\s+');
}

/** Builds the matchers for the built-in phrases plus the team's own. */
export function compileRules(custom: readonly string[] = []): SuspensionRules {
  const patterns = [...new Set([...BUILT_IN_SUSPENSION_PHRASES, ...custom].map(phrasePattern))].filter(
    (p): p is string => p !== null,
  );
  const any = patterns.join('|');
  return {
    // "Error: Account Suspended!" / "Oops – website suspended." but not "Account Suspended? Here's what to do".
    label: new RegExp(`^(?:(?:error|sorry|oops|notice|warning)\\s*[:!.,–-]?\\s*)?(?:${any})[\\s!.…]*$`),
    text: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${any})(?=$|[^\\p{L}\\p{N}])`, 'u'),
  };
}

/** Built-in phrases only, for when the team's list can't be read. */
export const DEFAULT_RULES = compileRules();

/** Title parts are separated by " | ", " - ", " – ", " — ", " : ", " · ", " » ". */
const TITLE_SEPARATOR = /\s+[|\-–—:·•»]\s+|\s*\|\s*/;

function labelMatches(label: string | null, rules: SuspensionRules): string | null {
  if (!label) return null;
  const whole = normalise(label);
  if (!whole || whole.length > 160) return null;
  if (rules.label.test(whole)) return label.trim();
  return whole.split(TITLE_SEPARATOR).some((part) => rules.label.test(part.trim())) ? label.trim() : null;
}

const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 79)}…` : s}”`;

/** A plain reason when the page is a suspension notice, otherwise null. */
export function judgeSuspended(facts: PageFacts, rules: SuspensionRules = DEFAULT_RULES): string | null {
  const title = labelMatches(facts.title, rules);
  if (title) return `The site is suspended or unavailable: its title says ${quote(title)}`;
  const h1 = facts.h1 && facts.h1.length <= 160 ? labelMatches(facts.h1, rules) : null;
  if (h1) return `The site is suspended or unavailable: its heading says ${quote(h1)}`;
  if (facts.textLength <= SHORT_PAGE_CHARS) {
    const m = rules.text.exec(normalise(facts.text));
    if (m) {
      const found = m[0].replace(/^[^\p{L}\p{N}]+/u, '');
      return `The site is suspended or unavailable: the page only says ${quote(found)}`;
    }
  }
  return null;
}

/** Hosting panels send suspended sites to a fixed address, e.g. cPanel's /cgi-sys/suspendedpage.cgi. */
const SUSPENDED_PATH =
  /(?:^|\/)(?:cgi-sys\/suspendedpage\.cgi|suspended(?:[-_]?page)?(?:\.(?:cgi|html?|php|aspx?))?|(?:account|site|website|domain)[-_]?suspended(?:\.(?:html?|php))?)(?:\/|$)/i;

export function judgeSuspendedRedirect(originalUrl: string, finalUrl: string): string | null {
  if (originalUrl === finalUrl) return null;
  try {
    const from = new URL(originalUrl);
    const to = new URL(finalUrl);
    if (SUSPENDED_PATH.test(to.pathname) && !SUSPENDED_PATH.test(from.pathname)) {
      return `The site is suspended: it sends visitors to a hosting suspension page (${to.pathname})`;
    }
  } catch {
    /* not a valid address: no verdict */
  }
  return null;
}
