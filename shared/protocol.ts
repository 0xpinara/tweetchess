/**
 * The wire protocol shared by the browser (src/) and the Worker (worker/).
 *
 * Everything a client sends is untrusted: `parseClientMessage` validates the
 * exact shape of every message before the server looks at it.
 */

export const PROTOCOL_VERSION = 1;

/** Largest client → server WebSocket message we accept (bytes). */
export const MAX_CLIENT_MESSAGE_BYTES = 1024;

/** The permanent shared room served at /world. */
export const WORLD_ROOM_ID = 'world';

/** Length of generated room IDs (base62). 62^10 ≈ 8×10^17 possibilities. */
export const ROOM_ID_LENGTH = 10;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

/** Guest tokens are 32 random bytes encoded as base64url (43 characters). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SQUARE_PATTERN = /^[a-h][1-8]$/;

export type Color = 'w' | 'b';
export type Role = Color | 'spectator';
/** private = friend game, world = the public /world board, match = created by matchmaking. */
export type RoomKind = 'private' | 'world' | 'match';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export type MatchStatus = 'waiting' | 'active' | 'over';

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move_rule'
  | 'agreement'
  | 'resignation'
  | 'abandonment'
  | 'timeout'
  | 'aborted';

export interface GameEnd {
  /** null means the game was drawn. */
  winner: Color | null;
  reason: EndReason;
}

export interface SeatInfo {
  taken: boolean;
  online: boolean;
  /** The seated player's public display name. */
  name: string | null;
}

/** World Board time limits (null in private rooms). Times are server epoch ms. */
export interface RoomTimers {
  /** When the player to move forfeits for taking too long. */
  turnEndsAt: number | null;
  /** When the seats reopen after a finished game (unless both choose Rematch). */
  seatsReopenAt: number | null;
  /** Server clock when this snapshot was made, to correct for client clock skew. */
  serverTime: number;
}

export interface MoveInfo {
  san: string;
  from: string;
  to: string;
  color: Color;
  promotion?: PromotionPiece;
  captured?: PieceType;
}

/** Everything a client needs to render a room. Contains no identities. */
export interface RoomSnapshot {
  roomId: string;
  kind: RoomKind;
  /** Increments every time a new game starts in this room. */
  game: number;
  fen: string;
  /** Half-moves played in the current game (always equals moves.length). */
  ply: number;
  moves: MoveInfo[];
  status: MatchStatus;
  end: GameEnd | null;
  seats: Record<Color, SeatInfo>;
  rematch: Record<Color, boolean>;
  drawOffer: Color | null;
  spectators: number;
  timers: RoomTimers | null;
  /** Shown in the public live-games directory. */
  listed: boolean;
}

export type ClientMessage =
  /**
   * `sit: false` means "don't give me a free seat automatically" — sent on
   * reconnects and after the player chose to leave, so seats aren't reclaimed
   * by accident. A seat you already hold is always returned.
   */
  | { type: 'hello'; token: string; protocol: number; sit?: boolean; name?: string }
  | {
      type: 'move';
      from: string;
      to: string;
      promotion?: PromotionPiece;
      expectedPly: number;
    }
  | { type: 'resign'; game: number }
  | { type: 'draw'; action: 'offer' | 'accept' | 'decline'; game: number }
  | { type: 'rematch'; want: boolean; game: number }
  | { type: 'sit'; color?: Color }
  | { type: 'leave' };

export type ErrorCode =
  | 'bad_message'
  | 'unsupported_version'
  | 'not_authenticated'
  | 'room_not_found'
  | 'room_full'
  | 'unavailable'
  | 'rate_limited'
  | 'not_a_player'
  | 'not_your_turn'
  | 'illegal_move'
  | 'stale'
  | 'game_not_active'
  | 'game_not_over'
  | 'seat_taken'
  | 'already_seated'
  | 'not_allowed'
  | 'nothing_to_do';

export interface PresenceUpdate {
  seats: Record<Color, SeatInfo>;
  spectators: number;
}

