import { useEffect, useState } from 'react';
import {
  WORLD_ROOM_ID,
  colorName,
  opposite,
  type Color,
  type Role,
  type RoomSnapshot,
} from '../../shared/protocol.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Board } from '../components/Board.tsx';
import { ConnectionBadge } from '../components/ConnectionBadge.tsx';
import { KeyboardPanel } from '../components/KeyboardPanel.tsx';
import { MoveList } from '../components/MoveList.tsx';
import { PlayerBar, type SeatStatus } from '../components/PlayerBar.tsx';
import { ShareButton } from '../components/ShareButton.tsx';
import { createRoom } from '../lib/api.ts';
import {
  capturedBy,
  describeEnd,
  fenAfter,
  formatClock,
  materialBalance,
  safeChess,
  spokenMove,
  type MoveIntent,
} from '../lib/chess-ui.ts';
import { isIdentityPersistent } from '../lib/identity.ts';
import { forgetLeftRoom, rememberLeftRoom } from '../lib/seat-memory.ts';
import { navigate } from '../lib/router.ts';
import { useRoom, type ConnectionStatus } from '../lib/useRoom.ts';
import { NotFoundPage } from './NotFoundPage.tsx';

interface PendingMove {
  intent: MoveIntent;
  ply: number;
  game: number;
  syncId: number;
  noticeId: number;
}

type Tone = 'info' | 'success' | 'warning' | 'danger';

