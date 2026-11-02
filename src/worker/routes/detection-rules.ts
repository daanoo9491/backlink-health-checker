/**
 * Settings → Suspended sites: the built-in phrases (read-only) and the team's
 * own. Phrases are plain text; see checker/suspended.ts for how they match.
 */
import { Hono, type Context } from 'hono';
import type { DetectionRulesResponse } from '../../shared/api';
import {
  BUILT_IN_SUSPENSION_PHRASES,
  CUSTOM_PHRASE_LIMIT,
  CUSTOM_PHRASE_MAX,
  CUSTOM_PHRASE_MIN,
  normalise,
} from '../checker/suspended';
import { iso } from '../db/db';
import { clearRulesCache, listRules } from '../detection/rules';
import type { AppContext } from '../env';
import { apiError } from '../errors';
import { requireAuth } from '../middleware/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trimmed, single spaces, control characters removed. */
export function cleanPhrase(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1000) return null;
  const p = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const n = [...p].length;
  return n >= CUSTOM_PHRASE_MIN && n <= CUSTOM_PHRASE_MAX && /[\p{L}\p{N}]/u.test(p) ? p : null;
}

export const detectionRuleRoutes = new Hono<AppContext>();
detectionRuleRoutes.use('*', requireAuth());

async function response(c: Context<AppContext>) {
  const rules = await listRules(c.get('db'));
  return c.json<DetectionRulesResponse>({
    builtIn: [...BUILT_IN_SUSPENSION_PHRASES],
    custom: rules.map((r) => ({ id: r.id, phrase: r.phrase, createdAt: iso(r.created_at)! })),
    limits: { minLength: CUSTOM_PHRASE_MIN, maxLength: CUSTOM_PHRASE_MAX, maxRules: CUSTOM_PHRASE_LIMIT },
  });
}

detectionRuleRoutes.get('/', (c) => response(c));

detectionRuleRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const phrase = cleanPhrase((body as { phrase?: unknown } | null)?.phrase);
  if (!phrase) {
    return apiError(
      c,
      400,
      'INVALID_PHRASE',
      `Enter a phrase of ${CUSTOM_PHRASE_MIN} to ${CUSTOM_PHRASE_MAX} characters, e.g. “Hosting plan expired”.`,
    );
  }
  const db = c.get('db');
  const existing = await listRules(db);
  const key = normalise(phrase);
  if (
    BUILT_IN_SUSPENSION_PHRASES.some((b) => normalise(b) === key) ||
    existing.some((r) => normalise(r.phrase) === key)
  ) {
    return apiError(c, 409, 'DUPLICATE_PHRASE', 'That phrase is already in the list.');
  }
  if (existing.length >= CUSTOM_PHRASE_LIMIT) {
    return apiError(c, 409, 'TOO_MANY_PHRASES', `You can add up to ${CUSTOM_PHRASE_LIMIT} phrases. Remove one first.`);
  }
  await db.query(
    `INSERT INTO detection_rules (id, kind, phrase, created_by) VALUES ($1, 'suspended', $2, $3)
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), phrase, c.get('user')!.id],
  );
  clearRulesCache();
  return response(c);
});

detectionRuleRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (UUID.test(id)) {
    await c.get('db').query(`DELETE FROM detection_rules WHERE id = $1 AND kind = 'suspended'`, [id]);
    clearRulesCache();
  }
  return response(c);
});
