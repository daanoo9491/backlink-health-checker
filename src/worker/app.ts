import { Hono } from 'hono';
import type { AppContext } from './env';
import type { ApiError } from '../shared/api';
import { securityHeaders } from './middleware/security-headers';
import { requestId } from './middleware/request-id';
import { healthRoutes } from './routes/health';

/**
 * The API application. Built as a factory so tests can call app.request()
 * without a running Worker.
 */
export function createApp() {
  const app = new Hono<AppContext>().basePath('/api');

  app.use('*', requestId());
  app.use('*', securityHeaders());

  app.route('/health', healthRoutes);

  app.notFound((c) =>
    c.json<ApiError>(
      { error: { code: 'NOT_FOUND', message: 'This API route does not exist.', requestId: c.get('requestId') } },
      404,
    ),
  );

  // Log full details server-side; send users a plain message only.
  app.onError((err, c) => {
    console.error(
      JSON.stringify({ level: 'error', requestId: c.get('requestId'), message: err.message, stack: err.stack }),
    );
    return c.json<ApiError>(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong on our side. Please try again in a moment.',
          requestId: c.get('requestId'),
        },
      },
      500,
    );
  });

  return app;
}
