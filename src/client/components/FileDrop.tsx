import { useId, useState, type DragEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
  onFile: (file: File) => void;
  variant?: 'page' | 'banner';
  children: ReactNode;
}

/** Drag-and-drop area that is also a normal, keyboard-usable file picker. */
export function FileDrop({ onFile, variant = 'page', children }: Props) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div
      className={`drop drop-${variant}${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <span className="drop-icon">
        <Icon name="upload" size={variant === 'page' ? 36 : 28} />
      </span>
      <div className="drop-text">{children}</div>
      <input
        id={inputId}
        className="visually-hidden file-input"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
      {/* Label follows the input so the input's keyboard focus can style it (see .file-input). */}
      <label htmlFor={inputId} className="button button-primary">
        Browse files
      </label>
    </div>
  );
}
