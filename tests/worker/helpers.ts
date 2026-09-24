import { createApp } from '../../src/worker/app';
import type { Env } from '../../src/worker/env';

export const ORIGIN = 'https://bhc.test';

export const env: Env = {
  APP_ENV: 'test',
  APP_NAME: 'Backlink Health Checker',
  AUTH_EMAIL: 'Marketing@Example.com',
  AUTH_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'x'.repeat(40),
};

export function call(path: string, init: RequestInit = {}, e: Env = env) {
  return createApp().request(`${ORIGIN}${path}`, init, e);
}

export function login(email: string, password: string, e: Env = env, origin = ORIGIN) {
  return call(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email, password }),
    },
    e,
  );
}

/** Turns a Set-Cookie header into a Cookie header value. */
export function cookieFrom(res: Response): string {
  const set = res.headers.get('Set-Cookie') ?? '';
  return set.split(';')[0] ?? '';
}
