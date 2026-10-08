import { useId, useState, type FormEvent } from 'react';
import { NAME_MAX_LENGTH } from '../../shared/names.ts';
import { setDisplayName, useDisplayName } from '../lib/display-name.ts';

/** "Playing as Swift Falcon 27 · Change" with an inline editor. */
export function NameEditor({ compact = false }: { compact?: boolean }) {
  const name = useDisplayName();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (setDisplayName(draft)) {
      setEditing(false);
      setError(null);
    } else {
      setError(`Use 2–${NAME_MAX_LENGTH} letters, numbers, spaces or . _ ' -`);
    }
  };

  if (!editing) {
    return (
      <div className={`name-editor${compact ? ' is-compact' : ''}`}>
        <span className="name-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="name-text">
          Playing as <strong>{name}</strong>
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <form className="name-editor is-editing" onSubmit={save}>
      <label htmlFor={inputId} className="sr-only">
        Your display name
      </label>
      <input
        id={inputId}
        value={draft}
        maxLength={NAME_MAX_LENGTH}
        autoFocus
        autoComplete="nickname"
        onChange={(event) => setDraft(event.target.value)}
        aria-invalid={error ? true : undefined}
      />
      <button type="submit" className="btn btn-primary btn-small">
        Save
      </button>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
