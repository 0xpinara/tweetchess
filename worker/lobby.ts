/**
 * GameLobby — one Durable Object per game type ("chess", "poker").
 *
 * Both instances keep the public live-games directory for their game: rooms
 * that are listed push small summaries here (throttled), visitors read them
 * in pages. Entries carry no player identities, and stale ones expire, so a
 * room that crashed or was deleted without saying goodbye disappears anyway.
 *
 * Chess instance: the matchmaking coordinator. Waiting players hold a
 * hibernatable WebSocket; the queue is derived from those sockets, so closing
 * the browser leaves the queue automatically and nothing stale survives.
 *
 * Pairing is done synchronously inside this single-threaded object (both
 * players leave the queue before any await), then the chess room is created
 * with an idempotent RPC. A `matches` row records every pairing so that a
 * guest who refreshes is sent back to their game instead of being matched
 * again, and so a failed room creation can be retried safely.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  LIVE_PAGE_SIZE,
  LOBBY_PROTOCOL_VERSION,
  parseMatchmakingMessage,
  type LiveFilter,
  type LiveGame,
  type LivePage,
  type MatchmakingClientMessage,
  type MatchmakingServerMessage,
} from '../shared/lobby.ts';
import { DEFAULT_NAME, sanitizeDisplayName } from '../shared/names.ts';
import { CloseCode, type Color } from '../shared/protocol.ts';
import { hashToken, randomRoomId, secureRandomInt } from './crypto.ts';

/** Limits for lobby connections (mutable so tests can lower them). */
export const LOBBY_LIMITS = {
  maxSockets: 2000,
  helloTimeoutMs: 10_000,
};
/** A pairing counts as a guest's current game for this long (unless the game ended). */
const MATCH_MEMORY_MS = 6 * 60 * 60 * 1000;
/** Old pairing records are cleaned up after this long. */
const MATCH_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Directory entries not refreshed for this long are hidden and later deleted. */
export const LISTING_STALE_MS = 30 * 60 * 1000;
/** How often stale directory entries are purged (only while there are entries). */
const LISTING_PURGE_MS = 10 * 60 * 1000;
/** Upper bound on directory size per game type (oldest entries are dropped). */
const MAX_LISTINGS = 1000;
/** After a failed room creation, try pairing again this soon. */
const PAIRING_RETRY_MS = 5_000;
const RATE_BURST = 10;
const RATE_PER_SECOND = 2;
const OPEN = 1;

interface LobbySocket {
  hash: string | null;
  name: string;
  /** When this guest joined the queue (null = not queued). */
  queuedAt: number | null;
  connectedAt: number;
}

interface Waiting {
  hash: string;
  name: string;
  queuedAt: number;
}

type ActiveMatch =
  | { state: 'creating' }
  | { state: 'ready'; roomId: string; color: Color; opponent: string };