export type ServerMessage =
  | { type: 'state'; you: Role; state: RoomSnapshot }
  | ({ type: 'presence' } & PresenceUpdate)
  | { type: 'error'; code: ErrorCode; message: string };

/** Custom WebSocket close codes (4000–4999 are reserved for applications). */
export const CloseCode = {
  RoomNotFound: 4004,
  UnsupportedVersion: 4010,
  RoomFull: 4013,
  /** Server problem or exhausted free-tier quota: retry, but slowly. */
  Unavailable: 4503,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
} as const;

/** Close codes after which the client should NOT try to reconnect. */
export const FATAL_CLOSE_CODES: readonly number[] = [
  CloseCode.RoomNotFound,
  CloseCode.UnsupportedVersion,
];

export function isValidRoomId(id: string): boolean {
  return id === WORLD_ROOM_ID || ROOM_ID_PATTERN.test(id);
}

export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function isSquare(value: unknown): value is string {
  return typeof value === 'string' && SQUARE_PATTERN.test(value);
}

function isColor(value: unknown): value is Color {
  return value === 'w' || value === 'b';
}

function isPromotion(value: unknown): value is PromotionPiece {
  return value === 'q' || value === 'r' || value === 'b' || value === 'n';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

/**
 * Parse and strictly validate a raw client message. Returns null for anything
 * that is not exactly one of the known message shapes.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;

  switch (msg.type) {
    case 'hello': {
      if (!hasOnlyKeys(msg, ['type', 'token', 'protocol', 'sit', 'name'])) return null;
      if (!isValidToken(msg.token) || !isCount(msg.protocol)) return null;
      if (msg.sit !== undefined && typeof msg.sit !== 'boolean') return null;
      // The name is sanitised by the server (an invalid one becomes "Guest").
      if (msg.name !== undefined && (typeof msg.name !== 'string' || msg.name.length > 64)) return null;
      const hello: ClientMessage = { type: 'hello', token: msg.token, protocol: msg.protocol };
      if (msg.sit !== undefined) hello.sit = msg.sit;
      if (msg.name !== undefined) hello.name = msg.name;
      return hello;
    }

    case 'move': {
      if (!hasOnlyKeys(msg, ['type', 'from', 'to', 'promotion', 'expectedPly'])) return null;
      if (!isSquare(msg.from) || !isSquare(msg.to) || !isCount(msg.expectedPly)) return null;
      if (msg.promotion !== undefined && !isPromotion(msg.promotion)) return null;
      const move: ClientMessage = {
        type: 'move',
        from: msg.from,
        to: msg.to,
        expectedPly: msg.expectedPly,
      };
      if (msg.promotion !== undefined) move.promotion = msg.promotion;
      return move;
    }

    case 'resign':
      if (!hasOnlyKeys(msg, ['type', 'game']) || !isCount(msg.game)) return null;
      return { type: 'resign', game: msg.game };

    case 'draw':
      if (!hasOnlyKeys(msg, ['type', 'action', 'game']) || !isCount(msg.game)) return null;
      if (msg.action !== 'offer' && msg.action !== 'accept' && msg.action !== 'decline') return null;
      return { type: 'draw', action: msg.action, game: msg.game };

    case 'rematch':
      if (!hasOnlyKeys(msg, ['type', 'want', 'game']) || !isCount(msg.game)) return null;
      if (typeof msg.want !== 'boolean') return null;
      return { type: 'rematch', want: msg.want, game: msg.game };

    case 'sit':
      if (!hasOnlyKeys(msg, ['type', 'color'])) return null;
      if (msg.color !== undefined && !isColor(msg.color)) return null;
      return msg.color === undefined ? { type: 'sit' } : { type: 'sit', color: msg.color };

    case 'leave':
      if (!hasOnlyKeys(msg, ['type'])) return null;
      return { type: 'leave' };

    default:
      return null;
  }
}

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

export function colorName(color: Color): 'White' | 'Black' {
  return color === 'w' ? 'White' : 'Black';
}
