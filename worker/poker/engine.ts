/**
 * Authoritative No-Limit Texas Hold'em rules for one table.
 *
 * Pure and synchronous: the PokerTable Durable Object owns persistence,
 * networking and timers, and calls these functions to change the state.
 * The full state (including the deck and every hole card) never leaves the
 * server; clients only ever receive `publicView` / `privateView`.
 *
 * Play money only: chips are free, have no value and cannot be transferred.
 */
import {
  MAX_SEATS,
  type LegalActions,
  type PlayerView,
  type PokerActionType,
  type PokerErrorCode,
  type PublicResult,
  type PublicSeat,
  type PublicTable,
  type Street,
  type TableVisibility,
} from '../../shared/poker.ts';
import { secureRandomInt } from '../crypto.ts';
import { fullDeck, shuffle } from './cards.ts';
import { describeHand, evaluateBest, type HandScore } from './evaluator.ts';

export interface PokerConfig {
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  maxSeats: number;
  /** Time each player has to act. */
  actionMs: number;
  /** Pause after a hand so everyone can see the result. */
  nextHandDelayMs: number;
}

export const DEFAULT_CONFIG: PokerConfig = {
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  maxSeats: MAX_SEATS,
  actionMs: 30_000,
  nextHandDelayMs: 5_000,
};

/** Consecutive timeouts after which a player is sat out (so idle tables stop dealing). */
export const MAX_MISSED_TURNS = 2;

export interface SeatState {
  /** SHA-256 hash of the player's guest token (never sent to clients). */
  hash: string;
  name: string;
  stack: number;
  sittingOut: boolean;
  missedTurns: number;
  /** Asked to leave during a hand: the seat is freed when the hand ends. */
  leaving: boolean;
  /** When the player's last connection closed (null while connected). */
  disconnectedAt: number | null;
}

export interface HandPlayer {
  hole: string[];
  /** Chips put in during the current betting round. */
  bet: number;
  /** Chips put in during the whole hand. */
  total: number;
  folded: boolean;
  allIn: boolean;
  /** Value of `fullRaises` when this player last acted this round (-1 = not yet). */
  actedAt: number;
  lastAction: string | null;
}

export interface HandState {
  number: number;
  dealer: number;
  sb: number;
  bb: number;
  /** Undealt cards; dealing pops from the end. */
  deck: string[];
  board: string[];
  street: Street;
  /** Players dealt into this hand, keyed by seat index. */
  players: Record<number, HandPlayer>;
  /** Seat indices dealt in, ascending. */
  order: number[];
  /** Highest bet in the current round. */
  currentBet: number;
  /** Minimum raise increment (the last full bet/raise size). */
  minRaise: number;
  /** Full bets/raises this round; an all-in for less doesn't count (it doesn't reopen betting). */
  fullRaises: number;
  turn: number | null;
  deadline: number | null;
  /** Increments with every action, so stale or replayed commands are rejected. */
  seq: number;
  done: boolean;
}

export interface HandResult {
  hand: number;
  foldWin: boolean;
  payouts: Record<number, number>;
  /** Hands revealed at showdown (only players who reached it). */
  shown: Record<number, { cards: string[]; hand: string }>;
  winners: PublicResult['winners'];
}

