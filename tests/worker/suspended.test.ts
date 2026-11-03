import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectionRulesResponse, ScanDetail, ScanRowsResponse } from '../../src/shared/api';
import { SubrequestBudget } from '../../src/worker/checker/budget';
import { checkLink, type CheckDeps } from '../../src/worker/checker/check-link';
import { createResolver } from '../../src/worker/checker/dns';
import { extractFacts } from '../../src/worker/checker/page-facts';
import { judgePage } from '../../src/worker/checker/soft-404';
import {
  BUILT_IN_SUSPENSION_PHRASES,
  compileRules,
  judgeSuspended,
  judgeSuspendedRedirect,
} from '../../src/worker/checker/suspended';
import { clearRulesCache } from '../../src/worker/detection/rules';
import { evaluateIndex } from '../../src/worker/indexing/evaluate';
import type { Env } from '../../src/worker/env';
import { fakeInternet } from './fake-net';
import { call, drain, ORIGIN, signedIn, testEnv } from './helpers';

const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const judge = (title: string, body: string, rules = compileRules()) =>
  judgeSuspended(extractFacts(html(title, body)), rules);
const longArticle = (extra: string) =>
  `<h1>Help centre</h1><p>${'Here is a long, genuine article with plenty of useful advice for site owners. '.repeat(60)}${extra}</p>`;

describe('suspension notices are recognised', () => {
  // Shapes of real notices from hosting panels and site builders.
  const NOTICES: [string, string, string][] = [
    [
      'cPanel',
      'Account Suspended',
      '<h1>Account Suspended</h1><p>This Account has been suspended.</p><p>Contact your hosting provider for more information.</p>',
    ],
    ['cPanel (no title)', '', '<div><h2>This Account Has Been Suspended</h2></div>'],
    ['host-branded title', 'Account Suspended | HostGator', '<p>Please contact support.</p>'],
    ['shouted', 'ACCOUNT SUSPENDED', ''],
    ['with interjection', 'Error: Website Suspended!', ''],
    ['heading only', 'Welcome', '<h1>Website is suspended</h1><p>Contact the site administrator.</p>'],
    ['hosting account', 'Notice', '<p>This hosting account has been suspended due to unpaid invoices.</p>'],
    ['WordPress.com', 'Site Not Available', '<p>This site has been archived or suspended.</p>'],
    ['site builder', 'Website Expired', '<p>The owner of this website needs to renew their subscription.</p>'],
    ['expired domain', 'example.com', '<p>This domain has expired. If you are the owner, renew it now.</p>'],
    ['bandwidth', 'Bandwidth Limit Exceeded', '<p>The server is temporarily unable to service your request.</p>'],
    ['closed shop', 'Store unavailable', '<p>Sorry, this store is unavailable.</p>'],
    ['curly apostrophes', 'Notice', '<p>This domain has been suspended. Contact your registrar’s support.</p>'],
  ];
  it.each(NOTICES)('%s', (_name, title, body) => {
    const reason = judge(title, body);
    expect(reason).toMatch(/^The site is suspended or unavailable: /);
  });

  it('gives the matching text as the reason', () => {
    expect(judge('Account Suspended | Host', '')).toBe(
      'The site is suspended or unavailable: its title says “Account Suspended | Host”',
    );
    expect(judge('Hi', '<p>Sorry. This account has been suspended.</p>')).toBe(
      'The site is suspended or unavailable: the page only says “this account has been suspended”',
    );
  });
});

describe('genuine pages are never marked suspended', () => {
  const GENUINE: [string, string, string][] = [
    ['an article about suspensions', 'Account Suspended? Here’s what to do', longArticle('If your account suspended…')],
    [
      'a long page mentioning it',
      'Hosting FAQ',
      longArticle('Why is my account suspended? This account has been suspended when…'),
    ],
    ['a product page', 'Suspended Ceilings | Shop', '<h1>Suspended ceiling tiles</h1><p>From £9.99</p>'],
    ['a news story', 'Twitter account suspended after row', longArticle('')],
    ['a site name containing the words', 'Suspended Animation Records', '<p>New releases every Friday.</p>'],
    ['an ordinary page', 'Contact us', '<h1>Contact</h1><p>Call us today.</p>'],
  ];
  it.each(GENUINE)('%s', (_name, title, body) => {
    expect(judge(title, body)).toBeNull();
    expect(judgePage('https://x.example.com/p', 'https://x.example.com/p', extractFacts(html(title, body)))).toBeNull();
  });
});

