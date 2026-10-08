import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WORLD_POSTGAME_MS,
  WORLD_SEAT_GRACE_MS,
  WORLD_TURN_LIMIT_MS,
  type ChessRoom,
} from '../../worker/chess-room.ts';
import { join, playMove } from './helpers.ts';

type Timestamps = { awaySince: { w: number | null; b: number | null }; turnStartedAt: number | null; endedAt: number | null };
type RoomInternals = {
  loaded: boolean;
  match: { record: Timestamps } | null;
  alarmAt: number | null;
  save(): void;
};
const internals = (room: ChessRoom) => room as unknown as RoomInternals;
const world = () => env.CHESS_ROOM.getByName('world');

/** Rewrite the room's clocks as if time had passed, then fire its alarm. */
async function travel(change: (record: Timestamps) => void) {
  await runInDurableObject(world(), (instance: ChessRoom) => {
    const room = internals(instance);
    change(room.match!.record);
    room.save();
  });
  expect(await runDurableObjectAlarm(world())).toBe(true);
}

describe('World Board', () => {
  // All tests share the single world room, so wipe it before each one.
  beforeEach(async () => {
    await runInDurableObject(world(), async (instance: ChessRoom, state) => {
      for (const socket of state.getWebSockets()) socket.close(1000, 'reset');
      await state.storage.deleteAll();
      const room = internals(instance);
      room.loaded = false;
      room.match = null;
      room.alarmAt = null;
    });
  });

  it('is created on first visit and sends countdown timers', async () => {
    const white = await join('world');
    expect(white.state.you).toBe('w');
    expect(white.state.state).toMatchObject({ kind: 'world', status: 'waiting', timers: { turnEndsAt: null } });
    const black = await join('world');
    expect(black.state.you).toBe('b');
    const timers = black.state.state.timers!;
    expect(timers.turnEndsAt! - timers.serverTime).toBeGreaterThan(WORLD_TURN_LIMIT_MS - 5_000);
    white.client.close();
    black.client.close();
  });

  it('frees the seat of a player who stays disconnected', async () => {
    const white = await join('world');
    const black = await join('world');
    await playMove(white.client, black.client, 'e2', 'e4', 0);
    black.client.close();
    await white.client.next((m) => m.type === 'presence' && !m.seats.b.online);

    await travel((record) => {
      expect(record.awaySince.b).not.toBeNull();
      record.awaySince.b = Date.now() - WORLD_SEAT_GRACE_MS - 1000;
    });
    const result = await white.client.nextState((s) => s.state.status === 'over');
    expect(result.state.end).toEqual({ winner: 'w', reason: 'abandonment' });
    expect(result.state.seats.b.taken).toBe(false);

    // The next visitor takes the free seat and a fresh game starts on the same URL.
    const next = await join('world');
    expect(next.state.you).toBe('b');
    expect(next.state.state).toMatchObject({ status: 'active', game: 2, ply: 0 });
    white.client.close();
    next.client.close();
  });

  it('a connected but idle player loses on time', async () => {
    const white = await join('world');
    const black = await join('world');
    await playMove(white.client, black.client, 'd2', 'd4', 0);
    await travel((record) => {
      record.turnStartedAt = Date.now() - WORLD_TURN_LIMIT_MS - 1000;
    });
    const result = await white.client.nextState((s) => s.state.status === 'over');
    expect(result.state.end).toEqual({ winner: 'w', reason: 'timeout' });
    expect(result.state.timers?.seatsReopenAt).not.toBeNull();
    white.client.close();
    black.client.close();
  });

  it('opens both seats for the next players shortly after a game ends', async () => {
    const white = await join('world');
    const black = await join('world');
    const viewer = await join('world');
    expect(viewer.state.you).toBe('spectator');
    white.client.send({ type: 'resign', game: 1 });
    await viewer.client.nextState((s) => s.state.status === 'over');

    await travel((record) => {
      record.endedAt = Date.now() - WORLD_POSTGAME_MS - 1000;
    });
    const reset = await viewer.client.nextState((s) => s.state.status === 'waiting');
    expect(reset.state).toMatchObject({ game: 2, ply: 0, seats: { w: { taken: false }, b: { taken: false } } });

    // The spectator can now sit down for the next game.
    viewer.client.send({ type: 'sit' });
    const seated = await viewer.client.nextState((s) => s.you !== 'spectator');
    expect(seated.you).toBe('w');
    for (const c of [white.client, black.client, viewer.client]) c.close();
  });

  it('does not offer rematches, so seats rotate between games', async () => {
    const white = await join('world');
    const black = await join('world');
    black.client.send({ type: 'resign', game: 1 });
    await white.client.nextState((s) => s.state.status === 'over');
    white.client.send({ type: 'rematch', want: true, game: 1 });
    expect((await white.client.nextError()).code).toBe('not_allowed');
    white.client.close();
    black.client.close();
  });

  it('resets the board with no winner when both players are gone', async () => {
    const white = await join('world');
    const black = await join('world');
    const viewer = await join('world');
    await playMove(white.client, black.client, 'e2', 'e4', 0);
    white.client.close();
    black.client.close();
    await viewer.client.next((m) => m.type === 'presence' && !m.seats.w.online && !m.seats.b.online);

    await travel((record) => {
      record.awaySince.w = Date.now() - WORLD_SEAT_GRACE_MS - 1000;
      record.awaySince.b = Date.now() - WORLD_SEAT_GRACE_MS - 500;
    });
    const reset = await viewer.client.nextState((s) => s.state.status === 'waiting');
    expect(reset.state).toMatchObject({ end: null, ply: 0, game: 2, seats: { w: { taken: false }, b: { taken: false } } });
    viewer.client.close();
  });
});
