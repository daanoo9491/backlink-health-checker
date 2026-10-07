import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  INDEX_GROUP,
  ROW_FILTER_GROUPS,
  ROW_SORTS,
  type IndexCheckFromScanResponse,
  type RowFilterGroup,
  type RowFilters,
  type RowSort,
  type ScanDetail,
  type ScanRowsResponse,
  type ScanRowView,
  type ScanSummary,
} from '../../shared/api';
import { TOOLS } from '../../shared/brand';
import {
  INDEX_SORT_ORDER,
  INDEX_STATUSES,
  INDEX_STATUS_INFO,
  GOOGLE_STATUSES,
  type IndexStatus,
} from '../../shared/index-status';
import { ISSUE_CATEGORIES, REVIEW_STATUSES } from '../../shared/issues';
import { STATUS_INFO, type LinkStatus } from '../../shared/status';
import { INVALID_REASON_TEXT, type InvalidReason } from '../../shared/url';
import { api, RequestError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RenameDialog } from '../components/RenameDialog';
import { ExportPanel } from '../components/ExportPanel';
import { RowFilterBar } from '../components/RowFilterBar';
import { ScanStatusBadge } from '../components/ScanStatusBadge';
import { SheetsTable } from '../components/SheetsTable';
import { IndexStatusBadge } from '../components/IndexStatusBadge';
import { StatusBadge } from '../components/StatusBadge';
import { formatBytes, formatDate, formatNumber } from '../lib/format';
import { isSafeHref } from '../lib/safe-link';

