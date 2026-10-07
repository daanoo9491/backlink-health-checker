import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { SCAN_NAME_MAX, type ScanDetail } from '../../shared/api';
import { api, RequestError } from '../api/client';

interface Props {
  /** The scan to rename; null = closed. Give the dialog key={scan?.id} so it starts fresh each time. */
  scan: { id: string; fileName: string } | null;
  /** "scan" or "index check", for the wording. */
  noun?: string;
  onRenamed: (updated: ScanDetail) => void;
  onCancel: () => void;
}

/** Native <dialog> with one text box: Enter saves, Esc cancels. */
export function RenameDialog({ scan, noun = 'scan', onRenamed, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const [name, setName] = useState(scan?.fileName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (scan && !d.open) {
      d.showModal();
      input.current?.select();
    }
    if (!scan && d.open) d.close();
  }, [scan]);

  const trimmed = name.replace(/\s+/g, ' ').trim();
  const unchanged = trimmed === scan?.fileName;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!scan || !trimmed || busy) return;
    if (unchanged) return onCancel();
    setBusy(true);
    setError(null);
    try {
      const updated = await api<ScanDetail>(`/scans/${scan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fileName: trimmed }),
      });
      onRenamed(updated);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Couldn’t rename it. Try again.');
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog dialog-rename"
      aria-labelledby={`${inputId}-title`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={save} noValidate>
        <h2 id={`${inputId}-title`} className="section-title">
          Rename this {noun}
        </h2>
        <div className="dialog-body field">
          <label htmlFor={inputId}>Name</label>
          <input
            ref={input}
            id={inputId}
            type="text"
            value={name}
            maxLength={SCAN_NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <p className="form-hint">
            Only the name changes: the results stay as they are, and downloads use the new name.
          </p>
          {error && (
            <p id={errorId} className="notice notice-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy || !trimmed}>
            {busy ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
