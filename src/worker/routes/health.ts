import { Hono } from 'hono';
import type { AppContext } from '../env';
import type { HealthResponse } from '../../shared/api';
import { APP_VERSION } from '../version';

export const healthRoutes = new Hono<AppContext>().get('/', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    app: c.env.APP_NAME,
    environment: c.env.APP_ENV,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
  return c.json(body);
});
