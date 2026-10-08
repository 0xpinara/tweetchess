import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { ClientMessage, Role, RoomSnapshot, ServerMessage } from '../../shared/protocol.ts';

export const ORIGIN = 'https://tweetchess.test';

let tokenCounter = 0;
/** A valid, unique guest token (43 base64url characters). */
export function newToken(): string {
  tokenCounter += 1;
  return `test${tokenCounter}`.padEnd(43, 'x');
}

export async function createRoom(): Promise<string> {
  const response = await exports.default.fetch(`${ORIGIN}/api/rooms`, { method: 'POST' });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { roomId: string };
  return body.roomId;
}

export type StateMessage = { type: 'state'; you: Role; state: RoomSnapshot };

/** A WebSocket test client with a message inbox and awaitable expectations. */
export class TestClient {
  readonly inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private closeWaiters: ((info: { code: number; reason: string }) => void)[] = [];

  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      const message = JSON.parse(event.data) as ServerMessage;
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      for (const resolve of this.closeWaiters) resolve(this.closed);
    });
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the next message matching `match` (including already-received ones). */
  next<T extends ServerMessage = ServerMessage>(match: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<T> {
    const index = this.inbox.findIndex(match);
    if (index !== -1) return Promise.resolve(this.inbox.splice(index, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as T);
        },
      });
    });
  }

  nextState(match: (s: StateMessage) => boolean = () => true): Promise<StateMessage> {
    return this.next<StateMessage>((m) => m.type === 'state' && match(m as StateMessage));
  }

  nextError(): Promise<Extract<ServerMessage, { type: 'error' }>> {
    return this.next((m) => m.type === 'error');
  }

  async hello(token: string, sit?: boolean): Promise<StateMessage> {
    this.send(sit === undefined ? { type: 'hello', token, protocol: 1 } : { type: 'hello', token, protocol: 1, sit });
    return this.nextState();
  }

  waitForClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
      this.closeWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /** Drop everything received so far. */
  drain(): void {
    this.inbox.length = 0;
  }

  close(): void {
    try {
      this.ws.close(1000, 'test done');
    } catch {
      // ignore
    }
  }
}

export async function connect(roomId: string, headers: Record<string, string> = {}): Promise<TestClient> {
  const response = await exports.default.fetch(`${ORIGIN}/api/rooms/${roomId}/ws`, {
    headers: { Upgrade: 'websocket', ...headers },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const client = new TestClient(ws);
  ws.accept();
  return client;
}

/** Connect and say hello in one step (`sit: false` = a reconnect that must not grab a free seat). */
export async function join(
  roomId: string,
  token = newToken(),
  sit?: boolean,
): Promise<{ client: TestClient; state: StateMessage; token: string }> {
  const client = await connect(roomId);
  const state = await client.hello(token, sit);
  return { client, state, token };
}

/** Two seated players (white, black) in a fresh private room. */
export async function startedGame() {
  const roomId = await createRoom();
  const white = await join(roomId);
  const black = await join(roomId);
  expect(white.state.you).toBe('w');
  expect(black.state.you).toBe('b');
  // White receives a broadcast when Black sits down.
  await white.client.nextState((s) => s.state.status === 'active');
  white.client.drain();
  black.client.drain();
  return { roomId, white, black };
}

/** Play a move and wait until `observer` sees the resulting ply. */
export async function playMove(
  player: TestClient,
  observer: TestClient,
  from: string,
  to: string,
  expectedPly: number,
  promotion?: 'q' | 'r' | 'b' | 'n',
): Promise<StateMessage> {
  player.send(promotion ? { type: 'move', from, to, promotion, expectedPly } : { type: 'move', from, to, expectedPly });
  return observer.nextState((s) => s.state.ply === expectedPly + 1);
}

/** Connect to the chess matchmaking lobby. */
export async function connectLobby(): Promise<TestClient> {
  const response = await exports.default.fetch(`${ORIGIN}/api/matchmaking/chess/ws`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const client = new TestClient(ws);
  ws.accept();
  return client;
}

/** Two guests matched through the lobby; returns the room and their tokens by colour. */
export async function matchPair(names: [string, string] = ['Alice', 'Bob']) {
  const tokens = [newToken(), newToken()];
  const clients = await Promise.all(tokens.map(() => connectLobby()));
  clients.forEach((client, index) => client.send({ type: 'hello', token: tokens[index], protocol: 1, name: names[index] }));
  await Promise.all(clients.map((client) => client.next((m) => (m as { type: string }).type === 'welcome')));
  for (const client of clients) client.send({ type: 'queue' });
  const results = (await Promise.all(
    clients.map((client) => client.next((m) => (m as { type: string }).type === 'matched')),
  )) as unknown as { roomId: string; color: 'w' | 'b' }[];
  for (const client of clients) client.close();
  const whiteIndex = results[0].color === 'w' ? 0 : 1;
  return { roomId: results[0].roomId, white: tokens[whiteIndex], black: tokens[1 - whiteIndex] };
}

/** Poll until `check` passes (directory updates are asynchronous). */
export async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Condition not met in ${timeoutMs} ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
