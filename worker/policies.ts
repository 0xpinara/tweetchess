/**
 * How each kind of chess room behaves. Pure data, shared by the rules
 * (match.ts) and the Durable Object's timers (chess-room.ts).
 *
 * - private: created with "Play with a Friend". Seats are reserved forever,
 *            no clocks; deleted after 30 days without activity.
 * - world:   the permanent public board at /world. Seats rotate between games
 *            and timers keep anyone from blocking it.
 * - match:   created by matchmaking for two strangers. Seats are pre-assigned,
 *            a move timer applies, and a no-show aborts the game.
 */
import type { RoomKind } from '../shared/protocol.ts';

export interface RoomPolicy {
  /** New visitors may take a free seat. */
  openSeating: boolean;
  /** A seated player offline this long loses their seat (and the game if moves were made). */
  seatGraceMs: number | null;
  /** Time allowed for each move. */
  turnLimitMs: number | null;
  /** After a finished game, empty the seats for new players after this long. */
  rotateSeatsAfterMs: number | null;
  /** Players may agree to a rematch. */
  rematch: boolean;
  /** Delete the room after this long without activity once nobody is connected. */
  ttlMs: number | null;
  /** A player who disappears before the first move aborts the game (no seat reopening). */
  abortWithoutMoves: boolean;
  /** Shown in the public live-games directory regardless of the creator's choice. */
  alwaysListed: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export const POLICIES: Record<RoomKind, RoomPolicy> = {
  private: {
    openSeating: true,
    seatGraceMs: null,
    turnLimitMs: null,
    rotateSeatsAfterMs: null,
    rematch: true,
    ttlMs: 30 * DAY,
    abortWithoutMoves: false,
    alwaysListed: false,
  },
  world: {
    openSeating: true,
    seatGraceMs: 60 * SECOND,
    turnLimitMs: 3 * MINUTE,
    rotateSeatsAfterMs: 30 * SECOND,
    rematch: false,
    ttlMs: null,
    abortWithoutMoves: false,
    alwaysListed: true,
  },
  match: {
    openSeating: false,
    seatGraceMs: 90 * SECOND,
    turnLimitMs: 3 * MINUTE,
    rotateSeatsAfterMs: null,
    rematch: true,
    ttlMs: DAY,
    abortWithoutMoves: true,
    alwaysListed: true,
  },
};
