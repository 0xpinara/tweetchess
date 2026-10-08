import type { ReactNode } from 'react';
import { PieceIcon } from './Board.tsx';
import { Link } from './Link.tsx';

export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="TweetChess home">
        <span className="brand-mark" aria-hidden="true">
          <PieceIcon color="w" type="n" />
        </span>
        <span className="brand-name">TweetChess</span>
      </Link>
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}
