/**
 * Serves the single-page app's index.html with link-preview metadata filled
 * in on the server. X (Twitter) and other crawlers do not run JavaScript, so
 * card tags must be in the initial HTML — and image URLs must be absolute,
 * which we can only know at request time (e.g. https://tweetchess.<you>.workers.dev).
 */

interface PageMeta {
  title: string;
  description: string;
  image: PreviewImage;
}

interface PreviewImage {
  path: string;
  alt: string;
}

/** Static 1200×600 images made by scripts/generate-assets.mjs. */
const IMAGES = {
  both: {
    path: '/og-image.png',
    alt: "Timeline Games: a chessboard and playing cards with the words 'Chess and poker with your timeline'",
  },
  chess: {
    path: '/og-chess.png',
    alt: "Timeline Games: a chessboard with the words 'Live chess you can share in a post'",
  },
  poker: {
    path: '/og-poker.png',
    alt: "Timeline Games: playing cards on a poker table with the words 'Texas Hold'em with your timeline'",
  },
} satisfies Record<string, PreviewImage>;

const DEFAULT_META: PageMeta = {
  title: 'Timeline Games — chess & poker with your timeline',
  description:
    "Real-time chess and Texas Hold'em in your browser. Find an opponent, invite a friend with a link, or watch games live. Free, no sign-up, play money only.",
  image: IMAGES.both,
};

const CHESS_META: PageMeta = {
  title: 'Play chess live · Timeline Games',
  description: 'Find an opponent in seconds, invite a friend with a link, or watch public chess games move by move. Free, no sign-up.',
  image: IMAGES.chess,
};

const POKER_META: PageMeta = {
  title: "Texas Hold'em with friends · Timeline Games",
  description:
    "Free play-money Texas Hold'em for 2–6 players. Join a table, invite friends with a link, or watch live. No real money, no sign-up.",
  image: IMAGES.poker,
};

/** Returns preview metadata for app routes, or null for anything else. */
export function pageMeta(pathname: string): PageMeta | null {
  if (pathname === '/') return DEFAULT_META;
  if (/^\/game\/[A-Za-z0-9]{10}$/.test(pathname)) {
    return {
      title: 'Play me at chess ♟️ · Timeline Games',
      description:
        'Tap to take the open seat and play live in your browser — or just watch the game in real time. No sign-up, no download.',
      image: IMAGES.chess,
    };
  }
  if (/^\/poker\/table\/[A-Za-z0-9]{10}$/.test(pathname)) {
    return {
      title: 'Join my poker table 🃏 · Timeline Games',
      description:
        "Free play-money Texas Hold'em in your browser. Take a seat and play live, or watch the table. No real money, no sign-up.",
      image: IMAGES.poker,
    };
  }
  if (pathname === '/world') {
    return {
      title: 'The World Board ♟️ · Timeline Games',
      description:
        'One public chessboard for everyone. Grab a seat when it opens and play live while the whole internet watches.',
      image: IMAGES.chess,
    };
  }
  if (pathname === '/local') {
    return {
      title: 'Pass-and-play chess · Timeline Games',
      description: 'Play chess with a friend on one device. Legal moves, check, checkmate and draws handled for you.',
      image: IMAGES.chess,
    };
  }
  if (pathname === '/chess' || pathname === '/chess/matchmaking') return CHESS_META;
  if (pathname === '/poker') return POKER_META;
  if (pathname === '/live' || pathname === '/chess/live' || pathname === '/poker/live') {
    return {
      title: 'Watch live chess & poker · Timeline Games',
      description: 'Browse public chess games and poker tables happening right now and watch them live.',
      image: IMAGES.both,
    };
  }
  return null;
}

export async function renderPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const asset = await env.ASSETS.fetch(request);
  const meta = pageMeta(url.pathname);
  if (!meta || request.method !== 'GET' || !asset.ok) return asset;
  if (!(asset.headers.get('Content-Type') ?? '').includes('text/html')) return asset;

  const canonical = `${url.origin}${url.pathname}`;
  const image = `${url.origin}${meta.image.path}`;
  const content = (value: string): HTMLRewriterElementContentHandlers => ({
    element(element) {
      element.setAttribute('content', value);
    },
  });

  const rewritten = new HTMLRewriter()
    .on('title', {
      element(element) {
        element.setInnerContent(meta.title);
      },
    })
    .on('head', {
      element(element) {
        const url = escapeAttribute(canonical);
        element.append(`<link rel="canonical" href="${url}" />\n<meta property="og:url" content="${url}" />\n`, {
          html: true,
        });
      },
    })
    .on('meta[name="description"]', content(meta.description))
    .on('meta[property="og:title"]', content(meta.title))
    .on('meta[property="og:description"]', content(meta.description))
    .on('meta[property="og:image"]', content(image))
    .on('meta[property="og:image:alt"]', content(meta.image.alt))
    .on('meta[name="twitter:title"]', content(meta.title))
    .on('meta[name="twitter:description"]', content(meta.description))
    .on('meta[name="twitter:image"]', content(image))
    .on('meta[name="twitter:image:alt"]', content(meta.image.alt))
    .transform(asset);

  const headers = new Headers(rewritten.headers);
  // The body changed, so the asset's validators no longer apply.
  headers.delete('ETag');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!import.meta.env.DEV) headers.set('Content-Security-Policy', contentSecurityPolicy(url));
  return new Response(rewritten.body, { status: rewritten.status, headers });
}

/**
 * Production-only CSP (Vite's dev server injects inline scripts). Inline
 * *styles* are needed by the chessboard component. The WebSocket origin is
 * listed explicitly because older browsers don't treat 'self' as covering wss:.
 */
function contentSecurityPolicy(url: URL): string {
  const socketOrigin = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${socketOrigin}`,
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
