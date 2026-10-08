import { useEffect } from 'react';
import { AppHeader } from '../components/AppHeader.tsx';
import { FriendGameButton } from '../components/FriendGameButton.tsx';
import { Link } from '../components/Link.tsx';
import { LiveGameCard } from '../components/LiveGameCard.tsx';
import { NameEditor } from '../components/NameEditor.tsx';
import { useLiveGames } from '../lib/live-api.ts';

export function ChessHomePage() {
  const live = useLiveGames('chess', 'all');

  useEffect(() => {
    document.title = 'Chess · Timeline Games';
  }, []);

  return (
    <div className="page">
      <AppHeader />
      <main className="landing">
        <header className="landing-header">
          <span className="game-tag game-tag-chess">Chess</span>
          <h1>Play chess live</h1>
          <p className="lede">Real-time games with legal-move checking on the server, spectators and rematches.</p>
          <NameEditor />
        </header>

        <section className="landing-actions" aria-label="Ways to play chess">
          <article className="action-card">
            <h2>Find a match</h2>
            <p>Get paired with the next person who&apos;s looking. Matchmade games are public, so anyone can watch.</p>
            <Link to="/chess/matchmaking" className="btn btn-primary">
              Find a match
            </Link>
          </article>
          <article className="action-card">
            <h2>Play with a friend</h2>
            <p>Create a private game and send the link. Your friend takes the other seat.</p>
            <FriendGameButton variant="primary" startOpen />
          </article>
          <article className="action-card">
            <h2>Watch live</h2>
            <p>Browse public games and follow every move as it happens.</p>
            <Link to="/chess/live" className="btn btn-secondary">
              Watch live chess
            </Link>
          </article>
        </section>

        <section className="landing-more" aria-label="More ways to play">
          <Link to="/world" className="more-card">
            <strong>World Board</strong>
            <span>One public game for everyone. Grab a seat when it opens.</span>
          </Link>
          <Link to="/local" className="more-card">
            <strong>Pass-and-play</strong>
            <span>Two players on one device, no connection needed.</span>
          </Link>
        </section>

        {live.games.length > 0 && (
          <section aria-labelledby="chess-live-title">
            <div className="section-head">
              <h2 id="chess-live-title" className="section-title">
                Live chess now
              </h2>
              <Link to="/chess/live" className="text-link">
                See all →
              </Link>
            </div>
            <div className="live-grid">
              {live.games.slice(0, 4).map((game) => (
                <LiveGameCard key={game.id} game={game} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
