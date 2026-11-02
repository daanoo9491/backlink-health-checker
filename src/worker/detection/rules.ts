/**
 * The team's own suspended-site phrases (Settings → Suspended sites), stored in
 * `detection_rules` and added to the built-in list in checker/suspended.ts.
 *
 * The checker reads them at most once a minute per Worker instance, so a batch
 * normally costs no extra database query; a change made in Settings applies to
 * links checked from then on (within about a minute).
 */
import type { Db } from '../db/db';
import { compileRules, DEFAULT_RULES, type SuspensionRules } from '../checker/suspended';

export interface DetectionRule {
  id: string;
  phrase: string;
  created_at: string | Date;
}

const CACHE_MS = 60_000;
let cache: { at: number; rules: SuspensionRules } | null = null;

/** Forget the cached rules (after a change in Settings, and in tests). */
export function clearRulesCache(): void {
  cache = null;
}

export async function listRules(db: Db): Promise<DetectionRule[]> {
  return db.query<DetectionRule>(
    `SELECT id, phrase, created_at FROM detection_rules WHERE kind = 'suspended' ORDER BY created_at, id`,
  );
}

/** Built-in + custom matchers for the checker. A database problem never stops checking. */
export async function suspensionRules(db: Db, now = Date.now()): Promise<SuspensionRules> {
  if (cache && now - cache.at < CACHE_MS) return cache.rules;
  try {
    const rules = compileRules((await listRules(db)).map((r) => r.phrase));
    cache = { at: now, rules };
    return rules;
  } catch {
    return cache?.rules ?? DEFAULT_RULES;
  }
}
