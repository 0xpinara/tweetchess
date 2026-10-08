import { describe, expect, it } from 'vitest';
import { Match, START_FEN, positionKey, type MoveProposal } from '../../worker/match.ts';

const WHITE = 'hash-white';
const BLACK = 'hash-black';
const VIEWER = 'hash-viewer';
const NOW = 1_700_000_000_000;

/** A room with both players seated and the game active. */
function startedMatch(): Match {
  const match = Match.create('AbCdEfGh12', 'private', NOW);
  match.claimSeat(WHITE, NOW);
  match.claimSeat(BLACK, NOW);
  return match;
}

function proposal(match: Match, from: string, to: string, promotion?: MoveProposal['promotion']): MoveProposal {
  return { from, to, promotion, expectedPly: match.ply };
}

/** Play a sequence of [from, to] moves, alternating white/black, asserting each succeeds. */
function play(match: Match, moves: Array<[string, string, MoveProposal['promotion']?]>): void {
  for (const [from, to, promotion] of moves) {
    const hash = match.turn() === 'w' ? match.record.white! : match.record.black!;
    const result = match.move(hash, proposal(match, from, to, promotion), NOW);
    expect(result, `${from}-${to}`).toMatchObject({ ok: true });
  }
}

describe('seats', () => {
  it('gives the first visitor White, the second Black and everyone else a spectator role', () => {
    const match = Match.create('AbCdEfGh12', 'private', NOW);
    expect(match.claimSeat(WHITE, NOW)).toEqual({ role: 'w', changed: true });
    expect(match.record.status).toBe('waiting');
    expect(match.claimSeat(BLACK, NOW)).toEqual({ role: 'b', changed: true });
    expect(match.record.status).toBe('active');
    expect(match.claimSeat(VIEWER, NOW)).toEqual({ role: 'spectator', changed: false });
  });

  it('returns the same seat to a returning player (refresh / reconnect)', () => {
    const match = startedMatch();
    expect(match.claimSeat(WHITE, NOW)).toEqual({ role: 'w', changed: false });
    expect(match.claimSeat(BLACK, NOW)).toEqual({ role: 'b', changed: false });
  });

  it('never assigns one seat to two people', () => {
    const match = Match.create('AbCdEfGh12', 'private', NOW);
    const roles = ['a', 'b', 'c', 'd', 'e'].map((hash) => match.claimSeat(hash, NOW).role);
    expect(roles).toEqual(['w', 'b', 'spectator', 'spectator', 'spectator']);
  });

  it('honours a preferred colour when that seat is free', () => {
    const match = Match.create('AbCdEfGh12', 'private', NOW);
    expect(match.claimSeat(BLACK, NOW, 'b').role).toBe('b');
    expect(match.claimSeat(WHITE, NOW, 'b').role).toBe('w');
  });
});

