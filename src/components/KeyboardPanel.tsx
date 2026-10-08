import { useId, useState, type FormEvent } from 'react';
import { colorName } from '../../shared/protocol.ts';
import { describePosition, parseTypedMove, type MoveIntent } from '../lib/chess-ui.ts';

/**
 * Accessible alternative to pointer input: type moves in algebraic notation
 * and read the position as text. Collapsed by default to keep mobile tidy.
 */
export function KeyboardPanel({
  fen,
  canMove,
  onMove,
}: {
  fen: string;
  canMove: boolean;
  onMove: (move: MoveIntent) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canMove) {
      setError("You can't move right now.");
      return;
    }
    const intent = parseTypedMove(fen, text);
    if (!intent) {
      setError(`"${text}" isn't a legal move here. Try e.g. e4, Nf3, O-O or e7e8q.`);
      return;
    }
    setError(null);
    setText('');
    onMove(intent);
  };

  return (
    <details className="keyboard-panel">
      <summary>Keyboard &amp; screen-reader controls</summary>
      <form className="move-form" onSubmit={submit}>
        <label htmlFor={inputId}>Type a move</label>
        <div className="move-form-row">
          <input
            id={inputId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="e.g. e4, Nf3, O-O"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <button type="submit" className="btn btn-secondary btn-small" disabled={!canMove}>
            Play
          </button>
        </div>
        {error && (
          <p id={errorId} className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="position-text">
        <p>Current position:</p>
        <ul>
          {describePosition(fen).map(({ color, pieces }) => (
            <li key={color}>
              <strong>{colorName(color)}:</strong> {pieces.join('; ')}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
