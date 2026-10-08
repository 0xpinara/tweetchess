/**
 * Texas Hold'em hand evaluation. Each 5-card hand gets a single comparable
 * score: category (0 high card … 8 straight flush) in the top bits, then up to
 * five tie-break ranks, 4 bits each. The best 5 of 7 cards wins.
 */
import { rankValue } from './cards.ts';

export const CATEGORY_NAMES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
] as const;

const RANK_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURALS = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

export interface HandScore {
  score: number;
  category: number;
  /** Tie-break ranks (0 = two … 12 = ace), most significant first. */
  ranks: number[];
  cards: string[];
}

function encode(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

/** Score exactly five cards. */
export function evaluate5(cards: string[]): HandScore {
  if (cards.length !== 5) throw new Error('evaluate5 needs exactly five cards');
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((card) => card[1] === cards[0][1]);

  let straightHigh = -1;
  if (new Set(values).size === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values[0] === 12 && values[1] === 3) straightHigh = 3; // A-2-3-4-5 ("wheel"), five high
  }

  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  // Groups ordered by size, then rank: e.g. full house → [[trips], [pair]].
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, count]) => count);
  const byGroup = groups.map(([value]) => value);

  let category: number;
  let ranks: number[];
  if (straightHigh >= 0 && flush) [category, ranks] = [8, [straightHigh]];
  else if (shape[0] === 4) [category, ranks] = [7, byGroup];
  else if (shape[0] === 3 && shape[1] === 2) [category, ranks] = [6, byGroup];
  else if (flush) [category, ranks] = [5, values];
  else if (straightHigh >= 0) [category, ranks] = [4, [straightHigh]];
  else if (shape[0] === 3) [category, ranks] = [3, byGroup];
  else if (shape[0] === 2 && shape[1] === 2) [category, ranks] = [2, byGroup];
  else if (shape[0] === 2) [category, ranks] = [1, byGroup];
  else [category, ranks] = [0, values];

  return { score: encode(category, ranks), category, ranks, cards: [...cards] };
}

/** Best five-card hand out of five to seven cards. */
export function evaluateBest(cards: string[]): HandScore {
  if (cards.length < 5 || cards.length > 7) throw new Error('evaluateBest needs 5–7 cards');
  let best: HandScore | null = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const score = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || score.score > best.score) best = score;
          }
  return best!;
}

/** Plain-language description, e.g. "Full house, Kings full of Fives". */
export function describeHand(hand: HandScore): string {
  const [r1, r2] = hand.ranks;
  switch (hand.category) {
    case 8:
      return r1 === 12 ? 'Royal flush' : `Straight flush, ${RANK_WORDS[r1]} high`;
    case 7:
      return `Four of a kind, ${RANK_PLURALS[r1]}`;
    case 6:
      return `Full house, ${RANK_PLURALS[r1]} full of ${RANK_PLURALS[r2]}`;
    case 5:
      return `Flush, ${RANK_WORDS[r1]} high`;
    case 4:
      return `Straight, ${RANK_WORDS[r1]} high`;
    case 3:
      return `Three of a kind, ${RANK_PLURALS[r1]}`;
    case 2:
      return `Two pair, ${RANK_PLURALS[r1]} and ${RANK_PLURALS[r2]}`;
    case 1:
      return `Pair of ${RANK_PLURALS[r1]}`;
    default:
      return `High card, ${RANK_WORDS[r1]}`;
  }
}
