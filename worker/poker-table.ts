/**
 * PokerTable — one Durable Object per Texas Hold'em table.
 *
 * - Holds the authoritative table state (deck, hole cards, bets, pots) in its
 *   SQLite database; clients only ever get the views built by the engine.
 * - Every socket gets its own frame: seated players see their own hole cards
 *   and legal actions, everyone else sees the public table only.
 * - Uses alarms for turn timeouts, the pause between hands, freeing seats of
 *   long-disconnected players and deleting abandoned tables. A new hand starts
 *   only when at least two connected, present players have chips, so idle
 *   tables stop dealing instead of looping.
 */
import { DurableObject } from 'cloudflare:workers';
import type { LivePokerTable } from '../shared/lobby.ts';
import { DEFAULT_NAME, sanitizeDisplayName } from '../shared/names.ts';
import {
  POKER_PROTOCOL_VERSION,
  parsePokerMessage,
  type PokerClientMessage,
  type PokerErrorCode,
  type PokerServerMessage,
  type TableVisibility,
} from '../shared/poker.ts';
import { CloseCode, isValidRoomId } from '../shared/protocol.ts';
import { hashToken } from './crypto.ts';
import {
  act,
  createTable,
  eligibleSeats,
  handInProgress,
  leave,
  privateView,
  publicView,
  rebuy,
  releaseAbsentSeats,
  seatOf,
  seatedCount,
  setAway,
  setName,
  sit,
  startHand,
  timeout,
  type EngineResult,
  type TableState,
} from './poker/engine.ts';

/** Limits per table (mutable so tests can lower them). */
export const POKER_LIMITS = {
  maxSpectators: 200,
  maxSockets: 400,
  helloTimeoutMs: 10_000,
};
/** Mutable timing knobs (tests shorten them). */
export const POKER_TIMING = {
  /** Pause before the first hand once two players are ready. */
  startDelayMs: 3_000,
  /** A seated player disconnected this long loses the seat (public / private tables). */
  publicSeatGraceMs: 3 * 60 * 1000,
  privateSeatGraceMs: 30 * 60 * 1000,
  /** Delete a table nobody is connected to after this long without activity. */
  publicTtlMs: 30 * 60 * 1000,
  privateTtlMs: 24 * 60 * 60 * 1000,
  /** Routine directory updates at most this often. */
  publishIntervalMs: 15_000,
};
const RATE_BURST = 20;
const RATE_PER_SECOND = 5;
const OPEN = 1;

interface Attachment {
  hash: string | null;
  connectedAt: number;
  /** Display name sent with hello (used if this guest takes a seat later). */
  name?: string;
}

