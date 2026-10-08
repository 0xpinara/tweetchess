import type { Color } from '../../shared/protocol.ts';
import { PieceIcon } from './Board.tsx';

/** A small static board for previews (no drag-and-drop machinery). */
export function MiniBoard({ fen, orientation = 'w' }: { fen: string; orientation?: Color }) {
  const ranks = fen.split(' ')[0].split('/');
  const squares: { key: string; light: boolean; piece: string | null }[] = [];
  ranks.forEach((rank, rankIndex) => {
    let file = 0;
    for (const char of rank) {
      if (/\d/.test(char)) {
        for (let i = 0; i < Number(char); i++) {
          squares.push({ key: `${rankIndex}-${file}`, light: (rankIndex + file) % 2 === 0, piece: null });
          file += 1;
        }
      } else {
        squares.push({ key: `${rankIndex}-${file}`, light: (rankIndex + file) % 2 === 0, piece: char });
        file += 1;
      }
    }
  });
  const ordered = orientation === 'w' ? squares : [...squares].reverse();
  return (
    <div className="mini-board" aria-hidden="true">
      {ordered.map(({ key, light, piece }) => (
        <div key={key} className={light ? 'mini-sq light' : 'mini-sq dark'}>
          {piece && (
            <PieceIcon
              color={piece === piece.toUpperCase() ? 'w' : 'b'}
              type={piece.toLowerCase()}
              className="mini-piece"
            />
          )}
        </div>
      ))}
    </div>
  );
}
