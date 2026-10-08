import { useState } from 'react';
import { createPrivateTable, findPokerTable } from '../lib/poker-api.ts';
import { navigate } from '../lib/router.ts';

function useCreate(open: () => Promise<string>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // ?sit=1 takes a seat on arrival (removed from the address bar once read).
      navigate(`/poker/table/${await open()}?sit=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function PokerFinderButton() {
  const { busy, error, run } = useCreate(findPokerTable);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? 'Finding a seat…' : 'Find a table'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function PrivateTableButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const { busy, error, run } = useCreate(createPrivateTable);
  return (
    <>
      <button type="button" className={`btn btn-${variant}`} onClick={run} disabled={busy}>
        {busy ? 'Opening table…' : 'Create private table'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
