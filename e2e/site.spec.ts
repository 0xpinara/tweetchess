import { expect, test } from '@playwright/test';
import { clickMove, pieceAt, statusTitle } from './helpers.ts';

test('pass-and-play: legal moves, promotion picker, undo and checkmate', async ({ page }) => {
  await page.goto('/local');
  await expect(statusTitle(page)).toHaveText('White to move');

  // Type moves through the accessible keyboard panel to reach a promotion.
  await page.getByText('Keyboard & screen-reader controls').click();
  const input = page.getByLabel('Type a move');
  for (const move of ['h4', 'g5', 'hxg5', 'h6', 'gxh6', 'Bg7', 'hxg7', 'a6']) {
    await input.fill(move);
    await input.press('Enter');
  }
  await expect(page.locator('.move-list')).toContainText('hxg7');

  // Promote by clicking: the picker appears and lets us under-promote to a knight.
  await clickMove(page, 'g7', 'h8');
  const picker = page.getByRole('dialog', { name: 'Promote pawn to…' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'White Knight' }).click();
  await expect(pieceAt(page, 'h8', 'wN')).toBeVisible();
  await expect(page.locator('.move-list')).toContainText('gxh8=N');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(pieceAt(page, 'g7', 'wP')).toBeVisible();

  // Fool's mate from a fresh game.
  await page.getByRole('button', { name: 'New game' }).click();
  await clickMove(page, 'f2', 'f3');
  await clickMove(page, 'e7', 'e5');
  await clickMove(page, 'g2', 'g4');
  await clickMove(page, 'd8', 'h4');
  await expect(statusTitle(page)).toHaveText('Checkmate — Black wins');
});

test('pieces have accessible names that follow the moves', async ({ page }) => {
  await page.goto('/local');
  await expect(page.getByRole('button', { name: 'White knight, g1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Black king, e8' })).toBeVisible();
  await clickMove(page, 'e2', 'e4');
  await expect(page.getByRole('button', { name: 'White pawn, e4' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'White pawn, e2' })).toHaveCount(0);
});

test('illegal clicks do nothing in pass-and-play', async ({ page }) => {
  await page.goto('/local');
  await clickMove(page, 'e2', 'e5');
  await expect(pieceAt(page, 'e2', 'wP')).toBeVisible();
  await clickMove(page, 'e7', 'e5'); // Black can't move first
  await expect(pieceAt(page, 'e7', 'bP')).toBeVisible();
});

test('link-preview tags are in the HTML the server sends (no JavaScript needed)', async ({ request, baseURL }) => {
  const created = await request.post('/api/rooms', { headers: { Origin: baseURL! } });
  expect(created.status()).toBe(201);
  const { roomId } = (await created.json()) as { roomId: string };

  const html = await (await request.get(`/game/${roomId}`)).text();
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
  expect(html).toContain(`<meta property="og:image" content="${baseURL}/og-image.png"`);
  expect(html).toContain(`<meta name="twitter:image" content="${baseURL}/og-image.png"`);
  expect(html).toContain(`<meta property="og:url" content="${baseURL}/game/${roomId}"`);
  expect(html).toMatch(/<meta name="twitter:title" content="[^"]+"/);
  expect(html).toMatch(/<meta property="og:description" content="[^"]+"/);

  const image = await request.get('/og-image.png');
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toBe('image/png');
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Allow: /');

  const health = await request.get('/health');
  expect(await health.json()).toMatchObject({ ok: true });
});

test('a game link that does not exist shows a friendly page', async ({ page }) => {
  await page.goto('/game/Zz9Zz9Zz9Z');
  await expect(page.getByRole('heading', { name: 'Game not found' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new game' })).toBeVisible();
});

test('narrow embedded-browser widths never scroll sideways', async ({ browser }) => {
  for (const width of [320, 360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 640 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    for (const route of ['/', '/local', '/chess', '/live', '/chess/matchmaking']) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
    }
    // The whole board fits on screen on a phone.
    await page.goto('/local');
    const board = await page.locator('.board-frame').boundingBox();
    expect(board!.width).toBeGreaterThanOrEqual(width - 40);
    expect(board!.x + board!.width).toBeLessThanOrEqual(width);
    await context.close();
  }
});

test('homepage offers chess and poker and links everywhere', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Play real-time games');
  await expect(page.getByRole('heading', { name: 'Chess', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Poker', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: 'Find a match' }).click();
  await expect(page).toHaveURL(/\/chess\/matchmaking$/);
  await page.goBack();
  await page.getByRole('link', { name: 'Pass-and-play' }).click();
  await expect(page).toHaveURL(/\/local$/);
  await page.goBack();
  await page.getByRole('link', { name: 'World Board' }).click();
  await expect(page).toHaveURL(/\/world$/);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Live' }).click();
  await expect(page).toHaveURL(/\/live$/);
});

test('play with a friend creates a private, unlisted game by default', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play with a friend' }).click();
  await expect(page.getByLabel('Let anyone watch from the Live page')).not.toBeChecked();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await page.waitForURL(/\/game\/[A-Za-z0-9]{10}$/);
  await expect(page.locator('.room-code')).toHaveText('Private game');
});
