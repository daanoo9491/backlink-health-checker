import { Hono } from 'hono';
import type { DashboardSummary } from '../../shared/api';
import type { AppContext } from '../env';
import { requireAuth } from '../middleware/auth';
import { toSummary, type ScanRecord } from '../db/scans';

export const dashboardRoutes = new Hono<AppContext>().get('/', requireAuth(), async (c) => {
  const userId = c.get('user')!.id;
  const db = c.get('db');
  const [[t], recent] = await Promise.all([
    db.query<{ scans: number; checked: number; active: number; dead: number; issues: number }>(
      `SELECT COUNT(*)::int AS scans,
              COALESCE(SUM(checked_count), 0)::int AS checked,
              COALESCE(SUM(active_count), 0)::int AS active,
              COALESCE(SUM(dead_count + soft_404_count), 0)::int AS dead,
              COALESCE(SUM(blocked_count + error_count), 0)::int AS issues
       FROM scans WHERE user_id = $1 AND status <> 'uploading'`,
      [userId],
    ),
    db.query<ScanRecord>(
      `SELECT * FROM scans WHERE user_id = $1 AND status <> 'uploading' ORDER BY created_at DESC LIMIT 5`,
      [userId],
    ),
  ]);
  const summary: DashboardSummary = {
    totalScans: t?.scans ?? 0,
    urlsChecked: t?.checked ?? 0,
    activeLinks: t?.active ?? 0,
    deadLinks: t?.dead ?? 0,
    issuesFound: t?.issues ?? 0,
    recentScans: recent.map(toSummary),
  };
  return c.json(summary);
});
