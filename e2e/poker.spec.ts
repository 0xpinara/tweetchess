import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { statusTitle } from './helpers.ts';

// "Find a table" fills one shared pool of public tables, so these run one at a time.
test.describe.configure({ mode: 'serial' });

interface Player {
  name: string;
  page: Page;
  /** Every WebSocket frame this browser received from the poker table. */
  frames: string[];
}

async function openPlayer(browser: Browser, name: string, options: BrowserContextOptions = {}): Promise<Player> {
  const context = await browser.newContext(options);
  await context.addInitScript((value) => localStorage.setItem('tweetchess.displayName.v1', value), name);
  const page = await context.newPage();
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/poker/tables/')) return;
    socket.on('framereceived', ({ payload }) => frames.push(typeof payload === 'string' ? payload : payload.toString()));
  });
  return { name, page, frames };
}

const myCards = (page: Page) => page.locator('.seat.is-me .playing-card[data-card]');
const actionBar = (page: Page) => page.locator('.action-bar');

async function holeCards(page: Page): Promise<string[]> {
  await expect(myCards(page)).toHaveCount(2);
  return myCards(page).evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card') ?? ''));
}

/** The page whose action bar is showing (exactly one player acts at a time). */
async function playerToAct(players: Player[]): Promise<Player> {
  let found: Player | undefined;
  await expect(async () => {
    const showing: Player[] = [];
    for (const player of players) if (await actionBar(player.page).isVisible()) showing.push(player);
    expect(showing).toHaveLength(1);
    found = showing[0];
  }).toPass({ timeout: 10_000 });
  return found!;
}

/** A hidden card leaked if its code appears as a JSON string in a frame. */
function leakedCards(frames: string[], cards: string[]): string[] {
  return cards.filter((card) => frames.some((frame) => frame.includes(`"${card}"`)));
}

test('six players fill a private table and a spectator never receives hidden cards', async ({ browser }) => {
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];
  const players: Player[] = [];
  for (const name of names) players.push(await openPlayer(browser, name));
  const [host, ...guests] = players;

  await host.page.goto('/poker');
  await host.page.getByRole('button', { name: 'Create private table' }).click();
  await host.page.waitForURL(/\/poker\/table\/[A-Za-z0-9]{10}$/);
  await expect(statusTitle(host.page)).toHaveText('Waiting for players (1/6)');
  const tableUrl = host.page.url();

  // Friends open the invite link and watch until they take a seat.
  const spectator = await openPlayer(browser, 'Sam');
  for (const player of [...guests, spectator]) {
    await player.page.goto(tableUrl);
    await expect(player.page.getByRole('button', { name: 'Take a seat' })).toBeVisible();
  }
  // Four press "Take a seat"; the last picks the sixth seat on the table.
  const lastGuest = guests[guests.length - 1];
  await Promise.all([
    ...guests.slice(0, -1).map((player) => player.page.getByRole('button', { name: 'Take a seat' }).click()),
    lastGuest.page.getByRole('button', { name: 'Sit in seat 6' }).click(),
  ]);

  // Everyone is dealt in: each player sees exactly their own two cards face up.
  const hands = new Map<string, string[]>();
  for (const player of players) hands.set(player.name, await holeCards(player.page));
  for (const player of players) {
    await expect(player.page.locator('.seat .playing-card.face-down')).toHaveCount(10);
    await expect(player.page.locator('.seat .playing-card[data-card]')).toHaveCount(2);
  }
  await expect(lastGuest.page.locator('.seat.is-me')).toHaveAttribute('aria-label', /^Seat 6: Frank \(you\)/);
  const allHoleCards = [...hands.values()].flat();
  expect(new Set(allHoleCards).size).toBe(12);

  // The spectator sees twelve face-down cards and no actions.
  await expect(spectator.page.locator('.seat .playing-card.face-down')).toHaveCount(12);
  await expect(spectator.page.locator('.seat .playing-card[data-card]')).toHaveCount(0);
  await expect(spectator.page.getByText("You're watching — players' hole cards are hidden.")).toBeVisible();
  await expect(actionBar(spectator.page)).toHaveCount(0);
  await expect(host.page.locator('.table-info')).toContainText('1 watching');

  // Everyone folds to the big blind: the hand ends without a showdown.
  for (let folds = 0; folds < 5; folds++) {
    const actor = await playerToAct(players);
    await actor.page.getByRole('button', { name: 'Fold' }).click();
    await expect(actionBar(actor.page)).toHaveCount(0);
  }
  await expect(statusTitle(spectator.page)).toHaveText(/ wins \d+/);
  // The next hand is dealt a few seconds later; only look at this hand's frames.
  const received = new Map([...players, spectator].map((player) => [player.name, [...player.frames]]));
  await expect(async () => {
    const titles = await Promise.all(players.map((player) => statusTitle(player.page).textContent()));
    expect(titles.filter((title) => title?.startsWith('You win'))).toHaveLength(1);
  }).toPass({ timeout: 4_000 });

  // Over the whole hand, no browser received a hidden card it shouldn't have:
  // the spectator got none of the 12, and each player only their own two.
  expect(received.get('Sam')!.length).toBeGreaterThan(0);
  expect(leakedCards(received.get('Sam')!, allHoleCards)).toEqual([]);
  for (const player of players) {
    const own = hands.get(player.name)!;
    const others = allHoleCards.filter((card) => !own.includes(card));
    expect(leakedCards(received.get(player.name)!, others), `${player.name} received other players' cards`).toEqual([]);
    expect(leakedCards(received.get(player.name)!, own)).toHaveLength(2);
  }

  await Promise.all([...players, spectator].map((player) => player.page.context().close()));
});

