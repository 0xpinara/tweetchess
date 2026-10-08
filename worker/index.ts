/**
 * TweetChess Worker entry point.
 *
 *   GET  /health                → JSON health check
 *   POST /api/rooms             → create a private room
 *   GET  /api/rooms/:id/ws      → WebSocket into the room's Durable Object
 *   GET  /, /game/:id, /world…  → the React app, with link-preview tags
 *
 * Static files (JS, CSS, images) are served by Cloudflare's asset handler
 * without invoking this Worker at all.
 */
import { CloseCode, ROOM_ID_LENGTH, WORLD_ROOM_ID, isValidRoomId } from '../shared/protocol.ts';
import { ChessRoom, rejectSocket } from './chess-room.ts';
import { renderPage } from './pages.ts';

export { ChessRoom };

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
  try {
    // A collision is astronomically unlikely, but retry rather than reuse a room.
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = randomRoomId();
      if (await env.CHESS_ROOM.getByName(roomId).initialize(roomId)) {
        return json({ roomId, path: `/game/${roomId}` }, 201);
      }
    }
    return json({ error: 'try_again' }, 503);
  } catch (error) {
    console.error('createRoom failed', error);
    return json(
      { error: 'unavailable', message: 'TweetChess could not create a game right now. Please try again shortly.' },
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
      'TweetChess is temporarily unavailable (it may have reached its free daily limit). Please try again later.',
    );
  }
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

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased random base62 ID from the Web Crypto CSPRNG. */
export function randomRoomId(): string {
  let id = '';
  while (id.length < ROOM_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 = 4 × 62: discard bytes ≥ 248 to avoid modulo bias.
      if (byte < 248 && id.length < ROOM_ID_LENGTH) id += ALPHABET[byte % 62];
    }
  }
  return id === WORLD_ROOM_ID ? randomRoomId() : id;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}
