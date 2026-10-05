/**
 * Browser helper API.
 *
 * Managed from the app (signed-in session):
 *   GET    /api/helper/tokens        connection codes (never the codes themselves)
 *   POST   /api/helper/tokens        new code, shown once
 *   DELETE /api/helper/tokens/:id    revoke
 * Used by the helper (Authorization: Bearer <code>, no cookies):
 *   GET  /api/helper/status          who it's connected as, links waiting
 *   POST /api/helper/claim           take a few links to search
 *   POST /api/helper/results         report what Google showed
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { HelperClaimResponse, HelperStatusResponse, HelperTokenCreated, HelperTokenList } from '../../shared/api';
import type { AppContext } from '../env';
import { apiError } from '../errors';
import { claimJobs, helperStatus, saveResults, type HelperResult } from '../helper/queue';
import { hashToken, newToken, userForToken, type HelperTokenRow } from '../helper/tokens';
import { iso } from '../db/db';
import { requireAuth } from '../middleware/auth';

const MAX_TOKENS = 10;
const MAX_CLAIM = 10;
const MAX_RESULTS = 20;

export const helperRoutes = new Hono<AppContext>();

// ---------- managed from the app ----------

helperRoutes.get('/tokens', requireAuth(), async (c) => {
  const rows = await c.get('db').query<HelperTokenRow>(
    `SELECT id, label, created_at, last_used_at FROM helper_tokens
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [c.get('user')!.id],
  );
  return c.json<HelperTokenList>({
    tokens: rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: iso(r.created_at)!,
      lastUsedAt: iso(r.last_used_at),
    })),
  });
});

helperRoutes.post('/tokens', requireAuth(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Browser helper';
  const db = c.get('db');
  const userId = c.get('user')!.id;
  const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM helper_tokens WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  if (n >= MAX_TOKENS) {
    return apiError(c, 409, 'TOO_MANY_CODES', `You already have ${MAX_TOKENS} connection codes. Remove one first.`);
  }
  const token = newToken();
  const id = crypto.randomUUID();
  await db.query('INSERT INTO helper_tokens (id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)', [
    id,
    userId,
    await hashToken(token),
    label,
  ]);
  return c.json<HelperTokenCreated>({ id, label, token }, 201);
});

helperRoutes.delete('/tokens/:id', requireAuth(), async (c) => {
  await c
    .get('db')
    .query('UPDATE helper_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [
      /^[0-9a-f-]{36}$/i.test(c.req.param('id')) ? c.req.param('id') : '00000000-0000-0000-0000-000000000000',
      c.get('user')!.id,
    ]);
  return c.json({ ok: true });
});

// ---------- used by the helper ----------

const requireHelper = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = token ? await userForToken(c.get('db'), token) : null;
  if (!user) {
    return apiError(
      c,
      401,
      'HELPER_NOT_CONNECTED',
      'This connection code isn’t valid any more. Create a new one in Settings.',
    );
  }
  c.set('user', user);
  return next();
};

helperRoutes.get('/status', requireHelper(), async (c) => {
  const s = await helperStatus(c.get('db'), c.get('user')!.id);
  return c.json<HelperStatusResponse>({ email: c.get('user')!.email, ...s });
});

helperRoutes.post('/claim', requireHelper(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { max?: unknown };
  const max = Number.isInteger(body.max) ? Math.min(MAX_CLAIM, Math.max(1, body.max as number)) : 5;
  return c.json<HelperClaimResponse>({ jobs: await claimJobs(c.get('db'), c.get('user')!.id, max) });
});

const ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,6})$/i;
const clean = (s: unknown, max: number) =>
  typeof s === 'string'
    ? s
        // eslint-disable-next-line no-control-regex -- removing control characters is the point
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** Builds the evidence line on the server from the helper's plain report. */
export function describe(outcome: HelperResult['outcome'], query: string, results: number, why: string): string {
  const q = `“${query}”`;
  if (outcome === 'FOUND') return `Google search for ${q}: this URL is in the results`;
  if (outcome === 'NOT_FOUND') {
    return results > 0
      ? `Google search for ${q}: ${results} result${results === 1 ? '' : 's'}, but not this URL`
      : `Google search for ${q}: no results`;
  }
  return `Google search couldn’t be read${why ? ` (${why})` : ''}`;
}

helperRoutes.post('/results', requireHelper(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { results?: unknown };
  if (!Array.isArray(body.results) || body.results.length > MAX_RESULTS) {
    return apiError(c, 400, 'INVALID_RESULTS', 'The helper sent results the app couldn’t read.');
  }
  const results: HelperResult[] = [];
  for (const raw of body.results as Record<string, unknown>[]) {
    const m = ID.exec(String(raw?.id ?? ''));
    const outcome = raw?.outcome;
    if (!m || !['FOUND', 'NOT_FOUND', 'ERROR', 'SKIP'].includes(outcome as string)) continue;
    const count = Number.isInteger(raw.resultCount) ? Math.min(Math.max(0, raw.resultCount as number), 1000) : 0;
    results.push({
      scanId: m[1]!.toLowerCase(),
      urlIndex: Number(m[2]),
      outcome: outcome as HelperResult['outcome'],
      detail: describe(outcome as HelperResult['outcome'], clean(raw.query, 300), count, clean(raw.why, 120)),
    });
  }
  const saved = await saveResults(c.get('db'), c.get('user')!.id, results);
  return c.json({ saved });
});
