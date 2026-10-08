import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LIMITS, ROOM_TTL_MS, type ChessRoom } from '../../worker/chess-room.ts';
import { ORIGIN, connect, createRoom, join, newToken, playMove, startedGame } from './helpers.ts';

/** Reach into the object's private state (tests only). */
type RoomInternals = { loaded: boolean; match: { record: { updatedAt: number } } | null; save(): void };
const internals = (room: ChessRoom) => room as unknown as RoomInternals;

describe('HTTP routes', () => {
  it('serves a health check', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'tweetchess' });
  });

  it('creates rooms with unguessable IDs and only via POST', async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(a).not.toBe(b);
    const get = await exports.default.fetch(`${ORIGIN}/api/rooms`);
    expect(get.status).toBe(405);
  });

  it('refuses room creation from other websites', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/rooms`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/nope`);
    expect(response.status).toBe(404);
  });
});

describe('WebSocket connection rules', () => {
  it('rejects malformed room IDs and non-WebSocket requests', async () => {
    for (const id of ['bad!id', 'short', 'AbCdEfGh12345', '%2e%2e']) {
      const bad = await exports.default.fetch(`${ORIGIN}/api/rooms/${id}/ws`, { headers: { Upgrade: 'websocket' } });
      expect(bad.status, id).toBe(404);
    }
    const plain = await exports.default.fetch(`${ORIGIN}/api/rooms/AbCdEfGh12/ws`);
    expect(plain.status).toBe(426);
  });

  it('rejects WebSockets opened from another origin', async () => {
    const roomId = await createRoom();
    const response = await exports.default.fetch(`${ORIGIN}/api/rooms/${roomId}/ws`, {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    const same = await connect(roomId, { Origin: ORIGIN });
    same.close();
  });

  it('tells the client when a room does not exist', async () => {
    const client = await connect('Zz9Zz9Zz9Z');
    const error = await client.nextError();
    expect(error.code).toBe('room_not_found');
    expect((await client.waitForClose()).code).toBe(4004);
  });

  it('requires hello before any action and rejects malformed messages', async () => {
    const roomId = await createRoom();
    const client = await connect(roomId);
    client.send({ type: 'move', from: 'e2', to: 'e4', expectedPly: 0 });
    expect((await client.nextError()).code).toBe('not_authenticated');
    client.ws.send('{not json');
    expect((await client.nextError()).code).toBe('bad_message');
    client.send({ type: 'hello', token: 'short', protocol: 1 });
    expect((await client.nextError()).code).toBe('bad_message');
    client.close();
  });

  it('closes the socket on oversized messages', async () => {
    const roomId = await createRoom();
    const client = await connect(roomId);
    client.ws.send('x'.repeat(5000));
    expect((await client.waitForClose()).code).toBe(1009);
  });

  it('closes the socket when a client floods messages', async () => {
    const roomId = await createRoom();
    const { client } = await join(roomId);
    for (let i = 0; i < 40; i++) client.send({ type: 'sit' });
    expect((await client.waitForClose()).code).toBe(1008);
  });

  it('asks outdated clients to reload', async () => {
    const roomId = await createRoom();
    const client = await connect(roomId);
    client.send({ type: 'hello', token: newToken(), protocol: 999 });
    expect((await client.nextError()).code).toBe('unsupported_version');
    expect((await client.waitForClose()).code).toBe(4010);
  });

  it('answers heartbeat pings', async () => {
    const roomId = await createRoom();
    const client = await connect(roomId);
    const pong = new Promise<string>((resolve) =>
      client.ws.addEventListener('message', (event) => {
        if (event.data === 'pong') resolve(event.data);
      }),
    );
    client.ws.send('ping');
    expect(await pong).toBe('pong');
    client.close();
  });
});

describe('seats and spectators', () => {
  it('gives two simultaneous visitors distinct colours and makes the third a spectator', async () => {
    const roomId = await createRoom();
    const [a, b] = await Promise.all([connect(roomId), connect(roomId)]);
    const [stateA, stateB] = await Promise.all([a.hello(newToken()), b.hello(newToken())]);
    expect([stateA.you, stateB.you].sort()).toEqual(['b', 'w']);

    const third = await join(roomId);
    expect(third.state.you).toBe('spectator');
    expect(third.state.state.status).toBe('active');
    expect(third.state.state.spectators).toBe(1);
    expect(JSON.stringify(third.state)).not.toMatch(/[0-9a-f]{64}/); // no token hashes leak
    for (const client of [a, b, third.client]) client.close();
  });

  it('lets many visitors race for seats without ever double-booking one', async () => {
    const roomId = await createRoom();
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect(roomId)));
    const states = await Promise.all(clients.map((client) => client.hello(newToken())));
    const roles = states.map((state) => state.you).sort();
    expect(roles).toEqual(['b', 'spectator', 'spectator', 'spectator', 'spectator', 'spectator', 'spectator', 'w']);
    for (const client of clients) client.close();
  });

  it('keeps a seat for a returning player (refresh) and sends the current position', async () => {
    const { roomId, white, black } = await startedGame();
    await playMove(white.client, black.client, 'e2', 'e4', 0);
    black.client.close();

    const again = await join(roomId, black.token);
    expect(again.state.you).toBe('b');
    expect(again.state.state.ply).toBe(1);
    expect(again.state.state.moves[0].san).toBe('e4');
    white.client.close();
    again.client.close();
  });

  it('does not put a player who left back into a free seat when they reconnect', async () => {
    const { roomId, white, black } = await startedGame();
    black.client.send({ type: 'leave' });
    await white.client.nextState((s) => !s.state.seats.b.taken);
    black.client.close();

    const returning = await join(roomId, black.token, false);
    expect(returning.state.you).toBe('spectator');
    const newcomer = await join(roomId);
    expect(newcomer.state.you).toBe('b');
    for (const c of [white.client, returning.client, newcomer.client]) c.close();
  });

  it("lets reconnecting spectators keep watching instead of grabbing a seat, until they choose to sit", async () => {
    const { roomId, white, black } = await startedGame();
    const viewer = await join(roomId);
    black.client.send({ type: 'leave' });
    await viewer.client.nextState((s) => !s.state.seats.b.taken);
    viewer.client.close();

    const again = await join(roomId, viewer.token, false);
    expect(again.state.you).toBe('spectator');
    again.client.send({ type: 'sit' });
    expect((await again.client.nextState((s) => s.you !== 'spectator')).you).toBe('b');
    for (const c of [white.client, black.client, again.client]) c.close();
  });

  it('caps spectators but always lets seated players back in', async () => {
    const before = LIMITS.maxSpectators;
    LIMITS.maxSpectators = 1;
    try {
      const { roomId, white, black } = await startedGame();
      const first = await join(roomId);
      expect(first.state.you).toBe('spectator');
      const extra = await connect(roomId);
      extra.send({ type: 'hello', token: newToken(), protocol: 1 });
      expect((await extra.nextError()).code).toBe('room_full');
      expect((await extra.waitForClose()).code).toBe(4013);
      // The same spectator in a second tab is still welcome, and so is a returning player.
      expect((await join(roomId, first.token)).state.you).toBe('spectator');
      white.client.close();
      expect((await join(roomId, white.token, false)).state.you).toBe('w');
      black.client.close();
    } finally {
      LIMITS.maxSpectators = before;
    }
  });

  it('closes silent sockets to make room when a room is at capacity', async () => {
    const before = { ...LIMITS };
    LIMITS.maxSockets = 3;
    LIMITS.helloTimeoutMs = 0;
    try {
      const roomId = await createRoom();
      const silent = await Promise.all([connect(roomId), connect(roomId), connect(roomId)]);
      const player = await join(roomId); // 4th connection triggers the sweep
      expect(player.state.you).toBe('w');
      expect((await silent[0].waitForClose()).code).toBe(1008);
      player.client.close();
    } finally {
      Object.assign(LIMITS, before);
    }
  });

  it('reports who is online', async () => {
    const { white, black } = await startedGame();
    black.client.close();
    const presence = await white.client.next((m) => m.type === 'presence' && !m.seats.b.online);
    expect(presence).toMatchObject({ seats: { w: { taken: true, online: true }, b: { taken: true, online: false } } });
    white.client.close();
  });
});

