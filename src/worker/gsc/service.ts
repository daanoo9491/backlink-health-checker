/**
 * Search Console for one batch of an index check: which links belong to your
 * verified sites, today's quota, and Google's answer for each.
 *
 * Quota: Google allows 2,000 URL inspections per property per day (and 600
 * a minute). The app stops at DAILY_LIMIT to leave room for people using
 * Search Console's own website, counting per Pacific-time day as Google does.
 * Over the limit, or when Google can't answer, a link keeps the crawler's
 * signals and says Search Console was unavailable.
 */
import type { Db } from '../db/db';
import type { Env } from '../env';
import { BudgetExhausted, type SubrequestBudget } from '../checker/budget';
import type { IndexResult } from '../indexing/evaluate';
import { accessToken, GscError, readServiceAccount, type ServiceAccount } from './auth';
import { inspectUrl, listProperties, type GscProperty } from './client';
import { judgeInspection, propertyFor } from './judge';

export const DAILY_LIMIT = 1_900;
const PROPERTIES_TTL_MS = 10 * 60_000;
const PARALLEL = 4;

/** Kept per Worker instance for 10 minutes, so most batches skip the extra request. */
let propertiesCache: { email: string; at: number; list: GscProperty[] } | null = null;

export function forgetProperties() {
  propertiesCache = null;
}

export async function properties(sa: ServiceAccount, budget?: SubrequestBudget, fresh = false): Promise<GscProperty[]> {
  if (!fresh && propertiesCache?.email === sa.clientEmail && Date.now() - propertiesCache.at < PROPERTIES_TTL_MS) {
    return propertiesCache.list;
  }
  const list = await listProperties(await accessToken(sa, budget), budget);
  propertiesCache = { email: sa.clientEmail, at: Date.now(), list };
  return list;
}

export const PACIFIC_DAY = `(now() AT TIME ZONE 'America/Los_Angeles')::date`;

export type GscOutcome =
  { kind: 'answer'; result: IndexResult } | { kind: 'unavailable'; why: string } | { kind: 'deferred' };

/**
 * Google's answer for each link that belongs to one of your Search Console
 * properties. Links outside every property are left out of the result.
 * At most one database query (the quota reservation).
 */
export async function searchConsoleFor(
  db: Db,
  env: Env,
  links: { key: number; url: string }[],
  budget: SubrequestBudget,
): Promise<Map<number, GscOutcome>> {
  const out = new Map<number, GscOutcome>();
  let sa: ServiceAccount | null;
  try {
    sa = readServiceAccount(env.GSC_SERVICE_ACCOUNT);
  } catch {
    return out; // a broken secret is reported on the Settings page, not on every row
  }
  if (!sa || links.length === 0) return out;

  let props: GscProperty[];
  let token: string;
  try {
    props = await properties(sa, budget);
    token = await accessToken(sa, budget);
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      for (const l of links) out.set(l.key, { kind: 'deferred' });
      return out;
    }
    return out; // can't tell which links are yours: signals only (Settings shows why)
  }

  const mine = links.flatMap((l) => {
    const p = propertyFor(l.url, props);
    return p ? [{ ...l, property: p.siteUrl }] : [];
  });
  if (mine.length === 0) return out;

  // Reserve today's quota for this batch, per property, in one statement.
  const need = new Map<string, number>();
  for (const m of mine) need.set(m.property, (need.get(m.property) ?? 0) + 1);
  const used = await db.query<{ property: string; used: number }>(
    `INSERT INTO gsc_usage (property, day, used)
     SELECT j.p, ${PACIFIC_DAY}, j.n FROM jsonb_to_recordset($1::jsonb) AS j(p text, n int)
     ON CONFLICT (property, day) DO UPDATE SET used = gsc_usage.used + excluded.used
     RETURNING property, used`,
    [JSON.stringify([...need].map(([p, n]) => ({ p, n })))],
  );
  const allowance = new Map<string, number>();
  for (const u of used) {
    const n = need.get(u.property) ?? 0;
    allowance.set(u.property, Math.max(0, n - Math.max(0, u.used - DAILY_LIMIT)));
  }

  const todo: typeof mine = [];
  for (const m of mine) {
    const left = allowance.get(m.property) ?? 0;
    if (left > 0) {
      allowance.set(m.property, left - 1);
      todo.push(m);
    } else {
      out.set(m.key, { kind: 'unavailable', why: `today’s Search Console limit for ${m.property} is used up` });
    }
  }

  const queue = [...todo];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const answer = judgeInspection(await inspectUrl(token, m.url, m.property, budget), m.property);
        out.set(
          m.key,
          answer ? { kind: 'answer', result: answer } : { kind: 'unavailable', why: 'Google gave no verdict' },
        );
      } catch (e) {
        if (e instanceof BudgetExhausted) out.set(m.key, { kind: 'deferred' });
        else
          out.set(m.key, {
            kind: 'unavailable',
            why: e instanceof GscError ? e.why.replace(/\.$/, '') : 'request failed',
          });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  return out;
}
