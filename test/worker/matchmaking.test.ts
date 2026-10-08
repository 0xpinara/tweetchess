import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MatchmakingServerMessage } from '../../shared/lobby.ts';
import type { ChessRoom } from '../../worker/chess-room.ts';
import { ORIGIN, TestClient, join, newToken, playMove } from './helpers.ts';

type Matched = Extract<MatchmakingServerMessage, { type: 'matched' }>;

async function connectLobby(): Promise<TestClient> {
  const response = await exports.default.fetch(`${ORIGIN}/api/matchmaking/chess/ws`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const client = new TestClient(ws);
  ws.accept();
  return client;
}

/** A guest on the matchmaking page: connected and identified. */
async function guest(token = newToken(), name = `Player ${token.slice(4, 8)}`) {
  const client = await connectLobby();
  client.send({ type: 'hello', token, protocol: 1, name });
  await client.next((m) => (m as unknown as MatchmakingServerMessage).type === 'welcome');
  return { client, token, name };
}

const isMatched = (m: unknown) => (m as MatchmakingServerMessage).type === 'matched';
const nextMatched = (client: TestClient) => client.next(isMatched) as unknown as Promise<Matched>;

async function expectNoMatch(client: TestClient, ms = 300) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(client.inbox.some(isMatched)).toBe(false);
}

type RoomInternals = { match: { record: { awaySince: { w: number | null; b: number | null }; turnStartedAt: number | null } } | null; save(): void };
const internals = (room: ChessRoom) => room as unknown as RoomInternals;

describe('chess matchmaking', () => {
  it('pairs two waiting guests into a new game with both seats assigned', async () => {
    const alice = await guest(newToken(), 'Alice');
    const bob = await guest(newToken(), 'Bob');
    alice.client.send({ type: 'queue' });
    await alice.client.next((m) => (m as unknown as MatchmakingServerMessage).type === 'queued');
    bob.client.send({ type: 'queue' });

    const [a, b] = await Promise.all([nextMatched(alice.client), nextMatched(bob.client)]);
    expect(a.roomId).toBe(b.roomId);
    expect([a.color, b.color].sort()).toEqual(['b', 'w']);
    expect(a.opponent).toBe('Bob');
    expect(b.opponent).toBe('Alice');
    expect(a.resumed).toBe(false);

    // Both players land in their seats; the game has already started.
    const aliceRoom = await join(a.roomId, alice.token);
    const bobRoom = await join(b.roomId, bob.token);
    expect(aliceRoom.state.you).toBe(a.color);
    expect(bobRoom.state.you).toBe(b.color);
    expect(bobRoom.state.state).toMatchObject({ kind: 'match', status: 'active', listed: true });
    const white = a.color === 'w' ? 'Alice' : 'Bob';
    expect(bobRoom.state.state.seats.w.name).toBe(white);
    for (const c of [alice.client, bob.client, aliceRoom.client, bobRoom.client]) c.close();
  });

  it('runs many matches at once, each in its own independent room', async () => {
    const guests = await Promise.all(Array.from({ length: 6 }, () => guest()));
    for (const g of guests) g.client.send({ type: 'queue' });
    const results = await Promise.all(guests.map((g) => nextMatched(g.client)));

    const rooms = new Map<string, string[]>();
    results.forEach((result, index) => rooms.set(result.roomId, [...(rooms.get(result.roomId) ?? []), guests[index].token]));
    expect(rooms.size).toBe(3);
    for (const tokens of rooms.values()) expect(tokens).toHaveLength(2);

    // A move in one room does not affect the others.
    const [firstRoom, secondRoom] = [...rooms.keys()];
    const players = await Promise.all(
      results.map((result, index) => join(result.roomId, guests[index].token).then((joined) => ({ ...joined, result }))),
    );
    const whiteOf = (roomId: string) => players.find((p) => p.result.roomId === roomId && p.result.color === 'w')!;
    const blackOf = (roomId: string) => players.find((p) => p.result.roomId === roomId && p.result.color === 'b')!;
    await playMove(whiteOf(firstRoom).client, blackOf(firstRoom).client, 'e2', 'e4', 0);
    const untouched = await join(secondRoom);
    expect(untouched.state.state.ply).toBe(0);
    for (const p of players) p.client.close();
    for (const g of guests) g.client.close();
    untouched.client.close();
  });

  it('never pairs a guest with themselves, even from two tabs', async () => {
    const token = newToken();
    const tab1 = await guest(token);
    const tab2 = await guest(token);
    tab1.client.send({ type: 'queue' });
    tab2.client.send({ type: 'queue' });
    await expectNoMatch(tab1.client);
    await expectNoMatch(tab2.client, 0);

    const other = await guest();
    other.client.send({ type: 'queue' });
    const [m1, m2, m3] = await Promise.all([nextMatched(tab1.client), nextMatched(tab2.client), nextMatched(other.client)]);
    expect(m1.roomId).toBe(m2.roomId); // both tabs of the same guest go to the same single game
    expect(m3.roomId).toBe(m1.roomId);
    for (const c of [tab1.client, tab2.client, other.client]) c.close();
  });

  it('removes guests who cancel or close the page', async () => {
    const leaver = await guest();
    leaver.client.send({ type: 'queue' });
    leaver.client.send({ type: 'cancel' });
    await leaver.client.next((m) => (m as unknown as MatchmakingServerMessage).type === 'cancelled');

    const closer = await guest();
    closer.client.send({ type: 'queue' });
    await closer.client.next((m) => (m as unknown as MatchmakingServerMessage).type === 'queued');
    closer.client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const first = await guest();
    first.client.send({ type: 'queue' });
    await expectNoMatch(first.client);
    const second = await guest();
    second.client.send({ type: 'queue' });
    const [a, b] = await Promise.all([nextMatched(first.client), nextMatched(second.client)]);
    expect(a.roomId).toBe(b.roomId);
    for (const c of [leaver.client, first.client, second.client]) c.close();
  });

  it('sends a refreshed guest back to their game instead of matching them again', async () => {
    const alice = await guest();
    const bob = await guest();
    alice.client.send({ type: 'queue' });
    bob.client.send({ type: 'queue' });
    const original = await nextMatched(alice.client);
    alice.client.close();

    // "Refresh": a new socket with the same token is told about the existing game…
    const again = await guest(alice.token);
    const resumed = await nextMatched(again.client);
    expect(resumed).toMatchObject({ roomId: original.roomId, color: original.color, resumed: true });
    // …and asking to queue again does not create a second game.
    again.client.send({ type: 'queue' });
    const repeat = await nextMatched(again.client);
    expect(repeat.roomId).toBe(original.roomId);
    for (const c of [again.client, bob.client]) c.close();
  });

  it('lets a guest search again once their game has ended', async () => {
    const alice = await guest();
    const bob = await guest();
    alice.client.send({ type: 'queue' });
    bob.client.send({ type: 'queue' });
    const matched = await nextMatched(alice.client);
    const room = await join(matched.roomId, alice.token);
    room.client.send({ type: 'resign', game: 1 });
    await room.client.nextState((s) => s.state.status === 'over');

    alice.client.send({ type: 'queue' });
    await alice.client.next((m) => (m as unknown as MatchmakingServerMessage).type === 'queued');
    await expectNoMatch(alice.client);
    for (const c of [alice.client, bob.client, room.client]) c.close();
  });
});

