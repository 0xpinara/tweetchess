import { expect, type Page } from '@playwright/test';

export const square = (page: Page, name: string) => page.locator(`[data-square="${name}"]`);

export const pieceAt = (page: Page, name: string, piece: string) =>
  page.locator(`[data-square="${name}"] [data-piece="${piece}"]`);

export const statusTitle = (page: Page) => page.locator('.status-title');

/** Click-to-move (mouse). */
export async function clickMove(page: Page, from: string, to: string) {
  await square(page, from).click();
  await square(page, to).click();
}

/** Tap-to-move (touch screens). */
export async function tapMove(page: Page, from: string, to: string) {
  await square(page, from).tap();
  await square(page, to).tap();
}

/** Drag-and-drop with the mouse, in small steps like a real hand. */
export async function dragMove(page: Page, from: string, to: string) {
  const source = await square(page, from).boundingBox();
  const target = await square(page, to).boundingBox();
  if (!source || !target) throw new Error('square not found');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 12, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Create a private game from the homepage and return its URL. */
export async function createGame(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a game' }).click();
  await page.waitForURL(/\/game\/[A-Za-z0-9]{10}$/);
  await expect(statusTitle(page)).toHaveText('Waiting for an opponent');
  return page.url();
}

export async function expectLive(page: Page) {
  await expect(page.locator('.connection')).toContainText('Live');
}
