/**
 * Pure, synchronous match logic — the authoritative chess rules for a room.
 *
 * The Durable Object (chess-room.ts) owns persistence and networking and
 * delegates every decision to this class, which keeps it unit-testable.
 * Methods never await, so each action runs atomically inside the object.
 */
import { Chess } from 'chess.js';
import {
  opposite,
  type Color,
  type EndReason,
  type ErrorCode,
  type GameEnd,
  type MatchStatus,
  type MoveInfo,
  type PieceType,
  type PromotionPiece,
  type Role,
  type RoomKind,
  type RoomSnapshot,
  type RoomTimers,
  type SeatInfo,
} from '../shared/protocol.ts';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The persisted room row. Seats hold SHA-256 hashes of guest tokens. */
export interface MatchRecord {
  roomId: string;
  kind: RoomKind;
  game: number;
  white: string | null;
  black: string | null;
  fen: string;
  status: MatchStatus;
  end: GameEnd | null;
  rematch: Record<Color, boolean>;
  drawOffer: Color | null;
  createdAt: number;
  updatedAt: number;
  /** World room only: when a seated player was last seen leaving. */
  awaySince: Record<Color, number | null>;
  /** When the current player's turn began (null unless a game is active). */
  turnStartedAt: number | null;
  /** When the current game finished (null unless it is over). */
  endedAt: number | null;
}

/** One persisted half-move of the current game. */
export interface MoveRecord extends MoveInfo {
  ply: number;
  /** Position after the move. */
  fen: string;
  /** Position identity used for threefold-repetition detection. */
  key: string;
  at: number;
}

/** What the caller must persist after a successful action. */
export interface Changes {
  /** A new game started: all stored moves must be replaced. */
  newGame: boolean;
  /** A move to append to the stored move list. */
  appendMove: MoveRecord | null;
}

export type ActionResult =
  | { ok: true; changes: Changes }
  | { ok: false; code: ErrorCode; message: string };

export interface MoveProposal {
  from: string;
  to: string;
  promotion?: PromotionPiece;
  expectedPly: number;
}

export interface Presence {
  online: Record<Color, boolean>;
  spectators: number;
}

const COLORS: readonly Color[] = ['w', 'b'];

/**
 * Two positions are "the same" for repetition purposes when piece placement,
 * side to move, castling rights and en-passant possibilities match — i.e. the
 * first four FEN fields. chess.js only writes an en-passant square when a
 * capture is actually possible, which is exactly the FIDE definition.
 */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function fail(code: ErrorCode, message: string): ActionResult {
  return { ok: false, code, message };
}

function ok(changes: Partial<Changes> = {}): ActionResult {
  return { ok: true, changes: { newGame: false, appendMove: null, ...changes } };
}

export class Match {
  record: MatchRecord;
  moves: MoveRecord[];

  constructor(record: MatchRecord, moves: MoveRecord[]) {
    this.record = record;
    this.moves = moves;
  }

  static create(roomId: string, kind: RoomKind, now: number): Match {
    return new Match(
      {
        roomId,
        kind,
        game: 1,
        white: null,
        black: null,
        fen: START_FEN,
        status: 'waiting',
        end: null,
        rematch: { w: false, b: false },
        drawOffer: null,
        createdAt: now,
        updatedAt: now,
        awaySince: { w: null, b: null },
        turnStartedAt: null,
        endedAt: null,
      },
      [],
    );
  }

  seat(color: Color): string | null {
    return color === 'w' ? this.record.white : this.record.black;
  }

  private setSeat(color: Color, hash: string | null): void {
    if (color === 'w') this.record.white = hash;
    else this.record.black = hash;
  }

  colorOf(hash: string): Color | null {
    if (this.record.white === hash) return 'w';
    if (this.record.black === hash) return 'b';
    return null;
  }

  roleOf(hash: string): Role {
    return this.colorOf(hash) ?? 'spectator';
  }

  get ply(): number {
    return this.moves.length;
  }

  turn(): Color {
    return this.record.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  }

  /**
   * Give `hash` a seat if one is free. Called when a visitor connects and when
   * a spectator explicitly asks to sit. Returns the visitor's role afterwards.
   */
  claimSeat(hash: string, now: number, preferred?: Color): { role: Role; changed: boolean } {
    const existing = this.colorOf(hash);
    if (existing) return { role: existing, changed: false };

    const free = COLORS.filter((color) => this.seat(color) === null);
    if (free.length === 0) return { role: 'spectator', changed: false };
    const color = preferred && free.includes(preferred) ? preferred : free[0];

    this.setSeat(color, hash);
    this.record.awaySince[color] = null;
    this.record.updatedAt = now;

    if (this.record.white && this.record.black) {
      if (this.record.status === 'waiting') {
        this.record.status = 'active';
        this.record.turnStartedAt = now;
      } else if (this.record.status === 'over') {
        // A new opponent sat down after a finished game: start a fresh one.
        this.startNewGame(false, now);
      }
    }
    return { role: color, changed: true };
  }

