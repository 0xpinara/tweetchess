import { useEffect, useState } from 'react';
import type { LiveFilter } from '../../shared/lobby.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Link } from '../components/Link.tsx';
import { LiveGameCard } from '../components/LiveGameCard.tsx';
import { useLiveGames, type LiveScope } from '../lib/live-api.ts';

const TABS: { scope: LiveScope; label: string; path: string }[] = [
  { scope: 'all', label: 'All games', path: '/live' },
  { scope: 'chess', label: 'Chess', path: '/chess/live' },
  { scope: 'poker', label: 'Poker', path: '/poker/live' },
];

const FILTERS: { filter: LiveFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'playing', label: 'Playing now' },
  { filter: 'waiting', label: 'Waiting for players' },
  { filter: 'open', label: 'Open seats' },
];

export function LivePage({ scope }: { scope: LiveScope }) {
  const [filter, setFilter] = useState<LiveFilter>('all');
  const { games, status, error, updatedAt, nextCursor, loadingMore, refresh, loadMore } = useLiveGames(scope, filter);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    document.title =
      scope === 'chess' ? 'Live chess · Timeline Games' : scope === 'poker' ? 'Live poker · Timeline Games' : 'Live games · Timeline Games';
  }, [scope]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const ago = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;

  return (
    <div className="page">
      <AppHeader />
      <main className="live-page">
        <header className="live-header">
          <h1>Watch live</h1>
          <p>Public games happening right now. Spectators see every move instantly but never anyone&apos;s hidden cards.</p>
        </header>

        <nav className="tabs" aria-label="Game type">
          {TABS.map((tab) => (
            <Link key={tab.scope} to={tab.path} className="tab" aria-current={tab.scope === scope ? 'page' : undefined}>
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="filters" role="group" aria-label="Filter games">
          {FILTERS.map((option) => (
            <button
              key={option.filter}
              type="button"
              className="chip"
              aria-pressed={filter === option.filter}
              onClick={() => setFilter(option.filter)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="live-toolbar">
          <span className="hint" aria-live="polite">
            {status === 'loading' ? 'Loading…' : ago !== null ? `Updated ${ago < 5 ? 'just now' : `${ago}s ago`}` : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>

        {status === 'error' && <p className="form-error">{error}</p>}

        {status !== 'loading' && games.length === 0 && status !== 'error' ? (
          <div className="empty-state">
            <p>No public {scope === 'all' ? '' : `${scope} `}games match right now.</p>
            <div className="cta-row cta-row-center">
              {scope !== 'poker' && (
                <Link to="/chess/matchmaking" className="btn btn-primary">
                  Find a chess match
                </Link>
              )}
              {scope !== 'chess' && (
                <Link to="/poker" className="btn btn-secondary">
                  Play poker
                </Link>
              )}
            </div>
          </div>
        ) : (
          <div className="live-grid">
            {games.map((game) => (
              <LiveGameCard key={`${game.game}:${game.id}`} game={game} />
            ))}
          </div>
        )}

        {nextCursor && (
          <div className="cta-row cta-row-center">
            <button type="button" className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