export class PokerTable extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private state: TableState | null = null;
  private loaded = false;
  private alarmAt: number | null = null;
  private lastPublishedAt = 0;
  private lastPublishedKey = '';
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---------------------------------------------------------------- RPC

  /** Create the table. Returns false if it already exists. */
  async initialize(tableId: string, visibility: TableVisibility): Promise<boolean> {
    if (!isValidRoomId(tableId) || tableId === 'world') throw new Error('Invalid table id');
    if (this.load()) return false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS poker_table (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      table_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const now = Date.now();
    this.state = createTable(tableId, visibility, now);
    this.loaded = true;
    this.save();
    this.scheduleAlarm(now);
    this.publish(true);
    return true;
  }

  /** Seats taken, for the table finder. */
  async seats(): Promise<{ seated: number; maxSeats: number } | null> {
    const state = this.load();
    return state ? { seated: seatedCount(state), maxSeats: state.config.maxSeats } : null;
  }

  // ---------------------------------------------------------- WebSockets

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const state = this.load();
    if (!state) return reject(CloseCode.RoomNotFound, 'table_not_found', 'This table does not exist (or closed).');
    const now = Date.now();
    if (this.openSockets().length >= POKER_LIMITS.maxSockets) this.closeSilentSockets(now);
    if (this.openSockets().length >= POKER_LIMITS.maxSockets) {
      return reject(CloseCode.RoomFull, 'room_full', 'This table is full right now. Try again soon.');
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ hash: null, connectedAt: now } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') {
      ws.close(CloseCode.PolicyViolation, 'Text messages only');
      return;
    }
    if (raw === 'ping') {
      ws.send('pong');
      return;
    }
    if (!this.takeToken(ws)) {
      ws.close(CloseCode.PolicyViolation, 'Too many messages');
      return;
    }
    const msg = parsePokerMessage(raw);
    if (!msg) {
      sendTo(ws, { type: 'error', code: 'bad_message', message: 'Malformed message.' });
      return;
    }
    if (msg.type === 'hello') {
      await this.hello(ws, msg);
      return;
    }
    const state = this.load();
    const hash = attachmentOf(ws)?.hash;
    if (!state) {
      ws.close(CloseCode.RoomNotFound, 'Table not found');
      return;
    }
    if (!hash) {
      sendTo(ws, { type: 'error', code: 'not_authenticated', message: 'Connect first.' });
      return;
    }

    const now = Date.now();
    const result = this.apply(state, hash, msg, now, attachmentOf(ws)?.name ?? DEFAULT_NAME);
    if (!result.ok) {
      sendTo(ws, { type: 'error', code: result.code, message: result.message });
      this.sendState(ws, hash); // resync the sender
      return;
    }
    this.afterChange(now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onDisconnect(ws);
  }

  // --------------------------------------------------------------- Alarm

  async alarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    this.alarmAt = null;
    const now = Date.now();
    let changed = timeout(state, now);
    changed = releaseAbsentSeats(state, now, this.seatGraceMs()) || changed;

    if (!handInProgress(state) && state.nextHandAt !== null && now >= state.nextHandAt) {
      if (startHand(state, now, (hash) => this.isConnected(hash))) changed = true;
      else {
        state.nextHandAt = null; // not enough players any more; wait for someone to sit
        changed = true;
      }
    }

    const ttl = state.visibility === 'public' ? POKER_TIMING.publicTtlMs : POKER_TIMING.privateTtlMs;
    if (this.openSockets().length === 0 && seatedCount(state) === 0 && now - state.updatedAt >= ttl) {
      if (state.visibility === 'public') await this.env.LOBBY.getByName('poker').unpublish(state.tableId).catch(() => {});
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
    if (changed) this.afterChange(now);
    else this.scheduleAlarm(now);
  }

  // ------------------------------------------------------------ Handlers

  private async hello(ws: WebSocket, msg: Extract<PokerClientMessage, { type: 'hello' }>) {
    if (msg.protocol !== POKER_PROTOCOL_VERSION) {
      sendTo(ws, { type: 'error', code: 'unsupported_version', message: 'Timeline Games was updated. Please reload the page.' });
      ws.close(CloseCode.UnsupportedVersion, 'Reload required');
      return;
    }
    if (attachmentOf(ws)?.hash) {
      sendTo(ws, { type: 'error', code: 'bad_message', message: 'Already connected.' });
      return;
    }
    const hash = await hashToken(msg.token);
    const state = this.load();
    if (!state) {
      ws.close(CloseCode.RoomNotFound, 'Table not found');
      return;
    }
    const current = attachmentOf(ws);
    if (!current || current.hash) return; // a second hello finished first

    const now = Date.now();
    const sentName = sanitizeDisplayName(msg.name);
    let changed = false;
    if (msg.sit && seatOf(state, hash) === null) changed = sit(state, hash, sentName ?? DEFAULT_NAME, now).ok;
    if (sentName && setName(state, hash, sentName)) changed = true;

    const seat = seatOf(state, hash);
    if (seat === null && !this.isConnected(hash) && this.spectatorCount() >= POKER_LIMITS.maxSpectators) {
      sendTo(ws, { type: 'error', code: 'room_full', message: 'This table has too many spectators right now.' });
      ws.close(CloseCode.RoomFull, 'room_full');
      return;
    }
    ws.serializeAttachment({ hash, connectedAt: current.connectedAt, name: sentName ?? this.nameFor(state, hash) } satisfies Attachment);
    if (seat !== null && state.seats[seat]!.disconnectedAt !== null) {
      state.seats[seat]!.disconnectedAt = null;
      changed = true;
    }
    if (changed) this.afterChange(now);
    else {
      this.broadcast(); // spectator counts changed for everyone
      this.publish();
    }
  }

  private apply(state: TableState, hash: string, msg: PokerClientMessage, now: number, name: string): EngineResult {
    switch (msg.type) {
      case 'sit':
        return sit(state, hash, name, now, msg.seat);
      case 'leave':
        return leave(state, hash, now);
      case 'away':
        return setAway(state, hash, msg.away, now);
      case 'rebuy':
        return rebuy(state, hash, now);
      case 'act':
        return act(state, hash, { action: msg.action, amount: msg.amount, hand: msg.hand, seq: msg.seq }, now);
      case 'hello':
        return { ok: false, code: 'bad_message', message: 'Unexpected hello.' };
    }
  }

  private nameFor(state: TableState, hash: string): string {
    const seat = seatOf(state, hash);
    return (seat !== null && state.seats[seat]?.name) || DEFAULT_NAME;
  }

  private onDisconnect(ws: WebSocket): void {
    const state = this.load();
    const hash = attachmentOf(ws)?.hash;
    if (!state || !hash) return;
    const seat = seatOf(state, hash);
    const now = Date.now();
    if (seat !== null && !this.isConnected(hash, ws)) {
      state.seats[seat]!.disconnectedAt = now;
      this.save();
      this.scheduleAlarm(now);
    }
    this.broadcast(ws);
    this.publish();
  }

  /** Persist, tell everyone, keep the directory current and make sure timers are set. */
  private afterChange(now: number): void {
    const state = this.state!;
    // Two ready players and no hand: deal shortly. Fewer than two: stop waiting.
    if (!handInProgress(state)) {
      const ready = eligibleSeats(state, (hash) => this.isConnected(hash)).length >= 2;
      if (ready && state.nextHandAt === null) state.nextHandAt = now + POKER_TIMING.startDelayMs;
      if (!ready) state.nextHandAt = null;
    }
    this.save();
    this.broadcast();
    this.publish();
    this.scheduleAlarm(now);
  }

  private seatGraceMs(): number {
    return this.state?.visibility === 'public' ? POKER_TIMING.publicSeatGraceMs : POKER_TIMING.privateSeatGraceMs;
  }

  // -------------------------------------------------------------- Timers

  private nextDeadline(now: number): number | null {
    const state = this.state;
    if (!state) return null;
    const deadlines: number[] = [];
    if (state.hand && !state.hand.done && state.hand.deadline !== null) deadlines.push(state.hand.deadline);
    if (state.nextHandAt !== null) deadlines.push(state.nextHandAt);
    const grace = this.seatGraceMs();
    for (const seat of state.seats) if (seat?.disconnectedAt != null) deadlines.push(seat.disconnectedAt + grace);
    const ttl = state.visibility === 'public' ? POKER_TIMING.publicTtlMs : POKER_TIMING.privateTtlMs;
    // Expiry is re-checked at most every 10 minutes while the table sits idle.
    deadlines.push(Math.max(state.updatedAt + ttl, now + 10 * 60_000));
    return Math.min(...deadlines);
  }

  /** Keep one alarm at the earliest deadline; a sooner alarm already set is kept (no extra write). */
  private scheduleAlarm(now = Date.now()): void {
    const next = this.nextDeadline(now);
    if (next === null) return;
    if (this.alarmAt !== null && this.alarmAt <= next && this.alarmAt > now) return;
    this.alarmAt = next;
    void this.ctx.storage.setAlarm(next);
  }

  // ------------------------------------------------------------ Directory

  private listing(): LivePokerTable | null {
    const state = this.state;
    if (!state || state.visibility !== 'public') return null;
    const seated = seatedCount(state);
    if (seated === 0) return null;
    const hand = state.hand;
    const live = Boolean(hand && !hand.done);
    return {
      game: 'poker',
      id: state.tableId,
      status: live ? 'playing' : 'waiting',
      seated,
      maxSeats: state.config.maxSeats,
      phase: live ? hand!.street : 'waiting',
      pot: live ? hand!.order.reduce((sum, seat) => sum + hand!.players[seat].total, 0) : 0,
      board: live ? [...hand!.board] : [],
      blinds: [state.config.smallBlind, state.config.bigBlind],
      spectators: this.spectatorCount(),
      openSeats: state.config.maxSeats - seated,
      handNumber: state.handCount,
      updatedAt: Date.now(),
    };
  }

  /** Public tables only. Seat/status changes go out at once, routine ones at most every 15 s. */
  private publish(force = false): void {
    if (this.state?.visibility !== 'public') return;
    const entry = this.listing();
    const key = entry ? `${entry.status}|${entry.seated}|${entry.phase}` : 'removed';
    const now = Date.now();
    if (!force && key === this.lastPublishedKey && now - this.lastPublishedAt < POKER_TIMING.publishIntervalMs) return;
    if (!force && key === 'removed' && this.lastPublishedKey === 'removed') return;
    this.lastPublishedAt = now;
    this.lastPublishedKey = key;
    const lobby = this.env.LOBBY.getByName('poker');
    const update = entry ? lobby.publish(entry) : lobby.unpublish(this.state.tableId);
    this.ctx.waitUntil(update.catch((error: unknown) => console.error('poker directory update failed', error)));
  }

  // ------------------------------------------------------------ Presence

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === OPEN);
  }

  private isConnected(hash: string, exclude?: WebSocket): boolean {
    return this.openSockets().some((socket) => socket !== exclude && attachmentOf(socket)?.hash === hash);
  }

  private spectatorCount(exclude?: WebSocket): number {
    const state = this.state;
    const hashes = new Set<string>();
    for (const socket of this.openSockets()) {
      if (socket === exclude) continue;
      const hash = attachmentOf(socket)?.hash;
      if (hash && (!state || seatOf(state, hash) === null)) hashes.add(hash);
    }
    return hashes.size;
  }

  private closeSilentSockets(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const data = attachmentOf(socket);
      if (data?.hash || now - (data?.connectedAt ?? 0) < POKER_LIMITS.helloTimeoutMs) continue;
      try {
        socket.close(CloseCode.PolicyViolation, 'No hello received');
      } catch {
        // Already closing.
      }
    }
  }

  private sendState(ws: WebSocket, hash: string): void {
    const state = this.state;
    if (!state) return;
    const now = Date.now();
    const table = publicView(state, { connected: (h) => this.isConnected(h), spectators: this.spectatorCount() }, now);
    sendTo(ws, { type: 'state', you: privateView(state, hash), table });
  }

  /**
   * Send every connected client its own view. The public part is shared;
   * each seated player's frame adds only their own cards and actions.
   */
  private broadcast(departed?: WebSocket): void {
    const state = this.state;
    if (!state) return;
    const now = Date.now();
    const table = JSON.stringify(
      publicView(
        state,
        { connected: (hash) => this.isConnected(hash, departed), spectators: this.spectatorCount(departed) },
        now,
      ),
    );
    const spectatorFrame = `{"type":"state","you":{"seat":null,"hole":null,"actions":null},"table":${table}}`;
    for (const socket of this.openSockets()) {
      if (socket === departed) continue;
      const hash = attachmentOf(socket)?.hash;
      if (!hash) continue;
      const frame =
        seatOf(state, hash) === null
          ? spectatorFrame
          : `{"type":"state","you":${JSON.stringify(privateView(state, hash))},"table":${table}}`;
      try {
        socket.send(frame);
      } catch {
        // Closed meanwhile.
      }
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

  private load(): TableState | null {
    if (this.loaded) return this.state;
    this.loaded = true;
    const exists = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poker_table'").toArray();
    if (exists.length === 0) return (this.state = null);
    const row = this.sql.exec('SELECT state FROM poker_table WHERE id = 1').toArray()[0];
    this.state = row ? (JSON.parse(row.state as string) as TableState) : null;
    return this.state;
  }

  /** One row holds the whole table (deck included): one atomic write per change. */
  private save(): void {
    const state = this.state;
    if (!state) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO poker_table (id, table_id, visibility, state, updated_at) VALUES (1, ?, ?, ?, ?)`,
      state.tableId, state.visibility, JSON.stringify(state), state.updatedAt,
    );
  }
}

function attachmentOf(ws: WebSocket): Attachment | null {
  return ws.deserializeAttachment() as Attachment | null;
}

function sendTo(ws: WebSocket, message: PokerServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket closed meanwhile.
  }
}

function reject(code: number, errorCode: PokerErrorCode, message: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ type: 'error', code: errorCode, message } satisfies PokerServerMessage));
  server.close(code, errorCode);
  return new Response(null, { status: 101, webSocket: client });
}
