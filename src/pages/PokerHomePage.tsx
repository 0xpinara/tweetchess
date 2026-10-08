import { useEffect } from 'react';
import { AppHeader } from '../components/AppHeader.tsx';
import { Link } from '../components/Link.tsx';
import { PlayingCard } from '../components/PlayingCard.tsx';

/** Placeholder while poker tables are being built (replaced when poker ships). */
export function PokerHomePage() {
  useEffect(() => {
    document.title = 'Poker · Timeline Games';
  }, []);

  return (
    <div className="page">
      <AppHeader />
      <main className="center-page">
        <div className="message-card">
          <div className="hero-cards" aria-hidden="true">
            <PlayingCard card="As" size="large" />
            <PlayingCard card="Kh" size="large" />
          </div>
          <span className="game-tag game-tag-poker">Work in progress</span>
          <h1>Poker tables are being set up</h1>
          <p>
            Texas Hold&apos;em for 2–6 players with free play-money chips is coming in this update. Chess is ready to
            play now.
          </p>
          <div className="cta-row cta-row-center">
            <Link to="/chess/matchmaking" className="btn btn-primary">
              Play chess instead
            </Link>
            <Link to="/" className="btn btn-secondary">
              Home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
