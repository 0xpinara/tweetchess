import { describe, expect, it } from 'vitest';
import {
  capturedBy,
  describeEnd,
  describePosition,
  fenAfter,
  materialBalance,
  movePairs,
  parseTypedMove,
  spokenMove,
} from '../../src/lib/chess-ui.ts';
import { createToken } from '../../src/lib/identity.ts';
import { xIntentUrl } from '../../src/lib/share.ts';
import { backoffDelay } from '../../src/lib/useRoom.ts';
import type { MoveInfo } from '../../shared/protocol.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('typed move entry (keyboard / screen readers)', () => {
  it('understands SAN and coordinate notation', () => {
    expect(parseTypedMove(START_FEN, 'e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseTypedMove(START_FEN, 'Nf3')).toEqual({ from: 'g1', to: 'f3' });
    expect(parseTypedMove(START_FEN, 'g1f3')).toEqual({ from: 'g1', to: 'f3' });
    expect(parseTypedMove(START_FEN, ' e2-e4 ')).toEqual({ from: 'e2', to: 'e4' });
  });

  it('handles castling written with zeros or letters', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(parseTypedMove(fen, 'O-O')).toEqual({ from: 'e1', to: 'g1' });
    expect(parseTypedMove(fen, '0-0-0')).toEqual({ from: 'e1', to: 'c1' });
  });

  it('handles promotion, defaulting coordinate input to a queen', () => {
    const fen = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
    expect(parseTypedMove(fen, 'e8=N')).toEqual({ from: 'e7', to: 'e8', promotion: 'n' });
    expect(parseTypedMove(fen, 'e7e8r')).toEqual({ from: 'e7', to: 'e8', promotion: 'r' });
    expect(parseTypedMove(fen, 'e7e8')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
  });

  it('rejects illegal or nonsense input', () => {
    expect(parseTypedMove(START_FEN, 'e5')).toBeNull();
    expect(parseTypedMove(START_FEN, 'e2e5')).toBeNull();
    expect(parseTypedMove(START_FEN, 'hello')).toBeNull();
    expect(parseTypedMove(START_FEN, '')).toBeNull();
  });
});

describe('board helpers', () => {
  const moves: MoveInfo[] = [
    { san: 'e4', from: 'e2', to: 'e4', color: 'w' },
    { san: 'd5', from: 'd7', to: 'd5', color: 'b' },
    { san: 'exd5', from: 'e4', to: 'd5', color: 'w', captured: 'p' },
    { san: 'Qxd5', from: 'd8', to: 'd5', color: 'b', captured: 'p' },
    { san: 'Nc3', from: 'b1', to: 'c3', color: 'w' },
  ];

  it('lists captured pieces per side', () => {
    expect(capturedBy(moves)).toEqual({ w: ['p'], b: ['p'] });
  });

  it('computes material balance from the FEN', () => {
    expect(materialBalance(START_FEN)).toBe(0);
    expect(materialBalance('4k3/8/8/8/8/8/8/3QK3 w - - 0 1')).toBe(9);
    expect(materialBalance('4k3/8/8/8/8/8/8/1r2K3 w - - 0 1')).toBe(-5);
  });

  it('groups moves into numbered pairs', () => {
    const pairs = movePairs(moves);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ number: 1, white: { san: 'e4' }, black: { san: 'd5' } });
    expect(pairs[2]).toMatchObject({ number: 3, white: { san: 'Nc3' } });
    expect(pairs[2].black).toBeUndefined();
  });

  it('computes optimistic positions and rejects illegal ones', () => {
    expect(fenAfter(START_FEN, { from: 'e2', to: 'e4' })).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(fenAfter(START_FEN, { from: 'e2', to: 'e5' })).toBeNull();
  });

  it('describes moves, positions and results in plain language', () => {
    expect(spokenMove(moves[2])).toBe('White played e4 to d5, capturing a pawn');
    expect(spokenMove({ san: 'O-O', from: 'e1', to: 'g1', color: 'w' })).toBe('White castled kingside');
    expect(describePosition('4k3/8/8/8/8/8/8/4K2R w K - 0 1')).toEqual([
      { color: 'w', pieces: ['King e1', 'Rook h1'] },
      { color: 'b', pieces: ['King e8'] },
    ]);
    expect(describeEnd({ winner: 'w', reason: 'checkmate' }).title).toBe('Checkmate — White wins');
    expect(describeEnd({ winner: null, reason: 'stalemate' }).title).toBe('Draw by stalemate');
    expect(describeEnd({ winner: 'b', reason: 'resignation' }).detail).toBe('White resigned.');
  });
});

describe('networking helpers', () => {
  it('backs off exponentially with jitter, capped at 30 seconds', () => {
    expect(backoffDelay(1, 0)).toBe(250);
    expect(backoffDelay(1, 1)).toBe(500);
    expect(backoffDelay(4, 1)).toBe(4000);
    expect(backoffDelay(20, 1)).toBe(30000);
    expect(backoffDelay(20, 0)).toBe(15000);
  });

  it('creates 256-bit base64url guest tokens', () => {
    const a = createToken();
    const b = createToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('builds a free X Web Intent link', () => {
    const url = new URL(xIntentUrl('Play me ♟️', 'https://tweetchess.example.workers.dev/game/AbCdEfGh12'));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe('Play me ♟️');
    expect(url.searchParams.get('url')).toBe('https://tweetchess.example.workers.dev/game/AbCdEfGh12');
  });
});
