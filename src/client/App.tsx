import { useEffect, useState } from 'react';
import type { HealthResponse } from '../shared/api';

type State = { kind: 'loading' } | { kind: 'ok'; data: HealthResponse } | { kind: 'error' };

/**
 * Phase 0 placeholder. Proves the React app is served by Cloudflare and can
 * reach the Worker API. Replaced by the real app shell in Phase 1.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => setState({ kind: 'ok', data }))
      .catch(() => setState({ kind: 'error' }));
  }, []);

  return (
    <main className="shell">
      <h1>Backlink Health Checker</h1>
      <p className="lead">Upload your backlink sheet and see which links are still alive.</p>

      <section className="status" aria-live="polite">
        {state.kind === 'loading' && <p>Checking the service…</p>}
        {state.kind === 'ok' && (
          <p>
            <span className="badge badge-ok">Service online</span> {state.data.environment} · v{state.data.version}
          </p>
        )}
        {state.kind === 'error' && (
          <p>
            <span className="badge badge-error">Service unreachable</span> The app loaded, but the API did not respond.
          </p>
        )}
      </section>

      <p className="note">Foundation release. Sign-in and scanning arrive in the next phases.</p>
    </main>
  );
}
