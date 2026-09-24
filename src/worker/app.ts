import { Hono } from 'hono';
import type { AppContext } from './env';
import { apiError } from './errors';
import { securityHeaders } from './middleware/security-headers';
import { requestId } from './middleware/request-id';
import { csrfProtection } from './middleware/csrf';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';

/**
 * The API application. Built as a factory so tests can call app.request()
 * without a running Worker.
 */
export function createApp() {
  const app = new Hono<AppContext>().basePath('/api');

  app.use('*', requestId());
  app.use('*', securityHeaders());
  app.use('*', csrfProtection());

  app.route('/health', healthRoutes);
  app.route('/auth', authRoutes);
  app.route('/dashboard', dashboardRoutes);

  app.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'This API route does not exist.'));

  // Log full details server-side; send users a plain message only.
  app.onError((err, c) => {
    console.error(
      JSON.stringify({ level: 'error', requestId: c.get('requestId'), message: err.message, stack: err.stack }),
    );
    return apiError(c, 500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again in a moment.');
  });

  return app;
}
