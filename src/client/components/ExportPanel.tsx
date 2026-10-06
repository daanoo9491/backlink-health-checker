import { useEffect, useId, useRef, useState } from 'react';
import type { RowFilters, ScanDetail } from '../../shared/api';
import { RequestError } from '../api/client';
import { buildFile, type ExportFormat } from '../export/build-file';
import { fetchAllRows } from '../export/download';
import { saveFile } from '../export/save-file';
import { describeFilters, hasFilters } from '../export/table';
import { formatNumber } from '../lib/format';

interface Props {
  scan: ScanDetail;
  filters: RowFilters;
  /** Rows matching the current filters, when known. */
  matching: number | null;
}

/** "Download the results" as Excel or CSV: all rows, or only the filtered ones. */
export function ExportPanel({ scan, filters, matching }: Props) {
  const scopeName = useId();
  const filtered = hasFilters(filters);
  const [scope, setScope] = useState<'all' | 'filtered'>('all');
  const [working, setWorking] = useState<ExportFormat | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({ done: 0, total: null });
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);
  const useFilters = filtered && scope === 'filtered';
  const unfinished = scan.status !== 'completed';

  async function download(format: ExportFormat) {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setWorking(format);
    setMessage(null);
    setProgress({ done: 0, total: null });
    try {
      const chosen = useFilters ? filters : null;
      const rows = await fetchAllRows(scan.id, chosen, (done, total) => setProgress({ done, total }), ctrl.signal);
      if (!rows.length) {
        setMessage({ kind: 'info', text: 'No rows match these filters, so there is nothing to download.' });
        return;
      }
      const { name, blob } = buildFile(scan, rows, chosen, format);
      saveFile(name, blob);
      setMessage({ kind: 'info', text: `Downloaded ${formatNumber(rows.length)} rows as “${name}”.` });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setMessage({ kind: 'info', text: 'Download cancelled.' });
      } else {
        setMessage({
          kind: 'error',
          text: e instanceof RequestError ? e.message : 'Couldn’t prepare the file. Try again.',
        });
      }
    } finally {
      setWorking(null);
      abort.current = null;
    }
  }

  return (
    <section className="panel export-panel" aria-labelledby="export-heading">
      <h2 id="export-heading" className="section-title">
        Download the results
      </h2>
      <p>
        Every row of your file with its original columns, followed by the results
        {scan.tool === 'index' ? ' (index status, where the answer came from, and the evidence)' : ''}. The Excel file
        also has a Summary sheet.
      </p>
      {unfinished && (
        <p className="form-hint">Checking isn’t finished: links not checked yet show as “Waiting” in the file.</p>
      )}

      {filtered && (
        <fieldset className="export-scope" disabled={working !== null}>
          <legend className="visually-hidden">Which rows</legend>
          <label>
            <input type="radio" name={scopeName} checked={scope === 'all'} onChange={() => setScope('all')} /> All rows
            ({formatNumber(scan.totalRows)})
          </label>
          <label>
            <input type="radio" name={scopeName} checked={scope === 'filtered'} onChange={() => setScope('filtered')} />{' '}
            Only rows matching your filters{matching !== null ? ` (${formatNumber(matching)})` : ''}:{' '}
            {describeFilters(filters, scan.tool)}
          </label>
        </fieldset>
      )}

      <div className="check-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={working !== null}
          onClick={() => download('xlsx')}
        >
          {working === 'xlsx' ? 'Preparing…' : 'Download Excel (.xlsx)'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={working !== null}
          onClick={() => download('csv')}
        >
          {working === 'csv' ? 'Preparing…' : 'Download CSV'}
        </button>
        {working && (
          <button type="button" className="button button-quiet" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      <p className="form-hint" aria-live="polite">
        {working
          ? `Collecting rows… ${formatNumber(progress.done)}${progress.total !== null ? ` of ${formatNumber(progress.total)}` : ''}`
          : ''}
      </p>
      {message && (
        <p className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}
