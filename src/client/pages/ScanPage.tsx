import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { ScanDetail, ScanRowsResponse, ScanRowView } from '../../shared/api';
import { STATUS_INFO, type LinkStatus } from '../../shared/status';
import { INVALID_REASON_TEXT, type InvalidReason } from '../../shared/url';
import { api, RequestError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ScanStatusBadge } from '../components/ScanStatusBadge';
import { SheetsTable } from '../components/SheetsTable';
import { StatusBadge } from '../components/StatusBadge';
import { formatBytes, formatDate, formatNumber } from '../lib/format';
import { isSafeHref } from '../lib/safe-link';

const PAGE_SIZE = 50;

export function ScanPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const justSaved = (useLocation().state as { justSaved?: boolean } | null)?.justSaved === true;

  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [rows, setRows] = useState<ScanRowsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api<ScanDetail>(`/scans/${id}`)
      .then(setScan)
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load this scan.'));
  }, [id]);

  useEffect(() => {
    api<ScanRowsResponse>(`/scans/${id}/rows?page=${page}&pageSize=${PAGE_SIZE}`)
      .then(setRows)
      .catch(() => setRows(null));
  }, [id, page]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api(`/scans/${id}`, { method: 'DELETE' });
      navigate('/scans', { replace: true, state: { deleted: scan?.fileName } });
    } catch (e) {
      setDeleting(false);
      setConfirmDelete(false);
      setError(e instanceof RequestError ? e.message : 'Couldn’t delete this scan. Try again.');
    }
  }

  if (error && !scan) {
    return (
      <div className="empty">
        <p className="empty-title">{error}</p>
        <Link to="/scans" className="button button-secondary">
          Back to scan history
        </Link>
      </div>
    );
  }
  if (!scan)
    return (
      <p className="page-loading" role="status">
        Loading scan…
      </p>
    );

  const stats = [
    { label: 'Rows', value: scan.totalRows },
    { label: 'Unique links', value: scan.uniqueUrls },
    { label: 'Repeated links', value: scan.duplicateRows },
    { label: 'Invalid', value: scan.invalidRows, tone: scan.invalidRows ? 'review' : undefined },
    { label: 'Checked', value: scan.checkedCount },
  ];
  const from = rows && rows.total ? (rows.page - 1) * rows.pageSize + 1 : 0;
  const to = rows ? Math.min(rows.page * rows.pageSize, rows.total) : 0;

  return (
    <div className="stack-lg">
      <section className="scan-head" aria-labelledby="scan-title">
        <div>
          <h2 id="scan-title" className="scan-title">
            {scan.fileName}
          </h2>
          <p className="scan-meta">
            Uploaded {formatDate(scan.createdAt)} · {formatBytes(scan.fileSize)} · {scan.worksheets}{' '}
            {scan.worksheets === 1 ? 'worksheet' : 'worksheets'}
          </p>
        </div>
        <ScanStatusBadge status={scan.status} />
      </section>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {scan.status === 'ready' && (
        <div className="notice notice-info" role={justSaved ? 'status' : undefined}>
          <p className="notice-title">{justSaved ? 'Your scan is saved.' : 'This scan is saved and ready.'}</p>
          <p>
            Link checking arrives in the next update. Your file is stored, so you can close this page and come back to
            it any time from Scan history.
          </p>
        </div>
      )}
      {scan.status === 'uploading' && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">This upload didn’t finish.</p>
          <p>Delete it and upload the file again.</p>
        </div>
      )}

      <dl className="stat-strip">
        {stats.map((s) => (
          <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
            <dt>{s.label}</dt>
            <dd>{formatNumber(s.value)}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="rows-heading">
        <div className="section-head">
          <h2 id="rows-heading" className="section-title">
            Backlinks
          </h2>
          {rows && rows.total > 0 && (
            <p className="form-hint">
              Rows {formatNumber(from)}–{formatNumber(to)} of {formatNumber(rows.total)}
            </p>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Sheet</th>
                <th scope="col" className="num">
                  Row
                </th>
                <th scope="col">Backlink</th>
                <th scope="col">Status</th>
                <th scope="col">Target URL</th>
              </tr>
            </thead>
            <tbody>
              {!rows && (
                <tr>
                  <td colSpan={5} className="form-hint">
                    Loading rows…
                  </td>
                </tr>
              )}
              {rows?.rows.map((r) => (
                <RowView key={`${r.sheet}-${r.row}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        {rows && rows.total > rows.pageSize && (
          <nav className="pager" aria-label="Pages">
            <button
              type="button"
              className="button button-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>
              Page {rows.page} of {Math.ceil(rows.total / rows.pageSize)}
            </span>
            <button
              type="button"
              className="button button-secondary"
              disabled={to >= rows.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </nav>
        )}
      </section>

      <section aria-labelledby="sheets-heading">
        <h2 id="sheets-heading" className="section-title">
          Worksheets
        </h2>
        <SheetsTable sheets={scan.sheets} />
      </section>

      <section className="danger-zone">
        <button type="button" className="button button-danger-outline" onClick={() => setConfirmDelete(true)}>
          Delete this scan
        </button>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this scan?"
        confirmLabel="Delete scan"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        <p>
          <strong>{scan.fileName}</strong> and all its results will be removed. This can’t be undone. Your Excel file on
          your computer isn’t affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function RowView({ r }: { r: ScanRowView }) {
  const status = r.status && r.status in STATUS_INFO ? (r.status as LinkStatus) : null;
  return (
    <tr>
      <td>{r.sheet}</td>
      <td className="num">{r.row}</td>
      <td className="cell-link">
        {isSafeHref(r.url) ? (
          <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
            {r.url}
          </a>
        ) : (
          <span className="cell-value">{r.value}</span>
        )}
        {r.duplicate && <span className="tag">repeat</span>}
      </td>
      <td>
        {status ? (
          <StatusBadge status={status} />
        ) : (
          <span className="skipped">
            Skipped: {INVALID_REASON_TEXT[r.invalidReason as InvalidReason] ?? 'not a web address'}
          </span>
        )}
      </td>
      <td className="cell-link">
        {isSafeHref(r.targetUrl) ? (
          <a href={r.targetUrl} target="_blank" rel="noopener noreferrer nofollow">
            {r.targetUrl}
          </a>
        ) : (
          (r.targetUrl ?? '—')
        )}
      </td>
    </tr>
  );
}
