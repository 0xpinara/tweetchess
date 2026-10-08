/**
 * Timeline Games (TweetChess) Worker entry point.
 *
 *   GET  /health                     → JSON health check
 *   POST /api/rooms                  → create a friend chess game ({ listed?: boolean })
 *   GET  /api/rooms/:id/ws           → WebSocket into the chess room's Durable Object
 *   GET  /api/matchmaking/chess/ws   → WebSocket into the chess matchmaking lobby
 *   GET  /api/live                   → public live-games directory (paginated)
 *   GET  /, /game/:id, /world…       → the React app, with link-preview tags
 *
 * Static files (JS, CSS, images) are served by Cloudflare's asset handler
 * without invoking this Worker at all.
 */
import { LIVE_PAGE_SIZE, isLiveFilter, type LiveGame, type LivePage } from '../shared/lobby.ts';
import { CloseCode, isValidRoomId } from '../shared/protocol.ts';
import { ChessRoom, rejectSocket } from './chess-room.ts';
import { randomRoomId } from './crypto.ts';
import { GameLobby } from './lobby.ts';
import { renderPage } from './pages.ts';

export { ChessRoom, GameLobby };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/health') {
      return json({ ok: true, service: 'tweetchess', time: new Date().toISOString() });
    }

    if (pathname === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      return createRoom(request, env, url);
    }

    const socketRoute = pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (socketRoute) return connect(request, env, url, socketRoute[1]);

    if (pathname === '/api/matchmaking/chess/ws') return connectLobby(request, env, url, 'chess');

    if (pathname === '/api/live') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      return liveGames(url, env);
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);

    return renderPage(request, env);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isSameOrigin(request, url, env)) return json({ error: 'forbidden_origin' }, 403);
  if (!allowRoomCreation(request)) {
    return json(
      { error: 'rate_limited', message: 'You are creating games very quickly. Please wait a minute.' },
      429,
      { 'Retry-After': '60' },
    );
  }
  // Optional JSON body: { "listed": true } shows the game in the public directory.
  const body = (await request.json().catch(() => null)) as { listed?: unknown } | null;
  const listed = body?.listed === true;
  try {
    // A collision is astronomically unlikely, but retry rather than reuse a room.
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = randomRoomId();
      if (await env.CHESS_ROOM.getByName(roomId).initialize(roomId, { listed })) {
        return json({ roomId, path: `/game/${roomId}` }, 201);
      }
    }
    return json({ error: 'try_again' }, 503);
  } catch (error) {
    console.error('createRoom failed', error);
    return json(
      { error: 'unavailable', message: 'Timeline Games could not create a game right now. Please try again shortly.' },
      503,
    );
  }
}

async function connect(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'expected_websocket' }, 426);
  }
  if (!isValidRoomId(roomId)) return json({ error: 'invalid_room' }, 404);
  if (!isSameOrigin(request, url, env)) return json({ error: 'forbidden_origin' }, 403);
  try {
    return await env.CHESS_ROOM.getByName(roomId).fetch(request);
  } catch (error) {
    // Usually a temporary outage or an exhausted free-tier daily quota.
    console.error('connect failed', error);
    return rejectSocket(
      CloseCode.Unavailable,
      'unavailable',
      'Timeline Games is temporarily unavailable (it may have reached its free daily limit). Please try again later.',
    );
  }
}

async function connectLobby(request: Request, env: Env, url: URL, lobby: 'chess'): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'expected_websocket' }, 426);
  }
  if (!isSameOrigin(request, url, env)) return json({ error: 'forbidden_origin' }, 403);
  try {
    return await env.LOBBY.getByName(lobby).fetch(request);
  } catch (error) {
    console.error('lobby connect failed', error);
    return rejectSocket(
      CloseCode.Unavailable,
      'unavailable',
      'Matchmaking is temporarily unavailable (it may have reached its free daily limit). Please try again later.',
    );
  }
}

