# TweetChess ♟️

Free, real-time multiplayer chess you can share in a post on X. Create a game, share one link: the
first person who opens it plays you, everyone after that watches live. No accounts, no downloads, no
bill: it runs entirely on Cloudflare's free tier.

![TweetChess link preview](public/og-image.png)

**Features**
- Live games between two browsers, any number of spectators
- Click-to-move, tap-to-move and drag-and-drop
- Legal-move dots, last-move and check highlights, promotion picker, captured pieces, move list
- Checkmate, stalemate and every draw rule, all enforced on the server with chess.js
- Resign, draw offers and mutual rematch with colours swapped
- Refresh-proof seats, automatic reconnect, spectator count, share-to-X button
- A permanent public **World Board** (`/world`) with move timers so no one can block it, plus offline **pass-and-play** (`/local`)
- Dark, mobile-first UI that works down to 320 px wide (X's in-app browser included)
- Keyboard and screen-reader controls: type moves, hear moves announced

## What it costs: $0

| Need | What we use | Price |
| --- | --- | --- |
| Hosting + domain | Cloudflare Workers + free `*.workers.dev` URL | Free plan |
| Multiplayer server + database | Durable Objects with SQLite storage | Free plan |
| Chess rules | [chess.js](https://github.com/jhlywa/chess.js) | Open source |
| Chessboard | [react-chessboard](https://github.com/Clariity/react-chessboard) | Open source |
| X integration | Link-preview meta tags + Web Intent link | No X API needed |

No credit card is needed. See [Free-tier limits](#free-tier-limits) for what happens at high traffic.

## Quick start (on your computer)

You need [Node.js](https://nodejs.org) 20 or newer (`node -v` to check).

```bash
cd tweetchess
npm install        # download the libraries (takes a minute)
npm run dev        # start the local server
```

Open <http://localhost:5173>, click **Create a game**, then open the game link in a **private window**
or a second browser. That second window plays Black. A third window spectates.

`npm run dev` runs the real Worker and Durable Object code locally (via Cloudflare's Vite plugin), so
multiplayer works offline. Press `Ctrl+C` to stop it.

## Deploy to your free workers.dev URL

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>. No card is required.
2. **Log in from the terminal.** This opens your browser; click *Allow*:
   ```bash
   npx wrangler login
   ```
3. **Deploy.** This builds the app and uploads it:
   ```bash
   npm run deploy
   ```
   On your first deploy, Wrangler may ask you to pick a free `workers.dev` subdomain (for example
   `yourname`). You can also set it in the dashboard under *Workers & Pages*.
4. Wrangler prints your URL, e.g. `https://tweetchess.yourname.workers.dev`. Open it and check
   `/health`, then follow the [manual test checklist](docs/TESTING.md#manual-checklist-after-npm-run-deploy).
5. Share a game link on X: paste it into the post composer and a preview card appears. See
   [docs/X-INTEGRATION.md](docs/X-INTEGRATION.md).

To update the site later, run `npm run deploy` again. Game links keep working because rooms live in
Durable Objects, not in the deployed code. Players connected at that moment reconnect automatically.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local development server with hot reload (<http://localhost:5173>) |
| `npm run build` | Type-check and build the app and Worker into `dist/` |
| `npm run preview` | Build, then run the production build locally (<http://localhost:4173>) |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm test` | Unit tests + Worker/Durable Object integration tests |
| `npm run test:e2e` | Browser tests (run `npx playwright install chromium` once first) |
| `npm run typecheck` | TypeScript checks for app, Worker and tests |
| `npm run lint` | Lint with oxlint |
| `npm run generate:assets` | Re-create `public/og-image.png` and `public/favicon.svg` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

## Project structure

```
tweetchess/
├── wrangler.jsonc          Cloudflare config: Worker, static assets, Durable Object (SQLite)
├── vite.config.ts          Vite + React + Cloudflare plugin
├── index.html              App shell incl. Open Graph / X card meta tags
├── public/                 og-image.png (1200×600 link preview), favicon.svg, robots.txt
├── shared/
│   └── protocol.ts         Message types + strict validation shared by browser and server
├── worker/
│   ├── index.ts            Worker entry: /health, POST /api/rooms, /api/rooms/:id/ws, page routes
│   ├── chess-room.ts       ChessRoom Durable Object: SQLite persistence, WebSockets (hibernation), alarms
│   ├── match.ts            Pure chess-match rules (seats, moves, endings, rematch). Fully unit-tested
│   └── pages.ts            Injects absolute link-preview tags into index.html (HTMLRewriter)
├── src/                    React app
│   ├── App.tsx             Routes: /, /game/:id, /world, /local
│   ├── pages/              HomePage, OnlineGamePage, LocalGamePage, NotFoundPage
│   ├── components/         Board (react-chessboard wrapper), PlayerBar, MoveList, ShareButton, …
│   ├── lib/                useRoom (WebSocket + reconnect), identity (guest token), chess-ui, share, api
│   └── styles.css          Dark theme
├── test/unit/              Node unit tests (Vitest)
├── test/worker/            Integration tests inside the Workers runtime (@cloudflare/vitest-plugin)
├── e2e/                    Playwright browser tests
├── scripts/                generate-assets.mjs (preview image + favicon)
└── docs/                   X-INTEGRATION.md, TESTING.md
```

## How it works

```
Browser ──HTTPS──▶ Worker ──▶ static files (free, unlimited)
   │                 │
   └──WebSocket──────┴──▶ ChessRoom Durable Object (one per game, named by room ID)
                              └── SQLite: room row + moves table
```

- **One Durable Object per room.** `POST /api/rooms` creates a random 10-character room ID (about
  8×10¹⁷ possibilities) and initialises that room's object. The object holds the official game state.
- **Guest identity without accounts.** Each browser makes a random 256-bit token and keeps it in
  `localStorage`. It is sent only inside the WebSocket, never in a URL, and the server stores only its
  SHA-256 hash. The first two distinct tokens get White and Black. Seat assignment runs in one
  synchronous step inside the object, so two people can never get the same seat.
- **Every move is validated on the server.** A move message looks like
  `{"type":"move","from":"e2","to":"e4","expectedPly":0}`. The server checks it, in order:
  1. the player's seat
  2. that the game is active
  3. the sequence number (`expectedPly`), which rejects outdated or duplicated moves
  4. whose turn it is
  5. legality with chess.js

  Only then does it write to SQLite and broadcast the new state. Rejected moves change nothing.
- **Hibernation.** WebSockets use Cloudflare's Hibernation API: an idle room is evicted from memory
  while its sockets stay open, and it wakes and reloads from SQLite on the next message. Heartbeat
  pings are answered by the runtime without waking the room.
- **Reconnects.** The client reconnects with exponential backoff (0.5 s up to 30 s, with jitter),
  immediately when the network or tab comes back, and always gets the full state again.
- **Room lifecycle.**
  - Seats are kept for disconnected players.
  - A player can **Leave seat**. Leaving mid-game forfeits it. Your browser remembers that you left, so a refresh doesn't put you back in a free seat. Reconnects never grab a free seat either; spectators click **Play as …**.
  - Private rooms are deleted after **30 days** without activity.
  - On the World Board, nobody can block the public game:
    - a player disconnected for more than **60 seconds** loses the game and their seat;
    - each move has a **3-minute** limit;
    - after each game, the result stays up for **30 seconds**, then the seats open up for the next players (no rematches on the World Board).
- **Protection.**
  - Strict message validation.
  - 1 KB message size limit and per-connection rate limit.
  - Same-origin check for WebSockets and room creation.
  - Up to 500 spectators per room. Seated players always get back in, and sockets that never identify themselves are closed when a room is busy.
  - Best-effort per-IP limit on room creation.
  - Content-Security-Policy.

## Configuration

Nothing is required; there are no secrets or environment variables to set.

- `wrangler.jsonc`:
  - `run_worker_first` sends only page routes and `/api/*` to the Worker; everything else is served as free static files.
  - `exports` declares the `ChessRoom` Durable Object with `"storage": "sqlite"`, the backend the free plan supports.
  - `vars.ALLOWED_ORIGINS` (optional, comma separated) allows other sites to open WebSockets, for example a custom domain in front of the Worker.
- Tunables in `worker/chess-room.ts`:
  - `ROOM_TTL_MS` (30 days)
  - World Board timers: `WORLD_SEAT_GRACE_MS` (60 s), `WORLD_TURN_LIMIT_MS` (3 min), `WORLD_POSTGAME_MS` (30 s)
  - `LIMITS`: 500 spectators, 1,000 sockets, 10 s to say hello
  - the per-connection message rate limit

## Free-tier limits

Workers Free plan (daily limits reset at 00:00 UTC):

| Resource | Free allowance | TweetChess usage |
| --- | --- | --- |
| Worker requests | 100,000 / day | 1 per page load, room creation or WebSocket connect. **Static files don't count** |
| Worker CPU | 10 ms / request | Validating a move with chess.js takes ~0.15 ms |
| Durable Object requests | 100,000 / day | 1 per connection + 1 per message sent by a player (moves, hello, …) |
| Durable Object duration | 13,000 GB-s / day | Small, because idle rooms hibernate |
| SQLite rows written | 100,000 / day | ~2 per move, a few per game |
| SQLite storage | 5 GB total | A few KB per room; idle rooms are deleted after 30 days |

As a rough guide, a 40-move game uses about 170 row writes and 100 Durable Object requests. That's a
few hundred full games per day. A spectator costs about 2 Worker requests and 2 Durable Object requests.

**If a limit is hit**:
- On the Free plan, requests fail until the daily reset. You are **not** charged or auto-upgraded; paid usage requires subscribing to the Workers Paid plan yourself.
- TweetChess shows "temporarily unavailable" and retries slowly.
- When the Worker request quota runs out, Cloudflare shows error 1027.

**Monitoring your usage** (Cloudflare dashboard):
- *Workers & Pages → tweetchess → Metrics* for requests and errors.
- *Workers & Pages → Durable Objects* for account-level Durable Object usage. Pick the `ChessRoom` namespace for its metrics.
- *Manage account → Billing* to confirm you are still on the Free plan.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `You are not authenticated` on deploy | Run `npx wrangler login` (or `npx wrangler logout` then login to switch accounts) |
| Deploy asks for a workers.dev subdomain | Pick any free name. It becomes `https://tweetchess.<name>.workers.dev` |
| Deploy error mentioning `migrations` and `exports` | Keep only the `exports` block in `wrangler.jsonc`. A Worker can use one format, not both |
| Deploy error `free_tier_requires_sqlite` | Keep `"storage": "sqlite"` for `ChessRoom` |
| Error 1027 / "temporarily unavailable" | A free daily limit was reached. It resets at 00:00 UTC |
| Stuck on "Reconnecting…" | Open `/health`. If it works, check for VPNs/extensions blocking WebSockets. If you use another domain, add it to `ALLOWED_ORIGINS` |
| "Please reload" message | The site was updated (protocol changed); reload the page |
| No preview card on X | View the page source: the `twitter:*` tags must have absolute `https://` URLs. Check `/robots.txt`. X caches cards ~7 days, so test with a new game link |
| Port 5173 already in use | `npm run dev -- --port 5174` |
| Reset local test data | Stop the dev server and delete the `.wrangler/state` folder |
| `npm install` warns about "install scripts" | Harmless with npm 11+. Cloudflare's runtime ships as a platform package |
| Playwright says a browser is missing | `npx playwright install chromium` |
| Types out of date after editing `wrangler.jsonc` | `npm run cf-typegen` |

## Testing

128 automated tests (73 unit, 40 Worker/Durable Object integration, 15 browser end-to-end) cover the
rules, server, persistence/hibernation and real browser play. Run `npm test` and `npm run test:e2e`. [docs/TESTING.md](docs/TESTING.md) maps each requirement to its
tests and has the manual checklist for the deployed site.

## Credits

- [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause) for chess rules on server and client.
- [react-chessboard](https://github.com/Clariity/react-chessboard) (MIT) for the board. Its piece
  artwork is the classic set by Colin M.L. Burnett (originally on Wikimedia Commons under free licences).
- Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) and
  [Durable Objects](https://developers.cloudflare.com/durable-objects/).
