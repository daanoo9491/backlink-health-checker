import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { HealthResponse, SearchConsoleStatus } from '../../shared/api';
import { formatNumber } from '../lib/format';
import { api } from '../api/client';
import { useAuth } from '../auth/auth-context';

export function SettingsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    api<HealthResponse>('/health')
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <div className="stack-lg narrow">
      <section className="panel" aria-labelledby="account-heading">
        <h2 id="account-heading" className="section-title">
          Your account
        </h2>
        <dl className="kv">
          <div>
            <dt>Email</dt>
            <dd>{user?.email}</dd>
          </div>
          <div>
            <dt>Password</dt>
            <dd>Ask your administrator to change it.</dd>
          </div>
        </dl>
        <button
          type="button"
          className="button button-secondary"
          onClick={async () => {
            await signOut();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </button>
      </section>

      <SearchConsoleSection />

      <section className="panel" aria-labelledby="about-heading">
        <h2 id="about-heading" className="section-title">
          About this app
        </h2>
        <dl className="kv">
          <div>
            <dt>Version</dt>
            <dd>{health?.version ?? '—'}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{health?.environment ?? '—'}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

const PERMISSION: Record<string, string> = {
  siteOwner: 'Owner',
  siteFullUser: 'Full user',
  siteRestrictedUser: 'Restricted user',
};

/** Index Checker: is Search Console connected, and which sites can it read? */
function SearchConsoleSection() {
  const [status, setStatus] = useState<SearchConsoleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchStatus = () =>
    api<SearchConsoleStatus>('/search-console')
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  const load = () => {
    setLoading(true);
    void fetchStatus();
  };
  useEffect(() => {
    void fetchStatus();
  }, []);

  return (
    <section className="panel" aria-labelledby="gsc-heading">
      <h2 id="gsc-heading" className="section-title">
        Google Search Console
      </h2>
      <p>
        Connect your own sites so the Index Checker can show Google’s own answer, <strong>Indexed</strong> or{' '}
        <strong>Not indexed</strong>, for their pages. Up to {formatNumber(status?.dailyLimit ?? 1900)} pages per site
        per day.
      </p>
      {loading && !status && <p className="form-hint">Checking the connection…</p>}
      {status && !status.configured && (
        <p className="notice notice-info">
          Not connected yet. Your administrator adds the Google service-account key as the{' '}
          <code>GSC_SERVICE_ACCOUNT</code> secret (README → Search Console setup).
        </p>
      )}
      {status?.email && (
        <div className="copy-row">
          <span>Add this email as a user in each Search Console site:</span>
          <code>{status.email}</code>
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(status.email!);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {status?.error && (
        <p className="notice notice-error" role="alert">
          {status.error}
        </p>
      )}
      {status && status.properties.length > 0 && (
        <ul className="gsc-list" aria-label="Connected sites">
          {status.properties.map((p) => (
            <li key={p.siteUrl}>
              <span className="gsc-site">{p.siteUrl.replace(/^sc-domain:/, '')}</span>
              <span className="gsc-meta">
                {p.siteUrl.startsWith('sc-domain:') ? 'Whole domain' : 'Address prefix'} ·{' '}
                {PERMISSION[p.permissionLevel] ?? p.permissionLevel} · {formatNumber(p.usedToday)} of{' '}
                {formatNumber(status.dailyLimit)} checks used today
              </span>
            </li>
          ))}
        </ul>
      )}
      {status?.configured && (
        <button type="button" className="button button-secondary" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Check again'}
        </button>
      )}
    </section>
  );
}
