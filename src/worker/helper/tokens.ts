/**
 * Connection codes for the browser helper. A code is 32 random bytes
 * ("llh_…"), shown once; only its SHA-256 hash is stored, so a database leak
 * can't be used to connect a helper. Codes can be revoked any time.
 */
import type { Db } from '../db/db';

export const TOKEN_PREFIX = 'llh_';

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function newToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface HelperTokenRow {
  id: string;
  label: string;
  created_at: string | Date;
  last_used_at: string | Date | null;
}

/** The user a valid, unrevoked code belongs to (and records that it was used). */
export async function userForToken(db: Db, token: string): Promise<{ id: string; email: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
  const [row] = await db.query<{ id: string; email: string }>(
    `UPDATE helper_tokens t
     SET last_used_at = CASE WHEN t.last_used_at IS NULL OR t.last_used_at < now() - interval '5 minutes'
                             THEN now() ELSE t.last_used_at END
     FROM users u
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.id = t.user_id
     RETURNING u.id, u.email`,
    [await hashToken(token)],
  );
  return row ?? null;
}