export class GameLobby extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS matches (
      room_id TEXT PRIMARY KEY,
      white TEXT NOT NULL,
      black TEXT NOT NULL,
      white_name TEXT NOT NULL,
      black_name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      open_seats INTEGER NOT NULL,
      spectators INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS listings_rank ON listings (spectators DESC, updated_at DESC)');
  }

  // ------------------------------------------------- Live directory (RPC)

  /** Add or refresh a public game's summary. Called by game rooms. */
  async publish(entry: LiveGame): Promise<void> {
    const game = this.ctx.id.name;
    if (game && entry.game !== game) throw new Error(`Listing for ${entry.game} sent to the ${game} lobby`);
    if (!/^[A-Za-z0-9]{1,16}$/.test(entry.id)) throw new Error('Invalid listing id');
    const now = Date.now();
    const data = JSON.stringify({ ...entry, updatedAt: now });
    this.sql.exec(
      `INSERT INTO listings (id, status, open_seats, spectators, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, open_seats = excluded.open_seats,
         spectators = excluded.spectators, updated_at = excluded.updated_at, data = excluded.data`,
      entry.id, entry.status, entry.openSeats, entry.spectators, now, data,
    );
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM listings').one().n as number;
    if (count > MAX_LISTINGS) {
      this.sql.exec(
        'DELETE FROM listings WHERE id IN (SELECT id FROM listings ORDER BY updated_at ASC LIMIT ?)',
        count - MAX_LISTINGS,
      );
    }
    this.scheduleAlarm(now + LISTING_PURGE_MS);
  }

  /** Remove a game from the directory (it ended, was deleted, or became private). */
  async unpublish(id: string): Promise<void> {
    this.sql.exec('DELETE FROM listings WHERE id = ?', id);
  }

  /** One page of fresh public games, most-watched first. */
  async list(query: { filter: LiveFilter; offset: number; limit?: number }): Promise<LivePage> {
    const limit = Math.min(Math.max(query.limit ?? LIVE_PAGE_SIZE, 1), 50);
    const offset = Math.min(Math.max(query.offset, 0), MAX_LISTINGS);
    const conditions = ['updated_at > ?'];
    if (query.filter === 'waiting') conditions.push("status = 'waiting'");
    if (query.filter === 'playing') conditions.push("status = 'playing'");
    if (query.filter === 'open') conditions.push('open_seats > 0');
    const rows = this.sql
      .exec(
        `SELECT data FROM listings WHERE ${conditions.join(' AND ')}
         ORDER BY spectators DESC, updated_at DESC LIMIT ? OFFSET ?`,
        Date.now() - LISTING_STALE_MS, limit + 1, offset,
      )
      .toArray();
    const games = rows.slice(0, limit).map((row) => JSON.parse(row.data as string) as LiveGame);
    return { games, nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  // ------------------------------------------------------ Matchmaking (WebSocket)

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const now = Date.now();
    if (this.openSockets().length >= LOBBY_LIMITS.maxSockets) this.closeSilentSockets(now);
    const { 0: client, 1: server } = new WebSocketPair();
    if (this.openSockets().length >= LOBBY_LIMITS.maxSockets) {
      server.accept();
      sendTo(server, { type: 'error', code: 'busy', message: 'Matchmaking is very busy right now. Please try again in a minute.' });
      server.close(CloseCode.RoomFull, 'busy');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ hash: null, name: DEFAULT_NAME, queuedAt: null, connectedAt: now } satisfies LobbySocket);
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
    const msg = parseMatchmakingMessage(raw);
    if (!msg) {
      sendTo(ws, { type: 'error', code: 'bad_message', message: 'Malformed message.' });
      return;
    }
    if (msg.type === 'hello') {
      await this.hello(ws, msg);
      return;
    }
    const me = attachment(ws);
    if (!me?.hash) {
      sendTo(ws, { type: 'error', code: 'not_authenticated', message: 'Connect first.' });
      return;
    }
    if (msg.type === 'queue') await this.queue(ws, me.hash);
    else this.cancel(me.hash);
  }

  async webSocketClose(): Promise<void> {
    // A closed socket simply stops counting as queued; refresh everyone's count.
    this.broadcastSearching();
  }

  async webSocketError(): Promise<void> {
    this.broadcastSearching();
  }

  private async hello(ws: WebSocket, msg: Extract<MatchmakingClientMessage, { type: 'hello' }>) {
    if (msg.protocol !== LOBBY_PROTOCOL_VERSION) {
      sendTo(ws, { type: 'error', code: 'unsupported_version', message: 'Timeline Games was updated. Please reload the page.' });
      ws.close(CloseCode.UnsupportedVersion, 'Reload required');
      return;
    }
    if (attachment(ws)?.hash) {
      sendTo(ws, { type: 'error', code: 'bad_message', message: 'Already connected.' });
      return;
    }
    const hash = await hashToken(msg.token);
    const current = attachment(ws);
    if (!current || current.hash) return;
    ws.serializeAttachment({ ...current, hash, name: sanitizeDisplayName(msg.name) ?? DEFAULT_NAME } satisfies LobbySocket);
    sendTo(ws, { type: 'welcome', searching: this.waiting().length });

    // Already matched (e.g. the page was refreshed right after pairing)? Send them back.
    const active = await this.activeMatch(hash);
    if (active?.state === 'ready') this.notifyMatched(hash, active, true);
  }

  private async queue(ws: WebSocket, hash: string): Promise<void> {
    const active = await this.activeMatch(hash);
    if (active?.state === 'ready') {
      this.notifyMatched(hash, active, true);
      return;
    }
    if (active?.state === 'creating') return; // Their game is being created; they'll be told shortly.

    // One queue entry per guest: every tab of this guest shares the earliest join time.
    const existing = this.waiting().find((entry) => entry.hash === hash);
    const me = attachment(ws);
    if (!me || ws.readyState !== OPEN) return;
    ws.serializeAttachment({ ...me, queuedAt: existing?.queuedAt ?? Date.now() } satisfies LobbySocket);
    this.broadcastSearching();
    await this.pairWaitingPlayers();
  }

  private cancel(hash: string): void {
    for (const socket of this.socketsOf(hash)) {
      const data = attachment(socket);
      if (data && data.queuedAt !== null) socket.serializeAttachment({ ...data, queuedAt: null } satisfies LobbySocket);
      sendTo(socket, { type: 'cancelled' });
    }
    this.broadcastSearching();
  }

  /** Pair waiting guests two at a time, oldest first, until fewer than two remain. */
  private async pairWaitingPlayers(): Promise<void> {
    for (;;) {
      const waiting = this.waiting();
      if (waiting.length < 2) return;
      // Entries are unique per guest, so a guest is never paired with themselves.
      const [first, second] = waiting;
      const [white, black] = secureRandomInt(2) === 0 ? [first, second] : [second, first];
      const roomId = randomRoomId();
      const now = Date.now();

      // Synchronously take both guests out of the queue and record the pairing,
      // so concurrent requests can neither re-pair them nor pair them twice.
      this.setQueued(first.hash, null);
      this.setQueued(second.hash, null);
      this.sql.exec(
        `INSERT INTO matches (room_id, white, black, white_name, black_name, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'creating', ?)`,
        roomId, white.hash, black.hash, white.name, black.name, now,
      );

      let created = false;
      try {
        created = await this.env.CHESS_ROOM.getByName(roomId).initializeMatch(
          roomId,
          { hash: white.hash, name: white.name },
          { hash: black.hash, name: black.name },
        );
      } catch (error) {
        console.error('initializeMatch failed', error);
      }

      if (!created) {
        // Put both back at the front of the queue and let the next request retry.
        this.sql.exec("UPDATE matches SET state = 'failed' WHERE room_id = ?", roomId);
        this.setQueued(first.hash, first.queuedAt);
        this.setQueued(second.hash, second.queuedAt);
        for (const guest of [first, second]) {
          for (const socket of this.socketsOf(guest.hash)) {
            sendTo(socket, { type: 'error', code: 'unavailable', message: 'Could not start the game. Still searching…' });
          }
        }
        this.scheduleAlarm(Date.now() + PAIRING_RETRY_MS);
        return;
      }

      this.sql.exec("UPDATE matches SET state = 'ready' WHERE room_id = ?", roomId);
      this.notifyMatched(white.hash, { state: 'ready', roomId, color: 'w', opponent: black.name }, false);
      this.notifyMatched(black.hash, { state: 'ready', roomId, color: 'b', opponent: white.name }, false);
      this.broadcastSearching();
      this.scheduleAlarm(now + MATCH_RETENTION_MS);
    }
  }

  /** The guest's current matchmade game, verified with the chess room. */
  private async activeMatch(hash: string): Promise<ActiveMatch | null> {
    const since = Date.now() - MATCH_MEMORY_MS;
    const row = this.sql
      .exec(
        `SELECT room_id, white, black, white_name, black_name, state FROM matches
         WHERE (white = ? OR black = ?) AND state IN ('creating', 'ready') AND created_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        hash, hash, since,
      )
      .toArray()[0];
    if (!row) return null;
    if (row.state === 'creating') return { state: 'creating' };

    const roomId = row.room_id as string;
    let status: { seated: boolean; status: string } | null = null;
    try {
      status = await this.env.CHESS_ROOM.getByName(roomId).playerStatus(hash);
    } catch {
      return null; // Can't verify right now: let them search rather than block them.
    }
    if (status?.seated && status.status !== 'over') {
      const color: Color = row.white === hash ? 'w' : 'b';
      const opponent = (color === 'w' ? row.black_name : row.white_name) as string;
      return { state: 'ready', roomId, color, opponent };
    }
    this.sql.exec("UPDATE matches SET state = 'finished' WHERE room_id = ?", roomId);
    return null;
  }

  private notifyMatched(hash: string, match: Extract<ActiveMatch, { state: 'ready' }>, resumed: boolean): void {
    for (const socket of this.socketsOf(hash)) {
      sendTo(socket, { type: 'matched', roomId: match.roomId, color: match.color, opponent: match.opponent, resumed });
    }
  }

  // ------------------------------------------------------------------ Alarm

  /** Retries a failed pairing, deletes old pairing records and purges stale listings. */
  async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = Date.now();
    this.sql.exec('DELETE FROM matches WHERE created_at < ?', now - MATCH_RETENTION_MS);
    this.sql.exec('DELETE FROM listings WHERE updated_at < ?', now - LISTING_STALE_MS);
    await this.pairWaitingPlayers();
    const oldest = this.sql.exec('SELECT MIN(created_at) AS t FROM matches').one().t as number | null;
    if (oldest !== null) this.scheduleAlarm(oldest + MATCH_RETENTION_MS);
    const listings = this.sql.exec('SELECT COUNT(*) AS n FROM listings').one().n as number;
    if (listings > 0) this.scheduleAlarm(now + LISTING_PURGE_MS);
  }

  /** Keep a single alarm at the earliest time anything needs doing. */
  private scheduleAlarm(at: number): void {
    if (this.alarmAt !== null && this.alarmAt <= at) return;
    this.alarmAt = at;
    void this.ctx.storage.setAlarm(at);
  }

  // ---------------------------------------------------------------- Helpers

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === OPEN);
  }

  private socketsOf(hash: string): WebSocket[] {
    return this.openSockets().filter((socket) => attachment(socket)?.hash === hash);
  }

  /** Queued guests, one entry each, oldest first. */
  private waiting(): Waiting[] {
    const byHash = new Map<string, Waiting>();
    for (const socket of this.openSockets()) {
      const data = attachment(socket);
      if (!data?.hash || data.queuedAt === null) continue;
      const entry = byHash.get(data.hash);
      if (!entry) byHash.set(data.hash, { hash: data.hash, name: data.name, queuedAt: data.queuedAt });
      else entry.queuedAt = Math.min(entry.queuedAt, data.queuedAt);
    }
    return [...byHash.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  }

  private setQueued(hash: string, queuedAt: number | null): void {
    for (const socket of this.socketsOf(hash)) {
      const data = attachment(socket);
      if (data) socket.serializeAttachment({ ...data, queuedAt } satisfies LobbySocket);
    }
  }

  private broadcastSearching(): void {
    const searching = this.waiting().length;
    for (const socket of this.openSockets()) {
      if (attachment(socket)?.queuedAt != null) sendTo(socket, { type: 'queued', searching });
    }
  }

  private closeSilentSockets(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const data = attachment(socket);
      if (data?.hash || now - (data?.connectedAt ?? 0) < LOBBY_LIMITS.helloTimeoutMs) continue;
      try {
        socket.close(CloseCode.PolicyViolation, 'No hello received');
      } catch {
        // Already closing.
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
}

function attachment(ws: WebSocket): LobbySocket | null {
  return ws.deserializeAttachment() as LobbySocket | null;
}

function sendTo(ws: WebSocket, message: MatchmakingServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket closed meanwhile.
  }
}
