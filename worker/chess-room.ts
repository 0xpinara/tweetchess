/**
 * ChessRoom — one Durable Object per chess room.
 *
 * - Owns the authoritative match state, stored in the object's SQLite database.
 * - Talks to browsers over WebSockets using the Hibernation API, so an idle
 *   room is evicted from memory (and stops accruing duration) while its
 *   sockets stay connected.
 * - Every rule decision is delegated to the pure `Match` class; how each kind
 *   of room behaves (timers, seating, expiry) lives in policies.ts.
 */
import { DurableObject } from 'cloudflare:workers';
import type { LiveChessGame } from '../shared/lobby.ts';
import { DEFAULT_NAME, sanitizeDisplayName } from '../shared/names.ts';
import {
  CloseCode,
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  WORLD_ROOM_ID,
  isValidRoomId,
  parseClientMessage,
  type ClientMessage,
  type Color,
  type EndReason,
  type ErrorCode,
  type MatchStatus,
  type PieceType,
  type PromotionPiece,
  type Role,
  type RoomKind,
  type RoomSnapshot,
  type RoomTimers,
  type ServerMessage,
} from '../shared/protocol.ts';
import { hashToken } from './crypto.ts';
import {
  Match,
  type ActionResult,
  type MatchRecord,
  type MoveRecord,
  type Presence,
  type SeatAssignment,
} from './match.ts';
import { POLICIES, type RoomPolicy } from './policies.ts';

/**
 * Connection limits per room. Seated players are always let in; spectators
 * are capped once they identify; sockets that never say hello are closed when
 * the room is under pressure. (Mutable so tests can lower them.)
 */
export const LIMITS = {
  maxSpectators: 500,
  maxSockets: 1000,
  helloTimeoutMs: 10_000,
};
/** Private rooms are deleted after this long without any activity. */
export const ROOM_TTL_MS = POLICIES.private.ttlMs!;
/** World room: a seated player offline for this long loses their seat. */
export const WORLD_SEAT_GRACE_MS = POLICIES.world.seatGraceMs!;
/** World room: time allowed per move before the player to move forfeits. */
export const WORLD_TURN_LIMIT_MS = POLICIES.world.turnLimitMs!;
/** World room: after a game ends, the result stays up this long, then the seats open up. */
export const WORLD_POSTGAME_MS = POLICIES.world.rotateSeatsAfterMs!;
/** When nobody is connected, re-check an idle room's expiry at most this often. */
const EXPIRY_RECHECK_MS = 60 * 60 * 1000;
/** Routine directory updates (moves, spectator counts) are sent at most this often (mutable for tests). */
export const DIRECTORY = { publishIntervalMs: 20_000 };
/** Per-socket token bucket: burst of 20 messages, refilled at 5 per second. */
const RATE_BURST = 20;
const RATE_PER_SECOND = 5;

const OPEN = 1; // WebSocket.READY_STATE_OPEN
const COLORS: readonly Color[] = ['w', 'b'];

/** Per-connection data that survives hibernation (serialized by the runtime). */
interface Attachment {
  /** SHA-256 of the guest token, set once the client says hello. */
  hash: string | null;
  /** When the socket connected (to close ones that never say hello). */
  connectedAt: number;
  /** Display name sent with hello (used if this guest later takes a seat). */
  name?: string;
}

type Row = Record<string, SqlStorageValue>;

/** Whether a policy needs alarms while a game is being played. */
function hasGameTimers(policy: RoomPolicy): boolean {
  return policy.seatGraceMs !== null || policy.turnLimitMs !== null || policy.rotateSeatsAfterMs !== null;
}

