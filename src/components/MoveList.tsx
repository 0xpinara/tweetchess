import { useEffect, useRef } from 'react';
import type { MoveInfo } from '../../shared/protocol.ts';
import { movePairs } from '../lib/chess-ui.ts';

export function MoveList({ moves }: { moves: MoveInfo[] }) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [moves.length]);

  if (moves.length === 0) {
    return <p className="move-list-empty">No moves yet.</p>;
  }

  const lastIndex = moves.length - 1;
  return (
    <ol className="move-list" ref={listRef} aria-label="Move history">
      {movePairs(moves).map(({ number, white, black }) => (
        <li key={number} className="move-row">
          <span className="move-number">{number}.</span>
          <span className={`move-san${(number - 1) * 2 === lastIndex ? ' is-last' : ''}`}>{white?.san}</span>
          <span className={`move-san${(number - 1) * 2 + 1 === lastIndex ? ' is-last' : ''}`}>{black?.san ?? ''}</span>
        </li>
      ))}
    </ol>
  );
}
