import { useEffect, useState } from 'react';
import type { PlayerView, PokerActionType, PokerClientMessage, PublicTable } from '../../shared/poker.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBadge } from '../components/ConnectionBadge.tsx';
import { Link } from '../components/Link.tsx';
import { PokerFinderButton } from '../components/PokerButtons.tsx';
import { ShareButton } from '../components/ShareButton.tsx';
import { ActionBar } from '../components/poker/ActionBar.tsx';
import { PokerTableView } from '../components/poker/PokerTableView.tsx';
import { forgetActiveGame, rememberActiveGame } from '../lib/active-games.ts';
import { cardName } from '../lib/cards.ts';
import { formatClock } from '../lib/chess-ui.ts';
import { usePokerTable } from '../lib/usePokerTable.ts';
import { NotFoundPage } from './NotFoundPage.tsx';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const SHARE_TEXT = "Join my poker table 🃏 Free play-money Texas Hold'em — take a seat or watch live:";

export function PokerTablePage({ tableId }: { tableId: string }) {
  // ?sit=1 (from Find a table / Create table) takes a seat on arrival.
  const [autoSit] = useState(() => new URLSearchParams(window.location.search).has('sit'));
  useEffect(() => {
    // Keep a copied address bar link from seating whoever opens it.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const { status, table, you, notice, fatal, retryAt, receivedAt, send, retryNow } = usePokerTable(tableId, { autoSit });
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [localToast, setLocalToast] = useState<{ id: number; text: string } | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState(0);

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
  useEffect(() => {
    if (!confirmLeave) return;
    const timer = setTimeout(() => setConfirmLeave(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmLeave]);
  const toast = localToast?.text ?? (notice && notice.id !== dismissedNotice ? notice.message : null);

  const hand = table?.hand ?? null;
  const live = Boolean(hand && !hand.done);
  const mySeat = you?.seat ?? null;
  const myTurn = Boolean(live && mySeat !== null && hand!.turn === mySeat && you?.actions);

  // Countdowns (turn timer, next hand), from server times so device clocks don't matter.
  const now = useNow(Boolean(live || table?.nextHandAt));
  const secondsUntil = (deadline: number | null | undefined) =>
    deadline == null || !table ? null : Math.max(0, (deadline - table.serverTime - Math.max(0, now - receivedAt)) / 1000);
  const turnLeft = live ? secondsUntil(hand!.deadline) : null;
  const nextHandIn = !live ? secondsUntil(table?.nextHandAt) : null;

  useEffect(() => {
    document.title = myTurn ? '● Your turn · Poker · Timeline Games' : 'Poker · Timeline Games';
  }, [myTurn]);

  // "Return to your game" on the homepage while you're seated.
  const seated = mySeat !== null;
  const hasTable = table !== null;
  useEffect(() => {
    if (!hasTable) return;
    if (seated) rememberActiveGame({ game: 'poker', id: tableId, label: "Texas Hold'em table" });
    else forgetActiveGame('poker', tableId);
  }, [hasTable, seated, tableId]);

  if (fatal) {
    return (
      <NotFoundPage title={fatal.code === 'table_not_found' ? 'Table not found' : 'Please reload'} message={fatal.message}>
        {fatal.code === 'table_not_found' ? (
          <PokerFinderButton />
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
      </NotFoundPage>
    );
  }

  const shareUrl = `${window.location.origin}/poker/table/${tableId}`;
  const header = (
    <AppHeader nav={false}>
      <ConnectionBadge status={status} retryAt={retryAt} onRetry={retryNow} />
      <ShareButton url={shareUrl} text={SHARE_TEXT} />
    </AppHeader>
  );

  if (!table || !you) {
    return (
      <div className="page">
        {header}
        <main className="poker-page">
          <section className="status-card tone-info">
            <div>
              <p className="status-title">{status === 'connecting' ? 'Joining the table…' : 'Reconnecting…'}</p>
              <p className="status-detail">Loading seats and cards.</p>
            </div>
          </section>
          <div className="poker-table is-loading" aria-busy="true">
            <div className="felt" />
          </div>
        </main>
      </div>
    );
  }

  const sendAction = (message: PokerClientMessage) => {
    if (!send(message)) setLocalToast({ id: Date.now(), text: 'Not connected — reconnecting…' });
  };
  const act = (action: PokerActionType, amount?: number) => {
    if (!hand) return;
    sendAction(amount === undefined ? { type: 'act', action, hand: hand.number, seq: hand.seq } : { type: 'act', action, amount, hand: hand.number, seq: hand.seq });
  };

  const me = mySeat !== null ? table.seats[mySeat] : null;
  const view = statusView(table, you, turnLeft, nextHandIn);
  const openSeats = table.seats.filter((seat) => seat === null).length;
  const waitingForPlayers = table.maxSeats - openSeats < 2;

  return (
    <div className="page">
      {header}
      <main className="poker-page">
        <section className={`status-card tone-${view.tone}`}>
          <div>
            <p className="status-title">{view.title}</p>
            <p className="status-detail">{view.detail}</p>
          </div>
        </section>

        <PokerTableView
          table={table}
          mySeat={mySeat}
          myHole={you.hole}
          canSit={mySeat === null}
          onSit={(seat) => sendAction({ type: 'sit', seat })}
          secondsLeft={turnLeft}
        />

        {myTurn && hand && you.actions && me && (
          <ActionBar key={`${hand.number}-${hand.seq}`} hand={hand} actions={you.actions} stack={me.stack} onAct={act} />
        )}

        <section className="table-controls" aria-label="Table controls">
          {mySeat === null ? (
            openSeats > 0 ? (
              <button type="button" className="btn btn-primary" onClick={() => sendAction({ type: 'sit' })}>
                Take a seat
              </button>
            ) : (
              <span className="hint">The table is full. You can watch, or find another table.</span>
            )
          ) : (
            <>
              {waitingForPlayers && <ShareButton url={shareUrl} text={SHARE_TEXT} />}
              {me?.away ? (
                <button type="button" className="btn btn-primary" onClick={() => sendAction({ type: 'away', away: false })}>
                  I&apos;m back
                </button>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => sendAction({ type: 'away', away: true })}>
                  Sit out
                </button>
              )}
              {me && me.stack === 0 && !(live && me.inHand && !me.folded) && (
                <button type="button" className="btn btn-primary" onClick={() => sendAction({ type: 'rebuy' })}>
                  Get {table.startingStack.toLocaleString()} free chips
                </button>
              )}
              {confirmLeave ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setConfirmLeave(false);
                      sendAction({ type: 'leave' });
                    }}
                  >
                    {live && me?.inHand && !me.folded ? 'Fold and leave' : 'Leave table'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmLeave(false)}>
                    Stay
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmLeave(true)}>
                  Leave table
                </button>
              )}
            </>
          )}
          <Link to="/poker/live" className="btn btn-ghost">
            Other tables
          </Link>
        </section>

        <section className="table-info">
          <p>
            Texas Hold&apos;em · Blinds {table.smallBlind}/{table.bigBlind} · {table.startingStack.toLocaleString()} starting
            chips · {table.actionMs / 1000} seconds per action · {table.visibility === 'private' ? 'Private table' : 'Public table'}{' '}
            · {table.spectators} watching
          </p>
          <p className="play-money">
            Play money only. Chips are free, have no value and can&apos;t be bought, sold, transferred or cashed out.
          </p>
        </section>
      </main>
      <div className="sr-only" aria-live="polite">
        {announcement(table, you)}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function statusView(
  table: PublicTable,
  you: PlayerView,
  turnLeft: number | null,
  nextHandIn: number | null,
): { tone: Tone; title: string; detail: string } {
  const hand = table.hand;
  const seat = you.seat;
  const me = seat !== null ? table.seats[seat] : null;
  const seated = table.seats.filter(Boolean).length;
  const watching = seat === null ? "You're watching — players' hole cards are hidden." : '';

  if (hand && !hand.done) {
    const clock = turnLeft !== null ? formatClock(turnLeft) : '';
    if (seat !== null && hand.turn === seat) return { tone: 'success', title: 'Your turn', detail: `${clock} to act.` };
    const actor = hand.turn !== null ? table.seats[hand.turn]?.name : null;
    const detail = me?.inHand && !me.folded ? 'Waiting for your turn.' : me && !me.inHand ? "You'll be dealt in next hand." : watching;
    return { tone: 'info', title: actor ? `${actor} is thinking… ${clock}` : 'Dealing…', detail };
  }

  const result = table.lastResult;
  const next =
    nextHandIn !== null ? `Next hand in ${Math.ceil(nextHandIn)}s.` : seated < 2 ? 'Waiting for at least two players.' : 'Waiting for players to be ready.';
  if (me?.away) return { tone: 'warning', title: "You're sitting out", detail: "Press I'm back to be dealt in." };
  if (me && me.stack === 0) return { tone: 'warning', title: "You're out of chips", detail: 'Take another free stack to keep playing.' };
  if (result && hand?.done && result.hand === hand.number) {
    const [top] = result.winners;
    const split = result.winners.length > 1;
    const title = split
      ? `Split pot: ${result.winners.map((w) => w.name).join(' & ')}`
      : `${top.name} wins ${top.amount.toLocaleString()}${top.hand ? ` with ${top.hand}` : ''}`;
    const mine = seat !== null ? result.winners.find((w) => w.seat === seat) : null;
    return { tone: mine ? 'success' : 'info', title: mine && !split ? `You win ${mine.amount.toLocaleString()}!` : title, detail: next };
  }
  if (seated < 2) {
    return {
      tone: 'warning',
      title: `Waiting for players (${seated}/${table.maxSeats})`,
      detail: seat !== null ? 'Share the invite link — the game starts as soon as someone sits down.' : 'Take a seat to start a game.',
    };
  }
  return { tone: 'info', title: 'Getting ready', detail: next };
}

function announcement(table: PublicTable, you: PlayerView): string {
  const hand = table.hand;
  if (!hand) return '';
  if (hand.done && table.lastResult?.hand === hand.number) {
    return table.lastResult.winners.map((w) => `${w.name} wins ${w.amount} chips${w.hand ? ` with ${w.hand}` : ''}`).join('. ');
  }
  if (you.seat !== null && hand.turn === you.seat) return 'Your turn.';
  if (hand.board.length) return `${hand.street}: ${hand.board.map(cardName).join(', ')}`;
  return 'New hand.';
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
