# Timeline Games on X — what works, what doesn't, and why

_Research date: 2026-10-08. X's documentation changes often; re-check before relying on it._

## Summary

| Experience | Status in Timeline Games | Cost |
| --- | --- | --- |
| Link preview card (`summary_large_image`) with a chess or poker image, title, description | ✅ Implemented | $0, no X API |
| "Post on X" button that opens the composer pre-filled with text + game or table link (Web Intent) | ✅ Implemented | $0, no API key |
| Playable chess or poker **inside** the post (Player Card iframe) | ❌ Deliberately **not** implemented | — |

## 1. Link preview card (implemented)

Every page route (`/`, `/chess`, `/chess/matchmaking`, `/game/<id>`, `/world`, `/local`, `/poker`,
`/poker/table/<id>`, `/live`, `/chess/live`, `/poker/live`) is served by the Worker, which rewrites
`index.html` with [`HTMLRewriter`](../worker/pages.ts) so the card tags are in the **initial HTML**
(X's crawler, `Twitterbot`, does not run JavaScript). Image URLs are made absolute from the request
origin, e.g. `https://tweetchess.<your-subdomain>.workers.dev/og-chess.png`.

Each page gets its own title, description and image:

| Pages | Title (example) | Image |
| --- | --- | --- |
| Chess game invites `/game/<id>` | Play me at chess ♟️ · Timeline Games | `og-chess.png` |
| `/world`, `/local`, `/chess`, `/chess/matchmaking` | The World Board ♟️ · Timeline Games, … | `og-chess.png` |
| Poker table invites `/poker/table/<id>` | Join my poker table 🃏 · Timeline Games | `og-poker.png` |
| `/poker` | Texas Hold'em with friends · Timeline Games | `og-poker.png` |
| `/`, `/live`, `/chess/live`, `/poker/live` | Timeline Games — chess & poker with your timeline, … | `og-image.png` (both games) |

Tags served for a chess invite:

```html
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Play me at chess ♟️ · Timeline Games" />
<meta name="twitter:description" content="Tap to take the open seat and play live…" />
<meta name="twitter:image" content="https://…workers.dev/og-chess.png" />
<meta name="twitter:image:alt" content="Timeline Games: a chessboard with the words 'Live chess you can share in a post'" />
<meta property="og:title" … /> <meta property="og:description" … />
<meta property="og:image" … /> <meta property="og:image:alt" … /> <meta property="og:url" content="https://…/game/<id>" />
```

Image rules from X's (archived) card docs, all satisfied by the three images in `public/`:
2:1 aspect ratio (ours: 1200×600), min 300×157, max 4096×4096, under 5 MB (ours: 170–230 KB),
PNG/JPG/WEBP/GIF, no SVG. Each image has alt text.

Other requirements we meet:
- `robots.txt` allows crawlers — "If a page with card markup is blocked, no card will be shown."
- HTTPS (automatic on `workers.dev`).
- Absolute image URLs.

Regenerate the images after design changes with `npm run generate:assets`.

### How to test the card (you must do this yourself — it can't be automated without an X account)

1. Deploy (see the README) and copy a game or table URL, e.g.
   `https://tweetchess.<you>.workers.dev/game/AbCdEfGh12` or `…/poker/table/AbCdEfGh12`.
2. Open X, start a new post, paste the URL. A preview card should appear in the composer within a few
   seconds. **You do not need to publish the post** — X's own guidance is that pasting into the composer
   is the test now that the Card Validator's preview was removed (Aug 2022).
3. X caches cards for about **7 days**. If you change the image or text, test with a fresh URL
   (any new game or table link works, or append `?v=2`).

If no card appears: open the URL in a private window and *View Source* — you should see the
`twitter:*` tags with absolute `https://` URLs; check `https://<your-url>/robots.txt` returns `Allow: /`.

## 2. "Post on X" button (implemented)

The share menu (on chess games and poker tables) opens `https://x.com/intent/tweet?text=…&url=…` in a
new tab. This is X's documented
**Web Intent**: "Web Intents do not require setting up a X application, storing app credentials, or
prompting a viewer for app permissions." No paid API, no keys. (`twitter.com/intent/tweet` redirects
to the same place.) Intents can't load inside iframes, which is why it opens a new tab.

## 3. Playing inside the post — investigated, not implemented

**Is it technically possible?** Yes. "Tweetcraft" (Minecraft in a post, posted by @jaivinwylde on
2026-10-06) uses an ordinary **Player Card**: the share page serves `twitter:card=player` with a
`twitter:player` iframe URL, and the game page allows framing by x.com via
`Content-Security-Policy: frame-ancestors … https://x.com https://*.x.com …`. X renders it as a player
card today.

**Is it permitted?** Not defensibly:

- X's current docs no longer have Player Card pages at all (the old URLs now redirect; still live on
  2026-02-04, gone by 2026-02-27).
- The only live rule is in the [Developer Policy](https://docs.x.com/developer-terms/policy):
  _"You may not exceed or circumvent X's limitations placed on any Cards, including the Card's intended use."_
- The last published definition of that intended use
  ([archived Feb 2026](https://web.archive.org/web/20260204163853/https://developer.x.com/en/docs/x-for-websites/cards/overview/player-card))
  said: _"Player Cards are reserved for linear audio and video consumption only"_ and _"Do not build
  end-to-end interactive experiences … such as the following: purchasing, **gaming**, polling,
  messaging, and data entry."_
- Twitter has enforced this before: in 2015 it switched off in-tweet MS-DOS games
  ([TechCrunch](https://techcrunch.com/2015/05/04/twitter-turns-off-ms-dos-game-embeds-in-tweets/)).
- There is no approval process and no official "games in posts" / mini-apps platform for third parties
  (nothing in X's developer changelog through 2026-10-02).

Following the project brief ("do not bypass restrictions or misrepresent an interactive game as
permitted video content"), Timeline Games ships the standard link card and does **not** declare
`twitter:card=player`, for chess or poker. The production CSP also sets `frame-ancestors 'self'`, so
the games can't be framed by other sites.

**If X publishes a supported way later**, the standalone app already works in narrow embedded browsers
(tested down to 320 px wide), so an embed would mainly need: a `/embed/<id>` route, the player meta
tags, and a `frame-ancestors` CSP that allows X — added as an optional, removable layer.

## Sources

- X Developer Policy — https://docs.x.com/developer-terms/policy
- Archived Player Card docs (Feb 2026) — https://web.archive.org/web/20260204163853/https://developer.x.com/en/docs/x-for-websites/cards/overview/player-card
- Archived summary_large_image docs — https://web.archive.org/web/20260204074639/https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image
- Archived "Getting started with cards" (crawler, robots.txt, 7-day cache) — https://web.archive.org/web/20260131185530/https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started
- Card Validator preview removal — https://devcommunity.x.com/t/card-validator-preview-removal/175006
- Web Intents — https://docs.x.com/x-for-websites/web-intents/overview and https://docs.x.com/x-for-websites/post-button/guides/web-intent
- Tweetcraft announcement — https://x.com/jaivinwylde/status/2107558218629288035
