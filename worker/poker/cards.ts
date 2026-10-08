/**
 * Cards and shuffling. A card is two characters: rank (23456789TJQKA) and
 * suit (s h d c), e.g. "As" = ace of spades, "Td" = ten of diamonds.
 */
import { secureRandomInt } from '../crypto.ts';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

export function fullDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

/** 0 (two) … 12 (ace). */
export function rankValue(card: string): number {
  return RANKS.indexOf(card[0]);
}

export function isCard(value: unknown): value is string {
  return typeof value === 'string' && value.length === 2 && RANKS.includes(value[0]) && SUITS.includes(value[1]);
}

/**
 * Unbiased Fisher–Yates shuffle. `randomInt(n)` must return a uniform integer
 * in [0, n); production uses the Web Crypto CSPRNG with rejection sampling.
 */
export function shuffle<T>(items: readonly T[], randomInt: (maxExclusive: number) => number = secureRandomInt): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
