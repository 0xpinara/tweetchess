import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Chessboard,
  defaultPieces,
  type PieceDropHandlerArgs,
  type PieceHandlerArgs,
  type SquareHandlerArgs,
} from 'react-chessboard';
import { colorName, type Color, type PieceType, type PromotionPiece } from '../../shared/protocol.ts';
import { checkedKingSquare, legalTargets, pieceLabel, safeChess, type MoveIntent } from '../lib/chess-ui.ts';

export interface BoardProps {
  id: string;
  fen: string;
  orientation: Color;
  /** Which side the user may move now: one colour, both (local play) or none. */
  movable: Color | 'both' | null;
  lastMove: { from: string; to: string } | null;
  onMove: (move: MoveIntent) => void;
}

const LAST_MOVE = 'rgba(255, 200, 40, 0.38)';
const SELECTED = 'rgba(29, 155, 240, 0.55)';
const MOVE_DOT = 'radial-gradient(circle, rgba(10, 20, 30, 0.32) 21%, transparent 23%)';
const CAPTURE_RING = 'radial-gradient(circle, transparent 57%, rgba(10, 20, 30, 0.32) 59%, rgba(10, 20, 30, 0.32) 73%, transparent 75%)';
const CHECK_GLOW = 'radial-gradient(circle, rgba(255, 40, 60, 0.95) 0%, rgba(240, 30, 50, 0.6) 38%, rgba(240, 30, 50, 0) 72%)';

const LIGHT_SQUARE: CSSProperties = { backgroundColor: 'var(--board-light)' };
const DARK_SQUARE: CSSProperties = { backgroundColor: 'var(--board-dark)' };
const LIGHT_NOTATION: CSSProperties = { color: 'var(--board-dark)', fontWeight: 600 };
const DARK_NOTATION: CSSProperties = { color: 'var(--board-light)', fontWeight: 600 };
const ALPHA_NOTATION: CSSProperties = { fontSize: 'clamp(8px, 2.4cqi, 13px)', position: 'absolute', bottom: 1, right: 3, userSelect: 'none' };
const NUMERIC_NOTATION: CSSProperties = { fontSize: 'clamp(8px, 2.4cqi, 13px)', position: 'absolute', top: 1, left: 3, userSelect: 'none' };
const DROP_SQUARE: CSSProperties = { boxShadow: 'inset 0 0 0 3px rgba(255, 255, 255, 0.75)' };

