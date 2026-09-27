import { Hono } from 'hono';
import type { DashboardSummary } from '../../shared/api';
import type { AppContext } from '../env';
import { requireAuth } from '../middleware/auth';
import { toSummary, type ScanRecord } from '../db/scans';

export const dashboardRoutes = new Hono<AppContext>().get('/', requireAuth(), async (c) => {
  const userId = c.get('user')!.id;
  const [totals, recent] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS scans,
              COALESCE(SUM(checked_count), 0) AS checked,
              COALESCE(SUM(active_count), 0) AS active,
              COALESCE(SUM(dead_count + soft_404_count), 0) AS dead,
              COALESCE(SUM(blocked_count + error_count), 0) AS issues
       FROM scans WHERE user_id = ?1 AND status != 'uploading'`,
    ).bind(userId),
    c.env.DB.prepare(
      `SELECT * FROM scans WHERE user_id = ?1 AND status != 'uploading' ORDER BY created_at DESC LIMIT 5`,
    ).bind(userId),
  ]);
  const t = totals!.results[0] as { scans: number; checked: number; active: number; dead: number; issues: number };
  const summary: DashboardSummary = {
    totalScans: t.scans,
    urlsChecked: t.checked,
    activeLinks: t.active,
    deadLinks: t.dead,
    issuesFound: t.issues,
    recentScans: (recent!.results as ScanRecord[]).map(toSummary),
  };
  return c.json(summary);
});
