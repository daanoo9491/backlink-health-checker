/**
 * Soft-404 detection: pages that answer "200 OK" but are really gone.
 * Pure functions, each verdict with a plain reason.
 *
 * Built to avoid false alarms. A genuine page must never be called gone just
 * because it *mentions* "404" or "not found", so:
 *  - a title or heading counts only when the whole of it (or one whole part
 *    of the title, e.g. "Page not found | Site") is a not-found message;
 *  - a not-found sentence in the text counts only on a short page;
 *  - redirects count only when a specific page lands on a home page or an
 *    error address.
 */
import type { LinkStatus } from '../../shared/status';
import type { PageFacts } from './page-facts';

export interface PageVerdict {
  status: Extract<LinkStatus, 'SOFT_404' | 'BLOCKED'>;
  reason: string;
}

/** A not-found sentence only counts on a page with at most this much text. */
export const SHORT_PAGE_CHARS = 2_500;

const raw = String.raw;
/** Interjections allowed before the message: "Oops! Page not found". */
const FILLER = raw`(?:(?:oops|whoops|sorry|uh[- ]?oh|ouch|hmm+|error)[\s!.,…:-]*)*`;
const NOT_FOUND_LABELS = [
  raw`(?:error\s*)?404(?:\s*error)?`,
  raw`(?:(?:error\s*)?404\s*[-:–—|]?\s*)?(?:the\s+)?(?:(?:web\s*)?page|post|article|content|file|document|product|resource|item|url|blog\s*post)?\s*not\s+found(?:\s*[-:–—|(]?\s*(?:error\s*)?404\)?)?`,
  raw`(?:that|this|the)?\s*page\s+(?:can['’]?t|cannot|could\s*n['’]?t|could\s+not)\s+be\s+found`,
  raw`(?:that|this|the)?\s*page\s+(?:does\s*n['’]?t|does\s+not|no\s+longer)\s+exists?`,
  raw`(?:that|this|the)?\s*page\s+(?:is\s*n['’]?t|is\s+not|is\s+no\s+longer)\s+available`,
  raw`nothing\s+(?:was\s+)?found`,
  raw`page\s+introuvable`,
  raw`seite\s+nicht\s+gefunden`,
  raw`p[aá]gina\s+no\s+encontrada`,
  raw`pagina\s+non\s+trovata`,
  raw`pagina\s+niet\s+gevonden`,
  raw`p[aá]gina\s+n[aã]o\s+encontrada`,
  raw`sayfa\s+bulunamad[ıi]`,
];
const NOT_FOUND_LABEL = new RegExp(`^${FILLER}(?:${NOT_FOUND_LABELS.join('|')})[\\s!.…]*$`, 'i');

/** Title parts are separated by " | ", " - ", " – ", " — ", " : ", " · ", " » ". */
const TITLE_SEPARATOR = /\s+[|\-–—:·•»]\s+|\s*\|\s*/;

export function isNotFoundLabel(label: string | null): boolean {
  if (!label) return false;
  const whole = label.trim();
  if (!whole || whole.length > 120) return false;
  if (NOT_FOUND_LABEL.test(whole)) return true;
  return whole.split(TITLE_SEPARATOR).some((part) => NOT_FOUND_LABEL.test(part.trim()));
}

/**
 * Whole sentences that, on a short page, mean the page is gone. Short phrases
 * like "page not found" or "error 404" are deliberately not here: a genuine
 * help page can mention them, while real error pages almost always say so in
 * their title or heading, which the label rules cover.
 */
const NOT_FOUND_SENTENCES = [
  // "The page you are looking for could not be found / does not exist / is no longer available / has been removed"
  raw`\b(?:page|post|article|content|url)\s+(?:you(?:['’]re|\s+are|\s+were)?\s+(?:looking\s+for|requested|tried\s+to\s+(?:access|reach|open))|you\s+(?:are|were)\s+trying\s+to\s+(?:reach|access|open))\b[^.!?]{0,40}?\b(?:(?:could|can|does|did)\s*(?:n['’]?t|not)\s+(?:be\s+found|exist)|(?:is|was)\s+(?:not|no\s+longer)\s+(?:found|available|here)|no\s+longer\s+exists|has\s+been\s+(?:removed|deleted))`,
  raw`\bthe\s+requested\s+(?:url|page)\b[^.!?]{0,80}?\bwas\s+not\s+found\s+on\s+this\s+server\b`,
  raw`\bthis\s+page\s+(?:is\s*n['’]?t|is\s+not|is\s+no\s+longer)\s+available\b`,
  raw`\bthis\s+page\s+(?:does\s*n['’]?t|does\s+not)\s+exist\b`,
  raw`\b(?:that|this)\s+page\s+can['’]?t\s+be\s+found\b`,
];
const NOT_FOUND_SENTENCE = new RegExp(NOT_FOUND_SENTENCES.join('|'), 'i');