describe('server-side move validation', () => {
  it('broadcasts a legal move to the opponent and spectators', async () => {
    const { roomId, white, black } = await startedGame();
    const viewer = await join(roomId);
    white.client.send({ type: 'move', from: 'e2', to: 'e4', expectedPly: 0 });
    const [seenByBlack, seenByViewer] = await Promise.all([
      black.client.nextState((s) => s.state.ply === 1),
      viewer.client.nextState((s) => s.state.ply === 1),
    ]);
    expect(seenByBlack.state.moves[0]).toMatchObject({ san: 'e4', from: 'e2', to: 'e4' });
    expect(seenByViewer.you).toBe('spectator');
    expect(seenByViewer.state.fen).toBe(seenByBlack.state.fen);
    for (const c of [white.client, black.client, viewer.client]) c.close();
  });

  it('rejects spectator moves, wrong-colour moves, double moves, illegal and stale moves', async () => {
    const { roomId, white, black } = await startedGame();
    const viewer = await join(roomId);

    viewer.client.send({ type: 'move', from: 'e2', to: 'e4', expectedPly: 0 });
    expect((await viewer.client.nextError()).code).toBe('not_a_player');

    black.client.send({ type: 'move', from: 'e7', to: 'e5', expectedPly: 0 });
    expect((await black.client.nextError()).code).toBe('not_your_turn');

    white.client.send({ type: 'move', from: 'e7', to: 'e5', expectedPly: 0 });
    expect((await white.client.nextError()).code).toBe('illegal_move');

    white.client.send({ type: 'move', from: 'e2', to: 'e5', expectedPly: 0 });
    expect((await white.client.nextError()).code).toBe('illegal_move');

    await playMove(white.client, black.client, 'e2', 'e4', 0);
    white.client.send({ type: 'move', from: 'd2', to: 'd4', expectedPly: 1 });
    expect((await white.client.nextError()).code).toBe('not_your_turn');

    // A delayed duplicate of an old move must not overwrite newer state.
    black.client.send({ type: 'move', from: 'e7', to: 'e5', expectedPly: 0 });
    expect((await black.client.nextError()).code).toBe('stale');

    const fresh = await join(roomId);
    expect(fresh.state.state.ply).toBe(1);
    expect(fresh.state.state.moves.map((m) => m.san)).toEqual(['e4']);
    for (const c of [white.client, black.client, viewer.client, fresh.client]) c.close();
  });

  it("ends the game on checkmate (fool's mate) and announces the winner", async () => {
    const { white, black } = await startedGame();
    await playMove(white.client, black.client, 'f2', 'f3', 0);
    await playMove(black.client, white.client, 'e7', 'e5', 1);
    await playMove(white.client, black.client, 'g2', 'g4', 2);
    const final = await playMove(black.client, white.client, 'd8', 'h4', 3);
    expect(final.state.status).toBe('over');
    expect(final.state.end).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(final.state.moves.at(-1)?.san).toBe('Qh4#');
    white.client.close();
    black.client.close();
  });

  it('handles promotion over the wire', async () => {
    const { white, black } = await startedGame();
    const moves: [string, string][] = [
      ['h2', 'h4'], ['g7', 'g5'], ['h4', 'g5'], ['h7', 'h6'], ['g5', 'h6'], ['f8', 'g7'], ['h6', 'g7'], ['a7', 'a6'],
    ];
    for (const [index, [from, to]] of moves.entries()) {
      const mover = index % 2 === 0 ? white.client : black.client;
      const observer = index % 2 === 0 ? black.client : white.client;
      await playMove(mover, observer, from, to, index);
    }
    white.client.send({ type: 'move', from: 'g7', to: 'h8', expectedPly: 8 });
    expect((await white.client.nextError()).code).toBe('illegal_move'); // promotion piece required
    const promoted = await playMove(white.client, black.client, 'g7', 'h8', 8, 'q');
    expect(promoted.state.moves.at(-1)).toMatchObject({ san: 'gxh8=Q', promotion: 'q', captured: 'r' });
    white.client.close();
    black.client.close();
  });
});

