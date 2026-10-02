/**
 * robots.txt matching, following RFC 9309 and Google's documented examples
 * (developers.google.com/search/docs/crawling-indexing/robots/robots_txt).
 */
import { describe, expect, it } from 'vitest';
import { googlebotMayCrawl, isAllowed, parseRobots, rulesFor } from '../../src/worker/indexing/robots-txt';

const may = (robots: string, url: string) => googlebotMayCrawl(robots, new URL(url)).allowed;

describe('which group applies to Googlebot', () => {
  it('uses the googlebot group when there is one, else "*"', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private/';
    expect(may(txt, 'https://x.example/post')).toBe(true);
    expect(may(txt, 'https://x.example/private/a')).toBe(false);
    expect(may('User-agent: *\nDisallow: /', 'https://x.example/post')).toBe(false);
  });

  it('merges every group for the same agent, and groups listing several agents', () => {
    const txt = 'User-agent: googlebot\nDisallow: /a\n\nUser-agent: bingbot\nUser-agent: Googlebot\nDisallow: /b';
    expect(may(txt, 'https://x.example/a')).toBe(false);
    expect(may(txt, 'https://x.example/b')).toBe(false);
    expect(may(txt, 'https://x.example/c')).toBe(true);
  });

  it('matches the product token only, case-insensitively', () => {
    expect(may('User-agent: Googlebot/2.1 (+http://www.google.com/bot.html)\nDisallow: /', 'https://x.example/')).toBe(
      false,
    );
    expect(may('USER-AGENT: GOOGLEBOT\nDISALLOW: /x', 'https://x.example/x')).toBe(false);
  });

  it('a group for another Google crawler does not apply to Googlebot', () => {
    const txt = 'User-agent: Googlebot-Image\nDisallow: /\n\nUser-agent: *\nAllow: /';
    expect(may(txt, 'https://x.example/page')).toBe(true);
  });

  it('ignores rules before any user-agent; Sitemap lines don’t end a group', () => {
    const txt = 'Disallow: /\nUser-agent: *\nSitemap: https://x.example/s.xml\nDisallow: /tmp';
    expect(may(txt, 'https://x.example/page')).toBe(true);
    expect(may(txt, 'https://x.example/tmp/1')).toBe(false);
  });

  it('no robots rules at all: everything allowed', () => {
    expect(may('', 'https://x.example/anything')).toBe(true);
    expect(may('# just a comment', 'https://x.example/anything')).toBe(true);
    expect(rulesFor(parseRobots('User-agent: bingbot\nDisallow: /'))).toEqual([]);
  });
});

describe('rule matching', () => {
  const rules = (txt: string) => rulesFor(parseRobots(`User-agent: *\n${txt}`));

  it('the longest matching rule wins; on a tie, Allow wins', () => {
    const r = rules('Disallow: /folder\nAllow: /folder/page');
    expect(isAllowed(r, '/folder/page').allowed).toBe(true);
    expect(isAllowed(r, '/folder/other').allowed).toBe(false);
    const tie = rules('Allow: /page\nDisallow: /page');
    expect(isAllowed(tie, '/page').allowed).toBe(true);
    // Google's example: allow: /$ and disallow: / -> only the home page is allowed.
    const home = rules('Allow: /$\nDisallow: /');
    expect(isAllowed(home, '/').allowed).toBe(true);
    expect(isAllowed(home, '/page.htm').allowed).toBe(false);
  });

  it('supports * and $ like Google', () => {
    const r = rules('Disallow: /*.php$\nDisallow: /fish*.php\nDisallow: /*?');
    expect(isAllowed(r, '/index.php').allowed).toBe(false);
    expect(isAllowed(r, '/index.php5').allowed).toBe(true);
    expect(isAllowed(r, '/fish/salmon.php').allowed).toBe(false);
    expect(isAllowed(r, '/page?id=1').allowed).toBe(false);
    expect(isAllowed(r, '/page').allowed).toBe(true);
  });

  it('matches paths as prefixes and case-sensitively', () => {
    const r = rules('Disallow: /fish');
    expect(isAllowed(r, '/fish.html').allowed).toBe(false);
    expect(isAllowed(r, '/fishheads/yummy.html').allowed).toBe(false);
    expect(isAllowed(r, '/Fish.asp').allowed).toBe(true);
    expect(isAllowed(r, '/catfish').allowed).toBe(true);
  });

  it('an empty Disallow allows everything; /robots.txt is always allowed', () => {
    expect(isAllowed(rules('Disallow:'), '/anything').allowed).toBe(true);
    expect(isAllowed(rules('Disallow: /'), '/robots.txt').allowed).toBe(true);
  });

  it('compares percent-encoding consistently', () => {
    const r = rules('Disallow: /café');
    expect(isAllowed(r, '/caf%C3%A9/menu').allowed).toBe(false);
    expect(isAllowed(rules('Disallow: /a%3cb'), '/a%3Cb').allowed).toBe(false);
  });

  it('includes the query string', () => {
    const r = rules('Disallow: /search?q=');
    expect(may('User-agent: *\nDisallow: /search?q=', 'https://x.example/search?q=seo')).toBe(false);
    expect(isAllowed(r, '/search').allowed).toBe(true);
  });

  it('reports the deciding rule, as written', () => {
    const d = isAllowed(rules('Disallow: /private/ # staff only'), '/private/x');
    expect(d.rule?.line).toBe('Disallow: /private/');
  });

  it('copes with Windows line endings, odd spacing and unknown lines', () => {
    expect(may('User-agent:*\r\nCrawl-delay: 5\r\n  Disallow :  /x  \r\n', 'https://x.example/x/1')).toBe(false);
  });

  it('a regular expression character in a rule is matched literally', () => {
    expect(may('User-agent: *\nDisallow: /a.b(c)', 'https://x.example/a.b(c)')).toBe(false);
    expect(may('User-agent: *\nDisallow: /a.b(c)', 'https://x.example/axb(c)')).toBe(true);
  });
});
