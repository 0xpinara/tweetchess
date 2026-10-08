import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { colorName, opposite, type Color, type GameEnd, type MoveInfo, type PieceType, type PromotionPiece } from '../../shared/protocol.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Board } from '../components/Board.tsx';
import { KeyboardPanel } from '../components/KeyboardPanel.tsx';
import { MoveList } from '../components/MoveList.tsx';
import { PlayerBar } from '../components/PlayerBar.tsx';
import { capturedBy, describeEnd, materialBalance, spokenMove, type MoveIntent } from '../lib/chess-ui.ts';

interface LocalSnapshot {
  fen: string;
  moves: MoveInfo[];
  end: GameEnd | null;
  inCheck: boolean;
}

/** Read everything the UI needs from the chess.js engine (which tracks repetition history). */
function snapshotOf(chess: Chess): LocalSnapshot {
  const moves: MoveInfo[] = chess.history({ verbose: true }).map((move) => {
    const info: MoveInfo = { san: move.san, from: move.from, to: move.to, color: move.color };
    if (move.promotion) info.promotion = move.promotion as PromotionPiece;
    if (move.captured) info.captured = move.captured as PieceType;
    return info;
  });
  let end: GameEnd | null = null;
  if (chess.isCheckmate()) end = { winner: opposite(chess.turn()), reason: 'checkmate' };
  else if (chess.isStalemate()) end = { winner: null, reason: 'stalemate' };
  else if (chess.isInsufficientMaterial()) end = { winner: null, reason: 'insufficient_material' };
  else if (chess.isThreefoldRepetition()) end = { winner: null, reason: 'threefold_repetition' };
  else if (chess.isDrawByFiftyMoves()) end = { winner: null, reason: 'fifty_move_rule' };
  return { fen: chess.fen(), moves, end, inCheck: chess.inCheck() };
}

export function LocalGamePage() {
  const engine = useRef<Chess | null>(null);
  if (engine.current === null) engine.current = new Chess();
  const [game, setGame] = useState<LocalSnapshot>(() => snapshotOf(new Chess()));
  const [autoFlip, setAutoFlip] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    document.title = 'Pass-and-play chess · Timeline Games';
  }, []);

  const turn: Color = game.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const baseOrientation: Color = autoFlip ? turn : 'w';
  const orientation: Color = flipped ? opposite(baseOrientation) : baseOrientation;
  const captured = capturedBy(game.moves);
  const balance = materialBalance(game.fen);
  const last = game.moves.at(-1) ?? null;

  const update = (chess: Chess) => {
    const next = snapshotOf(chess);
    setGame(next);
    const move = next.moves.at(-1);
    setAnnouncement(next.end ? describeEnd(next.end).title : move ? spokenMove(move) : 'New game');
  };

  const play = (intent: MoveIntent) => {
    const chess = engine.current!;
    if (game.end) return;
    try {
      chess.move(intent);
    } catch {
      return; // The board only offers legal moves, so this is just a guard.
    }
    update(chess);
  };

  const undo = () => {
    const chess = engine.current!;
    if (chess.undo()) update(chess);
  };

  const restart = () => {
    const chess = engine.current!;
    chess.reset();
    update(chess);
  };

  const top = opposite(orientation);
  const bottom = orientation;
  const endInfo = game.end ? describeEnd(game.end) : null;

  return (
    <div className="page">
      <AppHeader />
      <main className="game-layout">
        <section className={`status-card tone-${endInfo ? 'success' : game.inCheck ? 'danger' : 'info'}`}>
          <div>
            <p className="status-title">
              {endInfo ? endInfo.title : `${colorName(turn)} to move${game.inCheck ? ' — check!' : ''}`}
            </p>
            <p className="status-detail">
              {endInfo ? endInfo.detail : 'Pass-and-play: take turns on this device.'}
            </p>
          </div>
        </section>

        <section className="board-column" aria-label="Chessboard">
          <PlayerBar
            color={top}
            name={colorName(top)}
            isYou={false}
            seat="local"
            isTurn={!game.end && turn === top}
            captured={captured[top]}
            advantage={top === 'w' ? balance : -balance}
          />
          <Board
            id="local"
            fen={game.fen}
            orientation={orientation}
            movable={game.end ? null : 'both'}
            lastMove={last}
            onMove={play}
          />
          <PlayerBar
            color={bottom}
            name={colorName(bottom)}
            isYou={false}
            seat="local"
            isTurn={!game.end && turn === bottom}
            captured={captured[bottom]}
            advantage={bottom === 'w' ? balance : -balance}
          />
        </section>

        <section className="actions" aria-label="Game controls">
          <button type="button" className="btn btn-secondary" onClick={undo} disabled={game.moves.length === 0}>
            Undo
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setFlipped((value) => !value)}>
            Flip board
          </button>
          <button type="button" className={`btn ${game.end ? 'btn-primary' : 'btn-secondary'}`} onClick={restart}>
            New game
          </button>
          <label className="toggle">
            <input type="checkbox" checked={autoFlip} onChange={(event) => setAutoFlip(event.target.checked)} />
            Rotate board each turn
          </label>
        </section>

        <section className="panel moves-panel" aria-labelledby="local-moves-title">
          <h2 id="local-moves-title" className="panel-title">
            Moves
          </h2>
          <MoveList moves={game.moves} />
        </section>

        <section className="extras">
          <KeyboardPanel fen={game.fen} canMove={!game.end} onMove={play} />
        </section>
      </main>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
