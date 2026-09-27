import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { SCAN_LIMITS } from '../../shared/api';
import { INVALID_REASON_TEXT } from '../../shared/url';
import { RequestError } from '../api/client';
import { FileDrop } from '../components/FileDrop';
import { Icon } from '../components/Icon';
import { SheetsTable } from '../components/SheetsTable';
import { OPTIONAL_COLUMN_LABELS, type ImportResult } from '../import/backlink-import';
import { IMPORT_ERROR_TEXT } from '../import/errors';
import { readBacklinkFile, ReadFileError } from '../import/read-file';
import { saveScan, tooBigForOneScan, type SaveProgress } from '../import/save-scan';
import { clearHandedOffFile, peekHandedOffFile } from '../lib/file-handoff';
import { formatBytes, formatNumber } from '../lib/format';
import { checkUploadFile } from '../lib/upload-rules';

type State =
  | { kind: 'idle' }
  | { kind: 'reading'; file: File }
  | { kind: 'preview'; result: ImportResult; saving?: SaveProgress; saveError?: string; scanId?: string }
  | { kind: 'error'; title: string; help: string };

const MAX_INVALID_SHOWN = 200;

function stateForNewFile(file: File): State {
  const problem = checkUploadFile(file);
  return problem ? { kind: 'error', title: problem, help: '' } : { kind: 'reading', file };
}