export function OnlineGamePage({ roomId }: { roomId: string }) {
  const { status, state, role, notice, fatal, retryAt, syncId, receivedAt, send, retryNow } = useRoom(roomId);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [localToast, setLocalToast] = useState<{ id: number; text: string } | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState(0);
  const isWorld = roomId === WORLD_ROOM_ID;

  // An optimistic move is shown only while nothing contradicts it: same position,
  // same connection, and no server error (illegal/stale move) since it was sent.
  const activePending =
    pending &&
    state &&
    status === 'open' &&
    pending.ply === state.ply &&
    pending.game === state.game &&
    pending.syncId === syncId &&
    pending.noticeId === (notice?.id ?? 0)
      ? pending
      : null;

  // If the server never answers a move, verify the connection (it may be silently dead).
  useEffect(() => {
    if (!activePending) return;
    const timer = setTimeout(() => {
      setPending(null);
      retryNow();
    }, 8000);
    return () => clearTimeout(timer);
  }, [activePending, retryNow]);

  // Toasts: server notices and local problems, each hidden after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setDismissedNotice(notice.id), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!localToast) return;
    const timer = setTimeout(() => setLocalToast(null), 3500);
    return () => clearTimeout(timer);
  }, [localToast]);
  const showToast = (text: string) => setLocalToast({ id: Date.now(), text });
  const toast = localToast?.text ?? (notice && notice.id !== dismissedNotice ? notice.message : null);

  const me: Color | null = role === 'w' || role === 'b' ? role : null;
  const turn: Color = state?.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const yourTurn = Boolean(state && me && state.status === 'active' && turn === me);

  useEffect(() => {
    document.title = yourTurn ? '● Your move · TweetChess' : isWorld ? 'World Board · TweetChess' : 'Live game · TweetChess';
  }, [yourTurn, isWorld]);

  // Screen readers announce changes to this live-region text.
  const lastMoveInfo = state?.moves.at(-1);
  const announcement = !state
    ? ''
    : state.status === 'over' && state.end
      ? describeEnd(state.end).title
      : lastMoveInfo
        ? spokenMove(lastMoveInfo)
        : state.status === 'active'
          ? 'The game has started.'
          : '';

  // World Board countdowns, ticking once a second only while a timer runs. They
  // count down from when the state arrived using server times, so a wrong
  // device clock doesn't matter.
  const timers = state?.timers ?? null;
  const now = useNow(Boolean(timers?.turnEndsAt || timers?.seatsReopenAt));
  const secondsLeft = (deadline: number | null | undefined) =>
    deadline == null || !timers
      ? null
      : Math.max(0, (deadline - timers.serverTime - Math.max(0, now - receivedAt)) / 1000);
  const clocks: Clocks = { turn: secondsLeft(timers?.turnEndsAt), reopen: secondsLeft(timers?.seatsReopenAt) };

  if (fatal) {
    return (
      <NotFoundPage
        title={fatal.code === 'room_not_found' ? 'Game not found' : 'Please reload'}
        message={fatal.message}
      >
        {fatal.code === 'room_not_found' ? (
          <NewGameButton label="Create a new game" />
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
      </NotFoundPage>
    );
  }

  const header = (
    <AppHeader>
      <ConnectionBadge status={status} retryAt={retryAt} onRetry={retryNow} />
      <ShareButton roomId={roomId} />
    </AppHeader>
  );

  if (!state || !role) {
    return (
      <div className="page">
        {header}
        <main className="game-layout">
          <section className="status-card tone-info">
            <div>
              <p className="status-title">{status === 'connecting' ? 'Connecting to the game…' : 'Reconnecting…'}</p>
              <p className="status-detail">Loading the board and your seat.</p>
            </div>
          </section>
          <section className="board-column" aria-busy="true">
            <div className="board-skeleton" />
          </section>
        </main>
      </div>
    );
  }

  const displayFen = activePending ? (fenAfter(state.fen, activePending.intent) ?? state.fen) : state.fen;
  const lastMove = activePending ? activePending.intent : (state.moves.at(-1) ?? null);
  const inCheck = safeChess(state.fen).inCheck();
  const baseOrientation: Color = me ?? 'w';
  const orientation: Color = flipped ? opposite(baseOrientation) : baseOrientation;
  const movable = status === 'open' && state.status === 'active' && me && !activePending ? me : null;
  const captured = capturedBy(state.moves);
  const balance = materialBalance(state.fen);

  const sendAction = (message: Parameters<typeof send>[0]) => {
    if (!send(message)) {
      showToast('Not connected — reconnecting…');
      return;
    }
    if (message.type === 'leave') rememberLeftRoom(roomId);
    if (message.type === 'sit') forgetLeftRoom(roomId);
  };

  const playMove = (intent: MoveIntent) => {
    if (!movable) return;
    const message = { type: 'move' as const, ...intent, expectedPly: state.ply };
    if (send(message)) setPending({ intent, ply: state.ply, game: state.game, syncId, noticeId: notice?.id ?? 0 });
    else showToast('Not connected — your move was not sent.');
  };

  const seatStatus = (color: Color): SeatStatus => {
    const seat = state.seats[color];
    if (!seat.taken) return 'open';
    return seat.online ? 'online' : 'offline';
  };

  const playerBar = (color: Color) => (
    <PlayerBar
      color={color}
      name={colorName(color)}
      isYou={me === color}
      seat={seatStatus(color)}
      isTurn={state.status === 'active' && turn === color}
      captured={captured[color]}
      advantage={color === 'w' ? balance : -balance}
      clock={state.status === 'active' && turn === color && clocks.turn !== null ? formatClock(clocks.turn) : null}
    />
  );

  const view = statusView(state, role, status, inCheck, isWorld, clocks);

  return (
    <div className="page">
      {header}
      <main className="game-layout">
        <section className={`status-card tone-${view.tone}`}>
          <div>
            <p className="status-title">{view.title}</p>
            <p className="status-detail">{view.detail}</p>
          </div>
        </section>

        <section className="board-column" aria-label="Chessboard">
          {playerBar(opposite(orientation))}
          <Board
            id={`room-${roomId}`}
            fen={displayFen}
            orientation={orientation}
            movable={movable}
            lastMove={lastMove}
            onMove={playMove}
          />
          {playerBar(orientation)}
        </section>

        <section className="actions" aria-label="Game controls">
          <GameActions
            state={state}
            me={me}
            roomId={roomId}
            isWorld={isWorld}
            onAction={sendAction}
            onFlip={() => setFlipped((value) => !value)}
          />
        </section>

        <section className="panel moves-panel" aria-labelledby="moves-title">
          <h2 id="moves-title" className="panel-title">
            Moves
          </h2>
          <MoveList moves={state.moves} />
        </section>

        <section className="extras">
          <div className="room-meta">
            <span className="watchers" title="People watching this game">
              <EyeIcon /> {state.spectators} watching
            </span>
            <span className="room-code">{isWorld ? 'World Board' : state.game > 1 ? `Game #${state.game}` : 'Private game'}</span>
          </div>
          {isWorld && (
            <p className="hint">
              The World Board is one public game. Players get 3 minutes per move and lose their seat after a minute
              offline. After each game the seats open up for the next two players.
            </p>
          )}
          {me && !isIdentityPersistent() && (
            <p className="hint warning-text">
              Your browser is blocking storage, so refreshing this page will lose your seat.
            </p>
          )}
          <KeyboardPanel fen={state.fen} canMove={Boolean(movable)} onMove={playMove} />
        </section>
      </main>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

interface Clocks {
  /** Seconds the player to move has left (World Board only). */
  turn: number | null;
  /** Seconds until the seats reopen after a finished game (World Board only). */
  reopen: number | null;
}

/** Re-renders every second while `active`, for countdowns. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusView(
  state: RoomSnapshot,
  role: Role,
  connection: ConnectionStatus,
  inCheck: boolean,
  isWorld: boolean,
  clocks: Clocks,
): { tone: Tone; title: string; detail: string } {
  const me = role === 'spectator' ? null : role;
  const turn: Color = state.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const offline = connection !== 'open';
  const turnClock = clocks.turn === null ? null : formatClock(clocks.turn);

  if (state.status === 'over' && state.end) {
    const { title, detail } = describeEnd(state.end);
    const seatOpen = !state.seats.w.taken || !state.seats.b.taken;
    const reopen = clocks.reopen === null ? '' : ` Seats open up for the next game in ${formatClock(clocks.reopen)}.`;
    const next = seatOpen
      ? me
        ? ' Share the link — a new game starts when someone takes the open seat.'
        : ' A seat is open — take it to play the next game.'
      : reopen;
    if (me && state.end.winner === me) return { tone: 'success', title: 'You won! 🎉', detail: `${title}. ${detail}${next}` };
    if (me && state.end.winner) return { tone: 'danger', title: 'You lost', detail: `${title}. ${detail}${next}` };
    return { tone: 'info', title, detail: `${detail}${next}` };
  }

  if (state.status === 'waiting') {
    if (me) {
      return {
        tone: 'warning',
        title: 'Waiting for an opponent',
        detail: `Share the link — the first person to open it plays ${colorName(opposite(me))}.`,
      };
    }
    return { tone: 'info', title: 'Waiting for players', detail: 'A seat is open — take it to play.' };
  }

  if (me) {
    if (state.drawOffer === opposite(me)) {
      return { tone: 'warning', title: 'Your opponent offers a draw', detail: 'Accept, decline, or just make your move.' };
    }
    if (turn === me) {
      return {
        tone: inCheck ? 'danger' : 'success',
        title: inCheck ? 'Your move — you are in check!' : 'Your move',
        detail: offline
          ? 'Reconnecting… you can move once the connection is back.'
          : turnClock
            ? `You have ${turnClock} to make your move.`
            : `You are playing ${colorName(me)}.`,
      };
    }
    const opponentOnline = state.seats[opposite(me)].online;
    return {
      tone: 'info',
      title: "Opponent's move",
      detail: opponentOnline
        ? turnClock
          ? `${colorName(opposite(me))} has ${turnClock} to move.`
          : `Waiting for ${colorName(opposite(me))} to move…`
        : isWorld
          ? 'Your opponent disconnected. If they are not back within a minute, you win.'
          : 'Your opponent is offline. Their seat is saved until they come back.',
    };
  }

  return {
    tone: 'info',
    title: `${colorName(turn)} to move${inCheck ? ' — check!' : ''}`,
    detail: turnClock
      ? `${colorName(turn)} has ${turnClock} to move. You're watching live.`
      : "You're watching live. Both seats are taken.",
  };
}

function GameActions({
  state,
  me,
  roomId,
  isWorld,
  onAction,
  onFlip,
}: {
  state: RoomSnapshot;
  me: Color | null;
  roomId: string;
  isWorld: boolean;
  onAction: (message: Parameters<ReturnType<typeof useRoom>['send']>[0]) => void;
  onFlip: () => void;
}) {
  const [confirming, setConfirming] = useState<'resign' | 'leave' | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), 5000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const game = state.game;
  const flip = (
    <button type="button" className="btn btn-secondary" onClick={onFlip}>
      Flip board
    </button>
  );

  if (!me) {
    const openSeats = (['w', 'b'] as Color[]).filter((color) => !state.seats[color].taken);
    return (
      <>
        {openSeats.map((color) => (
          <button
            key={color}
            type="button"
            className="btn btn-primary"
            onClick={() => onAction({ type: 'sit', color })}
          >
            Play as {colorName(color)}
          </button>
        ))}
        {flip}
        <NewGameButton label="Start your own game" variant="secondary" />
      </>
    );
  }

  const opponent = opposite(me);
  const opponentSeated = state.seats[opponent].taken;
  const midGame = state.status === 'active' && state.ply > 0;

  const leave =
    confirming === 'leave' ? (
      <>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setConfirming(null);
            onAction({ type: 'leave' });
          }}
        >
          {midGame ? 'Leave & forfeit' : 'Leave seat'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
          Stay
        </button>
      </>
    ) : (
      <button type="button" className="btn btn-ghost" onClick={() => setConfirming('leave')}>
        Leave seat
      </button>
    );

  if (state.status === 'waiting') {
    return (
      <>
        <ShareButton roomId={roomId} />
        {flip}
        {leave}
      </>
    );
  }

  if (state.status === 'active') {
    const drawControls =
      state.drawOffer === opponent ? (
        <>
          <button type="button" className="btn btn-primary" onClick={() => onAction({ type: 'draw', action: 'accept', game })}>
            Accept draw
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => onAction({ type: 'draw', action: 'decline', game })}>
            Decline
          </button>
        </>
      ) : state.drawOffer === me ? (
        <button type="button" className="btn btn-secondary" onClick={() => onAction({ type: 'draw', action: 'decline', game })}>
          Cancel draw offer
        </button>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => onAction({ type: 'draw', action: 'offer', game })}>
          Offer draw
        </button>
      );

    const resign =
      confirming === 'resign' ? (
        <>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setConfirming(null);
              onAction({ type: 'resign', game });
            }}
          >
            Confirm resign
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
            Keep playing
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming('resign')}>
          Resign
        </button>
      );

    return (
      <>
        {drawControls}
        {resign}
        {flip}
        {confirming !== 'resign' && leave}
      </>
    );
  }

  // Game over. On the World Board the seats rotate instead of rematching.
  const rematch = isWorld ? null : !opponentSeated ? (
    <ShareButton roomId={roomId} />
  ) : state.rematch[me] ? (
    <button type="button" className="btn btn-secondary" onClick={() => onAction({ type: 'rematch', want: false, game })}>
      Rematch requested — cancel
    </button>
  ) : (
    <button type="button" className="btn btn-primary" onClick={() => onAction({ type: 'rematch', want: true, game })}>
      {state.rematch[opponent] ? 'Accept rematch' : 'Rematch'}
    </button>
  );

  return (
    <>
      {rematch}
      {flip}
      <NewGameButton label="New game" variant="secondary" />
      {leave}
    </>
  );
}

function NewGameButton({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'secondary' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={`btn btn-${variant}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            navigate(`/game/${await createRoom()}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create a game.');
            setBusy(false);
          }
        }}
      >
        {busy ? 'Creating…' : label}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
