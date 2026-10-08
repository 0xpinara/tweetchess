import { WORLD_ROOM_ID } from '../shared/protocol.ts';
import { usePathname } from './lib/router.ts';
import { HomePage } from './pages/HomePage.tsx';
import { LocalGamePage } from './pages/LocalGamePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OnlineGamePage } from './pages/OnlineGamePage.tsx';

export default function App() {
  const pathname = usePathname();

  if (pathname === '/') return <HomePage />;
  if (pathname === '/local') return <LocalGamePage />;
  if (pathname === '/world') return <OnlineGamePage key={WORLD_ROOM_ID} roomId={WORLD_ROOM_ID} />;

  const game = pathname.match(/^\/game\/([A-Za-z0-9]{10})\/?$/);
  if (game) return <OnlineGamePage key={game[1]} roomId={game[1]} />;

  return <NotFoundPage />;
}
