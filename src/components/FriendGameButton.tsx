import { useId, useState } from 'react';
import { createRoom } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';

/**
 * "Play with a friend": creates a private game and opens it, where the share
 * menu gives the invite link. Friend games are unlisted unless the creator
 * ticks the box.
 */
export function FriendGameButton({ variant = 'secondary', startOpen = false }: { variant?: 'primary' | 'secondary'; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  if (!open) {
    return (
      <button type="button" className={`btn btn-${variant}`} onClick={() => setOpen(true)}>
        Play with a friend
      </button>
    );
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      navigate(`/game/${await createRoom({ listed })}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a game.');
      setBusy(false);
    }
  };

  return (
    <div className="friend-panel" role="group" aria-label="Play with a friend" aria-describedby={hintId}>
      <label className="toggle">
        <input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} />
        Let anyone watch from the Live page
      </label>
      <div className="friend-panel-actions">
        <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
        {!startOpen && (
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
      <p id={hintId} className="hint">
        You&apos;ll get a link to send by DM, text or a post on X. The first person to open it plays you.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
