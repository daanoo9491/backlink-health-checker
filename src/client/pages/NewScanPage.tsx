import { useEffect, useRef, useState } from 'react';
import { INVALID_REASON_TEXT } from '../../shared/url';
import { FileDrop } from '../components/FileDrop';
import { Icon } from '../components/Icon';
import { OPTIONAL_COLUMN_LABELS, type ImportResult, type SheetSummary } from '../import/backlink-import';
import { IMPORT_ERROR_TEXT } from '../import/errors';
import { readBacklinkFile, ReadFileError } from '../import/read-file';
import { clearHandedOffFile, peekHandedOffFile } from '../lib/file-handoff';
import { formatBytes, formatNumber } from '../lib/format';
import { checkUploadFile } from '../lib/upload-rules';

type State =
  | { kind: 'idle' }
  | { kind: 'reading'; file: File }
  | { kind: 'preview'; result: ImportResult }
  | { kind: 'error'; title: string; help: string };

const MAX_INVALID_SHOWN = 200;

function stateForNewFile(file: File): State {
  const problem = checkUploadFile(file);
  return problem ? { kind: 'error', title: problem, help: '' } : { kind: 'reading', file };
}

export function NewScanPage() {
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

  const step = state.kind === 'preview' ? 1 : 0;
  const reset = () => setState({ kind: 'idle' });

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

      {state.kind === 'preview' && <Preview result={state.result} onReset={reset} />}
    </div>
  );
}

function Preview({ result, onReset }: { result: ImportResult; onReset: () => void }) {
  const t = result.totals;
  const invalidRows = result.rows.filter((r) => r.invalidReason);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const stats = [
    { label: 'Worksheets', value: result.worksheets },
    { label: 'Rows', value: t.rows },
    { label: 'Valid links', value: t.valid, tone: 'active' },
    { label: 'Unique links', value: t.unique },
    { label: 'Invalid', value: t.invalid, tone: t.invalid ? 'review' : undefined },
  ];

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
        <div className="file-card-actions">
          <button type="button" className="button button-primary" disabled aria-describedby="start-hint">
            Start scan
          </button>
          <button type="button" className="button button-quiet" onClick={onReset}>
            Choose a different file
          </button>
        </div>
        <p id="start-hint" className="form-hint file-card-wide">
          Scanning arrives in the next update. Everything above is what will be checked.
        </p>
      </section>

      <Notes result={result} />

      <section aria-labelledby="sheets-heading">
        <h2 id="sheets-heading" className="section-title">
          Worksheets
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Sheet</th>
                <th scope="col">What we did</th>
                <th scope="col" className="num">
                  Valid links
                </th>
                <th scope="col" className="num">
                  Invalid
                </th>
              </tr>
            </thead>
            <tbody>
              {result.sheets.map((s) => (
                <tr key={s.name}>
                  <th scope="row" className="cell-strong">
                    {s.name}
                    {s.hidden && <span className="tag">hidden</span>}
                  </th>
                  <td>{sheetOutcome(s)}</td>
                  <td className="num">{s.status === 'used' ? formatNumber(s.valid) : '—'}</td>
                  <td className="num">{s.status === 'used' ? formatNumber(s.invalid) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

function sheetOutcome(s: SheetSummary): string {
  if (s.status === 'empty') return 'Skipped: the sheet is empty';
  if (s.status === 'no-backlinks-column') return 'Skipped: no “Backlinks” column';
  return `Read the “${s.backlinksHeader}” column (headings on row ${s.headerRow})`;
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
