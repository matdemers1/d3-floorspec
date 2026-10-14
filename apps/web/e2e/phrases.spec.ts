/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, IN, password, settled } from './support.js';

/**
 * FLR-T-18.15: say it on the plan, on the Courtyard House (the worker's fixture) imported as a project.
 *
 * ⌘K, "push the island 6 inches north": the palette offers to say it; the phrase bar opens with the
 * island ghosted 6″ north and its cooktop riding with it, the summary "Move Kitchen island 6″ north"
 * and its operations — and the model unchanged. Enter accepts: one op in the history, the island and
 * the cooktop both 6″ further north. ⌘/ opens the bar directly: "make the island 10 feet long" is
 * previewed and Esc rejects it — the model and the history as they were. "add a 36-inch door to the
 * pantry" asks which of the Pantry's four walls, each lit on the plan as it is highlighted; the arrows
 * choose the north wall, Enter previews the door there and Enter again adds it: one op, a new opening
 * in W25. A phrase outside the grammar is answered "I can do: …" with examples. Axe passes on the bar,
 * its preview and its question in both themes; screenshots land in test-results/phrases-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Host { position?: number[] }
type Doc = {
  openings: Record<string, { wall: string; width?: number; fill?: string }>;
  extensions: { FS_furniture: { collections: Record<string, Record<string, { host?: Host }>> } };
};

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const positionOf = (d: Doc, id: string): number[] => Object.values(d.extensions.FS_furniture.collections).find((c) => id in c)![id]!.host!.position!;

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/phrases-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Open the phrase bar with ⌘/ and wait for its field to take the focus before typing into it. */
async function openBar(page: Page): Promise<void> {
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByTestId('phrase-input')).toBeFocused();
}

test('say it on the plan: a phrase previewed as a ghost, accepted as one op, rejected as nothing, and a question for an ambiguous wall', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Sayer', email: 'sayer@example.test', password: password('phrases') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  // The kitchen framed (⇧2), so the island and the pantry are on screen.
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).first().click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit2');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');

  const before = await docOf(page, project);
  const island = positionOf(before, 'KIT-ISLAND');
  const cooktop = positionOf(before, 'KIT-COOKTOP');
  const ops = (await historyOf(page, project)).length;

  // ── ⌘K, a phrase: the palette offers to say it on the plan.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('combobox', { name: 'Search commands and the plan' });
  await expect(palette).toBeFocused();
  await palette.fill('push the island 6 inches north');
  await expect(page.getByRole('option', { name: /Say it: “push the island 6 inches north”/ })).toBeVisible();
  await page.keyboard.press('Enter');

  // The bar, its phrase read: the island ghosted 6″ north, the cooktop riding with it, nothing applied.
  const bar = page.getByTestId('phrase-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('phrase-input')).toBeFocused();
  await expect(page.getByTestId('phrase-input')).toHaveValue('push the island 6 inches north');
  const preview = page.getByTestId('phrase-preview');
  await expect(preview).toContainText('Move Kitchen island 6″ north');
  await expect(preview).toContainText('Cooktop');
  await expect(bar.getByRole('list', { name: 'Operations' })).toContainText('moveElement');
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-item="KIT-ISLAND"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-item="KIT-COOKTOP"]')).toHaveCount(1);
  // The ghost stands north of the island: up the screen.
  const now = (await page.locator('[data-furniture="KIT-ISLAND"]').first().boundingBox())!;
  const ghost = (await page.locator('[data-testid="phrase-ghost"] [data-phrase-item="KIT-ISLAND"]').boundingBox())!;
  expect(ghost.y + ghost.height / 2).toBeLessThan(now.y + now.height / 2);
  // The bar stands clear of it, so the ghost is seen.
  const box = (await bar.boundingBox())!;
  const centre = { x: ghost.x + ghost.width / 2, y: ghost.y + ghost.height / 2 };
  expect(centre.x > box.x && centre.x < box.x + box.width && centre.y > box.y && centre.y < box.y + box.height).toBe(false);
  expect(positionOf(await docOf(page, project), 'KIT-ISLAND')).toEqual(island);
  expect((await historyOf(page, project)).length).toBe(ops);
  await shoot(page, 'preview');
  await axe(page, '[data-testid="phrase-bar"]');

  // Enter accepts: one op, the island and its cooktop 6″ north.
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(ops + 1);
  const after = await docOf(page, project);
  expect(positionOf(after, 'KIT-ISLAND')).toEqual([island[0], island[1]! + 6 * IN]);
  expect(positionOf(after, 'KIT-COOKTOP')).toEqual([cooktop[0], cooktop[1]! + 6 * IN]);
  await expect(page.getByRole('status').filter({ hasText: 'Applied: Move Kitchen island 6″ north' })).toHaveCount(1);

  // ── ⌘/: a resize previewed, then rejected with Esc — the model and the history as they were.
  await openBar(page);
  await page.keyboard.type('make the island 10 feet long');
  await expect(page.getByTestId('phrase-preview')).toContainText('Resize Kitchen island 10′-0″ long');
  const unchanged = JSON.stringify(await docOf(page, project));
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.locator('[data-testid="phrase-ghost"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(JSON.stringify(await docOf(page, project))).toBe(unchanged);
  expect((await historyOf(page, project)).length).toBe(ops + 1);

  // ── A phrase outside the grammar: what it can do, and examples to start from.
  await openBar(page);
  await page.keyboard.type('fly to the moon');
  await expect(page.getByTestId('phrase-help')).toContainText('I can do: move, resize, add a door or window, place an item, rename, set a finish.');
  await expect(bar.getByRole('button', { name: 'push the island 6 inches north' })).toBeVisible();
  await shoot(page, 'help');
  await page.keyboard.press('Escape');

  // ── A door in the pantry: which of its four walls? Each is lit on the plan as it is highlighted.
  const openings = Object.keys(before.openings).length;
  await openBar(page);
  await page.keyboard.type('add a 36-inch door to the pantry');
  await expect(page.getByTestId('phrase-question')).toContainText('Which wall of Pantry?');
  const options = page.getByTestId('phrase-options').getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-target]')).toHaveCount(4);
  // Hovering a candidate lights it.
  await options.filter({ hasText: 'East wall' }).hover();
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-target="W6"][data-hover="true"]')).toHaveCount(1);
  await page.getByTestId('phrase-input').focus();
  await shoot(page, 'chooser');
  await axe(page, '[data-testid="phrase-bar"]');
  // The arrows to the north wall, Enter to choose it: the door previewed there.
  for (let i = 0; i < 4; i++) {
    if (((await bar.locator('[role="option"][aria-selected="true"]').textContent()) ?? '').includes('North wall')) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(bar.locator('[role="option"][aria-selected="true"]')).toContainText('North wall');
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-target="W25"][data-hover="true"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('phrase-preview')).toContainText('Add a 3′-0″ door to the north wall of Pantry (W25), centred');
  // The new door drawn where it would go; nothing in the model yet.
  await expect(page.locator('[data-testid="phrase-ghost"] [data-phrase-item]')).toHaveCount(1);
  expect(Object.keys((await docOf(page, project)).openings).length).toBe(openings);
  await shoot(page, 'door');
  // Accepted with the button this time: one op, one new opening in W25.
  await bar.getByRole('button', { name: /Accept/ }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(ops + 2);
  const withDoor = await docOf(page, project);
  const added = Object.entries(withDoor.openings).filter(([id]) => !(id in before.openings));
  expect(added).toHaveLength(1);
  expect(added[0]![1].wall).toBe('W25');
});
