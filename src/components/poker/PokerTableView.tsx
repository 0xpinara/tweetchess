import type { PublicSeat, PublicTable } from '../../../shared/poker.ts';
import { cardName } from '../../lib/cards.ts';
import { PlayingCard } from '../PlayingCard.tsx';

interface PokerTableViewProps {
  table: PublicTable;
  mySeat: number | null;
  myHole: string[] | null;
  /** Spectators may pick an empty seat. */
  canSit: boolean;
  onSit: (seat: number) => void;
  /** Seconds left for the player to act, if a hand is running. */
  secondsLeft: number | null;
}

/** The felt, community cards, pot and six seats, rotated so your seat is at the bottom. */
export function PokerTableView({ table, mySeat, myHole, canSit, onSit, secondsLeft }: PokerTableViewProps) {
  const hand = table.hand;
  const anchor = mySeat ?? 0;
  const winners = new Set(hand?.done && table.lastResult?.hand === hand.number ? table.lastResult.winners.map((w) => w.seat) : []);
  const board = hand?.board ?? [];
  return (
    <div className="poker-table" role="group" aria-label="Poker table">
      <div className="felt">
        <div className="felt-center">
          <div
            className="board-cards"
            role="img"
            aria-label={board.length ? `Community cards: ${board.map(cardName).join(', ')}` : 'No community cards yet'}
          >
            {[0, 1, 2, 3, 4].map((index) =>
              board[index] ? <PlayingCard key={index} card={board[index]} /> : <span key={index} className="card-slot" />,
            )}
          </div>
          <div className="pot" aria-live="off">
            {hand && hand.pot > 0 ? `Pot ${hand.pot.toLocaleString()}` : `Blinds ${table.smallBlind}/${table.bigBlind}`}
          </div>
        </div>
      </div>
      {table.seats.map((seat, index) => (
        <SeatView
          key={index}
          index={index}
          position={(index - anchor + table.maxSeats) % table.maxSeats}
          seat={seat}
          table={table}
          isMe={index === mySeat}
          myHole={index === mySeat ? myHole : null}
          isWinner={winners.has(index)}
          canSit={canSit}
          onSit={onSit}
          secondsLeft={secondsLeft}
        />
      ))}
    </div>
  );
}

function SeatView({
  index,
  position,
  seat,
  table,
  isMe,
  myHole,
  isWinner,
  canSit,
  onSit,
  secondsLeft,
}: {
  index: number;
  position: number;
  seat: PublicSeat | null;
  table: PublicTable;
  isMe: boolean;
  myHole: string[] | null;
  isWinner: boolean;
  canSit: boolean;
  onSit: (seat: number) => void;
  secondsLeft: number | null;
}) {
  if (!seat) {
    return (
      <div className={`seat pos-${position} is-empty`}>
        {canSit ? (
          <button type="button" className="sit-button" onClick={() => onSit(index)} aria-label={`Sit in seat ${index + 1}`}>
            Sit here
          </button>
        ) : (
          <span className="empty-label">Empty seat</span>
        )}
      </div>
    );
  }
  const hand = table.hand;
  const live = Boolean(hand && !hand.done);
  const isTurn = live && hand!.turn === index;
  const marker = hand?.dealer === index ? 'D' : live && hand!.smallBlind === index ? 'SB' : live && hand!.bigBlind === index ? 'BB' : null;
  const status = seat.away
    ? 'Sitting out'
    : !seat.connected
      ? 'Offline'
      : seat.allIn
        ? 'All-in'
        : seat.folded
          ? 'Folded'
          : live && !seat.inHand
            ? 'Next hand'
            : seat.stack === 0 && !seat.inHand
              ? 'Out of chips'
              : null;
  const faceUp = seat.shownCards ?? (isMe && myHole && seat.inHand && !seat.folded ? myHole : null);
  const total = table.actionMs / 1000;
  const label = [
    `Seat ${index + 1}: ${seat.name}${isMe ? ' (you)' : ''}`,
    `${seat.stack} chips`,
    marker === 'D' ? 'dealer' : marker === 'SB' ? 'small blind' : marker === 'BB' ? 'big blind' : null,
    status,
    seat.bet > 0 ? `bet ${seat.bet}` : null,
    seat.lastAction,
    isTurn ? 'to act' : null,
    seat.shownHand,
    isWinner ? 'winner' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      className={`seat pos-${position}${isTurn ? ' is-turn' : ''}${seat.folded ? ' is-folded' : ''}${isMe ? ' is-me' : ''}${isWinner ? ' is-winner' : ''}${seat.away || !seat.connected ? ' is-away' : ''}`}
      aria-label={label}
      role="group"
    >
      <div className="seat-cards" aria-hidden={faceUp ? undefined : true}>
        {faceUp
          ? faceUp.map((card) => <PlayingCard key={card} card={card} size="small" highlight={isWinner} />)
          : seat.hasCards && (
              <>
                <PlayingCard card={null} size="small" />
                <PlayingCard card={null} size="small" />
              </>
            )}
      </div>
      <div className="seat-plate">
        <span className="seat-avatar" aria-hidden="true">
          {seat.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="seat-info">
          <span className="seat-name">{seat.name}</span>
          <span className="seat-stack">
            {seat.stack.toLocaleString()}
            {marker && (
              <span className={`seat-marker marker-${marker.toLowerCase()}`} aria-hidden="true">
                {marker}
              </span>
            )}
          </span>
        </span>
      </div>
      {isTurn && secondsLeft !== null && (
        <span className="seat-timer" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, (secondsLeft / total) * 100))}%` }} />
        </span>
      )}
      {(seat.shownHand || seat.lastAction || status) && (
        <span className={`seat-note${isWinner ? ' is-winner' : ''}`} aria-hidden="true">
          {seat.shownHand ?? (live ? (seat.lastAction ?? status) : status) ?? seat.lastAction}
        </span>
      )}
      {seat.bet > 0 && (
        <span className="seat-bet" aria-hidden="true">
          {seat.bet.toLocaleString()}
        </span>
      )}
    </div>
  );
}