describe('move validation', () => {
  it('plays a legal move and records SAN, ply and the new FEN', () => {
    const match = startedMatch();
    const result = match.move(WHITE, proposal(match, 'e2', 'e4'), NOW);
    expect(result.ok).toBe(true);
    expect(match.ply).toBe(1);
    expect(match.moves[0]).toMatchObject({ san: 'e4', from: 'e2', to: 'e4', color: 'w', ply: 1 });
    expect(match.record.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  it('rejects moves from spectators', () => {
    const match = startedMatch();
    expect(match.move(VIEWER, proposal(match, 'e2', 'e4'), NOW)).toMatchObject({ ok: false, code: 'not_a_player' });
    expect(match.ply).toBe(0);
  });

  it('does not let White move Black pieces', () => {
    const match = startedMatch();
    expect(match.move(WHITE, proposal(match, 'e7', 'e5'), NOW)).toMatchObject({ ok: false, code: 'illegal_move' });
    play(match, [['e2', 'e4']]);
    // Now it is Black's turn; White trying to move a black piece is "not your turn".
    expect(match.move(WHITE, proposal(match, 'e7', 'e5'), NOW)).toMatchObject({ ok: false, code: 'not_your_turn' });
  });

  it('does not let a player move twice in a row', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4']]);
    expect(match.move(WHITE, proposal(match, 'd2', 'd4'), NOW)).toMatchObject({ ok: false, code: 'not_your_turn' });
    expect(match.ply).toBe(1);
  });

  it('rejects illegal moves without changing state', () => {
    const match = startedMatch();
    const before = JSON.stringify(match.record);
    expect(match.move(WHITE, proposal(match, 'e2', 'e5'), NOW)).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(match.move(WHITE, proposal(match, 'g1', 'g3'), NOW)).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(match.move(WHITE, proposal(match, 'a3', 'a4'), NOW)).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(JSON.stringify(match.record)).toBe(before);
    expect(match.ply).toBe(0);
  });

  it('rejects an outdated move (wrong expectedPly) so it cannot overwrite newer state', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4'], ['e7', 'e5']]);
    const stale = match.move(WHITE, { from: 'd2', to: 'd4', expectedPly: 1 }, NOW);
    expect(stale).toMatchObject({ ok: false, code: 'stale' });
    const future = match.move(WHITE, { from: 'd2', to: 'd4', expectedPly: 5 }, NOW);
    expect(future).toMatchObject({ ok: false, code: 'stale' });
    expect(match.ply).toBe(2);
  });

  it('does not allow moves before the opponent has joined', () => {
    const match = Match.create('AbCdEfGh12', 'private', NOW);
    match.claimSeat(WHITE, NOW);
    expect(match.move(WHITE, proposal(match, 'e2', 'e4'), NOW)).toMatchObject({ ok: false, code: 'game_not_active' });
  });
});

describe('special moves', () => {
  it('supports kingside and queenside castling', () => {
    const match = startedMatch();
    play(match, [
      ['e2', 'e4'], ['e7', 'e5'],
      ['g1', 'f3'], ['b8', 'c6'],
      ['f1', 'c4'], ['d7', 'd6'],
      ['e1', 'g1'], // O-O
      ['c8', 'g4'],
      ['d2', 'd3'], ['d8', 'd7'],
      ['b1', 'c3'], ['e8', 'c8'], // O-O-O
    ]);
    expect(match.moves[6].san).toBe('O-O');
    expect(match.moves[11].san).toBe('O-O-O');
    expect(match.record.fen.split(' ')[0]).toBe('2kr1bnr/pppq1ppp/2np4/4p3/2B1P1b1/2NP1N2/PPP2PPP/R1BQ1RK1');
  });

  it('supports en passant captures', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5'], ['e5', 'd6']]);
    expect(match.moves[4]).toMatchObject({ san: 'exd6', captured: 'p' });
    expect(match.record.fen.split(' ')[0]).toBe('rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR');
  });

  it('requires a promotion piece and supports under-promotion', () => {
    const match = startedMatch();
    play(match, [
      ['h2', 'h4'], ['g7', 'g5'],
      ['h4', 'g5'], ['h7', 'h6'],
      ['g5', 'h6'], ['f8', 'g7'],
      ['h6', 'g7'], ['a7', 'a6'],
    ]);
    // Pawn on g7 can capture on h8 – without a piece the move is rejected.
    expect(match.move(WHITE, proposal(match, 'g7', 'h8'), NOW)).toMatchObject({ ok: false, code: 'illegal_move' });
    play(match, [['g7', 'h8', 'n']]);
    expect(match.moves.at(-1)).toMatchObject({ san: 'gxh8=N', promotion: 'n', captured: 'r' });
  });
});

