import { useEffect, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { AppHeader } from '../components/AppHeader.tsx';
import { createRoom } from '../lib/api.ts';
import { Link } from '../components/Link.tsx';
import { navigate } from '../lib/router.ts';

// Position after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 (Italian Game) — purely decorative.
const HERO_FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

export function HomePage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'TweetChess — live chess you can share in a post';
  }, []);

  const startGame = async () => {
    setCreating(true);
    setError(null);
    try {
      const roomId = await createRoom();
      navigate(`/game/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <AppHeader />
      <main className="home">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Free · No sign-up · Real-time</p>
            <h1>
              Chess you can share <span className="accent-text">in a post.</span>
            </h1>
            <p className="lede">
              Start a game, post the link on X, and play whoever clicks first. Everyone else who opens the link
              watches the game live.
            </p>
            <div className="cta-row">
              <button type="button" className="btn btn-primary btn-large" onClick={startGame} disabled={creating}>
                {creating ? 'Creating game…' : 'Create a game'}
              </button>
              <Link to="/world" className="btn btn-secondary btn-large">
                Join the World Board
              </Link>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Link to="/local" className="text-link">
              Or play pass-and-play on this device →
            </Link>
          </div>
          <div className="hero-board" aria-hidden="true">
            <div className="hero-board-inner">
              <Chessboard
                options={{
                  id: 'hero',
                  position: HERO_FEN,
                  allowDragging: false,
                  allowDrawingArrows: false,
                  showNotation: false,
                  showAnimations: false,
                  lightSquareStyle: { backgroundColor: 'var(--board-light)' },
                  darkSquareStyle: { backgroundColor: 'var(--board-dark)' },
                  squareStyles: {
                    f1: { backgroundColor: 'rgba(255, 200, 40, 0.38)' },
                    c4: { backgroundColor: 'rgba(255, 200, 40, 0.38)' },
                  },
                  arrows: [{ startSquare: 'f3', endSquare: 'g5', color: 'rgba(29, 155, 240, 0.9)' }],
                }}
              />
            </div>
          </div>
        </section>

        <section className="steps" aria-labelledby="how-it-works">
          <h2 id="how-it-works" className="section-title">
            How it works
          </h2>
          <ol className="step-list">
            <li className="step">
              <span className="step-number">1</span>
              <h3>Create a game</h3>
              <p>You get your own board and play White. No account, no download.</p>
            </li>
            <li className="step">
              <span className="step-number">2</span>
              <h3>Share the link on X</h3>
              <p>Post it with one tap. The link shows a board preview card in the timeline.</p>
            </li>
            <li className="step">
              <span className="step-number">3</span>
              <h3>Play live</h3>
              <p>The first person to click plays Black. Everyone after them spectates in real time.</p>
            </li>
          </ol>
        </section>

        <footer className="site-footer">
          <p>
            Runs on Cloudflare&apos;s free tier. Moves are checked on the server with chess.js. Piece artwork by
            Colin M.L. Burnett via react-chessboard.
          </p>
        </footer>
      </main>
    </div>
  );
}
