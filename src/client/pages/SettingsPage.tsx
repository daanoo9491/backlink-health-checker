import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { HealthResponse } from '../../shared/api';
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
