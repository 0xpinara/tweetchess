import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveChessGame, LivePage } from '../../shared/lobby.ts';
import { DIRECTORY } from '../../worker/chess-room.ts';
import { LIVE_CACHE } from '../../worker/index.ts';
import type { GameLobby } from '../../worker/lobby.ts';
import { ORIGIN, eventually, join, matchPair, playMove } from './helpers.ts';

async function live(query = 'game=chess'): Promise<LivePage> {
  const response = await exports.default.fetch(`${ORIGIN}/api/live?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as LivePage;
}

const find = (page: LivePage, id: string) => page.games.find((game) => game.id === id) as LiveChessGame | undefined;

async function createFriendGame(listed?: boolean): Promise<string> {
  const response = await exports.default.fetch(`${ORIGIN}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: listed === undefined ? undefined : JSON.stringify({ listed }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { roomId: string }).roomId;
}

describe('live games directory', () => {
  beforeAll(() => {
    // See every update immediately in tests.
    DIRECTORY.publishIntervalMs = 0;
    LIVE_CACHE.ttlMs = 0;
  });
  afterAll(() => {
    DIRECTORY.publishIntervalMs = 20_000;
    LIVE_CACHE.ttlMs = 5_000;
  });

  it('lists matchmade games publicly without exposing identities', async () => {
    const { roomId, white, black } = await matchPair(['Alice', 'Bob']);
    const page = await eventually(() => live(), (p) => Boolean(find(p, roomId)));
    const entry = find(page, roomId)!;
    expect(entry).toMatchObject({
      game: 'chess',
      mode: 'match',
      status: 'playing',
      moveNumber: 1,
      turn: 'w',
      openSeats: 0,
    });
    expect([entry.players.w, entry.players.b].sort()).toEqual(['Alice', 'Bob']);
    const raw = JSON.stringify(page);
    expect(raw).not.toMatch(/[0-9a-f]{64}/); // no token hashes
    expect(raw).not.toContain(white);
    expect(raw).not.toContain(black);
  });

  it('keeps friend games private unless the creator chooses to list them', async () => {
    const privateRoom = await createFriendGame();
    const privateHost = await join(privateRoom);
    const listedRoom = await createFriendGame(true);
    const listedHost = await join(listedRoom);

    const page = await eventually(() => live(), (p) => Boolean(find(p, listedRoom)));
    expect(find(page, listedRoom)).toMatchObject({ mode: 'friend', status: 'waiting', openSeats: 1 });
    expect(find(page, privateRoom)).toBeUndefined();
    privateHost.client.close();
    listedHost.client.close();
  });

  it('shows moves and spectator counts as games progress', async () => {
    const { roomId, white, black } = await matchPair();
    const w = await join(roomId, white);
    const b = await join(roomId, black);
    const watcher = await join(roomId);
    await playMove(w.client, b.client, 'e2', 'e4', 0);
    await playMove(b.client, w.client, 'e7', 'e5', 1);
    const page = await eventually(
      () => live(),
      (p) => find(p, roomId)?.moveNumber === 2 && find(p, roomId)?.spectators === 1,
    );
    expect(find(page, roomId)).toMatchObject({ turn: 'w', fen: expect.stringContaining('4p3/4P3') });
    for (const c of [w.client, b.client, watcher.client]) c.close();
  });

  it('removes games when they end', async () => {
    const { roomId, white } = await matchPair();
    const w = await join(roomId, white);
    await eventually(() => live(), (p) => Boolean(find(p, roomId)));
    w.client.send({ type: 'resign', game: 1 });
    await eventually(() => live(), (p) => !find(p, roomId));
    w.client.close();
  });

  it('filters by status and open seats', async () => {
    const waitingRoom = await createFriendGame(true);
    const host = await join(waitingRoom);
    const { roomId: playingRoom } = await matchPair();
    await eventually(() => live(), (p) => Boolean(find(p, waitingRoom) && find(p, playingRoom)));

    const waiting = await live('game=chess&filter=waiting');
    expect(find(waiting, waitingRoom)).toBeDefined();
    expect(find(waiting, playingRoom)).toBeUndefined();
    const playing = await live('game=chess&filter=playing');
    expect(find(playing, playingRoom)).toBeDefined();
    expect(find(playing, waitingRoom)).toBeUndefined();
    const open = await live('game=chess&filter=open');
    expect(find(open, waitingRoom)).toBeDefined();
    expect(find(open, playingRoom)).toBeUndefined();
    host.client.close();
  });

  it('pages through results', async () => {
    const lobby = env.LOBBY.getByName('chess');
    const seen = new Set<string>();
    let cursor: string | null = '0';
    let pages = 0;
    while (cursor !== null) {
      const page: LivePage = await lobby.list({ filter: 'all', offset: Number(cursor), limit: 2 });
      for (const game of page.games) seen.add(game.id);
      cursor = page.nextCursor;
      pages += 1;
    }
    const everything = await lobby.list({ filter: 'all', offset: 0, limit: 50 });
    expect(seen.size).toBe(everything.games.length);
    expect(pages).toBeGreaterThan(1);
  });

  it('merges chess and poker for the All tab', async () => {
    const page = await live('game=all');
    expect(Array.isArray(page.games)).toBe(true);
    expect(page.games.every((game) => game.game === 'chess' || game.game === 'poker')).toBe(true);
  });

  it('hides and then purges entries that stop updating', async () => {
    const waitingRoom = await createFriendGame(true);
    const host = await join(waitingRoom);
    await eventually(() => live(), (p) => Boolean(find(p, waitingRoom)));
    host.client.close();
    // Let the room send its final update for the disconnect, then pretend time passed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lobby = env.LOBBY.getByName('chess');
    await runInDurableObject(lobby, (_instance: GameLobby, state) => {
      state.storage.sql.exec('UPDATE listings SET updated_at = ? WHERE id = ?', Date.now() - 31 * 60_000, waitingRoom);
    });
    expect(find(await live(), waitingRoom)).toBeUndefined();
    await runDurableObjectAlarm(lobby);
    const row = await runInDurableObject(lobby, (_instance: GameLobby, state) =>
      state.storage.sql.exec('SELECT COUNT(*) AS n FROM listings WHERE id = ?', waitingRoom).one(),
    );
    expect(row.n).toBe(0);
  });

  it('validates directory queries', async () => {
    for (const query of ['game=checkers', 'filter=everything', 'game=chess&cursor=abc', 'game=all&cursor=5']) {
      const response = await exports.default.fetch(`${ORIGIN}/api/live?${query}`);
      expect(response.status, query).toBe(400);
    }
    const post = await exports.default.fetch(`${ORIGIN}/api/live`, { method: 'POST' });
    expect(post.status).toBe(405);
  });
});
