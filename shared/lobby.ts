/**
 * Protocol for the lobby: chess matchmaking (WebSocket) and the public
 * live-games directory (HTTP). Shared by the browser and the Worker.
 */
import { MAX_CLIENT_MESSAGE_BYTES, isValidToken, type Color } from './protocol.ts';

export const LOBBY_PROTOCOL_VERSION = 1;

// ------------------------------------------------------------ Matchmaking

export type MatchmakingClientMessage =
  | { type: 'hello'; token: string; protocol: number; name?: string }
  /** Join the queue (idempotent: one entry per guest, however many tabs). */
  | { type: 'queue' }
  | { type: 'cancel' };

export type MatchmakingServerMessage =
  | { type: 'welcome'; searching: number }
  | { type: 'queued'; searching: number }
  | { type: 'cancelled' }
  /** A game is ready. `resumed` means it was created earlier (e.g. before a refresh). */
  | { type: 'matched'; roomId: string; color: Color; opponent: string; resumed: boolean }
  | { type: 'error'; code: 'bad_message' | 'not_authenticated' | 'unsupported_version' | 'unavailable' | 'busy'; message: string };

export function parseMatchmakingMessage(raw: string): MatchmakingClientMessage | null {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  const keys = Object.keys(msg);
  switch (msg.type) {
    case 'hello': {
      if (!keys.every((key) => ['type', 'token', 'protocol', 'name'].includes(key))) return null;
      if (!isValidToken(msg.token) || typeof msg.protocol !== 'number' || !Number.isInteger(msg.protocol)) return null;
      if (msg.name !== undefined && (typeof msg.name !== 'string' || msg.name.length > 64)) return null;
      const hello: MatchmakingClientMessage = { type: 'hello', token: msg.token, protocol: msg.protocol };
      if (msg.name !== undefined) hello.name = msg.name;
      return hello;
    }
    case 'queue':
    case 'cancel':
      return keys.length === 1 ? { type: msg.type } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------- Live directory

export type LiveGameType = 'chess' | 'poker';
export type LiveStatus = 'waiting' | 'playing';
export type LiveFilter = 'all' | 'waiting' | 'playing' | 'open';

export interface LiveChessGame {
  game: 'chess';
  id: string;
  /** match = matchmaking, world = the /world board, friend = a listed friend game. */
  mode: 'match' | 'world' | 'friend';
  status: LiveStatus;
  players: { w: string | null; b: string | null };
  /** Full-move number (1 = the opening move). */
  moveNumber: number;
  turn: Color;
  fen: string;
  spectators: number;
  openSeats: number;
  updatedAt: number;
}

export interface LivePokerTable {
  game: 'poker';
  id: string;
  status: LiveStatus;
  seated: number;
  maxSeats: number;
  /** waiting | preflop | flop | turn | river | showdown */
  phase: string;
  pot: number;
  /** Public community cards only. */
  board: string[];
  blinds: [number, number];
  spectators: number;
  openSeats: number;
  handNumber: number;
  updatedAt: number;
}

export type LiveGame = LiveChessGame | LivePokerTable;

export interface LivePage {
  games: LiveGame[];
  /** Pass back as `cursor` to load more, or null when there is nothing more. */
  nextCursor: string | null;
}

export const LIVE_PAGE_SIZE = 24;
export const LIVE_FILTERS: readonly LiveFilter[] = ['all', 'waiting', 'playing', 'open'];

export function isLiveFilter(value: unknown): value is LiveFilter {
  return typeof value === 'string' && (LIVE_FILTERS as readonly string[]).includes(value);
}