export class ChessRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private match: Match | null = null;
  private loaded = false;
  private storedGame = 0;
  private storedPly = 0;
  /** The alarm time this instance last scheduled (unknown after a wake-up). */
  private alarmAt: number | null = null;
  /** Last directory update (in memory; after a wake-up the next change is always sent). */
  private lastPublishedAt = 0;
  private lastPublishedKey = '';
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---------------------------------------------------------------- RPC

  /** Called by POST /api/rooms ("Play with a Friend"). Returns false if the room already exists. */
  async initialize(roomId: string, options: { listed?: boolean } = {}): Promise<boolean> {
    if (!isValidRoomId(roomId) || roomId === WORLD_ROOM_ID) throw new Error('Invalid room id');
    if (this.load()) return false;
    this.create(roomId, 'private', { listed: Boolean(options.listed) });
    return true;
  }

  /**
   * Called by the matchmaking lobby. Creates a game with both seats already
   * assigned. Idempotent: repeating the call for the same pairing succeeds.
   */
  async initializeMatch(roomId: string, white: SeatAssignment, black: SeatAssignment): Promise<boolean> {
    if (!isValidRoomId(roomId) || roomId === WORLD_ROOM_ID) throw new Error('Invalid room id');
    const existing = this.load();
    if (existing) {
      return existing.record.kind === 'match' && existing.record.white === white.hash && existing.record.black === black.hash;
    }
    this.ensureSchema();
    const now = Date.now();
    const match = Match.createMatchGame(roomId, white, black, now);
    // Both players start "away": whoever doesn't show up forfeits after the grace period.
    match.record.awaySince = { w: now, b: now };
    this.match = match;
    this.loaded = true;
    this.storedGame = match.record.game;
    this.storedPly = 0;
    this.save();
    this.scheduleAlarm();
    this.publish();
    return true;
  }

  /** Lets the lobby check whether a matched guest still has a game here. */
  async playerStatus(hash: string): Promise<{ seated: boolean; status: MatchStatus } | null> {
    const match = this.load();
    if (!match) return null;
    return { seated: match.colorOf(hash) !== null, status: match.record.status };
  }

  // ---------------------------------------------------------- WebSockets

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const roomId = new URL(request.url).pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/)?.[1] ?? '';
    if (!isValidRoomId(roomId)) return new Response('Invalid room', { status: 400 });

    let match = this.load();
    if (!match && roomId === WORLD_ROOM_ID) match = this.create(roomId, 'world');
    if (!match) return rejectSocket(CloseCode.RoomNotFound, 'room_not_found', 'This game does not exist (or expired).');

    const now = Date.now();
    if (this.openSocketCount() >= LIMITS.maxSockets) this.closeSilentSockets(now);
    if (this.openSocketCount() >= LIMITS.maxSockets) {
      return rejectSocket(CloseCode.RoomFull, 'room_full', 'This room is full right now. Try again soon.');
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ hash: null, connectedAt: now } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(CloseCode.PolicyViolation, 'Text messages only');
      return;
    }
    if (message.length > MAX_CLIENT_MESSAGE_BYTES) {
      ws.close(CloseCode.MessageTooBig, 'Message too large');
      return;
    }
    if (message === 'ping') {
      ws.send('pong');
      return;
    }
    if (!this.takeToken(ws)) {
      ws.close(CloseCode.PolicyViolation, 'Too many messages');
      return;
    }

    const msg = parseClientMessage(message);
    if (!msg) {
      send(ws, { type: 'error', code: 'bad_message', message: 'Malformed message.' });
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (msg.type === 'hello') {
      await this.hello(ws, attachment, msg);
      return;
    }
    const match = this.load();
    if (!match) {
      ws.close(CloseCode.RoomNotFound, 'Room not found');
      return;
    }
    if (!attachment?.hash) {
      send(ws, { type: 'error', code: 'not_authenticated', message: 'Connect first.' });
      return;
    }

    const result = this.apply(match, attachment.hash, msg, Date.now(), attachment.name ?? DEFAULT_NAME);
    if (!result.ok) {
      send(ws, { type: 'error', code: result.code, message: result.message });
      // Re-sync the sender so an optimistic move on their board is undone.
      this.sendState(ws, attachment.hash);
      return;
    }
    this.save();
    this.broadcastState();
    this.publish();
    if (hasGameTimers(match.policy)) this.scheduleAlarm();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Since compatibility date 2026-04-07 the runtime answers the close frame
    // itself (web_socket_auto_reply_to_close), so no ws.close() is needed here.
    this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onDisconnect(ws);
  }

  // --------------------------------------------------------------- Alarm

  /** Runs the room's timers (seat grace, move limit, seat rotation) and expires idle rooms. */
  async alarm(): Promise<void> {
    const match = this.load();
    if (!match) return;
    const now = Date.now();
    this.alarmAt = null; // this alarm has fired

    if (this.applyTimers(match, now)) {
      this.save();
      this.broadcastState();
      this.publish();
    }

    const { ttlMs } = match.policy;
    if (ttlMs !== null && now - match.record.updatedAt >= ttlMs && this.ctx.getWebSockets().length === 0) {
      if (match.record.listed) await this.env.LOBBY.getByName('chess').unpublish(match.record.roomId).catch(() => {});
      // Removes the SQLite database and (since 2026-02-24) the alarm too.
      await this.ctx.storage.deleteAll();
      this.match = null;
      return;
    }
    this.scheduleAlarm(now);
  }

  // ------------------------------------------------------------ Handlers

  private async hello(ws: WebSocket, attachment: Attachment | null, msg: Extract<ClientMessage, { type: 'hello' }>) {
    if (attachment?.hash) {
      send(ws, { type: 'error', code: 'bad_message', message: 'Already connected.' });
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      send(ws, { type: 'error', code: 'unsupported_version', message: 'Timeline Games was updated. Please reload the page.' });
      ws.close(CloseCode.UnsupportedVersion, 'Reload required');
      return;
    }
    const hash = await hashToken(msg.token);

    // Everything below is synchronous, so seat assignment is atomic: two
    // visitors connecting at the same instant can never get the same seat.
    const match = this.load();
    if (!match) {
      ws.close(CloseCode.RoomNotFound, 'Room not found');
      return;
    }
    // A second hello on the same socket may have finished while we were hashing.
    if ((ws.deserializeAttachment() as Attachment | null)?.hash) {
      send(ws, { type: 'error', code: 'bad_message', message: 'Already connected.' });
      return;
    }
    const now = Date.now();
    const sentName = sanitizeDisplayName(msg.name);
    const name = sentName ?? DEFAULT_NAME;
    // Free seats go to new visitors only; reconnecting sockets and players who
    // chose to leave send sit:false. A seat you already hold is always yours.
    let dirty = msg.sit === false ? false : match.claimSeat(hash, now, undefined, name).changed;
    // Only a valid name replaces the one on the seat (a missing name keeps it).
    if (sentName && match.setName(hash, sentName)) dirty = true;
    const color = match.colorOf(hash);
    if (!color && !this.isConnected(hash) && this.presence().spectators >= LIMITS.maxSpectators) {
      send(ws, { type: 'error', code: 'room_full', message: 'This game has too many spectators right now. Try again soon.' });
      ws.close(CloseCode.RoomFull, 'room_full');
      return;
    }
    ws.serializeAttachment({ hash, connectedAt: attachment?.connectedAt ?? now, name } satisfies Attachment);
    if (color && match.record.awaySince[color] !== null) {
      match.record.awaySince[color] = null;
      dirty = true;
    }
    if (this.markAbsentPlayers(now)) dirty = true;

    if (dirty) {
      this.save();
      this.broadcastState();
      if (hasGameTimers(match.policy)) this.scheduleAlarm(now);
    } else {
      this.sendState(ws, hash);
      this.broadcastPresence({ skip: ws });
    }
    this.publish();
  }

  private apply(match: Match, hash: string, msg: ClientMessage, now: number, name: string): ActionResult {
    switch (msg.type) {
      case 'move':
        return match.move(hash, msg, now);
      case 'resign':
        return match.resign(hash, msg.game, now);
      case 'draw':
        return match.draw(hash, msg.action, msg.game, now);
      case 'rematch':
        return match.rematch(hash, msg.want, msg.game, now);
      case 'leave':
        return match.leave(hash, now);
      case 'sit': {
        if (match.colorOf(hash)) return { ok: false, code: 'already_seated', message: 'You already have a seat.' };
        if (!match.policy.openSeating) {
          return { ok: false, code: 'not_allowed', message: 'Seats in matchmade games belong to the matched players.' };
        }
        const { changed } = match.claimSeat(hash, now, msg.color, name);
        if (!changed) return { ok: false, code: 'seat_taken', message: 'Both seats are taken.' };
        return { ok: true, changes: { newGame: false, appendMove: null } };
      }
      case 'hello':
        return { ok: false, code: 'bad_message', message: 'Unexpected hello.' };
    }
  }

  private onDisconnect(ws: WebSocket): void {
    const match = this.load();
    const hash = (ws.deserializeAttachment() as Attachment | null)?.hash;
    if (!match || !hash) return;
    const color = match.colorOf(hash);
    if (color && match.policy.seatGraceMs !== null && !this.presence(ws).online[color]) {
      if (match.record.awaySince[color] === null) {
        match.record.awaySince[color] = Date.now();
        this.save();
        this.scheduleAlarm();
      }
    }
    this.broadcastPresence({ departed: ws });
    this.publish(ws);
  }

  // ------------------------------------------------------------ Directory

  /** This room's public summary, or null if it shouldn't be listed right now. */
  private listing(departed?: WebSocket): LiveChessGame | null {
    const match = this.match;
    if (!match || !match.record.listed || match.record.status === 'over') return null;
    const { record } = match;
    const openSeats = match.policy.openSeating ? COLORS.filter((color) => !match.seat(color)).length : 0;
    return {
      game: 'chess',
      id: record.roomId,
      mode: record.kind === 'private' ? 'friend' : record.kind,
      status: record.status === 'active' ? 'playing' : 'waiting',
      players: { w: record.names.w, b: record.names.b },
      moveNumber: Math.floor(match.ply / 2) + 1,
      turn: match.turn(),
      fen: record.fen,
      spectators: this.presence(departed).spectators,
      openSeats,
      updatedAt: Date.now(),
    };
  }

  /**
   * Keep the public directory up to date. Status/seat changes go out at once;
   * routine changes (moves, spectator counts) at most every 20 seconds, which
   * keeps directory traffic small on the free plan. Failures are harmless:
   * the next update repeats the state, and stale entries expire.
   */
  private publish(departed?: WebSocket): void {
    const match = this.match;
    if (!match?.record.listed) return;
    const entry = this.listing(departed);
    const key = entry ? `${entry.status}|${entry.openSeats}|${entry.players.w}|${entry.players.b}` : 'removed';
    const now = Date.now();
    if (key === this.lastPublishedKey && now - this.lastPublishedAt < DIRECTORY.publishIntervalMs) return;
    if (key === 'removed' && this.lastPublishedKey === 'removed') return;
    this.lastPublishedAt = now;
    this.lastPublishedKey = key;
    const lobby = this.env.LOBBY.getByName('chess');
    const update = entry ? lobby.publish(entry) : lobby.unpublish(match.record.roomId);
    this.ctx.waitUntil(update.catch((error: unknown) => console.error('directory update failed', error)));
  }

  // -------------------------------------------------------------- Timers

  /** Apply every timer that has run out. Returns true if the game changed. */
  private applyTimers(match: Match, now: number): boolean {
    const policy = match.policy;
    let changed = this.markAbsentPlayers(now);

    if (policy.seatGraceMs !== null) {
      const grace = policy.seatGraceMs;
      const { online } = this.presence();
      const gone = COLORS.filter((color) => {
        const since = match.record.awaySince[color];
        return match.seat(color) && !online[color] && since !== null && now - since >= grace;
      });
      if (gone.length === 2) {
        // Both players vanished: nobody wins; open boards reset for new players.
        match.abandonAll(now);
        changed = true;
      } else if (gone.length === 1) {
        match.forfeitAbsent(gone[0], now);
        changed = true;
      }
    }
    const { status, turnStartedAt } = match.record;
    if (policy.turnLimitMs !== null && status === 'active' && turnStartedAt !== null && now - turnStartedAt >= policy.turnLimitMs) {
      match.timeoutTurn(now);
      changed = true;
    }
    const seated = Boolean(match.record.white || match.record.black);
    const { endedAt } = match.record;
    if (
      policy.rotateSeatsAfterMs !== null &&
      match.record.status === 'over' &&
      seated &&
      endedAt !== null &&
      now - endedAt >= policy.rotateSeatsAfterMs
    ) {
      match.resetBoard(now);
      changed = true;
    }
    return changed;
  }

  /** Start the abandonment clock for seated players with no connection (rooms with a seat grace period). */
  private markAbsentPlayers(now: number): boolean {
    const match = this.match;
    if (!match || match.policy.seatGraceMs === null) return false;
    const { online } = this.presence();
    let changed = false;
    for (const color of COLORS) {
      if (match.seat(color) && !online[color] && match.record.awaySince[color] === null) {
        match.record.awaySince[color] = now;
        changed = true;
      }
    }
    return changed;
  }

  /** The next moment a timer needs checking, or null if none is running. */
  private nextDeadline(now: number): number | null {
    const match = this.match;
    if (!match) return null;
    const policy = match.policy;
    const { awaySince, status, turnStartedAt, endedAt, white, black, updatedAt } = match.record;
    const deadlines: number[] = [];
    if (policy.seatGraceMs !== null) {
      for (const color of COLORS) {
        const since = awaySince[color];
        if (since !== null && match.seat(color)) deadlines.push(since + policy.seatGraceMs);
      }
    }
    if (policy.turnLimitMs !== null && status === 'active' && turnStartedAt !== null) {
      deadlines.push(turnStartedAt + policy.turnLimitMs);
    }
    if (policy.rotateSeatsAfterMs !== null && status === 'over' && endedAt !== null && (white || black)) {
      deadlines.push(endedAt + policy.rotateSeatsAfterMs);
    }
    if (policy.ttlMs !== null) deadlines.push(Math.max(updatedAt + policy.ttlMs, now + EXPIRY_RECHECK_MS));
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  /**
   * Make sure an alarm fires by the next deadline. An alarm that is already
   * due sooner is kept (the handler reschedules), which avoids a storage
   * write on every move.
   */
  private scheduleAlarm(now = Date.now()): void {
    const next = this.nextDeadline(now);
    if (next === null) return;
    if (this.alarmAt !== null && this.alarmAt <= next) return;
    this.alarmAt = next;
    void this.ctx.storage.setAlarm(next);
  }

  /** Countdowns for the client (World Board and matchmade games); null otherwise. */
  private timers(): RoomTimers | null {
    const match = this.match;
    if (!match) return null;
    const policy = match.policy;
    if (policy.turnLimitMs === null && policy.rotateSeatsAfterMs === null) return null;
    const { status, turnStartedAt, endedAt, white, black } = match.record;
    return {
      turnEndsAt:
        policy.turnLimitMs !== null && status === 'active' && turnStartedAt !== null
          ? turnStartedAt + policy.turnLimitMs
          : null,
      seatsReopenAt:
        policy.rotateSeatsAfterMs !== null && status === 'over' && endedAt !== null && (white || black)
          ? endedAt + policy.rotateSeatsAfterMs
          : null,
      serverTime: Date.now(),
    };
  }

  private snapshot(presence: Presence): RoomSnapshot {
    return this.match!.snapshot(presence, this.timers());
  }

  // ------------------------------------------------------------ Presence

  private openSocketCount(): number {
    let count = 0;
    for (const socket of this.ctx.getWebSockets()) if (socket.readyState === OPEN) count++;
    return count;
  }

  /** Close sockets that connected but never identified themselves. */
  private closeSilentSockets(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.hash || now - (attachment?.connectedAt ?? 0) < LIMITS.helloTimeoutMs) continue;
      try {
        socket.close(CloseCode.PolicyViolation, 'No hello received');
      } catch {
        // Already closing.
      }
    }
  }

  private isConnected(hash: string): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === OPEN && (socket.deserializeAttachment() as Attachment | null)?.hash === hash) return true;
    }
    return false;
  }

  private presence(exclude?: WebSocket): Presence {
    const online: Record<Color, boolean> = { w: false, b: false };
    const spectators = new Set<string>();
    const match = this.match;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude || socket.readyState !== OPEN) continue;
      const hash = (socket.deserializeAttachment() as Attachment | null)?.hash;
      if (!hash || !match) continue;
      const color = match.colorOf(hash);
      if (color) online[color] = true;
      else spectators.add(hash);
    }
    return { online, spectators: spectators.size };
  }

  private sendState(ws: WebSocket, hash: string): void {
    const match = this.match;
    if (!match) return;
    send(ws, { type: 'state', you: match.roleOf(hash), state: this.snapshot(this.presence()) });
  }

  /** Send the full state to every connected client (each with their own role). */
  private broadcastState(): void {
    const match = this.match;
    if (!match) return;
    const snapshot = JSON.stringify(this.snapshot(this.presence()));
    const frames = new Map<Role, string>();
    for (const socket of this.ctx.getWebSockets()) {
      const hash = (socket.deserializeAttachment() as Attachment | null)?.hash;
      if (!hash) continue;
      const role = match.roleOf(hash);
      let frame = frames.get(role);
      if (!frame) {
        frame = `{"type":"state","you":${JSON.stringify(role)},"state":${snapshot}}`;
        frames.set(role, frame);
      }
      sendRaw(socket, frame);
    }
  }

  /**
   * Tell everyone who is online. `departed` is a socket that is closing (not
   * counted); `skip` is a socket that already has fresh state (not messaged).
   */
  private broadcastPresence({ departed, skip }: { departed?: WebSocket; skip?: WebSocket }): void {
    const match = this.match;
    if (!match) return;
    const { seats, spectators } = match.snapshot(this.presence(departed));
    const frame = JSON.stringify({ type: 'presence', seats, spectators } satisfies ServerMessage);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === departed || socket === skip || socket.readyState !== OPEN) continue;
      if ((socket.deserializeAttachment() as Attachment | null)?.hash) sendRaw(socket, frame);
    }
  }

  private takeToken(ws: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { tokens: RATE_BURST, at: now };
    bucket.tokens = Math.min(RATE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE_PER_SECOND);
    bucket.at = now;
    this.buckets.set(ws, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // --------------------------------------------------------- Persistence

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      game INTEGER NOT NULL,
      white TEXT,
      black TEXT,
      fen TEXT NOT NULL,
      ply INTEGER NOT NULL,
      status TEXT NOT NULL,
      end_winner TEXT,
      end_reason TEXT,
      rematch_w INTEGER NOT NULL,
      rematch_b INTEGER NOT NULL,
      draw_offer TEXT,
      white_away_since INTEGER,
      black_away_since INTEGER,
      turn_started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      white_name TEXT,
      black_name TEXT,
      listed INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS moves (
      ply INTEGER PRIMARY KEY,
      san TEXT NOT NULL,
      from_sq TEXT NOT NULL,
      to_sq TEXT NOT NULL,
      color TEXT NOT NULL,
      promotion TEXT,
      captured TEXT,
      fen TEXT NOT NULL,
      pos_key TEXT NOT NULL,
      played_at INTEGER NOT NULL
    )`);
  }

  /** Rooms created by older versions lack newer columns; add them in place. */
  private migrate(): void {
    const columns = new Set(this.sql.exec('SELECT * FROM room LIMIT 0').columnNames);
    if (!columns.has('white_name')) this.sql.exec('ALTER TABLE room ADD COLUMN white_name TEXT');
    if (!columns.has('black_name')) this.sql.exec('ALTER TABLE room ADD COLUMN black_name TEXT');
    if (!columns.has('listed')) this.sql.exec('ALTER TABLE room ADD COLUMN listed INTEGER NOT NULL DEFAULT 0');
  }

  private create(roomId: string, kind: RoomKind, options: { listed?: boolean } = {}): Match {
    this.ensureSchema();
    const now = Date.now();
    this.match = Match.create(roomId, kind, now, options);
    this.loaded = true;
    this.storedGame = this.match.record.game;
    this.storedPly = 0;
    this.save();
    this.scheduleAlarm(now);
    this.publish();
    return this.match;
  }

  /** Load the match from SQLite (once per wake-up). Returns null if the room doesn't exist. */
  private load(): Match | null {
    if (this.loaded) return this.match;
    this.loaded = true;
    const tables = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray();
    if (tables.length === 0) return (this.match = null);
    this.migrate();
    const row = this.sql.exec('SELECT * FROM room WHERE id = 1').toArray()[0] as Row | undefined;
    if (!row) return (this.match = null);
    const moves = this.sql.exec('SELECT * FROM moves ORDER BY ply').toArray().map((m) => rowToMove(m as Row));
    this.match = new Match(rowToRecord(row), moves);
    this.storedGame = this.match.record.game;
    this.storedPly = moves.length;
    return this.match;
  }

  /** Persist the room row and any new moves in one atomic transaction. */
  private save(): void {
    const match = this.match;
    if (!match) return;
    const r = match.record;
    let storedPly = this.storedPly;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR REPLACE INTO room (id, room_id, kind, game, white, black, fen, ply, status, end_winner,
          end_reason, rematch_w, rematch_b, draw_offer, white_away_since, black_away_since, turn_started_at,
          ended_at, created_at, updated_at, white_name, black_name, listed)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.roomId, r.kind, r.game, r.white, r.black, r.fen, match.ply, r.status, r.end?.winner ?? null,
        r.end?.reason ?? null, r.rematch.w ? 1 : 0, r.rematch.b ? 1 : 0, r.drawOffer,
        r.awaySince.w, r.awaySince.b, r.turnStartedAt, r.endedAt, r.createdAt, r.updatedAt,
        r.names.w, r.names.b, r.listed ? 1 : 0,
      );
      if (r.game !== this.storedGame) {
        this.sql.exec('DELETE FROM moves');
        storedPly = 0;
      }
      for (const m of match.moves.slice(storedPly)) {
        this.sql.exec(
          `INSERT INTO moves (ply, san, from_sq, to_sq, color, promotion, captured, fen, pos_key, played_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          m.ply, m.san, m.from, m.to, m.color, m.promotion ?? null, m.captured ?? null, m.fen, m.key, m.at,
        );
      }
    });
    this.storedGame = r.game;
    this.storedPly = match.ply;
  }
}