export function NewScanPage() {
  const navigate = useNavigate();
  // A file dropped on the Dashboard starts reading straight away.
  const [state, setState] = useState<State>(() => {
    const f = peekHandedOffFile();
    return f ? stateForNewFile(f) : { kind: 'idle' };
  });

  // Whenever we enter the "reading" state, read that file in the background.
  const readingFile = state.kind === 'reading' ? state.file : null;
  useEffect(() => {
    if (!readingFile) return;
    clearHandedOffFile();
    let cancelled = false; // ignore results for a file the user moved away from
    readBacklinkFile(readingFile)
      .then((result) => {
        if (!cancelled) setState({ kind: 'preview', result });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const code = e instanceof ReadFileError ? e.code : 'UNKNOWN';
        setState({ kind: 'error', ...IMPORT_ERROR_TEXT[code] });
      });
    return () => {
      cancelled = true;
    };
  }, [readingFile]);

  const choose = (file: File) => setState(stateForNewFile(file));
  const reset = () => setState({ kind: 'idle' });

  async function start() {
    if (state.kind !== 'preview' || state.saving) return;
    const { result, scanId: resumeId } = state;
    let createdId = resumeId;
    const update = (patch: Partial<Extract<State, { kind: 'preview' }>>) =>
      setState((s) => (s.kind === 'preview' && s.result === result ? { ...s, ...patch } : s));
    update({ saving: { done: 0, total: 1 }, saveError: undefined });
    try {
      const id = await saveScan(result, {
        resumeId,
        onProgress: (p) => update({ saving: p }),
        onCreated: (newId) => {
          createdId = newId; // so "Start scan" again resumes this scan instead of making a new one
        },
      });
      navigate(`/scans/${id}`, { state: { justSaved: true } });
    } catch (e) {
      update({
        saving: undefined,
        scanId: createdId,
        saveError:
          e instanceof RequestError ? e.message : 'We couldn’t save your scan. Check your connection and try again.',
      });
    }
  }

  const step = state.kind === 'preview' ? (state.saving ? 2 : 1) : 0;

  return (
    <div className="stack-lg narrow-wide">
      <ol className="steps" aria-label="Progress">
        {['Upload your sheet', 'Check what we found', 'Start the scan'].map((label, i) => (
          <li
            key={label}
            className={i === step ? 'is-current' : i < step ? 'is-done' : undefined}
            aria-current={i === step ? 'step' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      {(state.kind === 'idle' || state.kind === 'error') && (
        <>
          {state.kind === 'error' && (
            <div className="notice notice-error" role="alert">
              <p className="notice-title">{state.title}</p>
              {state.help && <p>{state.help}</p>}
            </div>
          )}
          <FileDrop onFile={choose}>
            <p className="drop-title">{state.kind === 'error' ? 'Try another file' : 'Upload your backlink sheet'}</p>
            <p className="drop-sub">Drag your Excel file here, or browse for it.</p>
            <p className="drop-meta">Excel workbook (.xlsx), up to 10 MB. Needs a column called “Backlinks”.</p>
          </FileDrop>
          <SheetHelp />
        </>
      )}

      {state.kind === 'reading' && (
        <section className="panel reading" role="status" aria-live="polite">
          <p className="file-name">{state.file.name}</p>
          <p>Reading your workbook…</p>
          <div className="progress-indeterminate" aria-hidden="true">
            <span />
          </div>
        </section>
      )}

      {state.kind === 'preview' && (
        <Preview
          result={state.result}
          saving={state.saving}
          saveError={state.saveError}
          onStart={start}
          onReset={reset}
        />
      )}
    </div>
  );
}

interface PreviewProps {
  result: ImportResult;
  saving?: SaveProgress;
  saveError?: string;
  onStart: () => void;
  onReset: () => void;
}

function Preview({ result, saving, saveError, onStart, onReset }: PreviewProps) {
  const t = result.totals;
  const invalidRows = result.rows.filter((r) => r.invalidReason);
  const tooBig = tooBigForOneScan(result);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const stats = [
    { label: 'Worksheets', value: result.worksheets },
    { label: 'Rows', value: t.rows },
    { label: 'Valid links', value: t.valid, tone: 'active' },
    { label: 'Unique links', value: t.unique },
    { label: 'Invalid', value: t.invalid, tone: t.invalid ? 'review' : undefined },
  ];
  const pct = saving ? Math.round((saving.done / saving.total) * 100) : 0;

  return (
    <>
      <section className="file-card" aria-labelledby="preview-heading">
        <span className="file-card-icon">
          <Icon name="file" size={28} />
        </span>
        <div className="file-card-body">
          <h2 id="preview-heading" className="file-name" tabIndex={-1} ref={headingRef}>
            {result.fileName}
          </h2>
          <p className="file-size">{formatBytes(result.fileSize)}</p>
        </div>
        <dl className="stat-strip file-card-stats">
          {stats.map((s) => (
            <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
              <dt>{s.label}</dt>
              <dd>{formatNumber(s.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="summary-line file-card-wide">
          We’ll check <strong>{formatNumber(t.unique)}</strong> unique {t.unique === 1 ? 'link' : 'links'}.
          {t.duplicates > 0 && (
            <>
              {' '}
              {formatNumber(t.duplicates)} {t.duplicates === 1 ? 'link appears' : 'links appear'} more than once, so
              each is checked once and the result is copied to every row.
            </>
          )}
        </p>

        {tooBig && (
          <p className="notice notice-error file-card-wide" role="alert">
            One scan can hold up to {formatNumber(SCAN_LIMITS.maxRows)} rows. Split this workbook into smaller files and
            scan them one at a time.
          </p>
        )}
        {saveError && (
          <div className="notice notice-error file-card-wide" role="alert">
            <p className="notice-title">{saveError}</p>
            <p>Nothing is lost. Press Start scan again to carry on from where it stopped.</p>
          </div>
        )}

        {saving ? (
          <div className="saving file-card-wide" role="status" aria-live="polite">
            <p>Saving your scan… {pct}%</p>
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Saving"
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <div className="file-card-actions">
            <button type="button" className="button button-primary" onClick={onStart} disabled={tooBig}>
              Start scan
            </button>
            <button type="button" className="button button-quiet" onClick={onReset}>
              Choose a different file
            </button>
          </div>
        )}
      </section>

      <Notes result={result} />

      <section aria-labelledby="sheets-heading">
        <h2 id="sheets-heading" className="section-title">
          Worksheets
        </h2>
        <SheetsTable sheets={result.sheets} />
      </section>

      {invalidRows.length > 0 && (
        <details className="disclosure">
          <summary>
            See the {formatNumber(invalidRows.length)} {invalidRows.length === 1 ? 'row' : 'rows'} we’ll skip
          </summary>
          <p className="form-hint">Fix these in your sheet and upload it again if you want them checked.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Sheet</th>
                  <th scope="col" className="num">
                    Row
                  </th>
                  <th scope="col">What’s in the cell</th>
                  <th scope="col">Why it’s skipped</th>
                </tr>
              </thead>
              <tbody>
                {invalidRows.slice(0, MAX_INVALID_SHOWN).map((r) => (
                  <tr key={`${r.sheet}-${r.rowNumber}`}>
                    <td>{r.sheet}</td>
                    <td className="num">{r.rowNumber}</td>
                    <td className="cell-value">{r.originalValue}</td>
                    <td>{INVALID_REASON_TEXT[r.invalidReason!]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invalidRows.length > MAX_INVALID_SHOWN && (
            <p className="form-hint">Showing the first {MAX_INVALID_SHOWN}.</p>
          )}
        </details>
      )}
    </>
  );
}

function Notes({ result }: { result: ImportResult }) {
  const t = result.totals;
  const notes: string[] = [];
  if (t.addedScheme > 0)
    notes.push(
      `${formatNumber(t.addedScheme)} ${t.addedScheme === 1 ? 'link started' : 'links started'} with “www.”, so we added https:// in front.`,
    );
  if (t.blank > 0)
    notes.push(
      `${formatNumber(t.blank)} ${t.blank === 1 ? 'row has' : 'rows have'} an empty Backlinks cell and will be skipped.`,
    );
  if (result.optionalColumns.length > 0) {
    const names = result.optionalColumns.map((c) => OPTIONAL_COLUMN_LABELS[c]).join(', ');
    notes.push(`We also found: ${names}. These are kept and included in your results.`);
  }
  if (result.optionalColumns.includes('targetUrl'))
    notes.push(
      'Because your sheet has a Target URL column, we’ll later be able to check your link is still on each page.',
    );
  if (!notes.length) return null;
  return (
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading" className="section-title">
        Good to know
      </h2>
      <ul className="notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}

function SheetHelp() {
  return (
    <section className="help" aria-labelledby="sheet-help">
      <h2 id="sheet-help" className="section-title">
        Getting your sheet ready
      </h2>
      <ul>
        <li>
          Put your backlink page addresses in a column headed <strong>Backlinks</strong>. Capitals and spaces don’t
          matter, and the heading doesn’t have to be on the first row.
        </li>
        <li>You can have several worksheets. We look through all of them, including hidden ones.</li>
        <li>Linked cells work too: if a cell says “View post” and links to the page, we use the link.</li>
        <li>Other columns, like Target URL or Anchor Text, are kept and added to your results.</li>
        <li>Blank rows and repeated links are handled for you.</li>
      </ul>
    </section>
  );
}
