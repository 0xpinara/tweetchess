# Testing Timeline Games

```bash
npm test            # unit tests (Node) + Worker/Durable Object integration tests (workerd)
npm run test:e2e    # real browsers against the production build (first time: npx playwright install chromium)
npm run typecheck   # TypeScript for app, worker and tests
npm run lint
```

| Suite | Where | What it runs on |
| --- | --- | --- |
| Unit | `test/unit/` | Node. Chess match rules, poker engine, cards and hand evaluator, protocol validation, names, UI helpers |
| Integration | `test/worker/` | The real Workers runtime via `@cloudflare/vitest-plugin`: Worker routes, all three Durable Objects, SQLite, WebSockets, alarms, hibernation |
| End-to-end | `e2e/` | Chromium (desktop, emulated phones down to 320 px) against `vite preview` of the production build |

The matchmaking and poker browser tests run one at a time (`mode: 'serial'`). They share one global
queue and one pool of public tables, so parallel copies would correctly join each other's games.

## Requirements → automated tests

### Chess

| Requirement | Covered by |
| --- | --- |
| Two users connecting at the same time get distinct colours | `test/worker/room.test.ts` "two simultaneous visitors…", "many visitors race for seats…" (8 concurrent sockets) |
| A third visitor becomes a spectator | same file; `e2e/multiplayer.spec.ts` "desktop vs phone with a spectator" |
| A spectator cannot make a move | `test/unit/match.test.ts`, `room.test.ts` "rejects spectator moves…", e2e "spectators cannot move pieces" |
| White cannot move Black's pieces; nobody moves twice in a row | `match.test.ts`, `room.test.ts` |
| Illegal moves are rejected on the backend | `match.test.ts` "rejects illegal moves without changing state", `room.test.ts` |
| Promotion, castling, en passant | `match.test.ts` (all three, incl. under-promotion), `room.test.ts`, e2e promotion picker |
| Checkmate, stalemate and draws end the game | `match.test.ts` (checkmate, stalemate, threefold, insufficient material, 50-move rule), `room.test.ts`, e2e |
| Refreshing or reconnecting keeps the seat | `room.test.ts`, e2e "refreshing the page keeps your seat", "reconnects and resyncs after the network drops" |
| An outdated move cannot overwrite newer state | `match.test.ts` "rejects an outdated move", `room.test.ts` (`stale`) |
| State is restored after hibernation | `room.test.ts` "restores the authoritative state after the object hibernates" (really evicts the object) |
| Mobile can play desktop | e2e "desktop vs phone" (touch taps vs mouse clicks and drag) |

### Matchmaking and Play with a Friend

| Requirement | Covered by |
| --- | --- |
| Two searching players are paired into one game with both seats assigned | `test/worker/matchmaking.test.ts` "pairs two waiting guests…", e2e "two browsers find each other through matchmaking" |
| Many matches at once, each independent | `matchmaking.test.ts` "runs many matches at once…" |
| Never paired with yourself (two tabs) | `matchmaking.test.ts` "never pairs a guest with themselves…" |
| Cancel / closing the page leaves the queue | `matchmaking.test.ts` "removes guests who cancel…", e2e "searching can be cancelled" |
| A refresh returns you to your matched game | `matchmaking.test.ts` "sends a refreshed guest back to their game…" |
| No-shows and stalled players | `matchmaking.test.ts` "aborts the game when a matched player never shows up", "a player who stops moving loses on time" |
| Friend games are private unless listed | `test/worker/directory.test.ts` "keeps friend games private…", e2e "play with a friend creates a private, unlisted game by default" |

### Live directory

| Requirement | Covered by |
| --- | --- |
| Public games are listed without identities | `directory.test.ts` "lists matchmade games publicly without exposing identities" |
| Status, open-seat filters, paging, combined Chess + Poker tab | `directory.test.ts` "filters by status and open seats", "pages through results", "merges chess and poker for the All tab" |
| Finished and stale entries disappear | `directory.test.ts` "removes games when they end", "hides and then purges entries that stop updating" |
| Watching from Live never takes a seat | e2e "public games appear in the live directory and can be watched without changing seats", e2e poker "…others can watch from Live" |
| Directory updates are throttled (free-tier quota) but seat changes are immediate | `poker.test.ts` "refreshes a running table in the directory at most once a minute…" |

### Poker

