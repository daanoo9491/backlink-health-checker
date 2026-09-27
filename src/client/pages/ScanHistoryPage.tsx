import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { ScanListResponse, ScanSummary } from '../../shared/api';
import { LINK_STATUSES, STATUS_INFO } from '../../shared/status';
import { api, RequestError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ScanStatusBadge } from '../components/ScanStatusBadge';
import { StatusBadge } from '../components/StatusBadge';
import { formatDate, formatNumber } from '../lib/format';

// Statuses users will actually see in results (CHECKING is an in-progress state).
const GUIDE = LINK_STATUSES.filter((s) => s !== 'CHECKING');

export function ScanHistoryPage() {
  const deletedName = (useLocation().state as { deleted?: string } | null)?.deleted;
  const [scans, setScans] = useState<ScanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ScanSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(deletedName ? `“${deletedName}” was deleted.` : null);

  useEffect(() => {
    api<ScanListResponse>('/scans')
      .then((r) => setScans(r.scans))
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load your scans.'));
  }, []);

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api(`/scans/${toDelete.id}`, { method: 'DELETE' });
      setScans((list) => list?.filter((s) => s.id !== toDelete.id) ?? null);
      setNotice(`“${toDelete.fileName}” was deleted.`);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : 'Couldn’t delete that scan. Try again.');
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

      <section aria-labelledby="history-heading">
        <div className="section-head">
          <h2 id="history-heading" className="section-title">
            Your scans
          </h2>
          <Link to="/scans/new" className="button button-primary">
            New scan
          </Link>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">File name</th>
                <th scope="col">Scan date</th>
                <th scope="col" className="num">
                  Links
                </th>
                <th scope="col" className="num">
                  Active
                </th>
                <th scope="col" className="num">
                  Dead
                </th>
                <th scope="col" className="num">
                  Need a look
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {scans === null && !error && (
                <tr>
                  <td colSpan={8} className="form-hint">
                    Loading…
                  </td>
                </tr>
              )}
              {scans?.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty empty-inline">
                      <p className="empty-title">No scans yet</p>
                      <p>Scans you run are saved here, so you can open them again later.</p>
                      <Link to="/scans/new" className="button button-secondary">
                        Start a new scan
                      </Link>
                    </div>
                  </td>
                </tr>
              )}
              {scans?.map((s) => (
                <tr key={s.id}>
                  <th scope="row" className="cell-strong">
                    <Link to={`/scans/${s.id}`}>{s.fileName}</Link>
                  </th>
                  <td>{formatDate(s.createdAt)}</td>
                  <td className="num">{formatNumber(s.uniqueUrls)}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.activeCount) : '—'}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.deadCount + s.soft404Count) : '—'}</td>
                  <td className="num">{s.checkedCount ? formatNumber(s.blockedCount + s.errorCount) : '—'}</td>
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

      <section aria-labelledby="guide-heading">
        <h2 id="guide-heading" className="section-title">
          What the results mean
        </h2>
        <dl className="status-guide">
          {GUIDE.map((s) => (
            <div key={s}>
              <dt>
                <StatusBadge status={s} />
              </dt>
              <dd>{STATUS_INFO[s].description}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this scan?"
        confirmLabel="Delete scan"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      >
        <p>
          <strong>{toDelete?.fileName}</strong> and all its results will be removed. This can’t be undone. Your Excel
          file on your computer isn’t affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}
