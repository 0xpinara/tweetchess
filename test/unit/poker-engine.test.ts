import { describe, expect, it } from 'vitest';
import type { PokerActionType } from '../../shared/poker.ts';
import { fullDeck } from '../../worker/poker/cards.ts';
import {
  DEFAULT_CONFIG,
  act,
  computePots,
  createTable,
  legalActions,
  leave,
  privateView,
  publicView,
  rebuy,
  setAway,
  sit,
  startHand,
  timeout,
  totalChips,
  type TableState,
} from '../../worker/poker/engine.ts';

const NOW = 1_700_000_000_000;
const H = ['hash-0', 'hash-1', 'hash-2', 'hash-3', 'hash-4', 'hash-5'];
const everyone = () => true;

/** A table with players in the given seats (seat → stack). */
function table(stacks: Record<number, number>): TableState {
  const state = createTable('TableId001', 'public', NOW);
  for (const [seat, stack] of Object.entries(stacks)) {
    expect(sit(state, H[Number(seat)], `P${seat}`, NOW, Number(seat)).ok).toBe(true);
    state.seats[Number(seat)]!.stack = stack;
  }
  return state;
}

/**
 * A deck that deals exactly these cards. `holes` are in seat order of the
 * players dealt in; then burn+flop, burn+turn, burn+river.
 */
function stackedDeck(holes: string[][], board: string[]): string[] {
  const sequence = holes.flatMap((hole) => hole);
  const used = new Set([...sequence, ...board]);
  const rest = fullDeck().filter((card) => !used.has(card));
  const burns = rest.splice(0, 3);
  sequence.push(burns[0], board[0], board[1], board[2], burns[1], board[3], burns[2], board[4]);
  return [...rest, ...sequence.reverse()];
}

function deal(state: TableState, deck?: string[]) {
  expect(startHand(state, NOW, everyone, deck ? { deck } : {})).toBe(true);
  return state.hand!;
}

function play(state: TableState, seat: number, action: PokerActionType, amount?: number) {
  const hand = state.hand!;
  const result = act(state, H[seat], { action, amount, hand: hand.number, seq: hand.seq }, NOW);
  expect(result, `${seat} ${action} ${amount ?? ''}`).toEqual({ ok: true });
}

function attempt(state: TableState, seat: number, action: PokerActionType, amount?: number) {
  const hand = state.hand!;
  return act(state, H[seat], { action, amount, hand: hand.number, seq: hand.seq }, NOW);
}

describe('dealing and blinds', () => {
  it('deals two private cards to each player from one 52-card deck', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    const holes = hand.order.map((seat) => hand.players[seat].hole);
    expect(holes.every((hole) => hole.length === 2)).toBe(true);
    const all = [...holes.flat(), ...hand.deck];
    expect(all).toHaveLength(52);
    expect(new Set(all).size).toBe(52);
  });

  it('heads-up: the dealer posts the small blind, acts first pre-flop and last after the flop', () => {
    const state = table({ 0: 1000, 1: 1000 });
    const hand = deal(state);
    expect(hand).toMatchObject({ dealer: 0, sb: 0, bb: 1, turn: 0, currentBet: 10 });
    expect(state.seats[0]!.stack).toBe(995);
    expect(state.seats[1]!.stack).toBe(990);
    play(state, 0, 'call');
    play(state, 1, 'check');
    expect(hand.street).toBe('flop');
    expect(hand.board).toHaveLength(3);
    expect(hand.turn).toBe(1); // big blind acts first after the flop
  });

  it('three-handed: blinds left of the dealer, first action left of the big blind', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    expect(hand).toMatchObject({ dealer: 0, sb: 1, bb: 2, turn: 0 });
  });

  it('rotates the dealer and blinds each hand, skipping empty seats and players sitting out', () => {
    const state = table({ 0: 1000, 2: 1000, 4: 1000, 5: 1000 });
    setAway(state, H[5], true, NOW);
    let hand = deal(state);
    expect([hand.dealer, hand.sb, hand.bb]).toEqual([0, 2, 4]);
    play(state, 0, 'fold');
    play(state, 2, 'fold');
    hand = deal(state);
    expect([hand.dealer, hand.sb, hand.bb]).toEqual([2, 4, 0]);
    expect(hand.order).toEqual([0, 2, 4]);
  });

  it('needs two present players with chips', () => {
    const state = table({ 0: 1000, 1: 1000 });
    expect(startHand(state, NOW, (hash) => hash === H[0])).toBe(false); // other player disconnected
    setAway(state, H[1], true, NOW);
    expect(startHand(state, NOW, everyone)).toBe(false);
    setAway(state, H[1], false, NOW);
    state.seats[1]!.stack = 0;
    expect(startHand(state, NOW, everyone)).toBe(false);
  });

  it('a player who sits down mid-hand waits for the next hand', () => {
    const state = table({ 0: 1000, 1: 1000 });
    const hand = deal(state);
    sit(state, H[2], 'Late', NOW, 2);
    expect(hand.players[2]).toBeUndefined();
    expect(privateView(state, H[2])).toEqual({ seat: 2, hole: null, actions: null });
  });

  it('a short blind is posted all-in', () => {
    const state = table({ 0: 1000, 1: 6 });
    const hand = deal(state);
    expect(hand.players[1]).toMatchObject({ bet: 6, allIn: true });
  });
});

