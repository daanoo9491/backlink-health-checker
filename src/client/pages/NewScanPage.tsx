import { useState } from 'react';
import { FileDrop } from '../components/FileDrop';
import { Icon } from '../components/Icon';
import { takeHandedOffFile } from '../lib/file-handoff';
import { formatBytes } from '../lib/format';
import { checkUploadFile } from '../lib/upload-rules';

function initialState(): { file: File | null; error: string | null } {
  const f = takeHandedOffFile();
  if (!f) return { file: null, error: null };
  const err = checkUploadFile(f);
  return err ? { file: null, error: err } : { file: f, error: null };
}

export function NewScanPage() {
  const [{ file, error }, setState] = useState(initialState);

  function choose(f: File) {
    const err = checkUploadFile(f);
    setState(err ? { file: null, error: err } : { file: f, error: null });
  }

  return (
    <div className="stack-lg narrow">
      <ol className="steps" aria-label="How it works">
        {['Upload your sheet', 'Check what we found', 'Start the scan'].map((label, i) => {
          const current = (file ? 1 : 0) === i;
          return (
            <li
              key={label}
              className={current ? 'is-current' : i < (file ? 1 : 0) ? 'is-done' : undefined}
              aria-current={current ? 'step' : undefined}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {!file && (
        <FileDrop onFile={choose}>
          <p className="drop-title">Upload your backlink sheet</p>
          <p className="drop-sub">Drag your Excel file here, or browse for it.</p>
          <p className="drop-meta">Excel workbook (.xlsx), up to 10 MB. Needs a column called “Backlinks”.</p>
        </FileDrop>
      )}

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {file && (
        <section className="file-card" aria-label="Selected file">
          <span className="file-card-icon">
            <Icon name="file" size={28} />
          </span>
          <div className="file-card-body">
            <p className="file-name">{file.name}</p>
            <p className="file-size">{formatBytes(file.size)}</p>
            <dl className="file-facts">
              <div>
                <dt>Worksheets</dt>
                <dd>Read in the next update</dd>
              </div>
              <div>
                <dt>Backlinks found</dt>
                <dd>Read in the next update</dd>
              </div>
            </dl>
          </div>
          <div className="file-card-actions">
            <button type="button" className="button button-primary" disabled aria-describedby="start-hint">
              Start scan
            </button>
            <button type="button" className="button button-quiet" onClick={() => setState({ file: null, error: null })}>
              Choose a different file
            </button>
          </div>
          <p id="start-hint" className="form-hint file-card-hint">
            Scanning is being built. This page is ready so you can try the upload.
          </p>
        </section>
      )}

      <section className="help" aria-labelledby="sheet-help">
        <h2 id="sheet-help" className="section-title">
          Getting your sheet ready
        </h2>
        <ul>
          <li>
            Put your backlink page addresses in a column headed <strong>Backlinks</strong>. Capitals and spaces don’t
            matter.
          </li>
          <li>You can have several worksheets. We look through all of them.</li>
          <li>Other columns, like Target URL or Anchor Text, are kept and added to your results.</li>
          <li>Blank rows and repeated links are handled for you.</li>
        </ul>
      </section>
    </div>
  );
}
