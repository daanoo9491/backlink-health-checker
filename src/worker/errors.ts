import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError } from '../shared/api';
import type { AppContext } from './env';

/** Consistent, user-safe error responses. */
export function apiError(c: Context<AppContext>, status: ContentfulStatusCode, code: string, message: string) {
  return c.json<ApiError>({ error: { code, message, requestId: c.get('requestId') } }, status);
}
