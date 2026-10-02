import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { IndexCheckFromScanResponse, ScanListResponse, ScanSummary } from '../../shared/api';
import { TOOLS } from '../../shared/brand';
import { INDEX_STATUSES, INDEX_STATUS_INFO } from '../../shared/index-status';
import { api, RequestError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IndexStatusBadge } from '../components/IndexStatusBadge';
import { ScanStatusBadge } from '../components/ScanStatusBadge';
import { formatDate, formatNumber } from '../lib/format';

/** Index Checker home: start a check, run one on a Link Health scan, and see past checks. */
export function IndexCheckerPage() {
  const navigate = useNavigate();
  const deletedName = (useLocation().state as { deleted?: string } | null)?.deleted;
  const sourceId = useId();
  const [checks, setChecks] = useState<ScanSummary[] | null>(null);
  const [linkScans, setLinkScans] = useState<ScanSummary[]>([]);
  const [source, setSource] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(deletedName ? `“${deletedName}” was deleted.` : null);
  const [toDelete, setToDelete] = useState<ScanSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api<ScanListResponse>('/scans?tool=index')
      .then((r) => setChecks(r.scans))
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load your index checks.'));
    api<ScanListResponse>('/scans')
      .then((r) => setLinkScans(r.scans.filter((s) => s.status !== 'uploading')))
      .catch(() => setLinkScans([]));
  }, []);

  async function runOnScan() {
    if (!source) return;
    setStarting(true);
    setError(null);
    try {
      const { id } = await api<IndexCheckFromScanResponse>(`/scans/${source}/index-check`, { method: 'POST' });
      navigate(`/scans/${id}`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : 'Couldn’t start the index check. Try again.');
      setStarting(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api(`/scans/${toDelete.id}`, { method: 'DELETE' });
      setChecks((list) => list?.filter((s) => s.id !== toDelete.id) ?? null);
      setNotice(`“${toDelete.fileName}” was deleted.`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : 'Couldn’t delete that check. Try again.');
    } finally {
      setDeleting(false);
      setToDelete(null);
    }
  }

  return (
    <div className="stack-lg">
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel tool-intro" aria-labelledby="ic-heading">
        <h2 id="ic-heading" className="section-title">
          Can Google index these pages?
        </h2>
        <p>
          For each page we read what any crawler can see: whether it loads, robots.txt, noindex tags and headers, and
          the canonical. The result says whether a page <strong>can</strong> be indexed, with the evidence.
        </p>
        <p className="notice notice-info">
          We never label a page “Not indexed”: only Google Search Console can confirm that, and it arrives for your own
          sites in the next phase. A check that fails shows as “Unknown”, never as a negative.
        </p>
        <div className="check-actions">
          <Link to="/index-checker/new" className="button button-primary">
            New index check
          </Link>
        </div>
      </section>

      {linkScans.length > 0 && (
        <section className="panel" aria-labelledby="from-scan-heading">
          <h2 id="from-scan-heading" className="section-title">
            Check the links from a {TOOLS.linkHealth} scan
          </h2>
          <div className="filter-fields">
            <div className="filter-field filter-search">
              <label htmlFor={sourceId}>Scan</label>
              <select id={sourceId} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Choose a scan…</option>
                {linkScans.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fileName} · {formatDate(s.createdAt)} · {formatNumber(s.uniqueUrls)} links
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button button-secondary"
              disabled={!source || starting}
              onClick={runOnScan}
            >
              {starting ? 'Starting…' : 'Check indexing'}
            </button>
          </div>
          <p className="form-hint">The scan is copied into a new index check; the original stays as it is.</p>
        </section>
      )}

      <section aria-labelledby="checks-heading">
        <h2 id="checks-heading" className="section-title">
          Your index checks
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Date</th>
                <th scope="col" className="num">
                  Pages
                </th>
                <th scope="col" className="num">
                  Indexable
                </th>
                <th scope="col" className="num">
                  Issues
                </th>
                <th scope="col" className="num">
                  Unknown
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {checks === null && !error && (
                <tr>
                  <td colSpan={8} className="form-hint">
                    Loading…
                  </td>
                </tr>
              )}
              {checks?.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty empty-inline">
                      <p className="empty-title">No index checks yet</p>
                      <p>Paste or upload URLs, or check the links from a {TOOLS.linkHealth} scan.</p>
                    </div>
                  </td>
                </tr>
              )}
              {checks?.map((s) => (
                <tr key={s.id}>
                  <th scope="row" className="cell-strong">
                    <Link to={`/scans/${s.id}`}>{s.fileName}</Link>
                  </th>
                  <td>{formatDate(s.createdAt)}</td>
                  <td className="num">{formatNumber(s.uniqueUrls)}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.indexableCount) : '—'}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.indexIssueCount) : '—'}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.indexUnknownCount) : '—'}</td>
                  <td>
                    <ScanStatusBadge status={s.status} />
                  </td>
                  <td className="actions">
                    <Link to={`/scans/${s.id}`} className="button button-secondary button-small">
                      Open
                    </Link>
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => setToDelete(s)}
                      aria-label={`Delete ${s.fileName}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="ic-guide">
        <h2 id="ic-guide" className="section-title">
          What the results mean
        </h2>
        <dl className="status-guide">
          {INDEX_STATUSES.map((s) => (
            <div key={s}>
              <dt>
                <IndexStatusBadge status={s} />
              </dt>
              <dd>{INDEX_STATUS_INFO[s].description}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this index check?"
        confirmLabel="Delete check"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      >
        <p>
          <strong>{toDelete?.fileName}</strong> and its results will be removed. This can’t be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