/** Bot-protection pages served with "200 OK" instead of the content. */
const BOT_CHECK_TITLE =
  /^(?:just a moment\.*|attention required!?(?:\s*\|\s*cloudflare)?|checking your browser.*|please wait\.*|one more step|security check|ddos-guard|are you a robot\??|pardon our interruption|verify(?:ing)? you are (?:a )?human\.*|human verification|access denied)$/i;
const BOT_CHECK_TEXT =
  /\b(?:enable javascript and cookies to continue|checking (?:if the site connection is secure|your browser before accessing)|verify you are (?:a )?human by completing)\b/i;

const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 79)}…` : s}”`;

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
/** "/", "/index.html", "/home", or a language home such as "/en/" or "/en-gb/". */
const HOME_PATH =
  /^\/(?:index\.(?:html?|php|aspx?))?$|^\/(?:home|(?:en|fr|de|es|it|nl|pt|ar|ur|pl|tr|ru|ja|zh|ko|sv|da|no|fi|cs|el|he|hi|id|ms|th|vi|uk|ro|hu)(?:[-_][a-z]{2})?)\/?$/i;
const ERROR_PATH =
  /(?:^|\/)(?:404|error-?404|404-?error|not-?found|page-?not-?found|pagenotfound|404\.(?:html?|php|aspx?))(?:\/|$)/i;

/** Verdicts from the addresses alone (no page content needed). */
export function judgeRedirect(originalUrl: string, finalUrl: string): PageVerdict | null {
  if (originalUrl === finalUrl) return null;
  const a = parse(originalUrl);
  const b = parse(finalUrl);
  if (!a || !b) return null;

  if (ERROR_PATH.test(b.pathname) || /[?&](?:error|status|code)=404\b/i.test(b.search)) {
    if (!ERROR_PATH.test(a.pathname)) {
      return { status: 'SOFT_404', reason: `Sends visitors to an error page (${b.pathname}${b.search})` };
    }
  }

  // A specific page that now lands on a home page: the page was removed.
  const from = a.pathname.replace(/\/+$/, '') || '/';
  if (HOME_PATH.test(b.pathname) && !HOME_PATH.test(from) && from !== '/') {
    const sameSite = bareHost(a.hostname) === bareHost(b.hostname);
    return {
      status: 'SOFT_404',
      reason: sameSite
        ? 'Sends visitors to the site’s home page instead (the page was probably removed)'
        : `Sends visitors to the home page of ${bareHost(b.hostname)} instead (the page was probably removed)`,
    };
  }
  return null;
}

/** Verdicts from the page's content. */
export function judgeContent(facts: PageFacts): PageVerdict | null {
  if (facts.title && BOT_CHECK_TITLE.test(facts.title.trim())) {
    return {
      status: 'BLOCKED',
      reason: `The site showed a bot check (${quote(facts.title)}) instead of the page. Open it yourself to confirm`,
    };
  }
  if (facts.textLength <= SHORT_PAGE_CHARS && BOT_CHECK_TEXT.test(facts.text)) {
    return {
      status: 'BLOCKED',
      reason: 'The site showed a bot check instead of the page. Open it yourself to confirm',
    };
  }
  if (isNotFoundLabel(facts.title)) {
    return { status: 'SOFT_404', reason: `The page loads, but its title says ${quote(facts.title!)}` };
  }
  if (facts.h1 && facts.h1.length <= 100 && isNotFoundLabel(facts.h1)) {
    return { status: 'SOFT_404', reason: `The page loads, but its heading says ${quote(facts.h1)}` };
  }
  if (facts.textLength <= SHORT_PAGE_CHARS) {
    const m = NOT_FOUND_SENTENCE.exec(facts.text);
    if (m) return { status: 'SOFT_404', reason: `The page loads, but says ${quote(m[0])}` };
  }
  return null;
}

/** Address rules first (a redirect to the home page shows a perfectly normal page). */
export function judgePage(originalUrl: string, finalUrl: string, facts: PageFacts | null): PageVerdict | null {
  return judgeRedirect(originalUrl, finalUrl) ?? (facts ? judgeContent(facts) : null);
}
