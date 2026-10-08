/**
 * Chess helpers for the UI. Rules always come from chess.js; in online games
 * the server re-validates every move, so these only drive what we display.
 */
import { Chess, type Square } from 'chess.js';
import { colorName, type Color, type GameEnd, type MoveInfo, type PieceType, type PromotionPiece } from '../../shared/protocol.ts';

export const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const PIECE_NAMES: Record<PieceType, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export interface MoveIntent {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

export function safeChess(fen: string): Chess {
  try {
    return new Chess(fen);
  } catch {
    return new Chess();
  }
}

/** Legal destination squares for the piece on `from`. */
export function legalTargets(chess: Chess, from: string): { to: string; capture: boolean; promotion: boolean }[] {
  return chess.moves({ square: from as Square, verbose: true }).map((move) => ({
    to: move.to,
    capture: move.isCapture(),
    promotion: move.isPromotion(),
  }));
}

export function needsPromotion(chess: Chess, from: string, to: string): boolean {
  return chess.moves({ square: from as Square, verbose: true }).some((move) => move.to === to && move.isPromotion());
}

export function isLegal(chess: Chess, intent: MoveIntent): boolean {
  return chess
    .moves({ square: intent.from as Square, verbose: true })
    .some((move) => move.to === intent.to && (!move.isPromotion() || move.promotion === intent.promotion));
}

/** FEN after applying a move, or null if it is illegal (used for optimistic UI). */
export function fenAfter(fen: string, intent: MoveIntent): string | null {
  const chess = safeChess(fen);
  try {
    chess.move(intent);
    return chess.fen();
  } catch {
    return null;
  }
}

/** Square of the king that is currently in check, if any. */
export function checkedKingSquare(chess: Chess): string | null {
  if (!chess.inCheck()) return null;
  return chess.findPiece({ type: 'k', color: chess.turn() })[0] ?? null;
}

/** Pieces captured *by* each colour, most valuable first. */
export function capturedBy(moves: MoveInfo[]): Record<Color, PieceType[]> {
  const result: Record<Color, PieceType[]> = { w: [], b: [] };
  for (const move of moves) if (move.captured) result[move.color].push(move.captured);
  const byValue = (a: PieceType, b: PieceType) => PIECE_VALUES[b] - PIECE_VALUES[a];
  result.w.sort(byValue);
  result.b.sort(byValue);
  return result;
}

/** Material on the board: positive means White is ahead. */
export function materialBalance(fen: string): number {
  let score = 0;
  for (const char of fen.split(' ')[0]) {
    const lower = char.toLowerCase() as PieceType;
    if (lower in PIECE_VALUES) score += (char === lower ? -1 : 1) * PIECE_VALUES[lower];
  }
  return score;
}

export function movePairs(moves: MoveInfo[]): { number: number; white?: MoveInfo; black?: MoveInfo }[] {
  const pairs: { number: number; white?: MoveInfo; black?: MoveInfo }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ number: i / 2 + 1, white: moves[i], black: moves[i + 1] });
  }
  return pairs;
}

export function describeEnd(end: GameEnd): { title: string; detail: string } {
  const winner = end.winner ? colorName(end.winner) : null;
  const loser = end.winner ? colorName(end.winner === 'w' ? 'b' : 'w') : null;
  switch (end.reason) {
    case 'checkmate':
      return { title: `Checkmate — ${winner} wins`, detail: `${loser}'s king has no escape.` };
    case 'resignation':
      return { title: `${winner} wins`, detail: `${loser} resigned.` };
    case 'abandonment':
      return { title: `${winner} wins`, detail: `${loser} left the game.` };
    case 'timeout':
      return { title: `${winner} wins on time`, detail: `${loser} took too long to move.` };
    case 'stalemate':
      return { title: 'Draw by stalemate', detail: 'The side to move has no legal moves but is not in check.' };
    case 'insufficient_material':
      return { title: 'Draw', detail: 'Neither side has enough material to checkmate.' };
    case 'threefold_repetition':
      return { title: 'Draw by repetition', detail: 'The same position occurred three times.' };
    case 'fifty_move_rule':
      return { title: 'Draw by the 50-move rule', detail: 'Fifty moves passed with no capture or pawn move.' };
    case 'agreement':
      return { title: 'Draw agreed', detail: 'Both players agreed to a draw.' };
  }
}

/** Plain-language description of a move for screen readers. */
export function spokenMove(move: MoveInfo): string {
  const who = colorName(move.color);
  if (move.san.startsWith('O-O-O')) return `${who} castled queenside`;
  if (move.san.startsWith('O-O')) return `${who} castled kingside`;
  const capture = move.captured ? `, capturing a ${PIECE_NAMES[move.captured]}` : '';
  const promotion = move.promotion ? `, promoting to a ${PIECE_NAMES[move.promotion]}` : '';
  const check = move.san.endsWith('#') ? ', checkmate' : move.san.endsWith('+') ? ', check' : '';
  return `${who} played ${move.from} to ${move.to}${capture}${promotion}${check}`;
}

export function pieceLabel(color: Color, type: PieceType): string {
  return `${colorName(color)} ${PIECE_NAMES[type]}`;
}

/**
 * Parse a typed move: SAN ("Nf3", "exd5", "O-O", "e8=Q") or coordinates
 * ("e2e4", "e2-e4", "e7e8q"). Returns null if it's not legal here.
 */
export function parseTypedMove(fen: string, text: string): MoveIntent | null {
  const input = text.trim();
  if (!input) return null;
  const chess = safeChess(fen);
  const coords = input.toLowerCase().match(/^([a-h][1-8])\s*[-x ]?\s*([a-h][1-8])\s*=?\s*([qrbn])?$/);
  if (coords) {
    const intent: MoveIntent = { from: coords[1], to: coords[2] };
    if (coords[3]) intent.promotion = coords[3] as PromotionPiece;
    else if (needsPromotion(chess, intent.from, intent.to)) intent.promotion = 'q';
    return isLegal(chess, intent) ? intent : null;
  }
  try {
    const move = chess.move(input.replace(/0/g, 'O'), { strict: false });
    const intent: MoveIntent = { from: move.from, to: move.to };
    if (move.promotion) intent.promotion = move.promotion as PromotionPiece;
    return intent;
  } catch {
    return null;
  }
}

/** Text listing of the position, for screen readers and keyboard users. */
export function describePosition(fen: string): { color: Color; pieces: string[] }[] {
  const chess = safeChess(fen);
  const order: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
  return (['w', 'b'] as Color[]).map((color) => {
    const pieces: string[] = [];
    for (const type of order) {
      const squares = chess.findPiece({ color, type }).sort();
      if (squares.length === 0) continue;
      const name = PIECE_NAMES[type];
      pieces.push(`${name[0].toUpperCase()}${name.slice(1)}${squares.length > 1 ? 's' : ''} ${squares.join(', ')}`);
    }
    return { color, pieces };
  });
}

/** "2:05" style countdown text. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
