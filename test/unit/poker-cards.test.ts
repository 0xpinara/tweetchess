import { afterEach, describe, expect, it, vi } from 'vitest';
import { fullDeck, isCard, shuffle } from '../../worker/poker/cards.ts';
import { describeHand, evaluate5, evaluateBest } from '../../worker/poker/evaluator.ts';
import { secureRandomInt } from '../../worker/crypto.ts';

describe('deck and shuffle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has 52 unique, valid cards', () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.every(isCard)).toBe(true);
  });

  it('shuffles into a permutation of the same cards', () => {
    const deck = fullDeck();
    const shuffled = shuffle(deck);
    expect(shuffled).toHaveLength(52);
    expect([...shuffled].sort()).toEqual([...deck].sort());
    expect(deck).toEqual(fullDeck()); // input untouched
  });

  it('uses rejection sampling, so random values are unbiased', () => {
    // For n = 3 the largest 32-bit value is in the biased tail and must be redrawn.
    const values = [0xffffffff, 7];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = values.shift()!;
      return array;
    }) as typeof crypto.getRandomValues);
    expect(secureRandomInt(3)).toBe(1); // 7 % 3, after rejecting 0xffffffff
    expect(values).toHaveLength(0);
  });

  it('rejects impossible ranges', () => {
    expect(() => secureRandomInt(0)).toThrow(RangeError);
    expect(() => secureRandomInt(1.5)).toThrow(RangeError);
  });

  it('produces every ordering equally often (Fisher–Yates with the secure RNG)', () => {
    const counts = new Map<string, number>();
    const runs = 60_000;
    for (let i = 0; i < runs; i++) {
      const key = shuffle(['a', 'b', 'c']).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      // Expected 10,000 each; ±5% is about ±5 standard deviations.
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });
});

const score = (cards: string) => evaluate5(cards.split(' ')).score;
const best = (cards: string) => evaluateBest(cards.split(' '));

describe('hand evaluator', () => {
  it('ranks every category in order', () => {
    const ladder = [
      '2c 5d 9h Js Kd', // high card
      '2c 2d 9h Js Kd', // pair
      '2c 2d 9h 9s Kd', // two pair
      '2c 2d 2h 9s Kd', // three of a kind
      '5c 6d 7h 8s 9d', // straight
      '2h 5h 9h Jh Kh', // flush
      '2c 2d 2h 9s 9d', // full house
      '2c 2d 2h 2s 9d', // four of a kind
      '5h 6h 7h 8h 9h', // straight flush
    ];
    for (let i = 1; i < ladder.length; i++) expect(score(ladder[i])).toBeGreaterThan(score(ladder[i - 1]));
    expect(evaluate5('Th Jh Qh Kh Ah'.split(' ')).category).toBe(8);
  });

  it('treats A-2-3-4-5 as the lowest straight', () => {
    expect(score('Ac 2d 3h 4s 5d')).toBeLessThan(score('2c 3d 4h 5s 6d'));
    expect(score('Ac 2d 3h 4s 5d')).toBeGreaterThan(score('Kc Kd Kh 9s 2d')); // still beats trips
    expect(evaluate5('Ac 2d 3h 4s 5d'.split(' ')).category).toBe(4);
    expect(score('Ah 2h 3h 4h 5h')).toBeLessThan(score('2h 3h 4h 5h 6h'));
  });

  it('compares kickers', () => {
    expect(score('Ac Ad Kh 9s 3d')).toBeGreaterThan(score('As Ah Qh Js Td'));
    expect(score('Kc Kd 7h 7s 9d')).toBeGreaterThan(score('Kh Ks 7c 7d 8d'));
    expect(score('2c 2d 2h Ks Qd')).toBeGreaterThan(score('2s 2d 2h Ks Jd'));
    expect(score('9c 9d 9h 2s 2d')).toBeGreaterThan(score('8c 8d 8h As Ad')); // trips decide a full house
    expect(score('Ah Jh 9h 4h 3h')).toBeGreaterThan(score('Ad Jd 9d 4d 2d')); // flush kickers
    expect(score('Ac Kd 8h 6s 4d')).toBe(score('Ad Kc 8s 6h 4c')); // exact tie
  });

  it('picks the best five of seven cards', () => {
    expect(best('As Ks 2s 7s 9s 3d 4c').category).toBe(5); // flush beats the pair-less straight draw
    expect(best('Jh Jd 9c 9h 4s 4d Ac').ranks).toEqual([9, 7, 12]); // best two pair with ace kicker
    expect(best('2c 3d 9h Th Jh Qh Kh').category).toBe(8); // straight flush on the board
    expect(best('Ac Ad Ah Ks Kd Kh 2c').category).toBe(6); // aces full of kings
  });

  it('describes hands in plain language', () => {
    expect(describeHand(best('Th Jh Qh Kh Ah 2c 3d'))).toBe('Royal flush');
    expect(describeHand(best('Kc Kd Kh 5s 5d 2c 3d'))).toBe('Full house, Kings full of Fives');
    expect(describeHand(best('Kc Kd 7h 7s 2d 3c 9d'))).toBe('Two pair, Kings and Sevens');
    expect(describeHand(best('9c 9d 2h 4s 6d Jc Kd'))).toBe('Pair of Nines');
    expect(describeHand(best('Ac 2d 3h 4s 5d 9c Kh'))).toBe('Straight, Five high');
    expect(describeHand(best('Ac 3d 7h 9s Jd 2c 4h'))).toBe('High card, Ace');
  });
});