export interface TableState {
  tableId: string;
  visibility: TableVisibility;
  config: PokerConfig;
  seats: (SeatState | null)[];
  /** Seat that held the button last hand (-1 before the first hand). */
  dealer: number;
  handCount: number;
  hand: HandState | null;
  lastResult: HandResult | null;
  nextHandAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type EngineResult = { ok: true } | { ok: false; code: PokerErrorCode; message: string };

export interface ActionRequest {
  action: PokerActionType;
  amount?: number;
  hand: number;
  seq: number;
}

const ok: EngineResult = { ok: true };
const fail = (code: PokerErrorCode, message: string): EngineResult => ({ ok: false, code, message });

// ------------------------------------------------------------------ Table

export function createTable(
  tableId: string,
  visibility: TableVisibility,
  now: number,
  config: PokerConfig = DEFAULT_CONFIG,
): TableState {
  return {
    tableId,
    visibility,
    config,
    seats: Array.from({ length: config.maxSeats }, () => null),
    dealer: -1,
    handCount: 0,
    hand: null,
    lastResult: null,
    nextHandAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function seatOf(state: TableState, hash: string): number | null {
  const index = state.seats.findIndex((seat) => seat?.hash === hash);
  return index === -1 ? null : index;
}

export function seatedCount(state: TableState): number {
  return state.seats.filter((seat) => seat !== null).length;
}

/** Next seat clockwise after `from` (wrapping, `from` itself checked last) that satisfies `test`. */
function nextSeat(state: TableState, from: number, test: (seat: number) => boolean): number | null {
  const max = state.config.maxSeats;
  for (let step = 1; step <= max; step++) {
    const seat = (((from + step) % max) + max) % max;
    if (test(seat)) return seat;
  }
  return null;
}

export function sit(state: TableState, hash: string, name: string, now: number, seatIndex?: number): EngineResult {
  if (seatOf(state, hash) !== null) return fail('already_seated', 'You already have a seat at this table.');
  const index = seatIndex ?? state.seats.findIndex((seat) => seat === null);
  if (index === -1 || index >= state.config.maxSeats) return fail('table_full', 'The table is full.');
  if (state.seats[index] !== null) return fail('seat_taken', 'That seat is taken.');
  state.seats[index] = {
    hash,
    name,
    stack: state.config.startingStack,
    sittingOut: false,
    missedTurns: 0,
    leaving: false,
    disconnectedAt: null,
  };
  state.updatedAt = now;
  return ok;
}

export function setName(state: TableState, hash: string, name: string): boolean {
  const index = seatOf(state, hash);
  const seat = index === null ? null : state.seats[index];
  if (!seat || seat.name === name) return false;
  seat.name = name;
  return true;
}

/** Leave the table. In a hand, the player folds now and the seat frees when the hand ends. */
export function leave(state: TableState, hash: string, now: number): EngineResult {
  const index = seatOf(state, hash);
  if (index === null) return fail('not_seated', 'You are not seated.');
  const hand = state.hand;
  const player = hand && !hand.done ? hand.players[index] : undefined;
  if (hand && player) {
    state.seats[index]!.leaving = true;
    if (!player.folded && !player.allIn) {
      player.folded = true;
      player.lastAction = 'Left the table';
      hand.seq += 1;
      if (hand.turn === index) advance(state, now);
      else {
        const live = livePlayers(hand);
        if (live.length === 1) {
          returnUncalled(state);
          awardFoldWin(state, live[0], now);
        }
      }
    }
  } else {
    state.seats[index] = null;
  }
  state.updatedAt = now;
  return ok;
}

/**
 * Free the seats of players who have been disconnected for at least `graceMs`
 * (players still holding cards in a live hand are freed when it ends). Keeps
 * absent players from blocking a table forever. Returns true if any changed.
 */
export function releaseAbsentSeats(state: TableState, now: number, graceMs: number): boolean {
  let changed = false;
  state.seats.forEach((seat, index) => {
    if (!seat || seat.disconnectedAt === null || now - seat.disconnectedAt < graceMs) return;
    const player = state.hand && !state.hand.done ? state.hand.players[index] : undefined;
    if (player) {
      // Still in a live hand: free the seat when the hand ends (they time out meanwhile).
      if (!seat.leaving) {
        seat.leaving = true;
        changed = true;
      }
      return;
    }
    state.seats[index] = null;
    changed = true;
  });
  if (changed) state.updatedAt = now;
  return changed;
}

/** Sit out of the next hands (away = true) or come back. */
export function setAway(state: TableState, hash: string, away: boolean, now: number): EngineResult {
  const index = seatOf(state, hash);
  if (index === null) return fail('not_seated', 'You are not seated.');
  const seat = state.seats[index]!;
  seat.sittingOut = away;
  if (!away) seat.missedTurns = 0;
  state.updatedAt = now;
  return ok;
}

/** Busted players can take another free stack of play chips (between hands). */
export function rebuy(state: TableState, hash: string, now: number): EngineResult {
  const index = seatOf(state, hash);
  if (index === null) return fail('not_seated', 'You are not seated.');
  const seat = state.seats[index]!;
  const player = state.hand && !state.hand.done ? state.hand.players[index] : undefined;
  if (seat.stack > 0 || (player && !player.folded)) {
    return fail('cannot_rebuy', 'You can take more chips once you have run out and are not in a hand.');
  }
  seat.stack = state.config.startingStack;
  seat.sittingOut = false;
  seat.missedTurns = 0;
  state.updatedAt = now;
  return ok;
}

// ------------------------------------------------------------------- Hands

/** Seats that would be dealt into a new hand right now. */
export function eligibleSeats(state: TableState, isConnected: (hash: string) => boolean): number[] {
  const seats: number[] = [];
  state.seats.forEach((seat, index) => {
    if (seat && !seat.sittingOut && !seat.leaving && seat.stack > 0 && isConnected(seat.hash)) seats.push(index);
  });
  return seats;
}

export function handInProgress(state: TableState): boolean {
  return Boolean(state.hand && !state.hand.done);
}

/**
 * Deal a new hand if at least two connected, present players have chips.
 * `options.deck` (tests only) fixes the card order; cards are popped from its end.
 */
export function startHand(
  state: TableState,
  now: number,
  isConnected: (hash: string) => boolean,
  options: { randomInt?: (maxExclusive: number) => number; deck?: string[] } = {},
): boolean {
  if (handInProgress(state)) return false;
  const eligible = eligibleSeats(state, isConnected);
  if (eligible.length < 2) return false;
  const inHand = new Set(eligible);
  const max = state.config.maxSeats;

  const dealer = nextSeat(state, state.dealer < 0 ? max - 1 : state.dealer, (seat) => inHand.has(seat))!;
  // Heads-up: the dealer posts the small blind and acts first before the flop.
  const sb = eligible.length === 2 ? dealer : nextSeat(state, dealer, (seat) => inHand.has(seat))!;
  const bb = nextSeat(state, sb, (seat) => inHand.has(seat))!;

  const deck = options.deck ? [...options.deck] : shuffle(fullDeck(), options.randomInt ?? secureRandomInt);
  const players: Record<number, HandPlayer> = {};
  for (const seat of eligible) {
    players[seat] = { hole: [deck.pop()!, deck.pop()!], bet: 0, total: 0, folded: false, allIn: false, actedAt: -1, lastAction: null };
  }

  const hand: HandState = {
    number: state.handCount + 1,
    dealer,
    sb,
    bb,
    deck,
    board: [],
    street: 'preflop',
    players,
    order: eligible,
    currentBet: state.config.bigBlind,
    minRaise: state.config.bigBlind,
    fullRaises: 0,
    turn: null,
    deadline: null,
    seq: 0,
    done: false,
  };
  state.handCount = hand.number;
  state.dealer = dealer;
  state.hand = hand;
  state.lastResult = null;
  state.nextHandAt = null;
  state.updatedAt = now;

  postBlind(state, sb, state.config.smallBlind, 'Small blind');
  postBlind(state, bb, state.config.bigBlind, 'Big blind');

  // Action starts left of the big blind (the dealer when heads-up).
  const first = nextActor(state, bb);
  if (first === null) endBettingRound(state, now);
  else {
    hand.turn = first;
    hand.deadline = now + state.config.actionMs;
  }
  return true;
}

function postBlind(state: TableState, seat: number, amount: number, label: string): void {
  const player = state.hand!.players[seat];
  pay(state, seat, Math.min(amount, state.seats[seat]!.stack));
  player.lastAction = player.allIn ? `${label} ${player.bet} (all-in)` : `${label} ${player.bet}`;
}

function pay(state: TableState, seat: number, amount: number): void {
  const player = state.hand!.players[seat];
  const holder = state.seats[seat]!;
  holder.stack -= amount;
  player.bet += amount;
  player.total += amount;
  if (holder.stack === 0) player.allIn = true;
}

function livePlayers(hand: HandState): number[] {
  return hand.order.filter((seat) => !hand.players[seat].folded);
}

function needsToAct(hand: HandState, seat: number): boolean {
  const player = hand.players[seat];
  return Boolean(player) && !player.folded && !player.allIn && (player.actedAt === -1 || player.bet < hand.currentBet);
}

/** Who acts next after `from`, or null when the betting round is complete. */
function nextActor(state: TableState, from: number): number | null {
  const hand = state.hand!;
  const canBet = hand.order.filter((seat) => !hand.players[seat].folded && !hand.players[seat].allIn);
  if (canBet.length === 0) return null;
  // The last player with chips only has a decision to make if they face a bet.
  if (canBet.length === 1 && hand.players[canBet[0]].bet >= hand.currentBet) return null;
  return nextSeat(state, from, (seat) => needsToAct(hand, seat));
}

export function legalActions(state: TableState, seat: number): LegalActions | null {
  const hand = state.hand;
  if (!hand || hand.done || hand.turn !== seat) return null;
  const player = hand.players[seat];
  const holder = state.seats[seat];
  if (!player || !holder) return null;
  const toCall = Math.max(0, hand.currentBet - player.bet);
  const maxTo = player.bet + holder.stack;
  const othersCanRespond = hand.order.some(
    (other) => other !== seat && !hand.players[other].folded && !hand.players[other].allIn,
  );
  // Betting is reopened for this player unless only an all-in for less happened since they acted.
  const reopened = player.actedAt === -1 || player.actedAt < hand.fullRaises;
  const canRaise = holder.stack > toCall && reopened && othersCanRespond;
  const minTo = hand.currentBet === 0 ? state.config.bigBlind : hand.currentBet + hand.minRaise;
  return {
    canCheck: toCall === 0,
    callAmount: Math.min(toCall, holder.stack),
    raise: canRaise ? { min: Math.min(minTo, maxTo), max: maxTo, isBet: hand.currentBet === 0 } : null,
  };
}

export function act(state: TableState, hash: string, request: ActionRequest, now: number): EngineResult {
  const hand = state.hand;
  if (!hand || hand.done) return fail('no_hand', 'No hand is being played right now.');
  if (request.hand !== hand.number || request.seq !== hand.seq) {
    return fail('stale', 'The table moved on before your action arrived, so it was not applied.');
  }
  const seat = seatOf(state, hash);
  if (seat === null) return fail('not_seated', 'Take a seat to play.');
  const player = hand.players[seat];
  if (!player || player.folded) return fail('not_in_hand', "You're not in this hand.");
  if (hand.turn !== seat) return fail('not_your_turn', "It's not your turn.");
  const holder = state.seats[seat]!;
  const legal = legalActions(state, seat)!;
  const toCall = Math.max(0, hand.currentBet - player.bet);

  switch (request.action) {
    case 'fold':
      player.folded = true;
      player.lastAction = 'Fold';
      break;
    case 'check':
      if (toCall > 0) return fail('illegal_action', `You need to call ${legal.callAmount} or fold.`);
      player.lastAction = 'Check';
      break;
    case 'call':
      if (toCall === 0) return fail('illegal_action', 'There is nothing to call. Check instead.');
      pay(state, seat, legal.callAmount);
      player.lastAction = player.allIn ? `All-in ${player.bet}` : `Call ${player.bet}`;
      break;
    case 'bet':
    case 'raise': {
      if (!legal.raise) return fail('illegal_action', 'You can only call or fold here.');
      if (request.action === 'bet' && !legal.raise.isBet) return fail('illegal_action', 'There is already a bet. Raise instead.');
      if (request.action === 'raise' && legal.raise.isBet) return fail('illegal_action', 'Nobody has bet yet. Bet instead.');
      const to = request.amount;
      if (to === undefined) return fail('invalid_amount', 'Choose an amount.');
      if (to > legal.raise.max) return fail('invalid_amount', `You only have ${legal.raise.max} in total.`);
      if (to < legal.raise.min) return fail('invalid_amount', `The minimum is ${legal.raise.min}.`);
      raiseTo(state, seat, to);
      break;
    }
    case 'allin':
      if (holder.stack <= toCall) {
        pay(state, seat, holder.stack);
        player.lastAction = `All-in ${player.bet}`;
      } else {
        if (!legal.raise) return fail('illegal_action', 'Betting was not reopened, so you can only call or fold.');
        raiseTo(state, seat, player.bet + holder.stack);
      }
      break;
  }

  player.actedAt = hand.fullRaises;
  holder.missedTurns = 0;
  hand.seq += 1;
  state.updatedAt = now;
  advance(state, now);
  return ok;
}

function raiseTo(state: TableState, seat: number, to: number): void {
  const hand = state.hand!;
  const player = hand.players[seat];
  const opening = hand.currentBet === 0;
  const raiseSize = to - hand.currentBet;
  pay(state, seat, to - player.bet);
  // Only a full raise sets a new minimum and reopens betting for players who already acted.
  if (raiseSize >= hand.minRaise) {
    hand.minRaise = raiseSize;
    hand.fullRaises += 1;
  }
  hand.currentBet = to;
  player.lastAction = player.allIn ? `All-in ${to}` : opening ? `Bet ${to}` : `Raise to ${to}`;
}

/** The player to act ran out of time: check if possible, otherwise fold. */
export function timeout(state: TableState, now: number): boolean {
  const hand = state.hand;
  if (!hand || hand.done || hand.turn === null || hand.deadline === null || now < hand.deadline) return false;
  const seat = hand.turn;
  const player = hand.players[seat];
  const holder = state.seats[seat]!;
  if (hand.currentBet > player.bet) {
    player.folded = true;
    player.lastAction = 'Fold (time)';
  } else {
    player.lastAction = 'Check (time)';
  }
  player.actedAt = hand.fullRaises;
  holder.missedTurns += 1;
  if (holder.missedTurns >= MAX_MISSED_TURNS) holder.sittingOut = true;
  hand.seq += 1;
  state.updatedAt = now;
  advance(state, now);
  return true;
}

function advance(state: TableState, now: number): void {
  const hand = state.hand!;
  const live = livePlayers(hand);
  if (live.length === 1) {
    returnUncalled(state);
    awardFoldWin(state, live[0], now);
    return;
  }
  const next = nextActor(state, hand.turn ?? hand.dealer);
  if (next !== null) {
    hand.turn = next;
    hand.deadline = now + state.config.actionMs;
    return;
  }
  endBettingRound(state, now);
}

/** Give back the part of the biggest bet that nobody matched. */
function returnUncalled(state: TableState): void {
  const hand = state.hand!;
  const bets = hand.order.map((seat) => ({ seat, bet: hand.players[seat].bet })).sort((a, b) => b.bet - a.bet);
  if (bets.length < 2) return;
  const excess = bets[0].bet - bets[1].bet;
  if (excess <= 0) return;
  const player = hand.players[bets[0].seat];
  const holder = state.seats[bets[0].seat]!;
  player.bet -= excess;
  player.total -= excess;
  holder.stack += excess;
  if (holder.stack > 0) player.allIn = false;
}

function endBettingRound(state: TableState, now: number): void {
  const hand = state.hand!;
  returnUncalled(state);
  for (const seat of hand.order) {
    const player = hand.players[seat];
    player.bet = 0;
    player.actedAt = -1;
    if (!player.folded && !player.allIn) player.lastAction = null;
  }
  hand.currentBet = 0;
  hand.minRaise = state.config.bigBlind;
  hand.fullRaises = 0;
  hand.turn = null;
  hand.deadline = null;

  // Deal streets until a betting round is possible (or run out the board).
  for (;;) {
    if (hand.street === 'river') {
      showdown(state, now);
      return;
    }
    dealStreet(hand);
    const canBet = hand.order.filter((seat) => !hand.players[seat].folded && !hand.players[seat].allIn);
    if (canBet.length >= 2) {
      hand.turn = nextSeat(state, hand.dealer, (seat) => canBet.includes(seat));
      hand.deadline = now + state.config.actionMs;
      return;
    }
  }
}

function dealStreet(hand: HandState): void {
  hand.deck.pop(); // burn card
  if (hand.street === 'preflop') {
    hand.board.push(hand.deck.pop()!, hand.deck.pop()!, hand.deck.pop()!);
    hand.street = 'flop';
  } else {
    hand.board.push(hand.deck.pop()!);
    hand.street = hand.street === 'flop' ? 'turn' : 'river';
  }
}

export interface Pot {
  amount: number;
  eligible: number[];
}

/** Main pot and side pots from everyone's total contribution this hand. */
export function computePots(hand: HandState): Pot[] {
  const contributions = hand.order.map((seat) => ({ seat, total: hand.players[seat].total, live: !hand.players[seat].folded }));
  const levels = [...new Set(contributions.filter((c) => c.live && c.total > 0).map((c) => c.total))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contributions) amount += Math.max(0, Math.min(c.total, level) - Math.min(c.total, previous));
    const eligible = contributions.filter((c) => c.live && c.total >= level).map((c) => c.seat);
    if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }
  // Chips from folded players above every live player's level go to the last pot.
  const counted = pots.reduce((sum, pot) => sum + pot.amount, 0);
  const total = contributions.reduce((sum, c) => sum + c.total, 0);
  if (total > counted && pots.length > 0) pots[pots.length - 1].amount += total - counted;
  return pots;
}

/** Seats in the order odd chips are handed out: starting left of the dealer. */
function leftOfDealerOrder(state: TableState, seats: number[]): number[] {
  const max = state.config.maxSeats;
  const dealer = state.hand!.dealer;
  return [...seats].sort((a, b) => ((a - dealer - 1 + max) % max) - ((b - dealer - 1 + max) % max));
}

function showdown(state: TableState, now: number): void {
  const hand = state.hand!;
  const live = livePlayers(hand);
  const scores = new Map<number, HandScore>();
  for (const seat of live) scores.set(seat, evaluateBest([...hand.players[seat].hole, ...hand.board]));

  const payouts: Record<number, number> = {};
  for (const pot of computePots(hand)) {
    const best = Math.max(...pot.eligible.map((seat) => scores.get(seat)!.score));
    const winners = leftOfDealerOrder(
      state,
      pot.eligible.filter((seat) => scores.get(seat)!.score === best),
    );
    const share = Math.floor(pot.amount / winners.length);
    let oddChips = pot.amount - share * winners.length;
    for (const seat of winners) {
      payouts[seat] = (payouts[seat] ?? 0) + share + (oddChips > 0 ? 1 : 0);
      if (oddChips > 0) oddChips -= 1;
    }
  }
  const shown: HandResult['shown'] = {};
  for (const seat of live) shown[seat] = { cards: [...hand.players[seat].hole], hand: describeHand(scores.get(seat)!) };
  finishHand(state, { hand: hand.number, foldWin: false, payouts, shown, winners: winnersList(state, payouts, shown) }, now);
}

function awardFoldWin(state: TableState, winner: number, now: number): void {
  const hand = state.hand!;
  const pot = hand.order.reduce((sum, seat) => sum + hand.players[seat].total, 0);
  const payouts = { [winner]: pot };
  finishHand(state, { hand: hand.number, foldWin: true, payouts, shown: {}, winners: winnersList(state, payouts, {}) }, now);
}

function winnersList(state: TableState, payouts: Record<number, number>, shown: HandResult['shown']): PublicResult['winners'] {
  return Object.entries(payouts)
    .map(([seat, amount]) => ({
      seat: Number(seat),
      name: state.seats[Number(seat)]?.name ?? 'Player',
      amount,
      hand: shown[Number(seat)]?.hand ?? null,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function finishHand(state: TableState, result: HandResult, now: number): void {
  const hand = state.hand!;
  for (const [seat, amount] of Object.entries(result.payouts)) state.seats[Number(seat)]!.stack += amount;
  hand.done = true;
  hand.turn = null;
  hand.deadline = null;
  state.lastResult = result;
  state.seats = state.seats.map((seat) => (seat?.leaving ? null : seat));
  state.nextHandAt = now + state.config.nextHandDelayMs;
  state.updatedAt = now;
}

/** Chips on the table right now: all stacks plus everything committed to the current hand. */
export function totalChips(state: TableState): number {
  const stacks = state.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0), 0);
  const hand = state.hand;
  const committed = hand && !hand.done ? hand.order.reduce((sum, seat) => sum + hand.players[seat].total, 0) : 0;
  return stacks + committed;
}

// ------------------------------------------------------------------- Views

export interface TablePresence {
  connected: (hash: string) => boolean;
  spectators: number;
}

/** What everyone (players and spectators) may see. Never includes the deck or unrevealed hole cards. */
export function publicView(state: TableState, presence: TablePresence, now: number): PublicTable {
  const hand = state.hand;
  const result = state.lastResult;
  const showdown = hand?.done && result && result.hand === hand.number ? result : null;
  const seats = state.seats.map((seat, index): PublicSeat | null => {
    if (!seat) return null;
    const player = hand?.players[index];
    const shown = showdown?.shown[index];
    return {
      name: seat.name,
      stack: seat.stack,
      connected: presence.connected(seat.hash),
      away: seat.sittingOut,
      inHand: Boolean(player),
      hasCards: Boolean(player && !player.folded && !hand!.done),
      folded: Boolean(player?.folded),
      allIn: Boolean(player?.allIn),
      bet: player && !hand!.done ? player.bet : 0,
      lastAction: player?.lastAction ?? null,
      shownCards: shown ? [...shown.cards] : null,
      shownHand: shown?.hand ?? null,
    };
  });
  return {
    tableId: state.tableId,
    visibility: state.visibility,
    smallBlind: state.config.smallBlind,
    bigBlind: state.config.bigBlind,
    startingStack: state.config.startingStack,
    maxSeats: state.config.maxSeats,
    actionMs: state.config.actionMs,
    seats,
    hand: hand
      ? {
          number: hand.number,
          street: hand.street,
          board: [...hand.board],
          pot: hand.order.reduce((sum, seat) => sum + hand.players[seat].total, 0),
          currentBet: hand.currentBet,
          turn: hand.turn,
          deadline: hand.deadline,
          dealer: hand.dealer,
          smallBlind: hand.sb,
          bigBlind: hand.bb,
          seq: hand.seq,
          done: hand.done,
        }
      : null,
    lastResult: result ? { hand: result.hand, foldWin: result.foldWin, winners: result.winners } : null,
    nextHandAt: state.nextHandAt,
    spectators: presence.spectators,
    serverTime: now,
  };
}

/** What one guest may additionally see: their own seat, hole cards and legal actions. */
export function privateView(state: TableState, hash: string | null): PlayerView {
  const seat = hash ? seatOf(state, hash) : null;
  if (seat === null) return { seat: null, hole: null, actions: null };
  const player = state.hand?.players[seat];
  return { seat, hole: player ? [...player.hole] : null, actions: legalActions(state, seat) };
}