describe('betting rules', () => {
  it('rejects acting out of turn, stale or replayed commands, and acting after folding', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    expect(attempt(state, 1, 'call')).toMatchObject({ ok: false, code: 'not_your_turn' });
    const seq = hand.seq;
    play(state, 0, 'call');
    // Replaying the exact same command (same seq) is rejected.
    expect(act(state, H[0], { action: 'call', hand: hand.number, seq }, NOW)).toMatchObject({ ok: false, code: 'stale' });
    expect(act(state, H[1], { action: 'call', hand: hand.number + 1, seq: hand.seq }, NOW)).toMatchObject({
      ok: false,
      code: 'stale',
    });
    play(state, 1, 'fold');
    expect(attempt(state, 1, 'check')).toMatchObject({ ok: false, code: 'not_in_hand' });
    expect(act(state, 'stranger', { action: 'check', hand: hand.number, seq: hand.seq }, NOW)).toMatchObject({
      ok: false,
      code: 'not_seated',
    });
  });

  it('validates checks, calls, bets and raises', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    expect(attempt(state, 0, 'check')).toMatchObject({ ok: false, code: 'illegal_action' });
    expect(attempt(state, 0, 'bet', 50)).toMatchObject({ ok: false, code: 'illegal_action' }); // must raise
    expect(attempt(state, 0, 'raise', 15)).toMatchObject({ ok: false, code: 'invalid_amount' }); // min is 20
    expect(attempt(state, 0, 'raise', 5000)).toMatchObject({ ok: false, code: 'invalid_amount' });
    expect(attempt(state, 0, 'raise')).toMatchObject({ ok: false, code: 'invalid_amount' });
    play(state, 0, 'raise', 30); // raise of 20
    expect(legalActions(state, 1)!.raise).toMatchObject({ min: 50, max: 1000 }); // next raise ≥ 20 more
    play(state, 1, 'call');
    expect(state.seats[1]!.stack).toBe(970);
    play(state, 2, 'call');
    expect(hand.street).toBe('flop');
    expect(attempt(state, 1, 'call')).toMatchObject({ ok: false, code: 'illegal_action' }); // nothing to call
    expect(attempt(state, 1, 'raise', 40)).toMatchObject({ ok: false, code: 'illegal_action' }); // must bet
    expect(attempt(state, 1, 'bet', 5)).toMatchObject({ ok: false, code: 'invalid_amount' }); // min bet = big blind
    play(state, 1, 'bet', 40);
    expect(hand.currentBet).toBe(40);
  });

  it('an all-in for less than a full raise does not reopen betting', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 25 });
    const hand = deal(state); // dealer 0, SB 1, BB 2 (15 behind)
    play(state, 0, 'raise', 20);
    play(state, 1, 'call');
    play(state, 2, 'allin'); // 25 total: a raise of only 5
    expect(hand.currentBet).toBe(25);
    // Seat 0 already acted at this raise level: may call or fold, not raise.
    expect(legalActions(state, 0)).toMatchObject({ callAmount: 5, raise: null });
    expect(attempt(state, 0, 'raise', 60)).toMatchObject({ ok: false, code: 'illegal_action' });
    expect(attempt(state, 0, 'allin')).toMatchObject({ ok: false, code: 'illegal_action' });
    play(state, 0, 'call');
    expect(legalActions(state, 1)!.raise).toBeNull();
    play(state, 1, 'call');
    expect(hand.street).toBe('flop');
  });

  it('cannot raise when everyone else is all-in', () => {
    const state = table({ 0: 1000, 1: 300 });
    deal(state);
    play(state, 0, 'raise', 300); // seat 0 is the small blind heads-up
    play(state, 1, 'allin');
    // Seat 1 called all-in with exactly 300: nobody left to bet against, board runs out.
    expect(state.hand!.done).toBe(true);
    expect(state.hand!.board).toHaveLength(5);
  });
});

