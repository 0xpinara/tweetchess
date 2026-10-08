import { SUITS, cardName } from '../lib/cards.ts';

/** A playing card drawn with CSS: "As" = ace of spades, "Td" = ten of diamonds. */
export function PlayingCard({
  card,
  size = 'medium',
  highlight = false,
}: {
  /** A card code, or null for a face-down card. */
  card: string | null;
  size?: 'small' | 'medium' | 'large';
  highlight?: boolean;
}) {
  if (!card) {
    return <span className={`playing-card face-down size-${size}`} role="img" aria-label="Face-down card" />;
  }
  const suit = SUITS[card[1]];
  const rank = card[0] === 'T' ? '10' : card[0];
  return (
    <span
      className={`playing-card size-${size}${suit?.red ? ' red' : ''}${highlight ? ' is-highlight' : ''}`}
      role="img"
      aria-label={cardName(card)}
      data-card={card}
    >
      <span className="card-rank" aria-hidden="true">
        {rank}
      </span>
      <span className="card-suit" aria-hidden="true">
        {suit?.symbol}
      </span>
    </span>
  );
}
