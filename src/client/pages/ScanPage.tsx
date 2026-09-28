import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ROW_FILTER_GROUPS,
  type CheckBatchResponse,
  type RowFilterGroup,
  type RowFilters,
  type ScanDetail,
  type ScanRowsResponse,
  type ScanRowView,
} from '../../shared/api';
import { STATUS_INFO, type LinkStatus } from '../../shared/status';
import { INVALID_REASON_TEXT, type InvalidReason } from '../../shared/url';
import { api, RequestError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RowFilterBar } from '../components/RowFilterBar';
import { ScanStatusBadge } from '../components/ScanStatusBadge';
import { SheetsTable } from '../components/SheetsTable';
import { StatusBadge } from '../components/StatusBadge';
import { formatBytes, formatDate, formatNumber } from '../lib/format';
import { isSafeHref } from '../lib/safe-link';

const PAGE_SIZE = 50;

export function ScanPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as { justSaved?: boolean; autoCheck?: boolean } | null;
  const justSaved = navState?.justSaved === true;
  const autoCheckRef = useRef(navState?.autoCheck === true);

  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [rows, setRows] = useState<ScanRowsResponse | null>(null);
  const [params, setParams] = useSearchParams();

  // Filters and page live in the address, so refresh/back keep them.
  const page = Math.max(1, Number(params.get('page')) || 1);
  const statusParam = params.get('status') ?? 'all';
  const filters: RowFilters = {
    group: (ROW_FILTER_GROUPS as readonly string[]).includes(statusParam) ? (statusParam as RowFilterGroup) : 'all',
    sheet: params.get('sheet') ?? '',
    http: params.get('http') ?? '',
    q: params.get('q') ?? '',
  };
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    ...(filters.group !== 'all' ? { status: filters.group } : {}),
    ...(filters.sheet ? { sheet: filters.sheet } : {}),
    ...(filters.http ? { http: filters.http } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  }).toString();

  const updateFilters = useCallback(
    (next: Partial<RowFilters>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const map: Record<keyof RowFilters, string> = { group: 'status', sheet: 'sheet', http: 'http', q: 'q' };
          for (const [k, v] of Object.entries(next) as [keyof RowFilters, string][]) {
            if (!v || v === 'all') p.delete(map[k]);
            else p.set(map[k], v);
          }
          p.delete('page'); // new filters start on page 1
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  const setPage = (n: number) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (n <= 1) p.delete('page');
        else p.set('page', String(n));
        return p;
      },
      { replace: true },
    );
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [rowsVersion, setRowsVersion] = useState(0);
  const stopRef = useRef(false);

  // Stop the checking loop when the user leaves the page.
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );

  // Warn before closing the tab while checking (checking pauses until they return).
  useEffect(() => {
    if (!checking) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [checking]);

  const runChecks = useCallback(async () => {
    stopRef.current = false;
    setChecking(true);
    setCheckError(null);
    let failures = 0;
    while (!stopRef.current) {
      try {
        const r = await api<CheckBatchResponse>(`/scans/${id}/check`, { method: 'POST' });
        failures = 0;
        setScan((prev) => (prev ? { ...prev, ...r.scan } : prev));
        setRowsVersion((v) => v + 1);
        if (r.remaining === 0) break;
      } catch (e) {
        if (e instanceof RequestError && e.status > 0 && e.status < 500 && e.status !== 429) {
          setCheckError(e.message);
          break;
        }
        if (++failures >= 5) {
          setCheckError('Checking paused because the connection keeps dropping. Press Continue checking to carry on.');
          break;
        }
        await new Promise((res) => setTimeout(res, 1000 * 2 ** failures));
      }
    }
    setChecking(false);
  }, [id]);

  // Coming straight from "Start scan" or pasted links: start checking by itself, once.
  // (The flag is cleared from the page history so a refresh doesn't restart it.)
  const scanStatus = scan?.status;
  useEffect(() => {
    if (!autoCheckRef.current || (scanStatus !== 'ready' && scanStatus !== 'running')) return;
    autoCheckRef.current = false;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: { justSaved: true } });
    void runChecks();
  }, [scanStatus, runChecks, navigate, location.pathname, location.search]);

  useEffect(() => {
    api<ScanDetail>(`/scans/${id}`)
      .then(setScan)
      .catch((e) => setError(e instanceof RequestError ? e.message : 'Couldn’t load this scan.'));
  }, [id]);

  useEffect(() => {
    let stale = false;
    api<ScanRowsResponse>(`/scans/${id}/rows?${query}`)
      .then((r) => !stale && setRows(r))
      .catch(() => !stale && setRows(null));
    return () => {
      stale = true;
    };
  }, [id, query, rowsVersion]);

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

  const started = scan.checkedCount > 0 || scan.status === 'running' || scan.status === 'completed';
  const stats = started
    ? [
        { label: 'Active', value: scan.activeCount, tone: 'active' },
        { label: 'Dead', value: scan.deadCount + scan.soft404Count, tone: 'dead' },
        { label: 'Redirected', value: scan.redirectedCount },
        { label: 'Need a look', value: scan.blockedCount + scan.errorCount, tone: 'review' },
        { label: 'Waiting', value: scan.uniqueUrls - scan.checkedCount },
      ]
    : [
        { label: 'Rows', value: scan.totalRows },
        { label: 'Unique links', value: scan.uniqueUrls },
        { label: 'Repeated links', value: scan.duplicateRows },
        { label: 'Invalid', value: scan.invalidRows, tone: scan.invalidRows ? 'review' : undefined },
        { label: 'Checked', value: scan.checkedCount },
      ];
  const pct = scan.uniqueUrls ? Math.round((scan.checkedCount / scan.uniqueUrls) * 100) : 0;
  const canCheck = scan.status === 'ready' || scan.status === 'running';

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

      {canCheck && (
        <section className="panel check-panel" aria-labelledby="check-heading">
          <h2 id="check-heading" className="section-title">
            {checking
              ? `Checking links… ${formatNumber(scan.checkedCount)} of ${formatNumber(scan.uniqueUrls)}`
              : scan.status === 'running'
                ? `${formatNumber(scan.checkedCount)} of ${formatNumber(scan.uniqueUrls)} links checked`
                : justSaved
                  ? 'Your scan is saved. Ready to check the links?'
                  : 'Ready to check the links'}
          </h2>
          {(checking || scan.status === 'running') && (
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Links checked"
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="form-hint">
            {checking
              ? 'Keep this page open while we check. If you leave, checking pauses and you can continue later.'
              : `We’ll open each of the ${formatNumber(scan.uniqueUrls)} unique links once. Keep this page open while it runs.`}
          </p>
          {checkError && (
            <p className="notice notice-error" role="alert">
              {checkError}
            </p>
          )}
          {!checking && (
            <div>
              <button type="button" className="button button-primary" onClick={runChecks}>
                {scan.status === 'running' ? 'Continue checking' : 'Start checking'}
              </button>
            </div>
          )}
        </section>
      )}
      {scan.status === 'completed' && (
        <div className="notice notice-info" role="status">
          <p className="notice-title">All {formatNumber(scan.uniqueUrls)} links checked.</p>
          <p>
            Finished {scan.completedAt ? formatDate(scan.completedAt) : ''}. Each result is copied to every row that
            uses the same link.
          </p>
        </div>
      )}
      {scan.status === 'uploading' && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">This upload didn’t finish.</p>
          <p>Delete it and upload the file again.</p>
        </div>
      )}

      <div className="stat-block">
        <dl className="stat-strip">
          {stats.map((s) => (
            <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
              <dt>{s.label}</dt>
              <dd>{formatNumber(s.value)}</dd>
            </div>
          ))}
        </dl>
        {started && (
          <p className="form-hint">
            These count unique links. The filters below count rows, so a link used on two rows counts twice there.
          </p>
        )}
      </div>

      <section aria-labelledby="rows-heading">
        <div className="section-head">
          <h2 id="rows-heading" className="section-title">
            Backlinks
          </h2>
          {rows && rows.total > 0 && (
            <p className="form-hint" aria-live="polite">
              Rows {formatNumber(from)}–{formatNumber(to)} of {formatNumber(rows.total)}
              {rows.total !== rows.facets.groups.all || filters.group !== 'all' ? ' matching your filters' : ''}
            </p>
          )}
        </div>
        <RowFilterBar filters={filters} facets={rows?.facets ?? null} onChange={updateFilters} />
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
                <th scope="col" className="num">
                  HTTP
                </th>
                <th scope="col">Target URL</th>
              </tr>
            </thead>
            <tbody>
              {!rows && (
                <tr>
                  <td colSpan={6} className="form-hint">
                    Loading rows…
                  </td>
                </tr>
              )}
              {rows && rows.rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty empty-inline">
                      <p className="empty-title">No rows match these filters</p>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => updateFilters({ group: 'all', sheet: '', http: '', q: '' })}
                      >
                        Clear filters
                      </button>
                    </div>
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
              onClick={() => setPage(page - 1)}
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
              onClick={() => setPage(page + 1)}
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
  const checked = status && status !== 'PENDING' && status !== 'CHECKING';
  const movedTo = r.finalUrl && r.url && r.finalUrl !== r.url ? r.finalUrl : null;
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
        {movedTo && (
          <span className="moved-to">
            now at{' '}
            {isSafeHref(movedTo) ? (
              <a href={movedTo} target="_blank" rel="noopener noreferrer nofollow">
                {movedTo}
              </a>
            ) : (
              movedTo
            )}
          </span>
        )}
      </td>
      <td>
        {status ? (
          <>
            <StatusBadge status={status} />
            {checked && r.checkReason && <span className="check-reason">{r.checkReason}</span>}
          </>
        ) : (
          <span className="skipped">
            Skipped: {INVALID_REASON_TEXT[r.invalidReason as InvalidReason] ?? 'not a web address'}
          </span>
        )}
      </td>
      <td className="num">{r.httpStatus ?? '—'}</td>
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