/**
 * Short in-memory cache for directory pages. Many visitors refreshing the
 * lobby at once then cost one Durable Object call per few seconds (per
 * Worker instance) instead of one each.
 */
export const LIVE_CACHE = { ttlMs: 5_000 };
const liveCache = new Map<string, { at: number; body: LivePage }>();

async function liveGames(url: URL, env: Env): Promise<Response> {
  const game = url.searchParams.get('game') ?? 'all';
  const filterParam = url.searchParams.get('filter') ?? 'all';
  const cursor = url.searchParams.get('cursor') ?? '';
  if (game !== 'all' && game !== 'chess' && game !== 'poker') return json({ error: 'invalid_game' }, 400);
  if (!isLiveFilter(filterParam)) return json({ error: 'invalid_filter' }, 400);
  // Single game: "<offset>". All games: "<chessOffset>,<pokerOffset>" where -1 means "no more".
  const cursorPattern = game === 'all' ? /^-?\d{1,4},-?\d{1,4}$/ : /^\d{1,4}$/;
  if (cursor && !cursorPattern.test(cursor)) return json({ error: 'invalid_cursor' }, 400);

  const key = `${game}|${filterParam}|${cursor}`;
  const cached = liveCache.get(key);
  if (cached && Date.now() - cached.at < LIVE_CACHE.ttlMs) return json(cached.body, 200, { 'Cache-Control': 'max-age=5' });

  let body: LivePage;
  try {
    if (game === 'all') {
      // One page from each game type, merged; the cursor carries both offsets ("-1" = done).
      const [chessOffset, pokerOffset] = (cursor || '0,0').split(',').map((part) => Number(part));
      const half = Math.ceil(LIVE_PAGE_SIZE / 2);
      const [chess, poker] = await Promise.all([
        chessOffset >= 0 ? env.LOBBY.getByName('chess').list({ filter: filterParam, offset: chessOffset, limit: half }) : null,
        pokerOffset >= 0 ? env.LOBBY.getByName('poker').list({ filter: filterParam, offset: pokerOffset, limit: half }) : null,
      ]);
      const games: LiveGame[] = [...(chess?.games ?? []), ...(poker?.games ?? [])].sort(
        (a, b) => b.spectators - a.spectators || b.updatedAt - a.updatedAt,
      );
      const nextChess = chess?.nextCursor ?? null;
      const nextPoker = poker?.nextCursor ?? null;
      body = {
        games,
        nextCursor: nextChess !== null || nextPoker !== null ? `${nextChess ?? -1},${nextPoker ?? -1}` : null,
      };
    } else {
      body = await env.LOBBY.getByName(game).list({ filter: filterParam, offset: cursor ? Number(cursor) : 0 });
    }
  } catch (error) {
    console.error('live directory failed', error);
    return json({ error: 'unavailable', message: 'The live games list is temporarily unavailable.' }, 503);
  }
  if (liveCache.size > 200) liveCache.clear();
  liveCache.set(key, { at: Date.now(), body });
  return json(body, 200, { 'Cache-Control': 'max-age=5' });
}

/**
 * Browsers always send Origin on WebSocket and fetch POST requests. Requests
 * from other sites are refused; extra origins can be allowed with the
 * ALLOWED_ORIGINS variable (comma separated). Non-browser clients send no
 * Origin and can't be stopped by this check anyway.
 */
function isSameOrigin(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === url.origin) return true;
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

/**
 * Best-effort limit on room creation per IP. It lives in this Worker
 * instance's memory, so it is approximate (instances don't share it) but
 * free, and it stops a single client from burning the daily quota by accident.
 */
const ROOMS_PER_MINUTE = 30;
const creationLog = new Map<string, { count: number; windowStart: number }>();

function allowRoomCreation(request: Request): boolean {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();
  const entry = creationLog.get(ip);
  if (!entry || now - entry.windowStart >= 60_000) {
    if (creationLog.size > 5_000) creationLog.clear();
    creationLog.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= ROOMS_PER_MINUTE;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}
