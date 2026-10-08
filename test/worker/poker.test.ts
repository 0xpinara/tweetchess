import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LivePage } from '../../shared/lobby.ts';
import type { PlayerView, PokerServerMessage, PublicTable } from '../../shared/poker.ts';
import { LIVE_CACHE } from '../../worker/index.ts';
import type { TableState } from '../../worker/poker/engine.ts';
import { POKER_TIMING, type PokerTable } from '../../worker/poker-table.ts';
import { ORIGIN, TestClient, eventually, newToken } from './helpers.ts';

type StateFrame = { type: 'state'; you: PlayerView; table: PublicTable };
type ErrorFrame = Extract<PokerServerMessage, { type: 'error' }>;

const isState = (m: unknown): m is StateFrame => (m as { type?: string }).type === 'state';

async function openTable(kind: 'private' | 'find' = 'private'): Promise<string> {
  const response = await exports.default.fetch(`${ORIGIN}/api/poker/${kind === 'private' ? 'tables' : 'find'}`, {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
  return ((await response.json()) as { tableId: string }).tableId;
}

async function connectTable(tableId: string): Promise<TestClient> {
  const response = await exports.default.fetch(`${ORIGIN}/api/poker/tables/${tableId}/ws`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const client = new TestClient(ws);
  ws.accept();
  return client;
}

async function joinTable(tableId: string, options: { sit?: boolean; token?: string; name?: string } = {}) {
  const token = options.token ?? newToken();
  const client = await connectTable(tableId);
  client.send({ type: 'hello', token, protocol: 1, sit: options.sit ?? true, name: options.name ?? `P${token.slice(4, 7)}` });
  const first = (await client.next(isState as (m: unknown) => boolean)) as unknown as StateFrame;
  return { client, token, first };
}

const nextState = (client: TestClient, match: (s: StateFrame) => boolean = () => true) =>
  client.next((m) => isState(m) && match(m)) as unknown as Promise<StateFrame>;
const nextError = (client: TestClient) =>
  client.next((m) => (m as { type?: string }).type === 'error') as unknown as Promise<ErrorFrame>;

const table = (tableId: string) => env.POKER_TABLE.getByName(tableId);

/** Start from an empty table finder (other tests leave public tables behind). */
async function resetFinder(): Promise<void> {
  await runInDurableObject(env.LOBBY.getByName('poker'), (instance) => {
    const lobby = instance as unknown as { sql: SqlStorage; reservations: Map<string, number[]>; freshTables: Map<string, number> };
    lobby.sql.exec('DELETE FROM listings');
    lobby.reservations.clear();
    lobby.freshTables.clear();
  });
}

/** The table's authoritative state, loaded the same way the object loads it after waking up. */
async function serverState(tableId: string): Promise<TableState> {
  return runInDurableObject(table(tableId), (instance: PokerTable) => {
    return structuredClone((instance as unknown as { load(): TableState }).load());
  });
}

/** Wait until a hand is being played (the table deals by itself via an alarm). */
async function handDealt(client: TestClient, tableId: string): Promise<StateFrame> {
  const seen = nextState(client, (s) => Boolean(s.table.hand && !s.table.hand.done));
  // Alarms fire on their own, but nudge it in case the runtime hasn't yet.
  setTimeout(() => void runDurableObjectAlarm(table(tableId)).catch(() => {}), 100);
  return seen;
}

/** The most recent full state this client received. */
function latest(client: TestClient): StateFrame {
  for (let i = client.frames.length - 1; i >= 0; i--) {
    const message = JSON.parse(client.frames[i]);
    if (isState(message)) return message;
  }
  throw new Error('No state received yet');
}

type Seated = { client: TestClient; token: string; first: StateFrame };

/** The seated player whose turn it is, according to the server. */
async function playerToAct(players: Seated[], tableId: string): Promise<{ player: Seated; hand: TableState['hand'] & object }> {
  const hand = (await serverState(tableId)).hand!;
  const player = players.find((p) => p.first.you.seat === hand.turn);
  if (!player) throw new Error(`Nobody at seat ${hand.turn}`);
  return { player, hand };
}

function send(client: TestClient, hand: { number: number; seq: number }, action: string, amount?: number) {
  client.send(
    amount === undefined
      ? { type: 'act', action, hand: hand.number, seq: hand.seq }
      : { type: 'act', action, amount, hand: hand.number, seq: hand.seq },
  );
}

describe('poker tables', () => {
  beforeAll(() => {
    POKER_TIMING.startDelayMs = 0;
    POKER_TIMING.publishIntervalMs = 0;
    LIVE_CACHE.ttlMs = 0;
  });
  afterAll(() => {
    POKER_TIMING.startDelayMs = 3_000;
    POKER_TIMING.publishIntervalMs = 15_000;
    LIVE_CACHE.ttlMs = 5_000;
  });

  it('deals private hole cards that only their owner ever receives', async () => {
    const tableId = await openTable();
    const alice = await joinTable(tableId);
    const bob = await joinTable(tableId);
    const viewer = await joinTable(tableId, { sit: false });
    expect(viewer.first.you.seat).toBeNull();

    const aliceHand = await handDealt(alice.client, tableId);
    const server = await serverState(tableId);
    const hand = server.hand!;
    const aliceSeat = aliceHand.you.seat!;
    const bobSeat = server.seats.findIndex((seat, index) => seat && index !== aliceSeat);
    expect(aliceHand.you.hole).toEqual(hand.players[aliceSeat].hole);

    // Play a little so more frames go out.
    const { player, hand: current } = await playerToAct([alice, bob], tableId);
    send(player.client, current, 'call');
    await nextState(viewer.client, (s) => s.table.hand!.seq >= 1);

    const quoted = (cards: string[]) => cards.map((card) => `"${card}"`);
    for (const card of quoted(hand.players[bobSeat].hole)) expect(alice.client.frames.join('\n')).not.toContain(card);
    for (const card of quoted(hand.players[aliceSeat].hole)) expect(bob.client.frames.join('\n')).not.toContain(card);
    for (const card of [...quoted(hand.players[aliceSeat].hole), ...quoted(hand.players[bobSeat].hole)]) {
      expect(viewer.client.frames.join('\n')).not.toContain(card);
    }
    expect(viewer.client.frames.join('\n')).not.toMatch(/[0-9a-f]{64}/); // no identities either
    for (const c of [alice.client, bob.client, viewer.client]) c.close();
  });

  it('rejects out-of-turn, stale and illegal actions, and spectators cannot act', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    const viewer = await joinTable(tableId, { sit: false });
    await handDealt(a.client, tableId);
    const { player, hand } = await playerToAct([a, b], tableId);
    const other = player === a ? b : a;

    send(other.client, hand, 'call');
    expect((await nextError(other.client)).code).toBe('not_your_turn');
    send(player.client, { number: hand.number, seq: hand.seq + 5 }, 'call');
    expect((await nextError(player.client)).code).toBe('stale');
    send(player.client, hand, 'check'); // heads-up: the small blind faces the big blind
    expect((await nextError(player.client)).code).toBe('illegal_action');
    send(player.client, hand, 'raise', 15); // the minimum raise is to 20
    expect((await nextError(player.client)).code).toBe('invalid_amount');
    send(viewer.client, hand, 'call');
    expect((await nextError(viewer.client)).code).toBe('not_seated');
    // None of that changed the hand.
    expect((await serverState(tableId)).hand!.seq).toBe(hand.seq);
    for (const c of [a.client, b.client, viewer.client]) c.close();
  });

  it('plays a hand to showdown over the wire, conserving chips and revealing only showdown hands', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    const viewer = await joinTable(tableId, { sit: false });
    await handDealt(a.client, tableId);

    // Everyone just calls or checks until the hand ends.
    for (let i = 0; i < 12; i++) {
      const server = await serverState(tableId);
      if (!server.hand || server.hand.done) break;
      const { player, hand } = await playerToAct([a, b], tableId);
      const facing = hand.currentBet > hand.players[hand.turn!].bet;
      send(player.client, hand, facing ? 'call' : 'check');
      await eventually(() => serverState(tableId), (st) => st.hand!.seq > hand.seq || st.hand!.done);
    }
    const done = await nextState(viewer.client, (s) => Boolean(s.table.hand?.done));
    expect(done.table.lastResult).not.toBeNull();
    const stacks = done.table.seats.filter(Boolean).reduce((sum, seat) => sum + seat!.stack, 0);
    expect(stacks).toBe(2000);
    // Both players reached showdown, so both hands are shown to everyone.
    expect(done.table.seats.filter((seat) => seat?.shownCards).length).toBe(2);
    for (const c of [a.client, b.client, viewer.client]) c.close();
  });

  it('times out a player who does not act (via the table alarm)', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    await handDealt(a.client, tableId);
    await runInDurableObject(table(tableId), (instance: PokerTable) => {
      const internals = instance as unknown as { state: TableState; save(): void };
      internals.state.hand!.deadline = Date.now() - 1;
      internals.save();
    });
    await runDurableObjectAlarm(table(tableId));
    const server = await serverState(tableId);
    // Heads-up, the small blind faced the big blind, so the timeout folded and ended the hand.
    expect(server.hand!.done).toBe(true);
    expect(Object.values(server.hand!.players).some((p) => p.lastAction === 'Fold (time)')).toBe(true);
    expect(server.seats.filter(Boolean).reduce((sum, seat) => sum + seat!.stack, 0)).toBe(2000);
    a.client.close();
    b.client.close();
  });

  it('keeps the hand and every hole card after the table hibernates mid-hand', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    await handDealt(a.client, tableId);
    const before = await serverState(tableId);

    await evictDurableObject(table(tableId), { webSockets: 'hibernate' });
    const after = await serverState(tableId);
    expect(after.hand).toEqual(before.hand);

    // The player to act can carry on through the hibernated sockets.
    const { player, hand } = await playerToAct([a, b], tableId);
    send(player.client, hand, 'call');
    await eventually(() => serverState(tableId), (st) => st.hand!.seq === hand.seq + 1);
    expect(latest(player.client).you.hole).toEqual(before.hand!.players[hand.turn!].hole);
    a.client.close();
    b.client.close();
  });

  it('gives a reconnecting player their seat and cards back', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    const dealt = await handDealt(a.client, tableId);
    a.client.close();
    const again = await joinTable(tableId, { token: a.token, sit: false });
    expect(again.first.you.seat).toBe(dealt.you.seat);
    expect(again.first.you.hole).toEqual(dealt.you.hole);
    again.client.close();
    b.client.close();
  });

  it('seats six players; a seventh visitor watches', async () => {
    const tableId = await openTable();
    const players = [];
    for (let i = 0; i < 6; i++) players.push(await joinTable(tableId));
    const seats = new Set(players.map((p) => p.first.you.seat));
    expect(seats.size).toBe(6);
    const seventh = await joinTable(tableId);
    expect(seventh.first.you.seat).toBeNull();
    seventh.client.send({ type: 'sit' });
    expect((await nextError(seventh.client)).code).toBe('table_full');
    for (const p of [...players, seventh]) p.client.close();
  });

  it('a spectator who takes a seat later plays under the name they joined with', async () => {
    const tableId = await openTable();
    const watcher = await joinTable(tableId, { sit: false, name: 'Frank' });
    expect(watcher.first.you.seat).toBeNull();
    watcher.client.send({ type: 'sit', seat: 3 });
    const seated = await nextState(watcher.client, (s) => s.you.seat === 3);
    expect(seated.table.seats[3]?.name).toBe('Frank');
    watcher.client.close();
  });

  it('fills one public table before opening another, even when players arrive in a burst', async () => {
    await resetFinder();
    const found: string[] = [];
    const players: Seated[] = [];
    for (let i = 0; i < 6; i++) {
      found.push(await openTable('find'));
      players.push(await joinTable(found[i]));
    }
    expect(new Set(found).size).toBe(1);
    expect(new Set(players.map((p) => p.first.you.seat)).size).toBe(6);
    // That table is full now, so the seventh player gets a new one.
    const seventh = await openTable('find');
    expect(seventh).not.toBe(found[0]);
    for (const p of players) p.client.close();
  });

  it('runs tables independently', async () => {
    const one = await openTable();
    const two = await openTable();
    const a1 = await joinTable(one);
    const b1 = await joinTable(one);
    const a2 = await joinTable(two);
    await handDealt(a1.client, one);
    expect((await serverState(two)).hand).toBeNull();
    expect((await serverState(one)).hand).not.toBeNull();
    for (const c of [a1.client, b1.client, a2.client]) c.close();
  });

  it('frees the seat of a player who stays away', async () => {
    const tableId = await openTable();
    const a = await joinTable(tableId);
    const b = await joinTable(tableId);
    a.client.close();
    await eventually(() => serverState(tableId), (s) => s.seats.some((seat) => seat?.disconnectedAt !== null && seat !== null));
    await runInDurableObject(table(tableId), (instance: PokerTable) => {
      const internals = instance as unknown as { state: TableState; save(): void };
      for (const seat of internals.state.seats) if (seat?.disconnectedAt) seat.disconnectedAt = Date.now() - 60 * 60_000;
      internals.save();
    });
    await runDurableObjectAlarm(table(tableId));
    await eventually(() => serverState(tableId), (s) => s.seats.filter(Boolean).length === 1 && !s.hand?.players[0]);
    b.client.close();
  });

  it('finds open public tables, lists them, and never lists private tables', async () => {
    await resetFinder();
    const first = await openTable('find');
    const second = await openTable('find');
    expect(second).toBe(first); // a new table is offered to the next player too
    const a = await joinTable(first);
    const b = await joinTable(second);

    const privateId = await openTable('private');
    const p = await joinTable(privateId);

    const live = async () =>
      (await (await exports.default.fetch(`${ORIGIN}/api/live?game=poker`)).json()) as LivePage;
    const page = await eventually(live, (pg) => pg.games.some((g) => g.id === first));
    expect(page.games.find((g) => g.id === first)).toMatchObject({ game: 'poker', seated: 2, openSeats: 4 });
    expect(page.games.some((g) => g.id === privateId)).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/"(hole|deck)"/);
    for (const c of [a.client, b.client, p.client]) c.close();
  });

  it('refuses unknown tables and malformed actions', async () => {
    const missing = await connectTable('Zz9Zz9Zz9Z');
    expect((await nextError(missing)).code).toBe('table_not_found');
    const tableId = await openTable();
    const a = await joinTable(tableId);
    a.client.send({ type: 'act', action: 'cheat', hand: 1, seq: 0 });
    expect((await nextError(a.client)).code).toBe('bad_message');
    a.client.send({ type: 'act', action: 'raise', amount: -5, hand: 1, seq: 0 });
    expect((await nextError(a.client)).code).toBe('bad_message');
    a.client.close();
  });
});