  move(hash: string, proposal: MoveProposal, now: number): ActionResult {
    const color = this.colorOf(hash);
    if (!color) return fail('not_a_player', 'Spectators can watch but not move.');
    if (this.record.status === 'waiting') {
      return fail('game_not_active', 'Waiting for an opponent to join.');
    }
    if (this.record.status === 'over') return fail('game_not_active', 'This game is over.');
    if (proposal.expectedPly !== this.ply) {
      return fail('stale', 'Your board was out of date, so the move was not played.');
    }
    if (this.turn() !== color) return fail('not_your_turn', "It's not your turn.");

    const chess = new Chess(this.record.fen);
    let played;
    try {
      played = chess.move({ from: proposal.from, to: proposal.to, promotion: proposal.promotion });
    } catch {
      return fail('illegal_move', 'That move is not legal.');
    }

    const fen = chess.fen();
    const record: MoveRecord = {
      ply: this.ply + 1,
      san: played.san,
      from: played.from,
      to: played.to,
      color,
      fen,
      key: positionKey(fen),
      at: now,
    };
    if (played.promotion) record.promotion = played.promotion as PromotionPiece;
    if (played.captured) record.captured = played.captured as PieceType;

    this.moves.push(record);
    this.record.fen = fen;
    this.record.updatedAt = now;
    this.record.turnStartedAt = now;
    // Moving declines a pending draw offer from the opponent.
    if (this.record.drawOffer === opposite(color)) this.record.drawOffer = null;

    if (chess.isCheckmate()) this.finish(color, 'checkmate', now);
    else if (chess.isStalemate()) this.finish(null, 'stalemate', now);
    else if (chess.isInsufficientMaterial()) this.finish(null, 'insufficient_material', now);
    else if (this.repetitions(record.key) >= 3) this.finish(null, 'threefold_repetition', now);
    else if (chess.isDrawByFiftyMoves()) this.finish(null, 'fifty_move_rule', now);

    return ok({ appendMove: record });
  }

  /** How many times a position has occurred in the current game. */
  repetitions(key: string): number {
    let count = positionKey(START_FEN) === key ? 1 : 0;
    for (const move of this.moves) if (move.key === key) count++;
    return count;
  }

  resign(hash: string, game: number, now: number): ActionResult {
    const color = this.colorOf(hash);
    if (!color) return fail('not_a_player', 'Only players can resign.');
    if (game !== this.record.game) return fail('stale', 'That game has already finished.');
    if (this.record.status !== 'active') return fail('game_not_active', 'There is no game to resign.');
    this.finish(opposite(color), 'resignation', now);
    this.record.updatedAt = now;
    return ok();
  }

  draw(hash: string, action: 'offer' | 'accept' | 'decline', game: number, now: number): ActionResult {
    const color = this.colorOf(hash);
    if (!color) return fail('not_a_player', 'Only players can offer draws.');
    if (game !== this.record.game) return fail('stale', 'That game has already finished.');
    if (this.record.status !== 'active') return fail('game_not_active', 'The game is not in progress.');
    const offer = this.record.drawOffer;

    if (action === 'offer') {
      if (offer === color) return fail('nothing_to_do', 'You already offered a draw.');
      // Offering when the opponent already offered is an acceptance.
      if (offer === opposite(color)) this.finish(null, 'agreement', now);
      else this.record.drawOffer = color;
    } else if (action === 'accept') {
      if (offer !== opposite(color)) return fail('nothing_to_do', 'There is no draw offer to accept.');
      this.finish(null, 'agreement', now);
    } else {
      if (offer === null) return fail('nothing_to_do', 'There is no draw offer.');
      this.record.drawOffer = null;
    }
    this.record.updatedAt = now;
    return ok();
  }