describe('winning chips', () => {
  it('awards the pot when everyone else folds, returning the uncalled bet and showing no cards', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    deal(state);
    play(state, 0, 'raise', 100);
    play(state, 1, 'fold');
    play(state, 2, 'fold');
    expect(state.hand!.done).toBe(true);
    expect(state.lastResult).toMatchObject({ foldWin: true, shown: {} });
    // Seat 0 wins the blinds (5 + 10); their uncalled 90 came back.
    expect(state.seats.slice(0, 3).map((seat) => seat!.stack)).toEqual([1015, 995, 990]);
    expect(totalChips(state)).toBe(3000);
  });

  it('builds side pots and pays each to the best eligible hand', () => {
    const state = table({ 0: 600, 1: 300, 2: 100 });
    const deck = stackedDeck(
      [
        ['7c', '2d'], // seat 0: nothing
        ['Ks', 'Kh'], // seat 1: kings
        ['As', 'Ah'], // seat 2: aces (shortest stack)
      ],
      ['3c', '8d', 'Js', '4h', '9c'],
    );
    deal(state, deck);
    play(state, 0, 'allin');
    play(state, 1, 'allin');
    play(state, 2, 'allin');
    const result = state.lastResult!;
    expect(result.foldWin).toBe(false);
    // Main pot 300 (aces), side pot 400 (kings), seat 0's uncalled 300 returned.
    expect(result.payouts).toEqual({ 2: 300, 1: 400 });
    expect(state.seats.slice(0, 3).map((seat) => seat!.stack)).toEqual([300, 400, 300]);
    expect(result.shown[2]).toEqual({ cards: ['As', 'Ah'], hand: 'Pair of Aces' });
  });

  it('computes pots from contributions, including dead money from folded players', () => {
    const hand = {
      order: [0, 1, 2],
      players: {
        0: { total: 50, folded: false },
        1: { total: 200, folded: false },
        2: { total: 120, folded: true },
      },
    } as unknown as Parameters<typeof computePots>[0];
    expect(computePots(hand)).toEqual([
      { amount: 150, eligible: [0, 1] },
      { amount: 220, eligible: [1] },
    ]);
  });

  it('splits a tied pot and gives the odd chip to the first winner left of the dealer', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const deck = stackedDeck(
      [
        ['2c', '2d'], // seat 0
        ['Kc', 'Qd'], // seat 1 (folds)
        ['3h', '3s'], // seat 2
      ],
      ['5c', '6d', '7h', '8s', '9c'], // straight on the board for everyone left
    );
    deal(state, deck);
    play(state, 0, 'call'); // 10
    play(state, 1, 'fold'); // 5 dead
    play(state, 2, 'check'); // pot 25
    for (let street = 0; street < 3; street++) {
      play(state, state.hand!.turn!, 'check');
      play(state, state.hand!.turn!, 'check');
    }
    expect(state.lastResult!.payouts).toEqual({ 2: 13, 0: 12 }); // seat 2 is first left of the dealer (0)
    expect(totalChips(state)).toBe(3000);
    expect(state.lastResult!.shown[1]).toBeUndefined(); // folded hands stay hidden
  });

  it('runs out the board when nobody can bet any more', () => {
    const state = table({ 0: 500, 1: 500 });
    deal(state);
    play(state, 0, 'allin');
    play(state, 1, 'call');
    expect(state.hand!.board).toHaveLength(5);
    expect(state.hand!.done).toBe(true);
    expect(totalChips(state)).toBe(1000);
  });
});