describe('game endings', () => {
  it("ends the game on checkmate (fool's mate) and blocks further moves", () => {
    const match = startedMatch();
    play(match, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
    expect(match.record.status).toBe('over');
    expect(match.record.end).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(match.move(WHITE, proposal(match, 'a2', 'a3'), NOW)).toMatchObject({ ok: false, code: 'game_not_active' });
  });

  it('detects stalemate', () => {
    // Shortest known stalemate (Sam Loyd, 10 moves).
    const match = startedMatch();
    play(match, [
      ['e2', 'e3'], ['a7', 'a5'],
      ['d1', 'h5'], ['a8', 'a6'],
      ['h5', 'a5'], ['h7', 'h5'],
      ['h2', 'h4'], ['a6', 'h6'],
      ['a5', 'c7'], ['f7', 'f6'],
      ['c7', 'd7'], ['e8', 'f7'],
      ['d7', 'b7'], ['d8', 'd3'],
      ['b7', 'b8'], ['d3', 'h7'],
      ['b8', 'c8'], ['f7', 'g6'],
      ['c8', 'e6'],
    ]);
    expect(match.record.status).toBe('over');
    expect(match.record.end).toEqual({ winner: null, reason: 'stalemate' });
  });

  it('detects threefold repetition', () => {
    const match = startedMatch();
    const shuffle: Array<[string, string]> = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
    play(match, shuffle);
    expect(match.record.status).toBe('active');
    play(match, shuffle);
    expect(match.record.end).toEqual({ winner: null, reason: 'threefold_repetition' });
  });

  it('detects insufficient material', () => {
    const match = startedMatch();
    // Load a position where White's last pawn can be captured, leaving K vs K+N.
    match.record.fen = '8/8/8/4k3/3P4/8/8/4K1n1 b - - 0 40';
    play(match, [['e5', 'd4']]);
    expect(match.record.end).toEqual({ winner: null, reason: 'insufficient_material' });
  });

  it('detects the fifty-move rule', () => {
    const match = startedMatch();
    match.record.fen = '8/8/8/4k3/8/8/R7/4K3 w - - 99 80';
    play(match, [['a2', 'a3']]);
    expect(match.record.end).toEqual({ winner: null, reason: 'fifty_move_rule' });
  });

  it('counts repetitions per game from stored position keys', () => {
    const match = startedMatch();
    expect(match.repetitions(positionKey(START_FEN))).toBe(1);
  });
});

describe('resign, draw offers and rematch', () => {
  it('lets a player resign, awarding the win to the opponent', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4']]);
    expect(match.resign(VIEWER, match.record.game, NOW)).toMatchObject({ ok: false, code: 'not_a_player' });
    expect(match.resign(BLACK, match.record.game, NOW).ok).toBe(true);
    expect(match.record.end).toEqual({ winner: 'w', reason: 'resignation' });
  });

  it('ignores a resignation aimed at an older game', () => {
    const match = startedMatch();
    expect(match.resign(WHITE, match.record.game + 1, NOW)).toMatchObject({ ok: false, code: 'stale' });
  });

  it('handles draw offer, decline and accept', () => {
    const match = startedMatch();
    const game = match.record.game;
    expect(match.draw(WHITE, 'offer', game, NOW).ok).toBe(true);
    expect(match.record.drawOffer).toBe('w');
    expect(match.draw(WHITE, 'accept', game, NOW)).toMatchObject({ ok: false, code: 'nothing_to_do' });
    expect(match.draw(BLACK, 'decline', game, NOW).ok).toBe(true);
    expect(match.record.drawOffer).toBeNull();
    match.draw(BLACK, 'offer', game, NOW);
    expect(match.draw(WHITE, 'accept', game, NOW).ok).toBe(true);
    expect(match.record.end).toEqual({ winner: null, reason: 'agreement' });
  });

  it('clears a draw offer when the opponent moves instead of accepting', () => {
    const match = startedMatch();
    match.draw(BLACK, 'offer', match.record.game, NOW);
    play(match, [['e2', 'e4']]);
    expect(match.record.drawOffer).toBeNull();
  });

  it('requires both players to agree to a rematch and swaps colours', () => {
    const match = startedMatch();
    expect(match.rematch(WHITE, true, 1, NOW)).toMatchObject({ ok: false, code: 'game_not_over' });
    play(match, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
    const first = match.rematch(WHITE, true, 1, NOW);
    expect(first).toMatchObject({ ok: true, changes: { newGame: false } });
    expect(match.record.rematch).toEqual({ w: true, b: false });
    const second = match.rematch(BLACK, true, 1, NOW);
    expect(second).toMatchObject({ ok: true, changes: { newGame: true } });
    expect(match.record).toMatchObject({ game: 2, status: 'active', white: BLACK, black: WHITE, fen: START_FEN, end: null });
    expect(match.ply).toBe(0);
    // A late rematch click for game 1 must not affect game 2.
    expect(match.rematch(WHITE, true, 1, NOW)).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('leaving a seat', () => {
  it('frees the seat without a result when no move was played', () => {
    const match = startedMatch();
    expect(match.leave(BLACK, NOW).ok).toBe(true);
    expect(match.record).toMatchObject({ black: null, status: 'waiting', end: null });
    expect(match.claimSeat(VIEWER, NOW)).toEqual({ role: 'b', changed: true });
    expect(match.record.status).toBe('active');
  });

  it('forfeits a game in progress and lets a new opponent start a fresh game', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4'], ['e7', 'e5']]);
    match.leave(BLACK, NOW);
    expect(match.record).toMatchObject({ status: 'over', end: { winner: 'w', reason: 'resignation' }, black: null });
    // Rematch is impossible with an empty seat.
    expect(match.rematch(WHITE, true, match.record.game, NOW)).toMatchObject({ ok: false });
    expect(match.claimSeat(VIEWER, NOW).role).toBe('b');
    expect(match.record).toMatchObject({ game: 2, status: 'active', white: WHITE, black: VIEWER, fen: START_FEN });
    expect(match.ply).toBe(0);
  });

  it('marks an absent world-room player as having abandoned the game', () => {
    const match = Match.create('world', 'world', NOW);
    match.claimSeat(WHITE, NOW);
    match.claimSeat(BLACK, NOW);
    play(match, [['d2', 'd4']]);
    expect(match.forfeitAbsent('b', NOW).ok).toBe(true);
    expect(match.record).toMatchObject({ status: 'over', end: { winner: 'w', reason: 'abandonment' }, black: null });
  });
});

describe('snapshot', () => {
  it('never exposes seat hashes to clients', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4']]);
    const json = JSON.stringify(match.snapshot({ online: { w: true, b: false }, spectators: 3 }));
    expect(json).not.toContain(WHITE);
    expect(json).not.toContain(BLACK);
    expect(JSON.parse(json)).toMatchObject({
      ply: 1,
      seats: { w: { taken: true, online: true }, b: { taken: true, online: false } },
      spectators: 3,
      moves: [{ san: 'e4', from: 'e2', to: 'e4', color: 'w' }],
    });
  });
});

describe('World Board timers', () => {
  it('records when each turn starts and when the game ends', () => {
    const match = startedMatch();
    expect(match.record.turnStartedAt).toBe(NOW);
    match.move(WHITE, proposal(match, 'f2', 'f3'), NOW + 5);
    expect(match.record.turnStartedAt).toBe(NOW + 5);
    match.move(BLACK, proposal(match, 'e7', 'e5'), NOW + 9);
    match.move(WHITE, proposal(match, 'g2', 'g4'), NOW + 12);
    match.move(BLACK, proposal(match, 'd8', 'h4'), NOW + 20);
    expect(match.record).toMatchObject({ status: 'over', turnStartedAt: null, endedAt: NOW + 20 });
  });

  it('frees an idle seat without a result before the first move', () => {
    const match = startedMatch();
    expect(match.timeoutTurn(NOW + 1).ok).toBe(true);
    expect(match.record).toMatchObject({ white: null, black: BLACK, status: 'waiting', end: null, turnStartedAt: null });
  });

  it('makes the player to move lose on time after the game has started', () => {
    const match = startedMatch();
    play(match, [['e2', 'e4']]);
    expect(match.timeoutTurn(NOW + 1).ok).toBe(true);
    expect(match.record).toMatchObject({ status: 'over', end: { winner: 'w', reason: 'timeout' } });
    expect(match.timeoutTurn(NOW + 2)).toMatchObject({ ok: false, code: 'game_not_active' });
  });

  it('resets the board with empty seats so new players can start fresh', () => {
    const match = Match.create('world', 'world', NOW);
    match.claimSeat(WHITE, NOW);
    match.claimSeat(BLACK, NOW);
    match.resign(BLACK, 1, NOW);
    expect(match.resetBoard(NOW + 30_000)).toMatchObject({ ok: true, changes: { newGame: true } });
    expect(match.record).toMatchObject({ white: null, black: null, status: 'waiting', game: 2, fen: START_FEN, end: null });
    expect(match.claimSeat(VIEWER, NOW).role).toBe('w');
  });

  it('resets a finished board once its last player leaves, so nobody inherits the old result', () => {
    const match = startedMatch();
    play(match, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
    match.leave(WHITE, NOW);
    expect(match.record).toMatchObject({ status: 'over', black: BLACK, game: 1 });
    match.leave(BLACK, NOW);
    expect(match.record).toMatchObject({ status: 'waiting', white: null, black: null, game: 2, end: null });
    expect(match.ply).toBe(0);
  });
});

describe('World Board rotation', () => {
  it('does not offer rematches, so the seats open up for new players', () => {
    const match = Match.create('world', 'world', NOW);
    match.claimSeat(WHITE, NOW);
    match.claimSeat(BLACK, NOW);
    match.resign(WHITE, 1, NOW);
    expect(match.rematch(BLACK, true, 1, NOW)).toMatchObject({ ok: false, code: 'not_allowed' });
  });
});
