# Testing TweetChess

```bash
npm test            # unit tests (Node) + Worker/Durable Object integration tests (workerd)
npm run test:e2e    # real browsers against the production build (first time: npx playwright install chromium)
npm run typecheck   # TypeScript for app, worker and tests
npm run lint
```

| Suite | Where | What it runs on |
| --- | --- | --- |
| Unit | `test/unit/` | Node. Match rules (`worker/match.ts`), protocol validation, UI helpers |
| Integration | `test/worker/` | The real Workers runtime via `@cloudflare/vitest-plugin`: Worker routes, Durable Object, SQLite, WebSockets, alarms, hibernation |
| End-to-end | `e2e/` | Chromium (desktop + emulated Pixel 7 phone) against `vite preview` of the production build |

## Requirements → automated tests

| Requirement (from the project brief) | Covered by |
| --- | --- |
| Two users connecting at the same time get distinct colours | `test/worker/room.test.ts` "two simultaneous visitors…", "many visitors race for seats…" (8 concurrent sockets) |
| A third visitor becomes a spectator | same file; `e2e/multiplayer.spec.ts` "desktop vs phone with a spectator" |
| A spectator cannot make a move | `test/unit/match.test.ts`, `room.test.ts` "rejects spectator moves…", e2e "spectators cannot move pieces" |
| White cannot move Black's pieces | `match.test.ts` "does not let White move Black pieces", `room.test.ts` |
| A player cannot move twice in a row | `match.test.ts`, `room.test.ts` |
| Illegal moves are rejected on the backend | `match.test.ts` "rejects illegal moves without changing state", `room.test.ts` |
| Promotion, castling, en passant | `match.test.ts` (all three, incl. under-promotion), `room.test.ts` (promotion over the wire), e2e promotion picker |
| Checkmate and stalemate end the game | `match.test.ts` (checkmate, stalemate, threefold, insufficient material, 50-move rule), `room.test.ts`, e2e (online + local) |
| Refreshing does not reset the match | `room.test.ts` "keeps a seat for a returning player", e2e "refreshing the page keeps your seat" |
| Reconnecting keeps the original seat | `room.test.ts` "keeps the game after a full restart", e2e "reconnects and resyncs after the network drops" |
| An outdated move cannot overwrite newer state | `match.test.ts` "rejects an outdated move", `room.test.ts` (`stale`) |
| State is restored after hibernation | `room.test.ts` "restores the authoritative state after the object hibernates" — really evicts the object with sockets hibernated, proves a fresh instance reloads from SQLite |
| Mobile can play desktop | e2e "desktop vs phone" (touch taps vs mouse clicks and drag) — confirm on a real phone too |
| Free hosted URL works without a domain | Manual (below); `npx wrangler deploy --dry-run` validates the config |
| X link preview works without an interactive embed | `test/worker/pages.test.ts`, e2e "link-preview tags are in the HTML" — confirm in the X composer |

Also covered:
- origin checks, malformed or oversized messages, message flooding, outdated client versions, heartbeat pings
- unknown rooms and 30-day room expiry
- World Board rules (`test/worker/world.test.ts`): seat release after a disconnect, both players vanishing (board resets, no winner), the 3-minute move limit, seats opening after each game, no rematch
- seat etiquette: a player who left isn't re-seated by reconnecting or refreshing; reconnecting spectators don't grab free seats
- capacity: spectator cap (seated players always get back in), silent sockets closed under pressure
- draw offers, resign + rematch with colour swap, share menu / X intent link
- accessible piece names, no sideways scrolling at 320–390 px

## Manual checklist (after `npm run deploy`)

Use the real `https://tweetchess.<your-subdomain>.workers.dev` URL.

- [ ] `https://…/health` shows `{"ok":true,…}`.
- [ ] Desktop browser: **Create a game** → you are White, status says "Waiting for an opponent".
- [ ] Phone (on mobile data, not your Wi-Fi): open the game link → you are Black.
- [ ] Make moves from both devices by tapping/clicking and by dragging; each appears on the other screen within a second.
- [ ] A third browser (or private window) opening the link is a spectator, sees the current position immediately, and cannot move.
- [ ] Refresh the phone mid-game: same colour, same position.
- [ ] Turn the phone's Wi-Fi/data off for ~10 s, make a move on desktop, turn it back on: the phone reconnects ("Live") and shows the move.
- [ ] Play to checkmate (e.g. 1.f3 e5 2.g4 Qh4#): both see the result; **Rematch** on both → colours swap.
- [ ] Promote a pawn: the picker appears; under-promotion works.
- [ ] Resign and draw offer work.
- [ ] `/world`: two devices get seats, a third spectates. Close one player's tab and wait ~1 minute: the other player wins by abandonment and the seat opens. A countdown shows the 3-minute move limit. After a game ends, the seats open up after 30 seconds.
- [ ] X composer: paste a game link → large image card appears (don't need to post). See [X-INTEGRATION.md](X-INTEGRATION.md).
- [ ] Open the link from inside the X app (in-app browser): the game loads and is playable.
- [ ] Cloudflare dashboard → Workers & Pages → tweetchess → Metrics shows requests; no paid plan was enabled.
