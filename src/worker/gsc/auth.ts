/**
 * Google service-account sign-in for the Search Console API, with no
 * libraries: a JWT signed with the key (RS256, Web Crypto) is exchanged for
 * a one-hour access token. Read-only scope.
 *
 * The key lives only in the GSC_SERVICE_ACCOUNT secret (the JSON file Google
 * gives you). Only its client_email is ever shown in the app.
 */
import { BudgetExhausted, type SubrequestBudget } from '../checker/budget';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export class GscError extends Error {
  constructor(
    /** Plain-English reason, safe to show (never contains the key). */
    readonly why: string,
    readonly status?: number,
  ) {
    super(why);
  }
}

/** Reads the secret. Returns null if it isn't set; throws GscError if it's malformed. */
export function readServiceAccount(secret: string | undefined): ServiceAccount | null {
  if (!secret || !secret.trim()) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(secret) as Record<string, unknown>;
  } catch {
    throw new GscError('The GSC_SERVICE_ACCOUNT secret isn’t valid JSON. Paste the whole key file.');
  }
  const clientEmail = typeof j.client_email === 'string' ? j.client_email : '';
  const privateKey = typeof j.private_key === 'string' ? j.private_key : '';
  if (!clientEmail || !privateKey.includes('PRIVATE KEY')) {
    throw new GscError('The GSC_SERVICE_ACCOUNT secret is missing client_email or private_key.');
  }
  const tokenUri = typeof j.token_uri === 'string' && j.token_uri.startsWith('https://') ? j.token_uri : TOKEN_URL;
  // Only Google's own token endpoint is ever called with the signed JWT.
  return {
    clientEmail,
    privateKey,
    tokenUri: new URL(tokenUri).hostname === 'oauth2.googleapis.com' ? tokenUri : TOKEN_URL,
  };
}

const b64url = (bytes: Uint8Array | string) => {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(sa.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new GscError('The private key in GSC_SERVICE_ACCOUNT couldn’t be read. Paste the whole key file again.');
  }
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: sa.clientEmail, scope: GSC_SCOPE, aud: sa.tokenUri, iat: nowSec, exp: nowSec + 3600 }),
  );
  const input = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

/** Kept per Worker instance; tokens last an hour, renewed a minute early. */
let cached: { email: string; token: string; expiresAt: number } | null = null;

export function forgetToken() {
  cached = null;
}

export async function accessToken(sa: ServiceAccount, budget?: SubrequestBudget): Promise<string> {
  if (cached && cached.email === sa.clientEmail && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const assertion = await signJwt(sa);
  if (budget && !budget.take()) throw new BudgetExhausted();
  let res: Response;
  try {
    res = await fetch(sa.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GscError('Couldn’t reach Google to sign in.');
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) {
    throw new GscError(
      res.status === 400 || res.status === 401
        ? 'Google rejected the service-account key (it may have been deleted or disabled).'
        : `Google sign-in failed (HTTP ${res.status}).`,
      res.status,
    );
  }
  cached = {
    email: sa.clientEmail,
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}