describe('chip conservation (randomised)', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('never creates or destroys chips across hundreds of random hands', () => {
    for (let game = 0; game < 25; game++) {
      const random = rng(game + 1);
      const players = 2 + Math.floor(random() * 5);
      const stacks: Record<number, number> = {};
      for (let seat = 0; seat < players; seat++) stacks[seat] = 20 + Math.floor(random() * 2000);
      const state = table(stacks);
      const total = totalChips(state);
      const randomInt = (n: number) => Math.floor(random() * n);

      for (let handNo = 0; handNo < 20; handNo++) {
        if (!startHand(state, NOW, everyone, { randomInt })) break;
        let guard = 0;
        while (!state.hand!.done && guard++ < 500) {
          const seat = state.hand!.turn!;
          const legal = legalActions(state, seat)!;
          const options: [PokerActionType, number?][] = [['fold']];
          if (legal.canCheck) options.push(['check'], ['check']);
          else options.push(['call'], ['call']);
          if (legal.raise) {
            const span = legal.raise.max - legal.raise.min;
            options.push([legal.raise.isBet ? 'bet' : 'raise', legal.raise.min + Math.floor(random() * (span + 1))]);
            options.push(['allin']);
          }
          const [action, amount] = options[Math.floor(random() * options.length)];
          play(state, seat, action, amount);
          expect(totalChips(state)).toBe(total);
          expect(state.seats.every((s) => !s || s.stack >= 0)).toBe(true);
        }
        expect(state.hand!.done).toBe(true);
        expect(totalChips(state)).toBe(total);
      }
    }
  });
});

describe('timeouts, leaving and rebuys', () => {
  it('auto-checks or auto-folds on timeout and sits out a player after repeated timeouts', () => {
    const state = table({ 0: 1000, 1: 1000 });
    const hand = deal(state);
    expect(timeout(state, NOW + 1_000)).toBe(false); // not yet
    expect(timeout(state, hand.deadline!)).toBe(true); // seat 0 faces the big blind → folds
    expect(hand.players[0]).toMatchObject({ folded: true, lastAction: 'Fold (time)' });
    expect(state.seats[0]).toMatchObject({ missedTurns: 1, sittingOut: false });

    const next = deal(state); // seat 1 is now dealer/small blind
    play(state, 1, 'call');
    expect(timeout(state, next.deadline!)).toBe(true); // seat 0 (big blind) can check → checks
    expect(next).toMatchObject({ street: 'flop' }); // the check closed the round
    expect(next.players[0].folded).toBe(false);
    expect(state.seats[0]).toMatchObject({ missedTurns: 2, sittingOut: true });
    expect(startHand(state, NOW, everyone)).toBe(false); // hand in progress anyway
  });

  it('a voluntary action resets the missed-turn count', () => {
    const state = table({ 0: 1000, 1: 1000 });
    const hand = deal(state);
    state.seats[0]!.missedTurns = 1;
    play(state, 0, 'call');
    expect(state.seats[0]!.missedTurns).toBe(0);
    expect(hand.turn).toBe(1);
  });

  it('leaving folds the hand, frees the seat afterwards, and can end the hand', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    expect(leave(state, H[1], NOW).ok).toBe(true); // not their turn
    expect(hand.players[1].folded).toBe(true);
    expect(state.seats[1]).not.toBeNull(); // freed when the hand ends
    expect(leave(state, H[2], NOW).ok).toBe(true);
    expect(state.hand!.done).toBe(true); // only seat 0 left
    expect(state.seats[1]).toBeNull();
    expect(state.seats[2]).toBeNull();
    expect(leave(state, H[0], NOW).ok).toBe(true);
    expect(state.seats[0]).toBeNull();
  });

  it('only lets busted players rebuy, between hands', () => {
    const state = table({ 0: 1000, 1: 1000 });
    expect(rebuy(state, H[0], NOW)).toMatchObject({ ok: false, code: 'cannot_rebuy' });
    state.seats[0]!.stack = 0;
    expect(rebuy(state, H[0], NOW).ok).toBe(true);
    expect(state.seats[0]!.stack).toBe(DEFAULT_CONFIG.startingStack);
  });

  it('allows one seat per guest and refuses taken seats', () => {
    const state = table({ 0: 1000 });
    expect(sit(state, H[0], 'P0', NOW)).toMatchObject({ ok: false, code: 'already_seated' });
    expect(sit(state, H[1], 'P1', NOW, 0)).toMatchObject({ ok: false, code: 'seat_taken' });
    for (let seat = 1; seat < 6; seat++) expect(sit(state, H[seat], `P${seat}`, NOW).ok).toBe(true);
    expect(sit(state, 'seventh', 'P6', NOW)).toMatchObject({ ok: false, code: 'table_full' });
  });
});

