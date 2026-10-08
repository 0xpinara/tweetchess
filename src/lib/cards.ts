/** Playing-card names for screen readers: "As" → "Ace of spades". */
export const SUITS: Record<string, { symbol: string; name: string; red: boolean }> = {
  s: { symbol: '♠', name: 'spades', red: false },
  h: { symbol: '♥', name: 'hearts', red: true },
  d: { symbol: '♦', name: 'diamonds', red: true },
  c: { symbol: '♣', name: 'clubs', red: false },
};

const RANK_NAMES: Record<string, string> = {
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', '9': 'Nine', '8': 'Eight',
  '7': 'Seven', '6': 'Six', '5': 'Five', '4': 'Four', '3': 'Three', '2': 'Two',
};

export function cardName(card: string): string {
  const suit = SUITS[card[1]];
  return suit ? `${RANK_NAMES[card[0]] ?? card[0]} of ${suit.name}` : 'Card';
}
