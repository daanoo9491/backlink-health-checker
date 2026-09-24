import type { ApiError } from '../../shared/api';

/** Error with a message that is safe to show to users. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const FALLBACK = 'We couldn’t reach the service. Check your connection and try again.';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new RequestError(FALLBACK, 0, 'NETWORK');
  }
  if (res.ok) return (await res.json()) as T;
  let message = FALLBACK;
  let code = 'UNKNOWN';
  try {
    const body = (await res.json()) as ApiError;
    message = body.error.message;
    code = body.error.code;
  } catch {
    /* non-JSON error: keep fallback */
  }
  throw new RequestError(message, res.status, code);
}
