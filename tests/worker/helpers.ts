import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll } from 'vitest';
import { createApp } from '../../src/worker/app';
import type { Db } from '../../src/worker/db/db';
import type { Env } from '../../src/worker/env';
import { processScanMessage, type MessageOutcome, type QueueLike, type ScanMessage } from '../../src/worker/queue';

export const ORIGIN = 'https://bhc.test';

const baseEnv = {
  APP_ENV: 'test',
  APP_NAME: 'LinkLedger SEO',
  AUTH_EMAIL: 'Marketing@Example.com',
  AUTH_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'x'.repeat(40),
  HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
};

let pglite: PGlite | null = null;
let ready: Promise<PGlite> | null = null;

afterAll(async () => {
  await pglite?.close();
});

/** A real Postgres (PGlite, in-process) with the same migrations as Supabase. One per test file. */
async function start(): Promise<PGlite> {
  const pg = new PGlite();
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await pg.exec(readFileSync(join(dir, file), 'utf8'));
  }
  pglite = pg;
  return pg;
}

/** Counts queries the app makes, so tests can hold each endpoint to a budget. */
let appQueries = 0;
export const queryCounter = {
  reset: () => {
    appQueries = 0;
  },
  get count() {
    return appQueries;
  },
};

function adapter(pg: PGlite, counted = false): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      if (counted) appQueries++;
      return (await pg.query<T>(sql, params)).rows;
    },
    async transaction(fn) {
      await pg.query('BEGIN');
      try {
        const out = await fn(db);
        await pg.query('COMMIT');
        return out;
      } catch (e) {
        await pg.query('ROLLBACK');
        throw e;
      }
    },
    async close() {
      /* shared for the whole test file */
    },
  };
  return db;
}

/** The test database, emptied. */
export async function freshDb(): Promise<Db> {
  ready ??= start();
  const pg = await ready;
  await pg.exec(
    'TRUNCATE users, scans, unique_urls, scan_rows, login_attempts, heartbeat, robots_cache, gsc_usage, helper_tokens CASCADE',
  );
  return adapter(pg);
}

/** Run SQL directly against the test database (for assertions and setup). */
export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const pg = await (ready ??= start());
  return (await pg.query<T>(query, params)).rows;
}

/** An in-memory stand-in for the Cloudflare queue: records every message sent. */
export class FakeQueue implements QueueLike {
  sent: { body: ScanMessage; delaySeconds: number }[] = [];
  async send(body: ScanMessage, options?: { delaySeconds?: number }) {
    this.sent.push({ body, delaySeconds: options?.delaySeconds ?? 0 });
  }
}

export async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
  await freshDb();
  return { ...baseEnv, SCAN_QUEUE: new FakeQueue(), ...overrides } as unknown as Env;
}

export const queueOf = (env: Env) => env.SCAN_QUEUE as unknown as FakeQueue;

/** The database as the queue consumer sees it (queries counted). */
export const consumerDb = () => adapter(pglite!, true);

/**
 * Plays the queue consumer: delivers waiting messages one at a time (ignoring
 * their delays) until the queue is empty or `max` messages were handled.
 */
export async function drain(env: Env, max = 50): Promise<MessageOutcome[]> {
  const q = queueOf(env);
  const out: MessageOutcome[] = [];
  while (out.length < max) {
    const msg = q.sent.shift();
    if (!msg) break;
    out.push(await processScanMessage(consumerDb(), env, q, msg.body));
  }
  return out;
}

const app = createApp({ db: () => adapter(pglite!, true) });

export function call(env: Env, path: string, init: RequestInit = {}) {
  return app.request(`${ORIGIN}${path}`, init, env);
}

export function login(env: Env, email: string, password: string, opts: { origin?: string; ip?: string } = {}) {
  return call(env, '/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: opts.origin ?? ORIGIN,
      'CF-Connecting-IP': opts.ip ?? '203.0.113.7',
    },
    body: JSON.stringify({ email, password }),
  });
}

/** Turns a Set-Cookie header into a Cookie header value. */
export function cookieFrom(res: Response): string {
  const set = res.headers.get('Set-Cookie') ?? '';
  return set.split(';')[0] ?? '';
}

/** Signs in and returns a helper that makes authenticated calls. */
export async function signedIn(env: Env) {
  const res = await login(env, baseEnv.AUTH_EMAIL, baseEnv.AUTH_PASSWORD);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = cookieFrom(res);
  return (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers: Record<string, string> = {
      Cookie: cookie,
      Origin: ORIGIN,
      ...(rest.headers as Record<string, string>),
    };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    return call(env, path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  };
}

export const PASSWORD = baseEnv.AUTH_PASSWORD;
export const EMAIL = baseEnv.AUTH_EMAIL;
