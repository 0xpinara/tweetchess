import { useEffect, type ReactNode } from 'react';
import { AppHeader } from '../components/AppHeader.tsx';
import { PieceIcon } from '../components/Board.tsx';
import { Link } from '../components/Link.tsx';

export function NotFoundPage({
  title = 'Page not found',
  message = "There's nothing at this address.",
  children,
}: {
  title?: string;
  message?: string;
  children?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · TweetChess`;
  }, [title]);

  return (
    <div className="page">
      <AppHeader />
      <main className="center-page">
        <div className="message-card">
          <PieceIcon color="w" type="k" className="message-icon" />
          <h1>{title}</h1>
          <p>{message}</p>
          <div className="cta-row cta-row-center">
            {children}
            <Link to="/" className="btn btn-secondary">
              Go to the homepage
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