export function Board({ id, fen, orientation, movable, lastMove, onMove }: BoardProps) {
  const chess = useMemo(() => safeChess(fen), [fen]);
  const turn = chess.turn();
  const mayMove = movable === 'both' || movable === turn;

  // Selections belong to a position; a new FEN implicitly clears them.
  const [selection, setSelection] = useState<{ fen: string; square: string } | null>(null);
  const [promotion, setPromotion] = useState<{ fen: string; from: string; to: string } | null>(null);
  const selected = mayMove && selection?.fen === fen ? selection.square : null;
  const pendingPromotion = promotion?.fen === fen ? promotion : null;

  const targets = useMemo(() => (selected ? legalTargets(chess, selected) : []), [chess, selected]);

  const tryMove = (from: string, to: string): boolean => {
    const options = legalTargets(chess, from).filter((target) => target.to === to);
    setSelection(null);
    if (options.length === 0) return false;
    if (options.some((option) => option.promotion)) {
      setPromotion({ fen, from, to });
      return false;
    }
    onMove({ from, to });
    return true;
  };

  const ownsPiece = (pieceType: string | undefined) => pieceType?.[0] === turn;

  const onSquareClick = ({ square, piece }: SquareHandlerArgs) => {
    if (pendingPromotion || !mayMove) return;
    if (selected && square !== selected && targets.some((target) => target.to === square)) {
      tryMove(selected, square);
      return;
    }
    if (square === selected) {
      setSelection(null);
      return;
    }
    if (ownsPiece(piece?.pieceType) && legalTargets(chess, square).length > 0) setSelection({ fen, square });
    else setSelection(null);
  };

  const onPieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) => {
    if (!targetSquare || targetSquare === sourceSquare || !mayMove || pendingPromotion) return false;
    return tryMove(sourceSquare, targetSquare);
  };

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    const add = (square: string, style: CSSProperties) => {
      styles[square] = { ...styles[square], ...style };
    };
    if (lastMove) {
      add(lastMove.from, { backgroundColor: LAST_MOVE });
      add(lastMove.to, { backgroundColor: LAST_MOVE });
    }
    const checked = checkedKingSquare(chess);
    if (checked) add(checked, { backgroundImage: CHECK_GLOW });
    if (selected) add(selected, { backgroundColor: SELECTED });
    for (const target of targets) {
      add(target.to, { backgroundImage: target.capture ? CAPTURE_RING : MOVE_DOT, cursor: 'pointer' });
    }
    if (pendingPromotion) {
      add(pendingPromotion.from, { backgroundColor: SELECTED });
      add(pendingPromotion.to, { backgroundColor: SELECTED });
    }
    return styles;
  }, [chess, lastMove, selected, targets, pendingPromotion]);

  const promotionColor: Color = turn;

  // The drag library makes every piece a focusable "button" without a name;
  // label them ("White knight, g1") so screen readers can explore the board.
  // The board re-renders pieces internally (after animations), so watch the DOM.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const labelPieces = () => {
      for (const piece of frame.querySelectorAll<HTMLElement>('[data-piece]')) {
        const code = piece.dataset.piece ?? '';
        const square = piece.closest<HTMLElement>('[data-square]')?.dataset.square;
        const handle = piece.parentElement;
        if (!square || !handle || code.length !== 2) continue;
        const label = `${pieceLabel(code[0] as Color, code[1].toLowerCase() as PieceType)}, ${square}`;
        if (handle.getAttribute('aria-label') !== label) handle.setAttribute('aria-label', label);
      }
    };
    labelPieces();
    const observer = new MutationObserver(labelPieces);
    observer.observe(frame, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="board-frame" ref={frameRef}>
      <Chessboard
        options={{
          id,
          position: fen,
          boardOrientation: orientation === 'w' ? 'white' : 'black',
          allowDragging: mayMove && !pendingPromotion,
          canDragPiece: ({ piece }: PieceHandlerArgs) => mayMove && !pendingPromotion && ownsPiece(piece.pieceType),
          onPieceDrag: ({ square }: PieceHandlerArgs) => {
            if (square) setSelection({ fen, square });
          },
          onPieceDrop,
          onSquareClick,
          squareStyles,
          dragActivationDistance: 5,
          animationDurationInMs: 180,
          lightSquareStyle: LIGHT_SQUARE,
          darkSquareStyle: DARK_SQUARE,
          lightSquareNotationStyle: LIGHT_NOTATION,
          darkSquareNotationStyle: DARK_NOTATION,
          alphaNotationStyle: ALPHA_NOTATION,
          numericNotationStyle: NUMERIC_NOTATION,
          dropSquareStyle: DROP_SQUARE,
          boardStyle: { borderRadius: 'var(--board-radius)', overflow: 'hidden' },
          clearArrowsOnPositionChange: true,
        }}
      />
      {pendingPromotion && (
        <PromotionPicker
          color={promotionColor}
          onPick={(piece) => {
            setPromotion(null);
            onMove({ from: pendingPromotion.from, to: pendingPromotion.to, promotion: piece });
          }}
          onCancel={() => setPromotion(null)}
        />
      )}
    </div>
  );
}

const PROMOTION_CHOICES: { piece: PromotionPiece; name: string }[] = [
  { piece: 'q', name: 'Queen' },
  { piece: 'r', name: 'Rook' },
  { piece: 'b', name: 'Bishop' },
  { piece: 'n', name: 'Knight' },
];

function PromotionPicker({
  color,
  onPick,
  onCancel,
}: {
  color: Color;
  onPick: (piece: PromotionPiece) => void;
  onCancel: () => void;
}) {
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => firstButton.current?.focus(), []);

  return (
    <div
      className="promotion-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="promotion-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="promotion-card">
        <p id="promotion-title" className="promotion-title">
          Promote pawn to…
        </p>
        <div className="promotion-options">
          {PROMOTION_CHOICES.map(({ piece, name }, index) => (
            <button
              key={piece}
              ref={index === 0 ? firstButton : undefined}
              type="button"
              className="promotion-option"
              onClick={() => onPick(piece)}
              aria-label={`${colorName(color)} ${name}`}
              title={name}
            >
              <PieceIcon color={color} type={piece} />
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PieceIcon({ color, type, className }: { color: Color; type: string; className?: string }) {
  const render = defaultPieces[`${color}${type.toUpperCase()}`];
  return (
    <span className={className ?? 'piece-icon'} aria-hidden="true">
      {render ? render() : null}
    </span>
  );
}
