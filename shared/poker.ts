/**
 * Poker wire protocol and the views the server sends.
 *
 * Poker has hidden information, so the server never sends a full game state.
 * Every client gets the public table view; a seated player additionally gets
 * only their own hole cards and legal actions. The deck and other players'
 * cards stay inside the PokerTable Durable Object (until a showdown reveals
 * the hands that reached it).
 *
 * Chips are free play money with no value: not purchasable, transferable or
 * redeemable.
 */
import { MAX_CLIENT_MESSAGE_BYTES, isValidToken } from './protocol.ts';

export const POKER_PROTOCOL_VERSION = 1;
export const MAX_SEATS = 6;

export type PokerActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type TableVisibility = 'public' | 'private';

export type PokerClientMessage =
  | { type: 'hello'; token: string; protocol: number; name?: string; sit?: boolean }
  /** Take a seat (a specific one, or any free one). */
  | { type: 'sit'; seat?: number }
  /** Leave the table (folds a hand in progress). */
  | { type: 'leave' }
  /** `hand` and `seq` must match the current hand and action number (rejects stale or replayed commands). */
  | { type: 'act'; action: PokerActionType; amount?: number; hand: number; seq: number }
  /** Sit out (away: true) or come back. */
  | { type: 'away'; away: boolean }
  /** Busted? Take another free 1,000 play chips. */
  | { type: 'rebuy' };

export type PokerErrorCode =
  | 'bad_message'
  | 'unsupported_version'
  | 'not_authenticated'
  | 'table_not_found'
  | 'table_full'
  | 'seat_taken'
  | 'already_seated'
  | 'not_seated'
  | 'not_in_hand'
  | 'not_your_turn'
  | 'no_hand'
  | 'stale'
  | 'illegal_action'
  | 'invalid_amount'
  | 'cannot_rebuy'
  | 'room_full'
  | 'unavailable';

export interface PublicSeat {
  name: string;
  stack: number;
  connected: boolean;
  /** Sitting out (by choice or after missing turns). */
  away: boolean;
  /** Dealt into the current (or just finished) hand. */
  inHand: boolean;
  /** Holds cards right now (in the hand and not folded). */
  hasCards: boolean;
  folded: boolean;
  allIn: boolean;
  /** Chips put in during the current betting round. */
  bet: number;
  lastAction: string | null;
  /** Revealed at showdown only. */
  shownCards: string[] | null;
  shownHand: string | null;
}

export interface PublicHand {
  number: number;
  street: Street;
  /** Community cards dealt so far. */
  board: string[];
  /** Everything committed this hand, including current bets. */
  pot: number;
  currentBet: number;
  turn: number | null;
  /** When the player to act times out (server epoch ms). */
  deadline: number | null;
  dealer: number;
  smallBlind: number;
  bigBlind: number;
  /** Action counter; clients echo it with their action. */
  seq: number;
  done: boolean;
}

export interface PublicResult {
  hand: number;
  foldWin: boolean;
  winners: { seat: number; name: string; amount: number; hand: string | null }[];
}

export interface PublicTable {
  tableId: string;
  visibility: TableVisibility;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  maxSeats: number;
  actionMs: number;
  seats: (PublicSeat | null)[];
  hand: PublicHand | null;
  lastResult: PublicResult | null;
  /** When the next hand is scheduled to start, if one is. */
  nextHandAt: number | null;
  spectators: number;
  serverTime: number;
}

export interface LegalActions {
  canCheck: boolean;
  /** Chips needed to call (0 when checking is possible); may be an all-in for less. */
  callAmount: number;
  /** Bet/raise limits as "raise to" totals for this betting round, or null if raising isn't allowed. */
  raise: { min: number; max: number; isBet: boolean } | null;
}

export interface PlayerView {
  seat: number | null;
  /** Your own two hole cards, or null if you aren't in the hand. */
  hole: string[] | null;
  /** Your legal actions when it's your turn. */
  actions: LegalActions | null;
}

export type PokerServerMessage =
  | { type: 'state'; you: PlayerView; table: PublicTable }
  | { type: 'error'; code: PokerErrorCode; message: string };

const ACTIONS: readonly PokerActionType[] = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

function isCount(value: unknown, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

export function parsePokerMessage(raw: string): PokerClientMessage | null {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(msg).every((key) => keys.includes(key));

  switch (msg.type) {
    case 'hello': {
      if (!only('type', 'token', 'protocol', 'name', 'sit')) return null;
      if (!isValidToken(msg.token) || !isCount(msg.protocol)) return null;
      if (msg.name !== undefined && (typeof msg.name !== 'string' || msg.name.length > 64)) return null;
      if (msg.sit !== undefined && typeof msg.sit !== 'boolean') return null;
      const hello: PokerClientMessage = { type: 'hello', token: msg.token, protocol: msg.protocol };
      if (msg.name !== undefined) hello.name = msg.name;
      if (msg.sit !== undefined) hello.sit = msg.sit;
      return hello;
    }
    case 'sit':
      if (!only('type', 'seat')) return null;
      if (msg.seat !== undefined && !(isCount(msg.seat) && msg.seat < MAX_SEATS)) return null;
      return msg.seat === undefined ? { type: 'sit' } : { type: 'sit', seat: msg.seat };
    case 'leave':
    case 'rebuy':
      return only('type') ? { type: msg.type } : null;
    case 'away':
      if (!only('type', 'away') || typeof msg.away !== 'boolean') return null;
      return { type: 'away', away: msg.away };
    case 'act': {
      if (!only('type', 'action', 'amount', 'hand', 'seq')) return null;
      if (!ACTIONS.includes(msg.action as PokerActionType)) return null;
      if (!isCount(msg.hand) || !isCount(msg.seq)) return null;
      if (msg.amount !== undefined && !isCount(msg.amount)) return null;
      const act: PokerClientMessage = { type: 'act', action: msg.action as PokerActionType, hand: msg.hand, seq: msg.seq };
      if (msg.amount !== undefined) act.amount = msg.amount;
      return act;
    }
    default:
      return null;
  }
}
