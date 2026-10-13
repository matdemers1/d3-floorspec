/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { IN, firstRunSetup, historyOf, password, settled } from './support.js';

/**
 * FLR-T-18.4: resize anything. The Courtyard House (the staging assistant's fixture, a copy of the
 * owner's house) is imported as a project, built as Ops. Its kitchen island, 1800 mm long with a cooktop set
 * into it (FS_furniture's `with`), is selected on the plan: eight handles and a rotate handle show.
 *
 * Its width typed as 10' in the inspector is one `resizeElement` (Ops 0.4, 4.11): the island is
 * 120" long from its middle, its working space as long, the cooktop still at its middle; the model
 * says it is procedural, five bays now; undo puts it back in one step. Its height typed as 42"
 * raises the cooktop standing on it. Its left edge handle dragged makes it longer on that side only,
 * snapped to the 3" cabinet module; the rotate handle turns it in 15° steps about its middle. The
 * 3D view draws it, and axe passes on the Size section in both themes. Screenshots land in
 * test-results/resize-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../../packages/assistants/staging/test/fixtures/courtyard.floorspec.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ISLAND = 'KIT-ISLAND';
const COOKTOP = 'KIT-COOKTOP';

interface Item {
  fallback: { box: { min: number[]; max: number[] } };
  host: { position: number[]; rotation?: number };
  clearances?: Record<string, { min: number[]; max: number[] }>;
}
type Doc = { extensions: { FS_furniture: { collections: Record<string, Record<string, Item>> } } };

const itemOf = async (page: Page, project: string, id: string): Promise<Item> => {
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
  return Object.values(doc.extensions.FS_furniture.collections).find((c) => id in c)![id]!;
};
const widthOf = (i: Item) => i.fallback.box.max[1]! - i.fallback.box.min[1]!;

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/resize-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('resize anything: the Courtyard House island made 10 ft long, its cooktop kept in the middle, dragged by a handle, turned, and drawn in 3D', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Joiner', email: 'joiner@example.test', password: password('resize') });
  // The house is larger than one batch may be (500 operations): imported as a model.json, which the
  // server builds as Ops in one transaction (FLR-T-9.1).
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  const before = await itemOf(page, project, ISLAND);
  const cooktopBefore = await itemOf(page, project, COOKTOP);
  expect(widthOf(before)).toBe(2_304_000); // 1800 mm

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── Select the island on the plan: its handles show.
  const island = page.locator(`[data-furniture="${ISLAND}"]`);
  await expect(island).toBeVisible();
  const at = await centreOf(page, `[data-furniture="${ISLAND}"]`);
  await page.mouse.click(at.x, at.y);
  // A click on the island can land on the cooktop set into it: then pick the island from the cooktop's inspector.
  const heading = inspector.getByRole('heading', { level: 2 }).first();
  if (!/Kitchen island/.test((await heading.textContent()) ?? '')) {
    await page.keyboard.press('Escape');
    const corner = (await island.boundingBox())!;
    await page.mouse.click(corner.x + 6, corner.y + 6);
  }
  await expect(inspector.getByRole('heading', { name: /Kitchen island/ })).toBeVisible();
  await expect(page.getByTestId('resize-handles').locator('rect')).toHaveCount(8);
  await expect(page.getByTestId('rotate-handle')).toBeVisible();
  const size = inspector.getByRole('region', { name: 'Size' });
  await expect(size.getByTestId('model-kind')).toHaveAttribute('data-kind', 'procedural');
  await expect(size).toContainText('3 bays');
  await shoot(page, 'selected');

  // ── Width typed: one resizeElement from the middle, 120" long; the cooktop with it stays at its middle.
  const history = (await historyOf(page, project)).length;
  const width = size.getByLabel('Width');
  await width.fill("10'");
  await width.press('Enter');
  await expect.poll(async () => widthOf(await itemOf(page, project, ISLAND))).toBe(120 * IN);
  const long = await itemOf(page, project, ISLAND);
  expect(long.fallback.box.min[1]).toBe(-60 * IN);
  expect(long.clearances!['front']!.min[1]).toBe(-60 * IN);
  expect(long.clearances!['front']!.max[1]).toBe(60 * IN);
  expect((await itemOf(page, project, COOKTOP)).host).toEqual(cooktopBefore.host);
  expect((await historyOf(page, project)).length - history).toBe(1);
  await expect(size).toContainText('5 bays');
  await shoot(page, 'island-10ft');
  const results = await new AxeBuilder({ page }).include('[aria-label="Size"]').withTags(TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // In 3D: the island drawn at its new size.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(800);
  await shoot(page, 'island-10ft-3d');
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '2D plan' }).click();
  await settled(page);

  // ── Undo: back to 1800 mm in one step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => widthOf(await itemOf(page, project, ISLAND))).toBe(2_304_000);
  await settled(page);

  // ── Height typed: the cooktop standing on its top rises with it.
  const height = size.getByLabel('Height');
  await height.fill('42"');
  await height.press('Enter');
  await expect.poll(async () => (await itemOf(page, project, ISLAND)).fallback.box.max[2]).toBe(42 * IN);
  expect((await itemOf(page, project, COOKTOP)).fallback.box.min[2]).toBe(cooktopBefore.fallback.box.min[2]! + 42 * IN - 1_152_000);
  await settled(page);

  // ── A handle dragged: its left edge (its +y) pulled out; its right end held; snapped to 3".
  const now = await itemOf(page, project, ISLAND);
  const left = await centreOf(page, '[data-testid="resize-handle-left"]');
  const right = await centreOf(page, '[data-testid="resize-handle-right"]');
  const away = { x: left.x - right.x, y: left.y - right.y };
  const len = Math.hypot(away.x, away.y);
  await page.mouse.move(left.x, left.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(left.x + (away.x / len) * 8 * k, left.y + (away.y / len) * 8 * k);
  await expect(page.getByTestId('resize-ghost')).toBeVisible();
  await page.screenshot({ path: 'test-results/resize-dragging-light.png' });
  await page.mouse.up();
  await expect.poll(async () => widthOf(await itemOf(page, project, ISLAND))).toBeGreaterThan(widthOf(now));
  const dragged = await itemOf(page, project, ISLAND);
  expect(widthOf(dragged) % (3 * IN)).toBe(0);
  expect(dragged.fallback.box.min[1]).toBe(now.fallback.box.min[1]);
  await settled(page);

  // ── The rotate handle: a turn in 15° steps, about the island's middle.
  const rotate = await centreOf(page, '[data-testid="rotate-handle"]');
  const middle = await centreOf(page, `[data-furniture="${ISLAND}"]`);
  await page.mouse.move(rotate.x, rotate.y);
  await page.mouse.down();
  // Swing the handle a little way round the middle.
  const r = Math.hypot(rotate.x - middle.x, rotate.y - middle.y);
  const a0 = Math.atan2(rotate.y - middle.y, rotate.x - middle.x);
  for (let k = 1; k <= 6; k++) await page.mouse.move(middle.x + r * Math.cos(a0 + (k * Math.PI) / 18), middle.y + r * Math.sin(a0 + (k * Math.PI) / 18));
  await page.mouse.up();
  await expect.poll(async () => (await itemOf(page, project, ISLAND)).host.rotation ?? 0).not.toBe(dragged.host.rotation ?? 0);
  const turned = await itemOf(page, project, ISLAND);
  expect((turned.host.rotation ?? 0) % 15_000_000).toBe(0);
  await shoot(page, 'turned');
});