test('Find a table seats a phone and a desktop player together; others can watch from Live', async ({ browser }) => {
  // The narrowest phone layout we support.
  const alice = await openPlayer(browser, 'Alice', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  const bob = await openPlayer(browser, 'Bob');

  await alice.page.goto('/poker');
  await alice.page.getByRole('button', { name: 'Find a table' }).tap();
  await alice.page.waitForURL(/\/poker\/table\/[A-Za-z0-9]{10}$/);
  await expect(alice.page.locator('.seat.is-me')).toBeVisible();
  const tableUrl = alice.page.url();
  const tableId = tableUrl.split('/').pop()!;
  const aliceSeat = (await alice.page.locator('.seat.is-me').getAttribute('aria-label'))!.match(/^Seat (\d)/)![1];

  await bob.page.goto('/poker');
  await bob.page.getByRole('button', { name: 'Find a table' }).click();
  await bob.page.waitForURL(/\/poker\/table\/[A-Za-z0-9]{10}$/);
  expect(bob.page.url()).toBe(tableUrl);

  // Heads-up: the dealer posts the small blind and acts first, the big blind
  // last. Call and check to the flop, tapping on the phone.
  const dealt = [...(await holeCards(alice.page)), ...(await holeCards(bob.page))];
  const press = (player: Player, name: string) => {
    const button = player.page.getByRole('button', { name, exact: true });
    return player === alice ? button.tap() : button.click();
  };
  const smallBlind = await playerToAct([alice, bob]);
  const bigBlind = smallBlind === alice ? bob : alice;
  await press(smallBlind, 'Call 5');
  await expect(actionBar(bigBlind.page)).toBeVisible();
  await expect(actionBar(smallBlind.page)).toHaveCount(0);
  await press(bigBlind, 'Check');
  await expect(alice.page.locator('.board-cards [data-card]')).toHaveCount(3);
  const flop = await alice.page.locator('.board-cards [data-card]').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-card')));

  // Nothing on the phone scrolls sideways, and the whole table fits.
  expect(await alice.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const table = await alice.page.locator('.poker-table').boundingBox();
  expect(table!.x).toBeGreaterThanOrEqual(0);
  expect(table!.x + table!.width).toBeLessThanOrEqual(320);

  // A visitor finds the table on Poker Live and watches the same flop, without hidden cards.
  const watcher = await openPlayer(browser, 'Wendy');
  const watchLink = watcher.page.locator(`.live-card a[href="/poker/table/${tableId}?watch=1"]`);
  await expect(async () => {
    await watcher.page.goto('/poker/live');
    await expect(watchLink).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await watchLink.click();
  await watcher.page.waitForURL(tableUrl);
  await expect(watcher.page.locator('.board-cards [data-card]')).toHaveCount(3);
  expect(await watcher.page.locator('.board-cards [data-card]').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-card')))).toEqual(flop);
  await expect(watcher.page.locator('.seat .playing-card[data-card]')).toHaveCount(0);
  await expect(watcher.page.locator('.seat .playing-card.face-down')).toHaveCount(4);

  // Alice leaves mid-hand: she folds, Bob wins, and her seat opens up.
  await alice.page.getByRole('button', { name: 'Leave table' }).tap();
  await alice.page.getByRole('button', { name: 'Fold and leave' }).tap();
  await expect(statusTitle(bob.page)).toHaveText(/^You win \d+!$/);
  await expect(alice.page.getByRole('button', { name: 'Take a seat' })).toBeVisible();
  await expect(watcher.page.getByRole('button', { name: `Sit in seat ${aliceSeat}`, exact: true })).toBeVisible();
  // Nobody showed their cards, so the watcher never received any of them.
  expect(watcher.frames.length).toBeGreaterThan(0);
  expect(leakedCards(watcher.frames, dealt)).toEqual([]);

  await Promise.all([alice, bob, watcher].map((player) => player.page.context().close()));
});
