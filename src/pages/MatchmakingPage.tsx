import { useEffect, useState } from 'react';
import { colorName } from '../../shared/protocol.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBadge } from '../components/ConnectionBadge.tsx';
import { Link } from '../components/Link.tsx';
import { NameEditor } from '../components/NameEditor.tsx';
import { rememberActiveGame } from '../lib/active-games.ts';
import { formatClock } from '../lib/chess-ui.ts';
import { navigate } from '../lib/router.ts';
import { useMatchmaking } from '../lib/useMatchmaking.ts';

export function MatchmakingPage() {
  const { status, phase, searching, match, notice, fatal, find, cancel, retryNow } = useMatchmaking();
  const [searchStarted, setSearchStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    document.title = 'Find a chess match · Timeline Games';
  }, []);

  // Elapsed-time counter while searching.
  useEffect(() => {
    if (phase !== 'searching') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Matched: remember the game and jump into it.
  useEffect(() => {
    if (!match) return;
    rememberActiveGame({ game: 'chess', id: match.roomId, label: `Chess vs ${match.opponent}` });
    const timer = setTimeout(() => navigate(`/game/${match.roomId}`), match.resumed ? 300 : 1200);
    return () => clearTimeout(timer);
  }, [match]);

  const start = () => {
    setSearchStarted(Date.now());
    setNow(Date.now());
    find();
  };

  return (
    <div className="page">
      <AppHeader nav={false}>
        <ConnectionBadge status={status} retryAt={null} onRetry={retryNow} />
      </AppHeader>
      <main className="center-page">
        <section className="message-card matchmaking-card" aria-live="polite">
          {fatal ? (
            <>
              <h1>Please reload</h1>
              <p>{fatal}</p>
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </>
          ) : phase === 'matched' && match ? (
            <>
              <div className="match-found-icon" aria-hidden="true">
                ⚔️
              </div>
              <h1>{match.resumed ? 'Back to your game' : 'Opponent found!'}</h1>
              <p>
                {match.resumed ? 'You have a game in progress' : `You're playing ${colorName(match.color)}`} against{' '}
                <strong>{match.opponent}</strong>. Taking you to the board…
              </p>
              <Link to={`/game/${match.roomId}`} className="btn btn-primary">
                Go to the game
              </Link>
            </>
          ) : phase === 'searching' ? (
            <>
              <div className="searching-spinner" aria-hidden="true" />
              <h1>Looking for an opponent…</h1>
              <p className="search-meta">
                <span>{formatClock((now - searchStarted) / 1000)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {searching <= 1 ? 'You are the only one searching right now' : `${searching} players searching`}
                </span>
              </p>
              <p className="hint">Keep this page open. We&apos;ll start the game as soon as someone else is looking.</p>
              {notice && <p className="hint warning-text">{notice}</p>}
              <button type="button" className="btn btn-secondary" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <h1>Find a chess match</h1>
              <p>We&apos;ll pair you with the next person who&apos;s looking. Colours are assigned at random.</p>
              <NameEditor />
              <p className="disclosure">
                Matchmade games are <strong>public</strong>: anyone can watch them live from the Live page, and your
                display name is shown. Moves have a 3-minute limit.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-large"
                onClick={start}
                disabled={status !== 'open'}
              >
                {status === 'open' ? 'Find a match' : 'Connecting…'}
              </button>
              {notice && <p className="form-error">{notice}</p>}
              <div className="card-links">
                <Link to="/chess" className="text-link">
                  Play a friend instead
                </Link>
                <Link to="/chess/live" className="text-link">
                  Watch live games
                </Link>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
