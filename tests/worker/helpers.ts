import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { afterAll } from 'vitest';
import { createApp } from '../../src/worker/app';
import type { Env } from '../../src/worker/env';

export const ORIGIN = 'https://bhc.test';

const baseEnv = {
  APP_ENV: 'test',
  APP_NAME: 'Backlink Health Checker',
  AUTH_EMAIL: 'Marketing@Example.com',
  AUTH_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'x'.repeat(40),
};

const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(disposers.map((d) => d()));
});

/** Strips SQL comments and splits a migration file into statements. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

let shared: Promise<D1Database> | null = null;

async function startDb(): Promise<D1Database> {
  // Same local D1 engine as `wrangler dev`, in memory (persist: false).
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  disposers.push(() => proxy.dispose());
  const db = proxy.env.DB;
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await db.batch(statements(readFileSync(join(dir, file), 'utf8')).map((s) => db.prepare(s)));
  }
  return db;
}

/** A migrated, empty D1 database (real D1 engine, run locally). One per test file, wiped per call. */
export async function freshDb(): Promise<D1Database> {
  shared ??= startDb();
  const db = await shared;
  await db.batch(
    ['scan_rows', 'unique_urls', 'scans', 'users', 'login_attempts'].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  return db;
}

export async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return { ...baseEnv, DB: await freshDb(), ...overrides } as Env;
}

export function call(env: Env, path: string, init: RequestInit = {}) {
  return createApp().request(`${ORIGIN}${path}`, init, env);
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
