import { devices, expect, test } from '@playwright/test';
import { clickMove, createGame, dragMove, expectLive, pieceAt, statusTitle, tapMove } from './helpers.ts';

test('desktop vs phone with a spectator: live moves, checkmate and a rematch', async ({ browser }) => {
  const whiteContext = await browser.newContext();
  const phoneContext = await browser.newContext({ ...devices['Pixel 7'] });
  const spectatorContext = await browser.newContext();
  const white = await whiteContext.newPage();
  const black = await phoneContext.newPage();
  const spectator = await spectatorContext.newPage();

  const url = await createGame(white);

  await black.goto(url);
  await expect(statusTitle(black)).toHaveText("Opponent's move");
  await expect(black.locator('.player-bar').last()).toContainText('Black');
  await expect(statusTitle(white)).toHaveText('Your move');

  await spectator.goto(url);
  await expect(statusTitle(spectator)).toHaveText('White to move');
  await expect(white.locator('.watchers')).toContainText('1 watching');

  // 1. f3 (click)   e5 (tap on the phone)
  await clickMove(white, 'f2', 'f3');
  await expect(pieceAt(black, 'f3', 'wP')).toBeVisible();
  await expect(pieceAt(spectator, 'f3', 'wP')).toBeVisible();
  await expect(statusTitle(black)).toHaveText('Your move');
  await tapMove(black, 'e7', 'e5');
  await expect(pieceAt(white, 'e5', 'bP')).toBeVisible();

  // 2. g4 (drag and drop)   Qh4# (tap)
  await dragMove(white, 'g2', 'g4');
  await expect(pieceAt(black, 'g4', 'wP')).toBeVisible();
  await tapMove(black, 'd8', 'h4');

  await expect(statusTitle(black)).toHaveText('You won! 🎉');
  await expect(statusTitle(white)).toHaveText('You lost');
  await expect(statusTitle(spectator)).toHaveText('Checkmate — Black wins');
  await expect(spectator.locator('.move-list')).toContainText('Qh4#');

  // Mutual rematch: colours swap and a fresh board appears.
  await white.getByRole('button', { name: 'Rematch', exact: true }).click();
  await black.getByRole('button', { name: 'Accept rematch' }).click();
  await expect(statusTitle(black)).toHaveText('Your move');
  await expect(black.locator('.status-detail')).toHaveText('You are playing White.');
  await expect(statusTitle(white)).toHaveText("Opponent's move");
  await expect(pieceAt(white, 'd8', 'bQ')).toBeVisible();
  await expect(spectator.locator('.room-code')).toHaveText('Game #2');

  await Promise.all([whiteContext.close(), phoneContext.close(), spectatorContext.close()]);
});

test('refreshing the page keeps your seat and the position', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const white = await a.newPage();
  const black = await b.newPage();
  const url = await createGame(white);
  await black.goto(url);
  await expect(statusTitle(white)).toHaveText('Your move');

  await clickMove(white, 'e2', 'e4');
  await expect(statusTitle(black)).toHaveText('Your move');

  await black.reload();
  await expect(statusTitle(black)).toHaveText('Your move');
  await expect(pieceAt(black, 'e4', 'wP')).toBeVisible();
  await expect(black.locator('.player-bar.is-turn')).toContainText('You');

  await white.reload();
  await expect(statusTitle(white)).toHaveText("Opponent's move");
  await expect(white.locator('.move-list')).toContainText('e4');
  await Promise.all([a.close(), b.close()]);
});

test('spectators cannot move pieces and can take a seat that opens up', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [white, black, viewer] = await Promise.all(contexts.map((context) => context.newPage()));
  const url = await createGame(white);
  await black.goto(url);
  await viewer.goto(url);
  await expect(statusTitle(viewer)).toHaveText('White to move');

  await clickMove(viewer, 'e2', 'e4');
  await dragMove(viewer, 'd2', 'd4');
  await viewer.waitForTimeout(500);
  await expect(pieceAt(viewer, 'e2', 'wP')).toBeVisible();
  await expect(pieceAt(white, 'e2', 'wP')).toBeVisible();
  await expect(pieceAt(white, 'd2', 'wP')).toBeVisible();

  // Black leaves before any move → the seat opens and the spectator can take it.
  await black.getByRole('button', { name: 'Leave seat' }).click();
  await black.getByRole('button', { name: 'Leave seat' }).click(); // confirm
  await viewer.getByRole('button', { name: 'Play as Black' }).click();
  await expect(statusTitle(viewer)).toHaveText("Opponent's move");
  await expect(statusTitle(white)).toHaveText('Your move');
  await expect(statusTitle(black)).toHaveText('White to move'); // now a spectator
  await Promise.all(contexts.map((context) => context.close()));
});

