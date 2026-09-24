import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app';
import type { Env } from '../../src/worker/env';
import type { ApiError, HealthResponse } from '../../src/shared/api';

const env: Env = { APP_ENV: 'test', APP_NAME: 'Backlink Health Checker' };

describe('GET /api/health', () => {
  it('returns ok with environment info', async () => {
    const res = await createApp().request('/api/health', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('test');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('sets security headers and a request id', async () => {
    const res = await createApp().request('/api/health', {}, env);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

describe('unknown API routes', () => {
  it('return a friendly JSON 404 without internals', async () => {
    const res = await createApp().request('/api/does-not-exist', {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.ts/);
  });
});
