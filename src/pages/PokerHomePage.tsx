import { useEffect } from 'react';
import { AppHeader } from '../components/AppHeader.tsx';
import { Link } from '../components/Link.tsx';
import { LiveGameCard } from '../components/LiveGameCard.tsx';
import { NameEditor } from '../components/NameEditor.tsx';
import { PlayingCard } from '../components/PlayingCard.tsx';
import { PokerFinderButton, PrivateTableButton } from '../components/PokerButtons.tsx';
import { useLiveGames } from '../lib/live-api.ts';

export function PokerHomePage() {
  const live = useLiveGames('poker', 'all');

  useEffect(() => {
    document.title = 'Poker · Timeline Games';
  }, []);

  return (
    <div className="page">
      <AppHeader />
      <main className="landing">
        <header className="landing-header">
          <span className="game-tag game-tag-poker">Poker</span>
          <h1>Texas Hold&apos;em, live</h1>
          <p className="lede">
            2–6 players per table, blinds 5/10, 1,000 free play chips each. Every card is dealt and checked on the
            server, and nobody can see your cards.
          </p>
          <div className="hero-cards" aria-hidden="true">
            <PlayingCard card="As" size="large" />
            <PlayingCard card="Ks" size="large" />
          </div>
          <NameEditor />
        </header>

        <section className="landing-actions" aria-label="Ways to play poker">
          <article className="action-card">
            <h2>Find a table</h2>
            <p>Join a public table with an open seat. A hand starts as soon as two players are seated.</p>
            <PokerFinderButton />
          </article>
          <article className="action-card">
            <h2>Private table</h2>
            <p>Open your own table and send the invite link to friends. It won&apos;t appear in public lists.</p>
            <PrivateTableButton variant="primary" />
          </article>
          <article className="action-card">
            <h2>Watch live</h2>
            <p>Follow public tables as they play. Spectators never see anyone&apos;s hidden cards.</p>
            <Link to="/poker/live" className="btn btn-secondary">
              Watch live poker
            </Link>
          </article>
        </section>

        <section className="poker-rules" aria-labelledby="poker-rules-title">
          <h2 id="poker-rules-title" className="section-title">
            Table rules
          </h2>
          <ul>
            <li>No-limit Texas Hold&apos;em. Small blind 5, big blind 10.</li>
            <li>You have 30 seconds to act; after that you check or fold automatically.</li>
            <li>Miss two turns in a row and you&apos;re sat out until you press &ldquo;I&apos;m back&rdquo;.</li>
            <li>Joined mid-hand? You&apos;re dealt in from the next hand.</li>
            <li>
              <strong>Play money only.</strong> Chips are free, have no value and can&apos;t be bought, sold, transferred
              or cashed out. Run out and you can take another free 1,000.
            </li>
          </ul>
        </section>

        {live.games.length > 0 && (
          <section aria-labelledby="poker-live-title">
            <div className="section-head">
              <h2 id="poker-live-title" className="section-title">
                Tables playing now
              </h2>
              <Link to="/poker/live" className="text-link">
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
