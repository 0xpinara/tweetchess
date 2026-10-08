import type { ReactNode } from 'react';
import { usePathname } from '../lib/router.ts';
import { PieceIcon } from './Board.tsx';
import { Link } from './Link.tsx';

const NAV = [
  { to: '/chess', label: 'Chess', match: (path: string) => path === '/chess' || path === '/chess/matchmaking' },
  { to: '/poker', label: 'Poker', match: (path: string) => path === '/poker' },
  { to: '/live', label: 'Live', match: (path: string) => path === '/live' || path.endsWith('/live') },
];

/**
 * Site header. Game pages pass their own controls as children and hide the
 * navigation (`nav={false}`) to keep the board area uncluttered on phones.
 */
export function AppHeader({ children, nav = true }: { children?: ReactNode; nav?: boolean }) {
  const pathname = usePathname();
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="Timeline Games home">
        <span className="brand-mark" aria-hidden="true">
          <PieceIcon color="w" type="n" />
        </span>
        <span className="brand-name">Timeline Games</span>
      </Link>
      {nav && (
        <nav className="site-nav" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="site-nav-link" aria-current={item.match(pathname) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}