test('leaving your seat sticks after a refresh until you choose to sit again', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const white = await a.newPage();
  const black = await b.newPage();
  const url = await createGame(white);
  await black.goto(url);
  await expect(statusTitle(black)).toHaveText("Opponent's move");

  await black.getByRole('button', { name: 'Leave seat' }).click();
  await black.getByRole('button', { name: 'Leave seat' }).click(); // confirm
  await expect(statusTitle(white)).toHaveText('Waiting for an opponent');

  await black.reload();
  await expect(statusTitle(black)).toHaveText('Waiting for players');
  await expect(statusTitle(white)).toHaveText('Waiting for an opponent');
  await black.getByRole('button', { name: 'Play as Black' }).click();
  await expect(statusTitle(black)).toHaveText("Opponent's move");
  await expect(statusTitle(white)).toHaveText('Your move');
  await Promise.all([a.close(), b.close()]);
});

test('a draw offer can be accepted', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const white = await a.newPage();
  const black = await b.newPage();
  const url = await createGame(white);
  await black.goto(url);
  await expect(statusTitle(white)).toHaveText('Your move');

  await white.getByRole('button', { name: 'Offer draw' }).click();
  await expect(statusTitle(black)).toHaveText('Your opponent offers a draw');
  await black.getByRole('button', { name: 'Accept draw' }).click();
  await expect(statusTitle(white)).toHaveText('Draw agreed');
  await expect(statusTitle(black)).toHaveText('Draw agreed');
  await Promise.all([a.close(), b.close()]);
});

test('reconnects and resyncs after the network drops', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const white = await a.newPage();
  const black = await b.newPage();
  const url = await createGame(white);
  await black.goto(url);
  await expectLive(black);

  await b.setOffline(true);
  await expect(black.locator('.connection')).toContainText(/Offline|Reconnecting/);
  // White moves while Black is offline…
  await clickMove(white, 'd2', 'd4');
  await b.setOffline(false);
  // …and Black catches up after reconnecting.
  await expectLive(black);
  await expect(pieceAt(black, 'd4', 'wP')).toBeVisible();
  await expect(statusTitle(black)).toHaveText('Your move');
  await Promise.all([a.close(), b.close()]);
});

test('share menu offers a free X post intent and copies the link', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const url = await createGame(page);
  await page.locator('.app-header').getByRole('button', { name: 'Share' }).click();
  const post = page.getByRole('link', { name: 'Post on X' });
  const href = await post.getAttribute('href');
  expect(href).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
  expect(new URL(href!).searchParams.get('url')).toBe(url);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await context.close();
});

// The World Board is one shared room, so this test assumes nobody else is
// sitting there (true for a fresh `npm run test:e2e`; don't run it in parallel
// with itself). It frees both seats at the end so a rerun starts clean.
test('World Board: first two visitors play on one permanent URL', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const first = await a.newPage();
  const second = await b.newPage();
  await first.goto('/world');
  await expect(first.locator('.room-code')).toHaveText('World Board');
  await expect(statusTitle(first)).toHaveText('Waiting for an opponent');
  await second.goto('/world');
  await expect(statusTitle(first)).toHaveText('Your move');
  await expect(statusTitle(second)).toHaveText("Opponent's move");

  for (const page of [second, first]) {
    await page.getByRole('button', { name: 'Leave seat' }).click();
    await page.getByRole('button', { name: 'Leave seat' }).click(); // confirm
  }
  await expect(statusTitle(first)).toHaveText('Waiting for players');
  await Promise.all([a.close(), b.close()]);
});
