/**
 * GET /api/search-console: is Search Console connected, and which of your
 * sites can it see? Used by the Settings page. Never returns the key itself.
 */
import { Hono } from 'hono';
import type { SearchConsoleStatus } from '../../shared/api';
import type { AppContext } from '../env';
import { GscError, readServiceAccount } from '../gsc/auth';
import { DAILY_LIMIT, PACIFIC_DAY, properties } from '../gsc/service';
import { requireAuth } from '../middleware/auth';

export const searchConsoleRoutes = new Hono<AppContext>().get('/', requireAuth(), async (c) => {
  const status: SearchConsoleStatus = {
    configured: false,
    email: null,
    properties: [],
    dailyLimit: DAILY_LIMIT,
    error: null,
  };
  let sa;
  try {
    sa = readServiceAccount(c.env.GSC_SERVICE_ACCOUNT);
  } catch (e) {
    return c.json<SearchConsoleStatus>({ ...status, configured: true, error: (e as GscError).why });
  }
  if (!sa) return c.json(status);
  status.configured = true;
  status.email = sa.clientEmail;
  try {
    const list = await properties(sa, undefined, true); // fresh, so newly added sites show at once
    const used = await c
      .get('db')
      .query<{ property: string; used: number }>(
        `SELECT property, used FROM gsc_usage WHERE day = ${PACIFIC_DAY} AND property = ANY($1::text[])`,
        [list.map((p) => p.siteUrl)],
      );
    const usedBy = new Map(used.map((u) => [u.property, Math.min(u.used, DAILY_LIMIT)]));
    status.properties = list
      .map((p) => ({ siteUrl: p.siteUrl, permissionLevel: p.permissionLevel, usedToday: usedBy.get(p.siteUrl) ?? 0 }))
      .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
    if (list.length === 0) {
      status.error = `Connected, but no sites are shared with ${sa.clientEmail} yet. Add it as a user in Search Console.`;
    }
  } catch (e) {
    status.error = e instanceof GscError ? e.why : 'Couldn’t reach Search Console.';
  }
  return c.json(status);
});
