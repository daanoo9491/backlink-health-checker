import { useEffect, useId, useState, type FormEvent } from 'react';
import type { DetectionRulesResponse } from '../../shared/api';
import { api, RequestError } from '../api/client';
import { formatDate } from '../lib/format';

/** Settings → Suspended sites: the built-in phrases and the team's own. */
export function SuspensionRulesSection() {
  const inputId = useId();
  const hintId = useId();
  const [data, setData] = useState<DetectionRulesResponse | null>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<DetectionRulesResponse>('/detection-rules')
      .then(setData)
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load the suspension phrases.'));
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const p = phrase.replace(/\s+/g, ' ').trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(
        await api<DetectionRulesResponse>('/detection-rules', { method: 'POST', body: JSON.stringify({ phrase: p }) }),
      );
      setPhrase('');
      setNotice(`Added “${p}”. Links checked from now on use it.`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Couldn’t add that phrase. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, text: string) {
    setError(null);
    setNotice(null);
    try {
      setData(await api<DetectionRulesResponse>(`/detection-rules/${id}`, { method: 'DELETE' }));
      setNotice(`Removed “${text}”.`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Couldn’t remove that phrase. Try again.');
    }
  }

  return (
    <section className="panel" aria-labelledby="suspended-heading">
      <h2 id="suspended-heading" className="section-title">
        Suspended sites
      </h2>
      <p>
        Pages that load but only show a hosting notice, such as <strong>“Account Suspended”</strong> or{' '}
        <strong>“Website Expired”</strong>, are marked <strong>Suspended / Unavailable</strong> instead of Active, even
        when the server answers “200 OK”.
      </p>
      <p className="form-hint">
        A phrase counts when it is the page’s title or main heading (or one part of the title, like “Account Suspended |
        Host”), or appears anywhere on a short page. Long articles that only mention it are not affected. Capital
        letters don’t matter.
      </p>

      {data && (
        <details className="rules-builtin">
          <summary>Built-in phrases ({data.builtIn.length})</summary>
          <ul className="rule-chips">
            {data.builtIn.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}

      <form className="rule-form" onSubmit={add} noValidate>
        <div className="field">
          <label htmlFor={inputId}>Add a phrase</label>
          <input
            id={inputId}
            type="text"
            value={phrase}
            maxLength={data?.limits.maxLength ?? 100}
            placeholder="e.g. Hosting plan expired"
            autoComplete="off"
            aria-describedby={hintId}
            disabled={busy}
            onChange={(e) => {
              setPhrase(e.target.value);
              setError(null);
            }}
          />
          <p id={hintId} className="form-hint">
            Plain words exactly as the page shows them. Applies to links checked from now on.
          </p>
        </div>
        <button type="submit" className="button button-secondary" disabled={busy || !phrase.trim()}>
          {busy ? 'Adding…' : 'Add phrase'}
        </button>
      </form>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}

      {data && data.custom.length > 0 && (
        <ul className="gsc-list" aria-label="Your phrases">
          {data.custom.map((r) => (
            <li key={r.id}>
              <span className="gsc-site">{r.phrase}</span>
              <span className="gsc-meta">
                Added {formatDate(r.createdAt)} ·{' '}
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => remove(r.id, r.phrase)}
                  aria-label={`Remove ${r.phrase}`}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && data.custom.length === 0 && <p className="form-hint">No phrases of your own yet.</p>}
    </section>
  );
}