describe('matchmade games', () => {
  async function matchedPair() {
    const a = await guest();
    const b = await guest();
    a.client.send({ type: 'queue' });
    b.client.send({ type: 'queue' });
    const [ma] = await Promise.all([nextMatched(a.client), nextMatched(b.client)]);
    a.client.close();
    b.client.close();
    const white = ma.color === 'w' ? a : b;
    const black = ma.color === 'w' ? b : a;
    return { roomId: ma.roomId, white, black, stub: env.CHESS_ROOM.getByName(ma.roomId) };
  }

  it('does not let spectators take a seat', async () => {
    const { roomId, white } = await matchedPair();
    const w = await join(roomId, white.token);
    const viewer = await join(roomId);
    expect(viewer.state.you).toBe('spectator');
    viewer.client.send({ type: 'sit' });
    expect((await viewer.client.nextError()).code).toBe('not_allowed');
    w.client.close();
    viewer.client.close();
  });

  it('aborts the game when a matched player never shows up', async () => {
    const { roomId, white, stub } = await matchedPair();
    const w = await join(roomId, white.token);
    await runInDurableObject(stub, (instance: ChessRoom) => {
      const room = internals(instance);
      room.match!.record.awaySince.b = Date.now() - 5 * 60_000;
      room.save();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const over = await w.client.nextState((s) => s.state.status === 'over');
    expect(over.state.end).toEqual({ winner: null, reason: 'aborted' });
    w.client.close();
  });

  it('a player who stops moving loses on time', async () => {
    const { roomId, white, black, stub } = await matchedPair();
    const w = await join(roomId, white.token);
    const b = await join(roomId, black.token);
    await playMove(w.client, b.client, 'd2', 'd4', 0);
    await runInDurableObject(stub, (instance: ChessRoom) => {
      const room = internals(instance);
      room.match!.record.turnStartedAt = Date.now() - 10 * 60_000;
      room.save();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const over = await w.client.nextState((s) => s.state.status === 'over');
    expect(over.state.end).toEqual({ winner: 'w', reason: 'timeout' });
    w.client.close();
    b.client.close();
  });
});
