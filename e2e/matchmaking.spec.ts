import { devices, expect, test, type Page } from '@playwright/test';
import { clickMove, pieceAt, statusTitle, tapMove } from './helpers.ts';

// Matchmaking is one global queue: tests that search must not overlap, or
// they would (correctly) be matched with each other.
test.describe.configure({ mode: 'serial' });

async function setName(page: Page, name: string) {
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Playing as ${name}`)).toBeVisible();
}

test('two browsers find each other through matchmaking and play a live game', async ({ browser }) => {
  const desktop = await browser.newContext();
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const alice = await desktop.newPage();
  const bob = await phone.newPage();

  await alice.goto('/chess/matchmaking');
  await setName(alice, 'Alice');
  await expect(alice.getByText(/Matchmade games are public/)).toBeVisible();
  await alice.getByRole('button', { name: 'Find a match' }).click();
  await expect(alice.getByRole('heading', { name: 'Looking for an opponent…' })).toBeVisible();

  await bob.goto('/chess/matchmaking');
  await setName(bob, 'Bob');
  await bob.getByRole('button', { name: 'Find a match' }).click();

  await alice.waitForURL(/\/game\/[A-Za-z0-9]{10}$/);
  await bob.waitForURL(/\/game\/[A-Za-z0-9]{10}$/);
  expect(alice.url()).toBe(bob.url());
  await expect(statusTitle(alice)).toHaveText(/^(Your move|Opponent's move)$/);

  // Exactly one of them moves first, and each sees the other's name.
  await expect(alice.locator('.player-bar').first()).toContainText('Bob');
  await expect(bob.locator('.player-bar').first()).toContainText('Alice');
  const aliceIsWhite = (await statusTitle(alice).textContent()) === 'Your move';
  if (aliceIsWhite) {
    await expect(statusTitle(bob)).toHaveText("Opponent's move");
    await clickMove(alice, 'e2', 'e4');
    await expect(pieceAt(bob, 'e4', 'wP')).toBeVisible();
  } else {
    await expect(statusTitle(bob)).toHaveText('Your move');
    await tapMove(bob, 'e2', 'e4');
    await expect(pieceAt(alice, 'e4', 'wP')).toBeVisible();
  }
  await expect(alice.locator('.room-code')).toHaveText('Matchmade game');
  await Promise.all([desktop.close(), phone.close()]);
});

test('searching can be cancelled', async ({ page }) => {
  await page.goto('/chess/matchmaking');
  await page.getByRole('button', { name: 'Find a match' }).click();
  await expect(page.getByRole('heading', { name: 'Looking for an opponent…' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Find a match' })).toBeVisible();
});

test('public games appear in the live directory and can be watched without changing seats', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [carol, dave, viewer] = await Promise.all(contexts.map((context) => context.newPage()));

  for (const [page, name] of [
    [carol, 'Carol'],
    [dave, 'Dave'],
  ] as const) {
    await page.goto('/chess/matchmaking');
    await setName(page, name);
    await page.getByRole('button', { name: 'Find a match' }).click();
  }
  await carol.waitForURL(/\/game\//);
  await dave.waitForURL(/\/game\//);
  // Wait for the game state before deciding who is White.
  await expect(statusTitle(carol)).toHaveText(/^(Your move|Opponent's move)$/);
  await expect(statusTitle(dave)).toHaveText(/^(Your move|Opponent's move)$/);
  const carolIsWhite = (await statusTitle(carol).textContent()) === 'Your move';
  const [white, black] = carolIsWhite ? [carol, dave] : [dave, carol];

  // The directory lists the game (it refreshes on its own; Refresh speeds it up).
  await viewer.goto('/chess/live');
  const card = viewer.locator('.live-card', { hasText: 'Carol' }).filter({ hasText: 'Dave' });
  await expect(async () => {
    await viewer.getByRole('button', { name: 'Refresh' }).click();
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(card).toContainText('Matchmade');

  await card.getByRole('link', { name: 'Watch live' }).click();
  await viewer.waitForURL(/\/game\/[A-Za-z0-9]{10}\?watch=1$/);
  await expect(statusTitle(viewer)).toHaveText('White to move');
  await expect(viewer.locator('.status-detail')).toContainText("You're watching live");

  await clickMove(white, 'd2', 'd4');
  await expect(pieceAt(viewer, 'd4', 'wP')).toBeVisible();
  // Watching changed nobody's seat.
  await expect(statusTitle(black)).toHaveText('Your move');
  await expect(statusTitle(white)).toHaveText("Opponent's move");
  await Promise.all(contexts.map((context) => context.close()));
});