describe('hidden information', () => {
  const presence = { connected: () => true, spectators: 3 };

  it('the public view never contains hole cards or the deck during a hand', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const hand = deal(state);
    play(state, 0, 'call');
    play(state, 1, 'call');
    play(state, 2, 'check');
    const json = JSON.stringify(publicView(state, presence, NOW));
    for (const seat of hand.order) for (const card of hand.players[seat].hole) expect(json).not.toContain(`"${card}"`);
    for (const card of hand.deck) expect(json).not.toContain(`"${card}"`);
    for (const card of hand.board) expect(json).toContain(`"${card}"`);
    expect(json).not.toContain('hash-');
  });

  it("a player's private view contains only their own cards", () => {
    const state = table({ 0: 1000, 1: 1000 });
    const hand = deal(state);
    const mine = privateView(state, H[0]);
    expect(mine.hole).toEqual(hand.players[0].hole);
    expect(mine.actions).not.toBeNull();
    const json = JSON.stringify(mine);
    for (const card of hand.players[1].hole) expect(json).not.toContain(card);
    expect(privateView(state, null)).toEqual({ seat: null, hole: null, actions: null });
    expect(privateView(state, H[1]).actions).toBeNull(); // not their turn
  });

  it('reveals only hands that reached showdown', () => {
    const state = table({ 0: 1000, 1: 1000, 2: 1000 });
    const deck = stackedDeck(
      [
        ['Ac', 'Ad'],
        ['Kc', 'Kd'],
        ['2h', '7s'],
      ],
      ['3c', '8d', 'Js', '4h', '9c'],
    );
    deal(state, deck);
    play(state, 0, 'call');
    play(state, 1, 'call');
    play(state, 2, 'check');
    play(state, 1, 'check'); // flop: seat 1 first after the dealer
    play(state, 2, 'fold');
    play(state, 0, 'check');
    while (!state.hand!.done) play(state, state.hand!.turn!, 'check');
    const view = publicView(state, presence, NOW);
    expect(view.seats[0]!.shownCards).toEqual(['Ac', 'Ad']);
    expect(view.seats[1]!.shownCards).toEqual(['Kc', 'Kd']);
    expect(view.seats[2]!.shownCards).toBeNull();
    expect(JSON.stringify(view)).not.toContain('"7s"');
    expect(view.lastResult!.winners[0]).toMatchObject({ seat: 0, hand: 'Pair of Aces' });
  });
});