// -------------------------------------------------------------- Helpers

function rowToRecord(row: Row): MatchRecord {
  const winner = row.end_winner as Color | null;
  const reason = row.end_reason as EndReason | null;
  const kind = row.kind as RoomKind;
  return {
    roomId: row.room_id as string,
    kind,
    game: row.game as number,
    white: row.white as string | null,
    black: row.black as string | null,
    fen: row.fen as string,
    status: row.status as MatchRecord['status'],
    end: reason ? { winner, reason } : null,
    rematch: { w: row.rematch_w === 1, b: row.rematch_b === 1 },
    drawOffer: row.draw_offer as Color | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    awaySince: { w: row.white_away_since as number | null, b: row.black_away_since as number | null },
    turnStartedAt: row.turn_started_at as number | null,
    endedAt: row.ended_at as number | null,
    names: {
      w: row.white ? ((row.white_name as string | null) ?? DEFAULT_NAME) : null,
      b: row.black ? ((row.black_name as string | null) ?? DEFAULT_NAME) : null,
    },
    listed: POLICIES[kind].alwaysListed || row.listed === 1,
  };
}

function rowToMove(row: Row): MoveRecord {
  const move: MoveRecord = {
    ply: row.ply as number,
    san: row.san as string,
    from: row.from_sq as string,
    to: row.to_sq as string,
    color: row.color as Color,
    fen: row.fen as string,
    key: row.pos_key as string,
    at: row.played_at as number,
  };
  if (row.promotion) move.promotion = row.promotion as PromotionPiece;
  if (row.captured) move.captured = row.captured as PieceType;
  return move;
}

function send(ws: WebSocket, message: ServerMessage): void {
  sendRaw(ws, JSON.stringify(message));
}

function sendRaw(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // The socket closed while we were working; its close handler cleans up.
  }
}

/**
 * Complete the WebSocket handshake only to deliver a reason, then close.
 * Browsers hide HTTP error statuses from WebSocket code, so this is the only
 * way for the page to show "room not found" instead of reconnecting forever.
 */
export function rejectSocket(code: number, errorCode: ErrorCode, message: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ type: 'error', code: errorCode, message } satisfies ServerMessage));
  server.close(code, errorCode);
  return new Response(null, { status: 101, webSocket: client });
}
