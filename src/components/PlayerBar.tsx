import { colorName, type Color, type PieceType } from '../../shared/protocol.ts';
import { PieceIcon } from './Board.tsx';

export type SeatStatus = 'online' | 'offline' | 'open' | 'local';

interface PlayerBarProps {
  color: Color;
  name: string;
  isYou: boolean;
  seat: SeatStatus;
  isTurn: boolean;
  /** Pieces this player has captured (they are the opponent's colour). */
  captured: PieceType[];
  /** Material lead in pawns, shown only when positive. */
  advantage: number;
  /** Time left to move (World Board), e.g. "2:41". */
  clock?: string | null;
}

const SEAT_LABEL: Record<SeatStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  open: 'Open seat',
  local: '',
};

export function PlayerBar({ color, name, isYou, seat, isTurn, captured, advantage, clock }: PlayerBarProps) {
  const opponent: Color = color === 'w' ? 'b' : 'w';
  return (
    <div className={`player-bar${isTurn ? ' is-turn' : ''}`} data-color={color}>
      <span className={`color-chip color-chip-${color}`} aria-hidden="true" />
      <div className="player-main">
        <div className="player-name">
          <span>{name}</span>
          {isYou && <span className="badge">You</span>}
          {isTurn && <span className="turn-pill">to move</span>}
        </div>
        {seat !== 'local' && (
          <div className={`seat-status seat-${seat}`}>
            <span className="dot" aria-hidden="true" />
            {colorName(color)} · {SEAT_LABEL[seat]}
          </div>
        )}
      </div>
      <div className="captured" aria-label={captured.length ? `${captured.length} pieces captured` : undefined}>
        {captured.map((type, index) => (
          <PieceIcon key={`${type}-${index}`} color={opponent} type={type} className="captured-piece" />
        ))}
        {advantage > 0 && <span className="advantage">+{advantage}</span>}
      </div>
      {clock && (
        <span className="clock-pill" aria-label={`${clock} left to move`}>
          {clock}
        </span>
      )}
    </div>
  );
}