const PAGE_SIZE = 50;
/** While checking runs, how often the page asks for progress (one small query). */
const POLL_MS = 4_000;
/** …and how often it reloads the results table when something changed. */
const ROWS_REFRESH_MS = 12_000;
/** No progress for this long while running = probably stalled (the server restarts it too). */
const STALLED_MS = 3 * 60_000;

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
  const sortParam = params.get('sort') ?? 'row';
  const filters: RowFilters = {
    group: (ROW_FILTER_GROUPS as readonly string[]).includes(statusParam) ? (statusParam as RowFilterGroup) : 'all',
    sheet: params.get('sheet') ?? '',
    http: params.get('http') ?? '',
    q: params.get('q') ?? '',
    sort: (ROW_SORTS as readonly string[]).includes(sortParam) ? (sortParam as RowSort) : 'row',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
  };
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    ...(filters.group !== 'all' ? { status: filters.group } : {}),
    ...(filters.sheet ? { sheet: filters.sheet } : {}),
    ...(filters.http ? { http: filters.http } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.sort !== 'row' ? { sort: filters.sort } : {}),
    ...(filters.dir !== 'asc' ? { dir: filters.dir } : {}),
  }).toString();

  const updateFilters = useCallback(
    (next: Partial<RowFilters>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const map: Record<keyof RowFilters, string> = {
            group: 'status',
            sheet: 'sheet',
            http: 'http',
            q: 'q',
            sort: 'sort',
            dir: 'dir',
          };
          // Defaults stay out of the address.
          const isDefault = (k: keyof RowFilters, v: string) =>
            !v || (k === 'group' && v === 'all') || (k === 'sort' && v === 'row') || (k === 'dir' && v === 'asc');
          for (const [k, v] of Object.entries(next) as [keyof RowFilters, string][]) {
            if (isDefault(k, v)) p.delete(map[k]);
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
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [rowsVersion, setRowsVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const control = useCallback(
    async (action: 'start' | 'pause') => {
      setBusy(true);
      setCheckError(null);
      try {
        const s = await api<ScanSummary>(`/scans/${id}/${action}`, { method: 'POST' });
        setScan((prev) => (prev ? { ...prev, ...s } : prev));
      } catch (e) {
        setCheckError(e instanceof RequestError ? e.message : 'That didn’t work. Check your connection and try again.');
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  async function checkIndexing() {
    setBusy(true);
    setCheckError(null);
    try {
      const { id: newId } = await api<IndexCheckFromScanResponse>(`/scans/${id}/index-check`, { method: 'POST' });
      navigate(`/scans/${newId}`);
    } catch (e) {
      setCheckError(e instanceof RequestError ? e.message : 'Couldn’t start the index check. Try again.');
    } finally {
      setBusy(false);
    }
  }

  // While checking runs in the background, follow its progress. One small
  // request every few seconds; the table reloads only when something changed.
  const scanStatus = scan?.status;
  const active = scanStatus === 'queued' || scanStatus === 'running';
  const lastRows = useRef({ at: 0, checked: -1 });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || document.hidden) return; // no polling from a background tab
      try {
        const s = await api<ScanDetail>(`/scans/${id}`);
        if (stopped) return;
        setScan(s);
        setNow(Date.now());
        const done = s.status !== 'queued' && s.status !== 'running';
        const changed = s.checkedCount !== lastRows.current.checked;
        if (done || (changed && Date.now() - lastRows.current.at > ROWS_REFRESH_MS)) {
          lastRows.current = { at: Date.now(), checked: s.checkedCount };
          setRowsVersion((v) => v + 1);
        }
      } catch {
        /* temporary network problem: try again on the next tick */
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, id]);

  // Index checks: while the browser helper still has links to search on
  // Google, reload the table now and then to show its answers.
  const googlePending = rows?.facets.googlePending ?? 0;
  useEffect(() => {
    if (googlePending === 0 || active) return;
    const timer = setInterval(() => {
      if (!document.hidden) setRowsVersion((v) => v + 1);
    }, 20_000);
    return () => clearInterval(timer);
  }, [googlePending, active]);

  // Coming straight from "Start scan" or pasted links: start checking by itself, once.
  // (The flag is cleared from the page history so a refresh doesn't restart it.)
  useEffect(() => {
    if (!autoCheckRef.current || scanStatus !== 'ready') return;
    autoCheckRef.current = false;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: { justSaved: true } });
    void control('start');
  }, [scanStatus, control, navigate, location.pathname, location.search]);

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
      navigate(scan?.tool === 'index' ? '/index-checker' : '/scans', {
        replace: true,
        state: { deleted: scan?.fileName },
      });
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
  // Unique-link counts per result, from the latest table load (a link waiting for
  // its automatic retry counts as Waiting only). Before that loads: the scan's totals.
  const links = rows?.facets.links;
  const count = (sts: readonly LinkStatus[]) => sts.reduce((n, st) => n + (links?.byStatus[st] ?? 0), 0);
  const isIndex = scan.tool === 'index';
  const ix = rows?.facets.index;
  const ixCount = (s: IndexStatus) => ix?.[s] ?? 0;
  const waiting = links ? count(['PENDING', 'CHECKING']) + links.retrying : scan.uniqueUrls - scan.checkedCount;
  const linkCards: { label: string; value: number; tone?: string; group: RowFilterGroup }[] = [
    { label: 'Active', value: links ? count(['ACTIVE']) : scan.activeCount, tone: 'active', group: 'active' },
    {
      label: 'Dead',
      value: links ? count(['DEAD', 'SOFT_404']) : scan.deadCount + scan.soft404Count,
      tone: 'dead',
      group: 'dead',
    },
    {
      label: 'Redirected',
      value: links ? count(['REDIRECTED']) : scan.redirectedCount,
      tone: 'redirected',
      group: 'redirected',
    },
    {
      label: 'Need a look',
      value: links ? count(REVIEW_STATUSES) : scan.blockedCount + scan.errorCount,
      tone: 'review',
      group: 'review',
    },
    { label: 'Waiting', value: waiting, group: 'waiting' },
  ];
  const indexCards: { label: string; value: number; tone?: string; group: RowFilterGroup }[] = [
    // Indexed / Not indexed come only from Google: shown once Google has answered.
    ...INDEX_STATUSES.filter((s) => !GOOGLE_STATUSES.includes(s) || ixCount(s) > 0).map((s) => ({
      label: INDEX_STATUS_INFO[s].label,
      value: ixCount(s),
      tone: ixCount(s) ? INDEX_STATUS_INFO[s].tone : undefined, // a zero isn't a warning
      group: INDEX_GROUP[s],
    })),
    { label: 'Waiting', value: waiting, group: 'waiting' },
  ];
  const cards = isIndex ? indexCards : linkCards;
  const issues: { key: string; group: RowFilterGroup; label: string; tone: string; advice: string; n: number }[] =
    !links
      ? []
      : isIndex
        ? INDEX_SORT_ORDER.filter((s) => s !== 'INDEXABLE' && s !== 'INDEXED' && ixCount(s) > 0).map((s) => ({
            key: s,
            group: INDEX_GROUP[s],
            label: INDEX_STATUS_INFO[s].label,
            tone: INDEX_STATUS_INFO[s].tone,
            advice: INDEX_STATUS_INFO[s].advice,
            n: ixCount(s),
          }))
        : ISSUE_CATEGORIES.map((c) => ({ ...c, group: c.key as RowFilterGroup, n: count(c.statuses) })).filter(
            (c) => c.n > 0,
          );
  const showRows = (group: RowFilterGroup) => {
    updateFilters({ group });
    document.getElementById('rows-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const sortBy = (sort: RowSort) =>
    updateFilters(filters.sort === sort ? { dir: filters.dir === 'asc' ? 'desc' : 'asc' } : { sort, dir: 'asc' });
  const stats = started
    ? []
    : [
        { label: 'Rows', value: scan.totalRows },
        { label: 'Unique links', value: scan.uniqueUrls },
        { label: 'Repeated links', value: scan.duplicateRows },
        { label: 'Invalid', value: scan.invalidRows, tone: scan.invalidRows ? 'review' : undefined },
        { label: 'Checked', value: scan.checkedCount },
      ];
  const pct = scan.uniqueUrls ? Math.round((scan.checkedCount / scan.uniqueUrls) * 100) : 0;
  const showPanel = ['ready', 'queued', 'running', 'paused'].includes(scan.status);
  const allTried = scan.checkedCount >= scan.uniqueUrls;
  const stalled =
    (scan.status === 'queued' || scan.status === 'running') &&
    !!scan.heartbeatAt &&
    now - Date.parse(scan.heartbeatAt) > STALLED_MS;

  const from = rows && rows.total ? (rows.page - 1) * rows.pageSize + 1 : 0;
  const to = rows ? Math.min(rows.page * rows.pageSize, rows.total) : 0;

  return (
    <div className="stack-lg">
      <section className="scan-head" aria-labelledby="scan-title">
        <div>
          <div className="scan-title-row">
            <h2 id="scan-title" className="scan-title">
              {scan.fileName}
            </h2>
            <button type="button" className="button button-quiet button-small" onClick={() => setRenaming(true)}>
              Rename
            </button>
          </div>
          <p className="scan-meta">
            Uploaded {formatDate(scan.createdAt)} · {formatBytes(scan.fileSize)} · {scan.worksheets}{' '}
            {scan.worksheets === 1 ? 'worksheet' : 'worksheets'}
          </p>
        </div>
        <div className="scan-head-side">
          {isIndex && <span className="tool-tag">{TOOLS.indexChecker}</span>}
          <ScanStatusBadge status={scan.status} />
        </div>
      </section>

      {isIndex && (
        <p className="notice notice-info">
          <strong>Indexed</strong> / <strong>Not indexed</strong> come from Google itself: a Google search by the
          browser helper, or Search Console for your own sites. Until Google has answered, a page shows what our crawler
          saw: whether Google <strong>can</strong> index it.
          {scan.sourceScanId && (
            <>
              {' '}
              Made from <Link to={`/scans/${scan.sourceScanId}`}>a {TOOLS.linkHealth} scan</Link>.
            </>
          )}
        </p>
      )}

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {isIndex && googlePending > 0 && !active && (
        <section className="panel" aria-labelledby="google-heading">
          <h2 id="google-heading" className="section-title" aria-live="polite">
            Google check: {formatNumber(googlePending)} {googlePending === 1 ? 'link is' : 'links are'} waiting for the
            browser helper
          </h2>
          <p>
            The browser helper searches Google for each link from your own Chrome and fills in <strong>Indexed</strong>{' '}
            or <strong>Not indexed</strong> here. Keep Chrome open with the helper started; this page updates by itself.
          </p>
          <Link to="/settings">Set up the browser helper</Link>
        </section>
      )}

      {showPanel && (
        <section className="panel check-panel" aria-labelledby="check-heading">
          <h2 id="check-heading" className="section-title" aria-live="polite">
            {scan.status === 'ready'
              ? justSaved
                ? 'Your scan is saved. Ready to check the links?'
                : 'Ready to check the links'
              : scan.status === 'paused'
                ? `Paused at ${formatNumber(scan.checkedCount)} of ${formatNumber(scan.uniqueUrls)} links`
                : allTried
                  ? 'Retrying the links that failed temporarily…'
                  : `Checking links… ${formatNumber(scan.checkedCount)} of ${formatNumber(scan.uniqueUrls)}`}
          </h2>
          {scan.status !== 'ready' && (
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
            {scan.status === 'paused'
              ? 'Nothing is being checked. Resume to carry on from where it stopped.'
              : `Checking runs on our servers, so you can close this page and come back later. Timeouts and server errors are retried automatically.`}
          </p>
          {stalled && (
            <p className="notice notice-error" role="status">
              Checking seems to have stopped. It restarts by itself within about 20 minutes, or you can restart it now.
            </p>
          )}
          {checkError && (
            <p className="notice notice-error" role="alert">
              {checkError}
            </p>
          )}
          <div className="check-actions">
            {(scan.status === 'ready' || scan.status === 'paused' || stalled) && (
              <button type="button" className="button button-primary" disabled={busy} onClick={() => control('start')}>
                {scan.status === 'ready'
                  ? 'Start checking'
                  : scan.status === 'paused'
                    ? 'Resume checking'
                    : 'Restart now'}
              </button>
            )}
            {(scan.status === 'queued' || scan.status === 'running') && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => control('pause')}
              >
                Pause
              </button>
            )}
          </div>
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
      {!isIndex && scan.status === 'completed' && (
        <section className="panel next-step" aria-labelledby="next-index">
          <h2 id="next-index" className="section-title">
            Next: can Google index these pages?
          </h2>
          <p>
            Run the {TOOLS.indexChecker} on the same links: robots.txt, noindex and canonical for every page. This scan
            stays as it is.
          </p>
          {checkError && (
            <p className="notice notice-error" role="alert">
              {checkError}
            </p>
          )}
          <button type="button" className="button button-secondary" disabled={busy} onClick={checkIndexing}>
            Check indexing for these links
          </button>
        </section>
      )}
      {scan.status === 'uploading' && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">This upload didn’t finish.</p>
          <p>Delete it and upload the file again.</p>
        </div>
      )}

      <div className="stat-block">
        {started ? (
          <ul
            className={`stat-strip stat-cards${isIndex ? ' stat-cards-many' : ''}`}
            aria-label="Results by unique link. Choose one to show those rows."
          >
            {cards.map((c) => {
              const selected = filters.group === c.group;
              return (
                <li key={c.label} className={`stat${c.tone ? ` stat-${c.tone}` : ''}${selected ? ' is-selected' : ''}`}>
                  <button
                    type="button"
                    className="stat-button"
                    aria-pressed={selected}
                    onClick={() => (selected ? updateFilters({ group: 'all' }) : showRows(c.group))}
                  >
                    <span className="stat-label">{c.label}</span>
                    <span className="stat-value">{formatNumber(c.value)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <dl className="stat-strip">
            {stats.map((s) => (
              <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
                <dt>{s.label}</dt>
                <dd>{formatNumber(s.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {started && (
          <p className="form-hint">
            These count unique links; choose one to see its rows. The filters below count rows, so a link used on two
            rows counts twice there.
          </p>
        )}
      </div>

      {issues.length > 0 && (
        <section className="panel issues" aria-labelledby="issues-heading">
          <h2 id="issues-heading" className="section-title">
            Issues to look at
          </h2>
          <ul className="issue-list">
            {issues.map((c) => (
              <li key={c.key} className={`issue issue-${c.tone}`}>
                <div>
                  <p className="issue-title">
                    {c.label}{' '}
                    <span className="issue-count">
                      {formatNumber(c.n)} {c.n === 1 ? 'link' : 'links'}
                    </span>
                  </p>
                  <p className="issue-advice">{c.advice}</p>
                </div>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  onClick={() => showRows(c.group)}
                >
                  Show rows
                </button>
              </li>
            ))}
          </ul>
          {links && links.retrying > 0 && (
            <p className="form-hint">
              {formatNumber(links.retrying)} more {links.retrying === 1 ? 'link is' : 'links are'} waiting for an
              automatic retry.
            </p>
          )}
        </section>
      )}

      {scan.status !== 'uploading' && <ExportPanel scan={scan} filters={filters} matching={rows ? rows.total : null} />}

      <section aria-labelledby="rows-heading">
        <div className="section-head">
          <h2 id="rows-heading" className="section-title">
            {isIndex ? 'Pages' : 'Backlinks'}
          </h2>
          {rows && rows.total > 0 && (
            <p className="form-hint" aria-live="polite">
              Rows {formatNumber(from)}–{formatNumber(to)} of {formatNumber(rows.total)}
              {rows.total !== rows.facets.groups.all || filters.group !== 'all' ? ' matching your filters' : ''}
              {filters.sort === 'status' && (filters.dir === 'asc' ? ' · most urgent first' : ' · most urgent last')}
            </p>
          )}
        </div>
        <RowFilterBar
          filters={filters}
          facets={rows?.facets ?? null}
          onChange={updateFilters}
          tool={isIndex ? 'index' : 'links'}
        />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Sheet</th>
                <SortHeader label="Row" sort="row" filters={filters} onSort={sortBy} className="num" />
                <SortHeader label={isIndex ? 'Page' : 'Backlink'} sort="url" filters={filters} onSort={sortBy} />
                <SortHeader
                  label={isIndex ? 'Index result' : 'Status'}
                  sort="status"
                  filters={filters}
                  onSort={sortBy}
                />
                <SortHeader label="HTTP" sort="http" filters={filters} onSort={sortBy} className="num" />
                <th scope="col">{isIndex ? 'Checked' : 'Target URL'}</th>
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
              {rows?.rows.map((r) =>
                isIndex ? (
                  <IndexRowView key={`${r.sheet}-${r.row}`} r={r} />
                ) : (
                  <RowView key={`${r.sheet}-${r.row}`} r={r} />
                ),
              )}
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

      <RenameDialog
        key={renaming ? 'open' : 'closed'}
        scan={renaming ? scan : null}
        noun={isIndex ? 'index check' : 'scan'}
        onCancel={() => setRenaming(false)}
        onRenamed={(u) => {
          setScan((prev) => (prev ? { ...prev, fileName: u.fileName } : prev));
          setRenaming(false);
        }}
      />

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

/** A column header that sorts the table; pressing it again reverses the order. */
function SortHeader({
  label,
  sort,
  filters,
  onSort,
  className,
}: {
  label: string;
  sort: RowSort;
  filters: RowFilters;
  onSort: (sort: RowSort) => void;
  className?: string;
}) {
  const current = filters.sort === sort;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={current ? (filters.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" className={`sort-button${current ? ' is-sorted' : ''}`} onClick={() => onSort(sort)}>
        {label}
        <span className="sort-arrow" aria-hidden="true">
          {current ? (filters.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
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
        {r.pageTitle && <span className="page-title-text">{r.pageTitle}</span>}
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
            {r.retryAt && <span className="check-reason">Trying again automatically soon</span>}
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

/** A row of an Index Checker scan: the page, its index result with evidence, and when it was checked. */
function IndexRowView({ r }: { r: ScanRowView }) {
  const status = r.status && r.status in STATUS_INFO ? (r.status as LinkStatus) : null;
  const waiting = !r.indexStatus && (status === 'PENDING' || status === 'CHECKING');
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
        {r.pageTitle && <span className="page-title-text">{r.pageTitle}</span>}
      </td>
      <td>
        {!status ? (
          <span className="skipped">
            Skipped: {INVALID_REASON_TEXT[r.invalidReason as InvalidReason] ?? 'not a web address'}
          </span>
        ) : waiting || !r.indexStatus ? (
          <StatusBadge status={status === 'CHECKING' ? 'CHECKING' : 'PENDING'} />
        ) : (
          <>
            <IndexStatusBadge status={r.indexStatus} />
            {r.indexSource === 'search_console' && <span className="source-tag">Search Console</span>}
            {r.indexSource === 'google_search' && <span className="source-tag">Google search</span>}
            {r.indexReason && <span className="check-reason">{r.indexReason}</span>}
            {r.retryAt && <span className="check-reason">Trying again automatically soon</span>}
            {r.indexEvidence && r.indexEvidence.length > 0 && (
              <details className="evidence">
                <summary>Evidence</summary>
                <ul>
                  {r.indexEvidence.map((e, i) => (
                    <li key={i} className={e.bad ? 'is-bad' : undefined}>
                      {e.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </td>
      <td className="num">{r.httpStatus ?? '—'}</td>
      <td className="cell-date">{r.checkedAt ? formatDate(r.checkedAt) : '—'}</td>
    </tr>
  );
}