| Requirement | Covered by |
| --- | --- |
| Fair shuffle | `test/unit/poker-cards.test.ts` "produces every ordering equally often", "uses rejection sampling…" |
| Correct hand ranking | `poker-cards.test.ts` (every category, wheel straight, kickers, best 5 of 7) |
| Blinds, dealer rotation, heads-up order | `test/unit/poker-engine.test.ts` "heads-up…", "three-handed…", "rotates the dealer and blinds…" |
| Legal actions only; out-of-turn, stale and replayed actions rejected | `poker-engine.test.ts` "rejects acting out of turn…", "validates checks, calls, bets and raises"; `test/worker/poker.test.ts` "rejects out-of-turn, stale and illegal actions, and spectators cannot act" |
| All-ins, side pots, split pots, odd chips, uncalled bets | `poker-engine.test.ts` (incomplete raise, side pots, dead money, split pot + odd chip, run-out, uncalled bet) |
| Chips are never created or lost | `poker-engine.test.ts` "never creates or destroys chips across hundreds of random hands"; `poker.test.ts` showdown test |
| **Hidden cards never leak** | `poker-engine.test.ts` public/private view tests; `poker.test.ts` "deals private hole cards that only their owner ever receives" (scans every raw frame); **e2e "six players fill a private table and a spectator never receives hidden cards"** (scans every WebSocket frame in seven real browsers) |
| Only showdown hands are revealed | `poker-engine.test.ts` "reveals only hands that reached showdown"; `poker.test.ts` showdown test |
| 30-second timer: auto check/fold, sit out after two misses | `poker-engine.test.ts` timeout tests; `poker.test.ts` "times out a player who does not act (via the table alarm)" |
| Reconnect and hibernation keep the hand and cards | `poker.test.ts` "keeps the hand and every hole card after the table hibernates mid-hand", "gives a reconnecting player their seat and cards back" |
| 2–6 players; extra visitors watch | `poker.test.ts` "seats six players; a seventh visitor watches", e2e six-player test |
| Find a table fills tables together; private tables are never listed | `poker.test.ts` "fills one public table before opening another…", "finds open public tables, lists them, and never lists private tables"; e2e "Find a table seats a phone and a desktop player together…" |
| Leaving and absent players | `poker-engine.test.ts` "leaving folds the hand…", "frees the seats of players disconnected too long…"; `poker.test.ts` "frees the seat of a player who stays away"; e2e leave mid-hand |
| Play money only: free top-ups, nothing to buy | `poker-engine.test.ts` "only lets busted players rebuy, between hands"; no payment code exists |

### Site

| Requirement | Covered by |
| --- | --- |
| Free hosted URL works without a domain | Manual (below); `npx wrangler deploy --dry-run` validates the config |
| X link preview without an interactive embed, with chess and poker images | `test/worker/pages.test.ts`, e2e "link-preview tags are in the HTML" (game and table links) |
| No sideways scrolling on phones | e2e "narrow embedded-browser widths…" (320–390 px, incl. poker pages), e2e poker table at 320 px |
| "Continue your game" returns you to your seat | e2e "Find a table…" (back to the poker table from the homepage) |

Also covered: origin checks, malformed or oversized messages, message flooding, outdated client
versions, heartbeat pings, unknown rooms and tables, room and table expiry, World Board rules
(`test/worker/world.test.ts`), seat etiquette, spectator caps, draw offers, rematches, the share menu,
and accessible names for pieces and seats.

## Manual checklist (after `npm run deploy`)

Use the real `https://tweetchess.<your-subdomain>.workers.dev` URL.

**Basics**
- [ ] `https://…/health` shows `{"ok":true,…}`.
- [ ] The homepage offers Chess and Poker; the Chess, Poker and Live links work.

**Chess**
- [ ] Desktop: *Play with a friend → Create invite link*. You are White and the status says "Waiting for an opponent".
- [ ] Phone (on mobile data, not your Wi-Fi): open the link. You are Black.
- [ ] Moves by tapping, clicking and dragging appear on the other screen within a second.
- [ ] A third browser opening the link is a spectator and cannot move.
- [ ] Refresh the phone mid-game: same colour, same position. Turn data off for ~10 s and back on: it reconnects.
- [ ] Checkmate (e.g. 1.f3 e5 2.g4 Qh4#), then **Rematch** on both: colours swap. Promotion, resign and draw offers work.
- [ ] *Find a match* on two devices: both land in the same game, and it appears on `/live`.
- [ ] `/world`: two devices get seats and a third spectates.

**Poker**
- [ ] *Poker → Create private table* on desktop; open the table link on a phone and a second browser and *Take a seat*. A hand starts.
- [ ] Each player sees only their own two cards. A spectator window sees only card backs.
- [ ] Fold, check, call, bet and raise (try the ½ Pot / Pot / All-in shortcuts) work from the phone.
- [ ] Let the timer run out: the player checks or folds automatically.
- [ ] *Find a table* on two devices: both land at the same public table, and it appears under *Poker* on `/live`.
- [ ] *Leave table* in the middle of a hand: you fold, and the seat opens after the hand.

**X and the dashboard**
- [ ] X composer: paste a chess link and a poker table link. Large image cards appear with the chess and the poker image (you don't need to post). See [X-INTEGRATION.md](X-INTEGRATION.md).
- [ ] Open a link from inside the X app (in-app browser): it loads and is playable.
- [ ] Cloudflare dashboard → Workers & Pages → tweetchess → Metrics shows requests; no paid plan was enabled.