describe('resign and rematch', () => {
  it('lets a player resign and both players agree to a rematch with colours swapped', async () => {
    const { white, black } = await startedGame();
    await playMove(white.client, black.client, 'e2', 'e4', 0);
    white.client.send({ type: 'resign', game: 1 });
    const over = await black.client.nextState((s) => s.state.status === 'over');
    expect(over.state.end).toEqual({ winner: 'b', reason: 'resignation' });

    white.client.send({ type: 'rematch', want: true, game: 1 });
    await black.client.nextState((s) => s.state.rematch.w);
    black.client.send({ type: 'rematch', want: true, game: 1 });
    const [newWhiteView, newBlackView] = await Promise.all([
      white.client.nextState((s) => s.state.game === 2),
      black.client.nextState((s) => s.state.game === 2),
    ]);
    expect(newWhiteView.you).toBe('b');
    expect(newBlackView.you).toBe('w');
    expect(newBlackView.state).toMatchObject({ status: 'active', ply: 0, moves: [], end: null });
    white.client.close();
    black.client.close();
  });
});

describe('persistence and hibernation', () => {
  it('restores the authoritative state after the object hibernates', async () => {
    const { roomId, white, black } = await startedGame();
    const viewer = await join(roomId);
    await playMove(white.client, black.client, 'e2', 'e4', 0);
    await playMove(black.client, white.client, 'c7', 'c5', 1);

    // Evict the object from memory while keeping the sockets connected (hibernation).
    const stub = env.CHESS_ROOM.getByName(roomId);
    await runInDurableObject(stub, (instance: ChessRoom) => expect(internals(instance).loaded).toBe(true));
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    // Proof the in-memory instance is gone: a fresh one hasn't loaded anything yet.
    await runInDurableObject(stub, (instance: ChessRoom, state) => {
      expect(internals(instance).loaded).toBe(false);
      expect(state.getWebSockets()).toHaveLength(3); // sockets survived hibernation
    });

    // The next message wakes a brand-new instance, which must reload from SQLite
    // and still know who each socket belongs to.
    const afterWake = await playMove(white.client, viewer.client, 'g1', 'f3', 2);
    expect(afterWake.state.moves.map((m) => m.san)).toEqual(['e4', 'c5', 'Nf3']);
    black.client.send({ type: 'move', from: 'e7', to: 'e5', expectedPly: 2 });
    expect((await black.client.nextError()).code).toBe('stale');
    white.client.send({ type: 'move', from: 'd2', to: 'd4', expectedPly: 3 });
    expect((await white.client.nextError()).code).toBe('not_your_turn');
    for (const c of [white.client, black.client, viewer.client]) c.close();
  });

  it('keeps the game after a full restart that drops every connection', async () => {
    const { roomId, white, black } = await startedGame();
    await playMove(white.client, black.client, 'd2', 'd4', 0);
    const stub = env.CHESS_ROOM.getByName(roomId);
    await evictDurableObject(stub, { webSockets: 'close' });

    const whiteAgain = await join(roomId, white.token);
    const blackAgain = await join(roomId, black.token);
    expect(whiteAgain.state.you).toBe('w');
    expect(blackAgain.state.you).toBe('b');
    expect(blackAgain.state.state.moves.map((m) => m.san)).toEqual(['d4']);
    const next = await playMove(blackAgain.client, whiteAgain.client, 'd7', 'd5', 1);
    expect(next.state.ply).toBe(2);
    whiteAgain.client.close();
    blackAgain.client.close();
  });

  it('stores only token hashes, never raw tokens', async () => {
    const { roomId, white } = await startedGame();
    const stub = env.CHESS_ROOM.getByName(roomId);
    const row = await runInDurableObject(stub, (_instance: ChessRoom, state) =>
      state.storage.sql.exec('SELECT white, black FROM room').one(),
    );
    expect(row.white).toMatch(/^[0-9a-f]{64}$/);
    expect(row.white).not.toBe(white.token);
  });
});

describe('room lifecycle (alarms)', () => {
  it('deletes a private room after 30 days without activity', async () => {
    const roomId = await createRoom();
    const stub = env.CHESS_ROOM.getByName(roomId);
    await runInDurableObject(stub, (instance: ChessRoom) => {
      const room = internals(instance);
      room.match!.record.updatedAt = Date.now() - ROOM_TTL_MS - 1000;
      room.save();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const client = await connect(roomId);
    expect((await client.nextError()).code).toBe('room_not_found');
  });

  it('keeps an active private room when its alarm fires', async () => {
    const roomId = await createRoom();
    const stub = env.CHESS_ROOM.getByName(roomId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const { state, client } = await join(roomId);
    expect(state.you).toBe('w');
    client.close();
  });
});
