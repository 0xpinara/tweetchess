import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pageMeta, renderPage } from '../../worker/pages.ts';

const INDEX_HTML = `<!doctype html><html><head>
<title>TweetChess</title>
<meta name="description" content="default" />
<meta property="og:title" content="default" />
<meta property="og:description" content="default" />
<meta property="og:image" content="/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="default" />
<meta name="twitter:description" content="default" />
<meta name="twitter:image" content="/og-image.png" />
</head><body><div id="root"></div></body></html>`;

/** The test runtime has no built assets, so stand in for the ASSETS binding. */
const testEnv = {
  ...env,
  ASSETS: {
    fetch: async () =>
      new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"abc"' } }),
  },
} as unknown as Env;

async function render(path: string) {
  const response = await renderPage(new Request(`https://tweetchess.example.workers.dev${path}`), testEnv);
  return { response, html: await response.text() };
}

describe('link-preview metadata', () => {
  it('puts absolute X/Open Graph URLs into the server-rendered HTML', async () => {
    const { response, html } = await render('/game/AbCdEfGh12');
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta property="og:image" content="https://tweetchess.example.workers.dev/og-image.png"');
    expect(html).toContain('<meta name="twitter:image" content="https://tweetchess.example.workers.dev/og-image.png"');
    expect(html).toContain('<meta property="og:url" content="https://tweetchess.example.workers.dev/game/AbCdEfGh12"');
    expect(html).toContain('<link rel="canonical" href="https://tweetchess.example.workers.dev/game/AbCdEfGh12"');
    expect(html).toContain('<title>Play me at chess on TweetChess');
  });

  it('uses page-specific titles', async () => {
    expect((await render('/world')).html).toContain('<title>The TweetChess World Board');
    expect((await render('/')).html).toContain('<title>TweetChess — live chess');
  });

  it('only rewrites known app routes', () => {
    expect(pageMeta('/game/AbCdEfGh12')).not.toBeNull();
    expect(pageMeta('/game/not-a-room')).toBeNull();
    expect(pageMeta('/random')).toBeNull();
  });

  it('drops the query string from og:url', async () => {
    const { html } = await render('/?utm_source=x');
    expect(html).toContain('<meta property="og:url" content="https://tweetchess.example.workers.dev/"');
  });
});