describe('redirects to a hosting suspension page', () => {
  it('cPanel’s suspended page and similar addresses', () => {
    for (const to of [
      'https://host.example.com/cgi-sys/suspendedpage.cgi',
      'https://x.example.com/suspended.html',
      'https://x.example.com/account-suspended/',
      'https://parking.example.net/website_suspended.php',
    ]) {
      expect(judgeSuspendedRedirect('https://x.example.com/blog/post', to)).toMatch(/hosting suspension page/);
      expect(judgePage('https://x.example.com/blog/post', to, null)?.status).toBe('SUSPENDED');
    }
  });
  it('not when the page itself is about suspensions, or for ordinary moves', () => {
    expect(judgeSuspendedRedirect('https://x.example.com/suspended', 'https://x.example.com/suspended/')).toBeNull();
    expect(judgeSuspendedRedirect('https://x.example.com/a', 'https://x.example.com/suspended-ceilings/')).toBeNull();
    expect(judgeSuspendedRedirect('https://x.example.com/a', 'https://x.example.com/a')).toBeNull();
  });
});

describe('the team’s own phrases', () => {
  it('are added to the built-in ones', () => {
    const rules = compileRules(['Hosting plan expired', 'Sitio suspendido']);
    expect(judge('Hosting plan expired', '', rules)).not.toBeNull();
    expect(judge('Aviso', '<p>Este sitio web: sitio suspendido.</p>', rules)).not.toBeNull();
    expect(judge('Hosting plan expired', '')).toBeNull(); // not built in
    expect(judge('Account Suspended', '', rules)).not.toBeNull(); // built-ins still apply
  });
  it('are plain text: symbols match themselves, never as patterns', () => {
    const rules = compileRules(['(.*)+', 'Site [closed]', 'a|b']);
    expect(judge('Site [closed]', '', rules)).not.toBeNull();
    expect(judge('Anything at all', '<p>x</p>', rules)).toBeNull();
    expect(judge('a', '<p>b</p>', rules)).toBeNull();
  });
  it('stay fast on hostile pages', () => {
    const rules = compileRules(Array.from({ length: 100 }, (_, i) => `custom phrase number ${i} here`));
    const facts = extractFacts(html('a'.repeat(150), `<p>${'account '.repeat(300)}</p>`));
    const t = performance.now();
    for (let i = 0; i < 50; i++) judgeSuspended(facts, rules);
    expect(performance.now() - t).toBeLessThan(500);
  });
  it('the built-in list has no duplicates', () => {
    const lower = BUILT_IN_SUSPENSION_PHRASES.map((p) => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});

describe('checkLink', () => {
  afterEach(() => vi.unstubAllGlobals());
  const PUBLIC = ['93.184.216.34'];
  const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
    resolver: createResolver(),
    budget: new SubrequestBudget(45),
    blockedHosts: new Set(),
    timeoutMs: 500,
    ...over,
  });
  const SUSPENDED_PAGE = html('Account Suspended', '<h1>Account Suspended</h1><p>This Account has been suspended.</p>');

  it('200 OK with a suspension notice is Suspended / Unavailable, not Active, and not retried', async () => {
    fakeInternet({ 's.example.com': PUBLIC }, { 'https://s.example.com/post': { status: 200, html: SUSPENDED_PAGE } });
    const r = await checkLink('https://s.example.com/post', deps());
    expect(r).toMatchObject({ status: 'SUSPENDED', httpStatus: 200, retryable: false, pageTitle: 'Account Suspended' });
    expect(r.reason).toMatch(/title says “Account Suspended”/);
  });

  it('the same notice behind 403 or 503 is Suspended too; a plain 503 is still a server error', async () => {
    fakeInternet(
      { 's.example.com': PUBLIC },
      {
        'https://s.example.com/a': { status: 503, html: SUSPENDED_PAGE },
        'https://s.example.com/b': { status: 403, html: SUSPENDED_PAGE },
        'https://s.example.com/c': { status: 503, html: html('Service Unavailable', '<p>Back soon</p>') },
        'https://s.example.com/d': { status: 403, html: html('Forbidden', '<p>No</p>') },
      },
    );
    expect(await checkLink('https://s.example.com/a', deps())).toMatchObject({ status: 'SUSPENDED', retryable: false });
    expect((await checkLink('https://s.example.com/a', deps())).reason).toMatch(/\(HTTP 503\)$/);
    expect((await checkLink('https://s.example.com/b', deps())).status).toBe('SUSPENDED');
    expect(await checkLink('https://s.example.com/c', deps())).toMatchObject({
      status: 'SERVER_ERROR',
      retryable: true,
    });
    expect((await checkLink('https://s.example.com/d', deps())).status).toBe('BLOCKED');
  });

  it('a redirect to cPanel’s suspended page is Suspended', async () => {
    fakeInternet(
      { 's.example.com': PUBLIC },
      {
        'https://s.example.com/post': { status: 302, location: '/cgi-sys/suspendedpage.cgi' },
        'https://s.example.com/cgi-sys/suspendedpage.cgi': { status: 200, html: SUSPENDED_PAGE },
      },
    );
    expect((await checkLink('https://s.example.com/post', deps())).status).toBe('SUSPENDED');
  });

  it('uses the team’s phrases when given', async () => {
    fakeInternet(
      { 's.example.com': PUBLIC },
      { 'https://s.example.com/p': { status: 200, html: html('Plan lapsed', '<p>Your hosting plan expired.</p>') } },
    );
    expect((await checkLink('https://s.example.com/p', deps())).status).toBe('ACTIVE');
    const rules = compileRules(['hosting plan expired']);
    expect((await checkLink('https://s.example.com/p', deps({ suspensionRules: rules }))).status).toBe('SUSPENDED');
  });

  it('an index check reports it as Page not reachable', () => {
    const r = evaluateIndex({
      link: { status: 'SUSPENDED', reason: 'The site is suspended or unavailable', retryable: false, finalUrl: null },
      page: null,
      robots: null,
    } as Parameters<typeof evaluateIndex>[0]);
    expect(r.status).toBe('NOT_REACHABLE');
    expect(r.evidence[0]).toMatchObject({ signal: 'page', bad: true });
  });
});

describe('Settings → Suspended sites (API) and a full scan', () => {
  let env: Env;
  let api: Awaited<ReturnType<typeof signedIn>>;
  beforeEach(async () => {
    env = await testEnv();
    api = await signedIn(env);
    clearRulesCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  const rules = async () => (await (await api('/api/detection-rules')).json()) as DetectionRulesResponse;
  const add = (phrase: unknown) => api('/api/detection-rules', { method: 'POST', json: { phrase } });

  it('lists the built-in phrases, and adds and removes the team’s own', async () => {
    const start = await rules();
    expect(start.builtIn).toContain('Account Suspended');
    expect(start.custom).toEqual([]);
    expect(start.limits).toEqual({ minLength: 3, maxLength: 100, maxRules: 100 });

    const res = await add('  Hosting   plan expired ');
    expect(res.status).toBe(200);
    const after = (await res.json()) as DetectionRulesResponse;
    expect(after.custom.map((r) => r.phrase)).toEqual(['Hosting plan expired']);

    const del = await api(`/api/detection-rules/${after.custom[0]!.id}`, { method: 'DELETE' });
    expect(((await del.json()) as DetectionRulesResponse).custom).toEqual([]);
  });

  it('refuses empty, too long, duplicate and built-in phrases with a plain message', async () => {
    for (const bad of ['', 'ab', '!!!', 'x'.repeat(101), 42, null]) {
      const res = await add(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PHRASE');
    }
    expect((await add('Hosting plan expired')).status).toBe(200);
    const dup = await add('HOSTING PLAN EXPIRED');
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { message: string } }).error.message).toBe(
      'That phrase is already in the list.',
    );
    expect((await add('account suspended')).status).toBe(409); // built in already
  });

  it('only for signed-in people, from the app itself', async () => {
    expect((await call(env, '/api/detection-rules')).status).toBe(401);
    const cross = await api('/api/detection-rules', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      json: { phrase: 'Gone away' },
    });
    expect(cross.status).toBe(403);
    expect((await call(env, '/api/detection-rules', { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it('a scan counts suspended sites separately, filters them, and uses a phrase added in Settings', async () => {
    const PUBLIC = ['93.184.216.34'];
    fakeInternet(
      { 'ok.example.com': PUBLIC, 'sus.example.com': PUBLIC, 'own.example.com': PUBLIC },
      {
        'https://ok.example.com/a': { status: 200, html: html('Fine', '<h1>Fine</h1><p>All good.</p>') },
        'https://sus.example.com/b': {
          status: 200,
          html: html('Account Suspended', '<p>This Account has been suspended.</p>'),
        },
        'https://own.example.com/c': { status: 200, html: html('Notice', '<p>Hosting plan expired.</p>') },
      },
    );
    expect((await add('Hosting plan expired')).status).toBe(200);
    const urls = ['https://ok.example.com/a', 'https://sus.example.com/b', 'https://own.example.com/c'];
    const { id } = (await (
      await api('/api/scans', {
        method: 'POST',
        json: {
          fileName: 'b.xlsx',
          fileSize: 1,
          worksheets: 1,
          sheets: [],
          headers: ['Backlinks'],
          totalRows: 3,
          uniqueUrls: 3,
          blankRows: 0,
        },
      })
    ).json()) as { id: string };
    await api(`/api/scans/${id}/urls`, { method: 'POST', json: { offset: 0, urls } });
    await api(`/api/scans/${id}/rows`, {
      method: 'POST',
      json: { rows: urls.map((u, i) => ({ sheet: 'S', row: i + 2, value: u, urlIndex: i, cells: { Backlinks: u } })) },
    });
    await api(`/api/scans/${id}/complete`, { method: 'POST' });
    await api(`/api/scans/${id}/start`, { method: 'POST' });
    await drain(env);

    const scan = (await (await api(`/api/scans/${id}`)).json()) as ScanDetail;
    expect(scan).toMatchObject({ status: 'completed', activeCount: 1, suspendedCount: 2, deadCount: 0 });
    const rows = (await (await api(`/api/scans/${id}/rows?status=suspended`)).json()) as ScanRowsResponse;
    expect(rows.rows.map((r) => r.url)).toEqual(['https://sus.example.com/b', 'https://own.example.com/c']);
    expect(rows.facets.groups.suspended).toBe(2);
    expect(rows.facets.links.byStatus.SUSPENDED).toBe(2);
  });
});

describe('notices inside a full blog layout (dailyblogzz and similar networks)', () => {
  // The real page reported by the team: the post's title is kept, the notice is
  // the page's second <h1>, and ~250 hidden spam links make it look long.
  const REAL = readFileSync(join(__dirname, '..', 'fixtures', 'suspended-dailyblogzz.html'), 'utf8');
  const URL_ = 'https://lanopbusinessandtax.dailyblogzz.com/38365000/title-accountants-for-ai-companies';
  afterEach(() => vi.unstubAllGlobals());

  it('reads every main heading and ignores the hidden links', () => {
    const f = extractFacts(REAL);
    expect(f.title).toMatch(/^Title: Accountants for AI Companies/);
    expect(f.headings).toHaveLength(3);
    expect(f.headings[1]).toBe('Account has been disabled due to a violation of Terms of Service. Contact Moderators');
    expect(f.text).not.toContain('aibacklinks.space');
    expect(f.textLength).toBeLessThan(1000);
  });

  it('the real page is Suspended / Unavailable, not Active', async () => {
    fakeInternet({ 'lanopbusinessandtax.dailyblogzz.com': ['93.184.216.34'] }, { [URL_]: { status: 200, html: REAL } });
    const r = await checkLink(URL_, {
      resolver: createResolver(),
      budget: new SubrequestBudget(45),
      blockedHosts: new Set(),
      timeoutMs: 500,
    });
    expect(r.status).toBe('SUSPENDED');
    expect(r.reason).toBe(
      'The site is suspended or unavailable: its heading says “Account has been disabled due to a violation of Terms of Service. Contact Moderators”',
    );
  });

  const page = (h1s: string[], body = '') =>
    extractFacts(
      `<html><head><title>My post | Blog</title></head><body>${h1s.map((h) => `<h1>${h}</h1>`).join('')}${body}` +
        `<div style="display:none">${'<a href="https://spam.example/x">spam-link-domain.example</a><br>'.repeat(300)}</div></body></html>`,
    );
  const longBody = `<p>${'A genuine article with plenty of useful, original advice for business owners. '.repeat(60)}</p>`;

  it.each([
    [
      'a reason after the phrase',
      'Account has been disabled due to a violation of Terms of Service. Contact Moderators',
    ],
    ['suspended for a reason', 'This blog has been suspended for violating our Terms of Service.'],
    ['blog removed', 'This blog has been removed'],
    ['deactivated', 'Account has been deactivated.'],
    ['two sentences, notice second', 'Sorry! This account has been suspended.'],
  ])('heading: %s', (_n, heading) => {
    expect(judgeSuspended(page(['My post title', heading], longBody))).toMatch(/its heading says/);
  });

  it.each([
    ['a question', 'Account suspended. What now?'],
    ['an article heading with a reason but no full stop', 'Account Suspended for Policy Violation – How to Appeal'],
    ['a how-to', 'How to fix “Account has been disabled” on Instagram'],
    ['a headline', 'Popular blog has been suspended after complaints, says host'],
    ['an ordinary second heading', 'Comments'],
  ])('a long article is not marked suspended: %s', (_n, heading) => {
    expect(judgeSuspended(page(['My post title', heading], longBody))).toBeNull();
  });

  it('hidden blocks are left out of the text, visible text is kept', () => {
    const f = extractFacts(
      '<html><body><p>Before</p><div hidden>secret one</div><span style="visibility: hidden">secret two</span>' +
        '<div style="color:red; display : none">secret three</div><p>After</p></body></html>',
    );
    expect(f.text).toBe('Before After');
  });
});
