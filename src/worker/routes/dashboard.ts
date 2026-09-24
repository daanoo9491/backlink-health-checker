import { Hono } from 'hono';
import type { AppContext } from '../env';
import type { DashboardSummary } from '../../shared/api';
import { requireAuth } from '../middleware/auth';

/** Phase 1: no scans are stored yet. Phase 3 reads these numbers from D1. */
export const dashboardRoutes = new Hono<AppContext>().get('/', requireAuth(), (c) => {
  const summary: DashboardSummary = {
    totalScans: 0,
    urlsChecked: 0,
    activeLinks: 0,
    deadLinks: 0,
    issuesFound: 0,
    recentScans: [],
  };
  return c.json(summary);
});