  rematch(hash: string, want: boolean, game: number, now: number): ActionResult {
    const color = this.colorOf(hash);
    if (!color) return fail('not_a_player', 'Only players can ask for a rematch.');
    if (this.record.kind === 'world') {
      return fail('not_allowed', 'On the World Board the seats open up for new players after each game.');
    }
    if (game !== this.record.game) return fail('stale', 'A newer game has already started.');
    if (this.record.status !== 'over') return fail('game_not_over', 'The game is still in progress.');
    if (!this.record.white || !this.record.black) {
      return fail('game_not_active', 'Your opponent left. Waiting for a new opponent.');
    }
    this.record.rematch[color] = want;
    this.record.updatedAt = now;
    if (this.record.rematch.w && this.record.rematch.b) {
      // Both agreed: play again with colours swapped.
      this.startNewGame(true, now);
      return ok({ newGame: true });
    }
    return ok();
  }

  /** A player gives up their seat. Leaving a game in progress forfeits it. */
  leave(hash: string, now: number): ActionResult {
    const color = this.colorOf(hash);
    if (!color) return fail('not_a_player', 'You are not seated.');
    this.vacate(color, 'resignation', now);
    this.record.updatedAt = now;
    return ok();
  }

  /** World room: a player who stayed disconnected too long loses their seat. */
  forfeitAbsent(color: Color, now: number): ActionResult {
    if (!this.seat(color)) return fail('nothing_to_do', 'Seat is already free.');
    this.vacate(color, 'abandonment', now);
    this.record.updatedAt = now;
    return ok();
  }

  /**
   * World room: the player to move took too long. Before the first move they
   * just lose the seat; after that they lose the game on time.
   */
  timeoutTurn(now: number): ActionResult {
    if (this.record.status !== 'active') return fail('game_not_active', 'No game in progress.');
    const color = this.turn();
    if (this.ply === 0) this.vacate(color, 'abandonment', now);
    else this.finish(opposite(color), 'timeout', now);
    this.record.updatedAt = now;
    return ok();
  }

  /**
   * World room: empty both seats and set up a fresh board — after a finished
   * game, or when both players vanished (nobody wins a game nobody finished).
   */
  resetBoard(now: number): ActionResult {
    this.record.white = null;
    this.record.black = null;
    this.record.awaySince = { w: null, b: null };
    this.startNewGame(false, now);
    this.record.updatedAt = now;
    return ok({ newGame: true });
  }

  private vacate(color: Color, reason: 'resignation' | 'abandonment', now: number): void {
    if (this.record.status === 'active') {
      if (this.ply > 0) this.finish(opposite(color), reason, now);
      else {
        this.record.status = 'waiting';
        this.record.turnStartedAt = null;
      }
    }
    this.setSeat(color, null);
    this.record.awaySince[color] = null;
    this.record.rematch = { w: false, b: false };
    this.record.drawOffer = null;
    // Nobody left at a finished board: reset it, so whoever sits next starts a
    // fresh game instead of inheriting the old result.
    if (!this.record.white && !this.record.black && this.record.status === 'over') {
      this.startNewGame(false, now);
    }
  }

  private finish(winner: Color | null, reason: EndReason, now: number): void {
    this.record.status = 'over';
    this.record.end = { winner, reason };
    this.record.drawOffer = null;
    this.record.rematch = { w: false, b: false };
    this.record.turnStartedAt = null;
    this.record.endedAt = now;
  }

  private startNewGame(swapColors: boolean, now: number): void {
    if (swapColors) {
      const { white, black } = this.record;
      this.record.white = black;
      this.record.black = white;
      const away = this.record.awaySince;
      this.record.awaySince = { w: away.b, b: away.w };
    }
    this.record.game += 1;
    this.record.fen = START_FEN;
    this.record.status = this.record.white && this.record.black ? 'active' : 'waiting';
    this.record.end = null;
    this.record.rematch = { w: false, b: false };
    this.record.drawOffer = null;
    this.record.turnStartedAt = this.record.status === 'active' ? now : null;
    this.record.endedAt = null;
    this.moves = [];
  }

  snapshot(presence: Presence, timers: RoomTimers | null = null): RoomSnapshot {
    const seat = (color: Color): SeatInfo => ({
      taken: this.seat(color) !== null,
      online: this.seat(color) !== null && presence.online[color],
    });
    return {
      roomId: this.record.roomId,
      kind: this.record.kind,
      game: this.record.game,
      fen: this.record.fen,
      ply: this.ply,
      moves: this.moves.map(({ san, from, to, color, promotion, captured }) => {
        const move: MoveInfo = { san, from, to, color };
        if (promotion) move.promotion = promotion;
        if (captured) move.captured = captured;
        return move;
      }),
      status: this.record.status,
      end: this.record.end,
      seats: { w: seat('w'), b: seat('b') },
      rematch: { ...this.record.rematch },
      drawOffer: this.record.drawOffer,
      spectators: presence.spectators,
      timers,
    };
  }
}
