import type { LiveChessGame, LiveGame, LivePokerTable } from '../../shared/lobby.ts';
import { colorName, WORLD_ROOM_ID } from '../../shared/protocol.ts';
import { Link } from './Link.tsx';
import { MiniBoard } from './MiniBoard.tsx';
import { PlayingCard } from './PlayingCard.tsx';

export function LiveGameCard({ game }: { game: LiveGame }) {
  return game.game === 'chess' ? <ChessCard game={game} /> : <PokerCard table={game} />;
}

const MODE_LABEL: Record<LiveChessGame['mode'], string> = {
  match: 'Matchmade',
  world: 'World Board',
  friend: 'Friend game',
};

function ChessCard({ game }: { game: LiveChessGame }) {
  const white = game.players.w ?? 'Open seat';
  const black = game.players.b ?? 'Open seat';
  const path = game.id === WORLD_ROOM_ID ? '/world' : `/game/${game.id}`;
  return (
    <article className="live-card" aria-label={`Chess: ${white} versus ${black}`}>
      <div className="live-card-media">
        <MiniBoard fen={game.fen} />
      </div>
      <div className="live-card-body">
        <div className="live-tags">
          <span className="game-tag game-tag-chess">Chess</span>
          <span className="mode-tag">{MODE_LABEL[game.mode]}</span>
        </div>
        <h3 className="live-title">
          {white} <span className="versus">vs</span> {black}
        </h3>
        <p className="live-detail">
          {game.status === 'playing'
            ? `Move ${game.moveNumber} · ${colorName(game.turn)} to move`
            : 'Waiting for players'}
        </p>
        <p className="live-meta">
          <EyeIcon /> {game.spectators} watching
        </p>
        <div className="live-actions">
          <Link to={`${path}?watch=1`} className="btn btn-secondary btn-small">
            Watch live
          </Link>
          {game.openSeats > 0 && (
            <Link to={path} className="btn btn-primary btn-small">
              Join
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

const PHASE_LABEL: Record<string, string> = {
  waiting: 'Waiting for players',
  preflop: 'Pre-flop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
};

function PokerCard({ table }: { table: LivePokerTable }) {
  const path = `/poker/table/${table.id}`;
  const slots = [...table.board, ...Array(Math.max(0, 5 - table.board.length)).fill(null)].slice(0, 5);
  return (
    <article className="live-card" aria-label={`Poker table with ${table.seated} of ${table.maxSeats} players`}>
      <div className="live-card-media">
        <div className="mini-felt">
          <div className="mini-board-cards">
            {slots.map((card, index) =>
              card ? <PlayingCard key={index} card={card} size="small" /> : <span key={index} className="card-slot small" />,
            )}
          </div>
          <span className="mini-pot">{table.pot > 0 ? `Pot ${table.pot}` : `Blinds ${table.blinds[0]}/${table.blinds[1]}`}</span>
        </div>
      </div>
      <div className="live-card-body">
        <div className="live-tags">
          <span className="game-tag game-tag-poker">Poker</span>
          <span className="mode-tag">Texas Hold&apos;em</span>
        </div>
        <h3 className="live-title">
          {table.seated}/{table.maxSeats} players
        </h3>
        <p className="live-detail">
          {table.status === 'playing'
            ? `${PHASE_LABEL[table.phase] ?? table.phase} · Pot ${table.pot} chips`
            : 'Waiting for players'}
        </p>
        <p className="live-meta">
          <EyeIcon /> {table.spectators} watching
        </p>
        <div className="live-actions">
          <Link to={`${path}?watch=1`} className="btn btn-secondary btn-small">
            Watch
          </Link>
          {table.openSeats > 0 && (
            <Link to={`${path}?sit=1`} className="btn btn-primary btn-small">
              Join table
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
