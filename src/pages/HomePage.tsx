import { useEffect } from 'react';
import { AppHeader } from '../components/AppHeader.tsx';
import { FriendGameButton } from '../components/FriendGameButton.tsx';
import { Link } from '../components/Link.tsx';
import { LiveGameCard } from '../components/LiveGameCard.tsx';
import { MiniBoard } from '../components/MiniBoard.tsx';
import { NameEditor } from '../components/NameEditor.tsx';
import { PlayingCard } from '../components/PlayingCard.tsx';
import { PokerFinderButton, PrivateTableButton } from '../components/PokerButtons.tsx';
import { useActiveGames } from '../lib/active-games.ts';
import { useLiveGames } from '../lib/live-api.ts';

// Position after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 (Italian Game) — purely decorative.
const HERO_FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

export function HomePage() {
  const activeGames = useActiveGames();
  const live = useLiveGames('all', 'all');

  useEffect(() => {
    document.title = 'Timeline Games — chess & poker with your timeline';
  }, []);

  return (
    <div className="page">
      <AppHeader />
      <main className="home">
        <section className="home-hero">
          <p className="eyebrow">Free · No sign-up · Real-time</p>
          <h1>
            Play real-time games with <span className="accent-text">people across your timeline.</span>
          </h1>
          <p className="lede">
            Chess and Texas Hold&apos;em in your browser. Find an opponent in seconds, send a friend a link, or watch
            games live. Share any game in a post on X.
          </p>
          <NameEditor />
        </section>

        {activeGames.length > 0 && (
          <section className="continue" aria-labelledby="continue-title">
            <h2 id="continue-title" className="section-title">
              Continue your game
            </h2>
            <div className="continue-list">
              {activeGames.slice(0, 3).map((game) => (
                <Link
                  key={`${game.game}:${game.id}`}
                  to={game.game === 'chess' ? (game.id === 'world' ? '/world' : `/game/${game.id}`) : `/poker/table/${game.id}`}
                  className="continue-item"
                >
                  <span className={`game-tag game-tag-${game.game}`}>{game.game === 'chess' ? 'Chess' : 'Poker'}</span>
                  <span>{game.label}</span>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="game-choices" aria-label="Choose a game">
          <article className="game-choice chess-choice">
            <div className="game-choice-art" aria-hidden="true">
              <MiniBoard fen={HERO_FEN} />
            </div>
            <div className="game-choice-body">
              <h2>Chess</h2>
              <p>1v1 games with live spectators. Moves are checked on the server.</p>
              <div className="choice-actions">
                <Link to="/chess/matchmaking" className="btn btn-primary">
                  Find a match
                </Link>
                <FriendGameButton />
                <Link to="/chess/live" className="btn btn-ghost">
                  Watch live
                </Link>
              </div>
              <p className="choice-more">
                <Link to="/world" className="text-link">
                  World Board
                </Link>{' '}
                ·{' '}
                <Link to="/local" className="text-link">
                  Pass-and-play
                </Link>
              </p>
            </div>
          </article>

          <article className="game-choice poker-choice">
            <div className="game-choice-art" aria-hidden="true">
              <div className="hero-cards">
                <PlayingCard card="As" size="large" />
                <PlayingCard card="Kh" size="large" />
              </div>
            </div>
            <div className="game-choice-body">
              <h2>Poker</h2>
              <p>Texas Hold&apos;em for 2–6 players with free play-money chips.</p>
              <div className="choice-actions">
                <PokerFinderButton />
                <PrivateTableButton variant="secondary" />
                <Link to="/poker/live" className="btn btn-ghost">
                  Watch live
                </Link>
              </div>
              <p className="choice-more">Play money only: chips are free and have no value.</p>
            </div>
          </article>
        </section>

        <section className="live-now" aria-labelledby="live-now-title">
          <div className="section-head">
            <h2 id="live-now-title" className="section-title">
              Live now
            </h2>
            <Link to="/live" className="text-link">
              See all →
            </Link>
          </div>
          {live.games.length === 0 ? (
            <p className="hint">
              {live.status === 'loading'
                ? 'Loading live games…'
                : 'No public games right now. Find a match and yours will show up here.'}
            </p>
          ) : (
            <div className="live-grid">
              {live.games.slice(0, 6).map((game) => (
                <LiveGameCard key={`${game.game}:${game.id}`} game={game} />
              ))}
            </div>
          )}
        </section>

        <section className="steps" aria-labelledby="how-it-works">
          <h2 id="how-it-works" className="section-title">
            How it works
          </h2>
          <ol className="step-list">
            <li className="step">
              <span className="step-number">1</span>
              <h3>Pick a game</h3>
              <p>Chess or poker. No account, no download. Choose any display name.</p>
            </li>
            <li className="step">
              <span className="step-number">2</span>
              <h3>Find people</h3>
              <p>Get matched with someone online, or share a link on X and play whoever clicks.</p>
            </li>
            <li className="step">
              <span className="step-number">3</span>
              <h3>Play or watch live</h3>
              <p>Everything updates in real time. Public games can be watched by anyone.</p>
            </li>
          </ol>
        </section>

        <footer className="site-footer">
          <p>
            Runs on Cloudflare&apos;s free tier. Chess moves and poker hands are checked on the server. Poker is free
            play-money entertainment: no real-money betting, purchases, prizes or cash-out. Chess piece artwork by Colin
            M.L. Burnett via react-chessboard.
          </p>
        </footer>
      </main>
    </div>
  );
}
