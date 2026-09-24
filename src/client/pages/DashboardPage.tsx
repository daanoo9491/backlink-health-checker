import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DashboardSummary } from '../../shared/api';
import { api, RequestError } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { FileDrop } from '../components/FileDrop';
import { handOffFile } from '../lib/file-handoff';
import { formatDate, formatNumber } from '../lib/format';

function firstName(email: string) {
  const part = email.split('@')[0]?.split(/[._-]/)[0] ?? '';
  return part ? part.charAt(0).toUpperCase() + part.slice(1) : 'there';
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardSummary>('/dashboard')
      .then(setData)
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load your dashboard.'));
  }, []);

  const stats: { label: string; value: number; tone?: string }[] = data
    ? [
        { label: 'Scans run', value: data.totalScans },
        { label: 'Links checked', value: data.urlsChecked },
        { label: 'Active links', value: data.activeLinks, tone: 'active' },
        { label: 'Dead links', value: data.deadLinks, tone: 'dead' },
        { label: 'Need a look', value: data.issuesFound, tone: 'review' },
      ]
    : [];

  return (
    <div className="stack-lg">
      <p className="greeting">Hello {user ? firstName(user.email) : 'there'}. Ready to check your backlinks?</p>

      <FileDrop
        variant="banner"
        onFile={(f) => {
          handOffFile(f);
          navigate('/scans/new');
        }}
      >
        <p className="drop-title">Upload backlink Excel</p>
        <p className="drop-sub">Drop your .xlsx file here. We’ll find the “Backlinks” column for you.</p>
      </FileDrop>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {data && (
        <section aria-labelledby="totals-heading">
          <h2 id="totals-heading" className="section-title">
            Your totals
          </h2>
          <dl className="stat-strip">
            {stats.map((s) => (
              <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
                <dt>{s.label}</dt>
                <dd>{formatNumber(s.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {data && (
        <section aria-labelledby="recent-heading">
          <div className="section-head">
            <h2 id="recent-heading" className="section-title">
              Recent scans
            </h2>
            {data.recentScans.length > 0 && <Link to="/scans">See all scans</Link>}
          </div>
          {data.recentScans.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No scans yet</p>
              <p>Your first scan will appear here. Upload a backlink sheet to start.</p>
              <Link to="/scans/new" className="button button-secondary">
                Start a new scan
              </Link>
            </div>
          ) : (
            <ul className="recent-list">
              {data.recentScans.map((s) => (
                <li key={s.id}>
                  <span className="recent-name">{s.fileName}</span>
                  <span className="recent-date">{formatDate(s.createdAt)}</span>
                  <span>{formatNumber(s.urlsChecked)} links</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
