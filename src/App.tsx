import { WORLD_ROOM_ID } from '../shared/protocol.ts';
import { usePathname } from './lib/router.ts';
import { ChessHomePage } from './pages/ChessHomePage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LivePage } from './pages/LivePage.tsx';
import { LocalGamePage } from './pages/LocalGamePage.tsx';
import { MatchmakingPage } from './pages/MatchmakingPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OnlineGamePage } from './pages/OnlineGamePage.tsx';
import { PokerHomePage } from './pages/PokerHomePage.tsx';
import { PokerTablePage } from './pages/PokerTablePage.tsx';

export default function App() {
  const pathname = usePathname();

  if (pathname === '/') return <HomePage />;
  if (pathname === '/local') return <LocalGamePage />;
  if (pathname === '/chess') return <ChessHomePage />;
  if (pathname === '/chess/matchmaking') return <MatchmakingPage />;
  if (pathname === '/poker') return <PokerHomePage />;
  if (pathname === '/live') return <LivePage key="all" scope="all" />;
  if (pathname === '/chess/live') return <LivePage key="chess" scope="chess" />;
  if (pathname === '/poker/live') return <LivePage key="poker" scope="poker" />;
  if (pathname === '/world') return <OnlineGamePage key={WORLD_ROOM_ID} roomId={WORLD_ROOM_ID} />;

  const game = pathname.match(/^\/game\/([A-Za-z0-9]{10})\/?$/);
  if (game) return <OnlineGamePage key={game[1]} roomId={game[1]} />;

  const pokerTable = pathname.match(/^\/poker\/table\/([A-Za-z0-9]{10})\/?$/);
  if (pokerTable) return <PokerTablePage key={pokerTable[1]} tableId={pokerTable[1]} />;

  return <NotFoundPage />;
}
