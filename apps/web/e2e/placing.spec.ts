/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, password, settled } from './support.js';

/**
 * FLR-T-18.7: adding things easily, on the Courtyard House (the worker's fixture) imported as a project.
 *
 * I opens the library in the left drawer, its search focused. The Seating chip shows the sofas; the
 * three-seat sofa is dragged from its card onto the Den, near its south wall: the ghost backs onto
 * the wall, says so, shows the clear distance to each corner, and is let go — one batch, the sofa an
 * FS_furniture element on the Den's floor facing into the room; one undo takes it away and redo brings
 * it back. A casement window is dragged onto the Den's east wall: one addOpening, on that wall. A
 * dining chair is clicked and then placed twice by clicks on the plan — the place tool stays on —
 * turned with R between them; Esc puts the tool down. / opens the quick-add bar at the pointer:
 * "small tree" and Enter puts an FS_landscape plant on the level, free. The keyboard alone: Enter in
 * the search starts placing its first match, the arrows move the ghost, Enter places. A favourite is
 * starred and listed; the recent items are listed. A finger taps a card, then the plan. Axe runs on
 * the drawer and the quick-add bar in both themes; screenshots land in test-results/placing-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MM = 1_280;

type Point = [number, number];
interface Host { mode: string; room?: string; surface?: string; level?: string; rotation?: number; position?: number[] }
interface El { catalogue?: string; category?: string; host?: Host; form?: string }
type Doc = {
  openings: Record<string, { wall: string; fill?: string }>;
  extensions: { FS_furniture: { collections: Record<string, Record<string, El>> }; FS_landscape: { collections: Record<string, Record<string, El>> } };
};

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const furniture = (d: Doc) => Object.entries(d.extensions.FS_furniture.collections).flatMap(([, els]) => Object.entries(els).map(([id, el]) => ({ id, ...el })));
const plants = (d: Doc) => Object.entries(d.extensions.FS_landscape.collections['plants'] ?? {}).map(([id, el]) => ({ id, ...el }));

type Hook = { __floorspecPlacing?: { screenPoint(x: number, y: number): { x: number; y: number } | null; room(id: string): Point[] | null } };
const screenOf = async (page: Page, p: Point) => (await page.evaluate(([x, y]) => (window as unknown as Hook).__floorspecPlacing?.screenPoint(x, y) ?? null, p))!;
const roomRing = async (page: Page, id: string) => (await page.evaluate((r) => (window as unknown as Hook).__floorspecPlacing?.room(r) ?? null, id))!;

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/placing-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Drag from a locator to a screen point, in steps, without letting go. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
}

const centreOf = async (page: Page, selector: string) => {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('adding things: drag a sofa and a window in, click-to-place with turns, quick add, the keyboard, favourites and a finger', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Placer', email: 'placer@example.test', password: password('placing') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspecPlacing !== undefined);
  // Decorator (⌥2), as the board's frame, framed on the Den: chosen in the tree, ⇧2, a step out.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Alt+Digit2');
  await page.getByRole('tree').getByRole('treeitem', { name: /^Den\b/ }).click();
  await page.keyboard.press('Shift+Digit2');
  await expect(page.locator('.fs-canvas')).not.toHaveAttribute('data-zooming', 'on');
  await page.keyboard.press('Escape');
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('-');
  await expect(page.locator('.fs-canvas')).not.toHaveAttribute('data-zooming', 'on');
  await page.keyboard.press('Escape');

  // ── I: the library in the left drawer, its search focused.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('i');
  const drawer = page.locator('.fs-lib');
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search the library to add' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Seating' }).click();
  const sofaCard = drawer.getByRole('button', { name: /^Three-seat sofa/ });
  await expect(sofaCard).toBeVisible();
  await axe(page, '.fs-drawer--left');

  // ── Drag the sofa onto the Den, near the middle of its south wall.
  const den = await roomRing(page, 'R6');
  const ys = den.map((p) => p[1]);
  const south = Math.min(...ys);
  const xsOnSouth = den.filter((p) => Math.abs(p[1] - south) < MM).map((p) => p[0]);
  const target = await screenOf(page, [(Math.min(...xsOnSouth) + Math.max(...xsOnSouth)) / 2 + 40 * MM, south + 700 * MM]);
  const before = (await historyOf(page, project)).length;
  const idsBefore = new Set(furniture(await docOf(page, project)).map((f) => f.id));
  const countBefore = idsBefore.size;
  await dragTo(page, await centreOf(page, '.fs-lib-card[data-entry="furniture:sofa-2100"]'), target);
  const ghost = page.getByTestId('placing-ghost');
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-entry', 'furniture:sofa-2100');
  await expect(page.getByTestId('placing-hint')).toContainText('Against the south wall');
  await expect(page.getByTestId('placing-hint')).toContainText('Den');
  await expect(page.getByTestId('placing-gap').first()).toBeVisible();
  await shoot(page, 'drag-sofa');
  await page.mouse.up();
  await expect.poll(async () => furniture(await docOf(page, project)).length).toBe(countBefore + 1);
  await settled(page);
  const sofa = furniture(await docOf(page, project)).find((f) => !idsBefore.has(f.id))!;
  expect(sofa.catalogue).toBe('sofa-2100');
  expect(sofa.host).toMatchObject({ mode: 'surface', room: 'R6', surface: 'floor', rotation: 90_000_000 });
  expect((await historyOf(page, project)).length).toBe(before + 1);
  // One undo takes it away, redo brings it back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => furniture(await docOf(page, project)).length).toBe(countBefore);
  await settled(page);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => furniture(await docOf(page, project)).length).toBe(countBefore + 1);
  await settled(page);

  // ── Drag a casement window onto the Den's east wall.
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Windows' }).click();
  const xs = den.map((p) => p[0]);
  const east = Math.max(...xs);
  const ysOnEast = den.filter((p) => Math.abs(p[0] - east) < MM).map((p) => p[1]);
  // Near the south end of it, clear of the window already there.
  const onWall = await screenOf(page, [east + 70 * MM, Math.min(...ysOnEast) + 1_000 * MM]);
  const openings = Object.keys((await docOf(page, project)).openings).length;
  await dragTo(page, await centreOf(page, '.fs-lib-card[data-entry="window:window-casement-30x48"]'), onWall);
  await expect(ghost).toHaveAttribute('data-entry', 'window:window-casement-30x48');
  await expect(page.getByTestId('placing-hint')).toContainText('Den');
  await shoot(page, 'drag-window');
  await page.mouse.up();
  await expect.poll(async () => Object.keys((await docOf(page, project)).openings).length).toBe(openings + 1);
  await settled(page);
  const doc = await docOf(page, project);
  const added = Object.values(doc.openings).filter((o) => o.fill === 'window-casement-30x48');
  expect(added.length).toBeGreaterThan(0);

  // ── Click-to-place: a dining chair, twice, turned between; Esc ends it.
  await page.getByRole('searchbox', { name: 'Search the library to add' }).fill('dining chair');
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'All' }).click();
  await drawer.locator('.fs-lib-card[data-entry="furniture:dining-chair-450"]').click();
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-tool', 'place');
  const great = await roomRing(page, 'R7');
  const gx = great.map((p) => p[0]);
  const gy = great.map((p) => p[1]);
  const mid: Point = [(Math.min(...gx) + Math.max(...gx)) / 2, (Math.min(...gy) + Math.max(...gy)) / 2];
  const chairs = furniture(await docOf(page, project)).filter((f) => f.catalogue === 'dining-chair-450').length;
  const a = await screenOf(page, [mid[0] - 900 * MM, mid[1] - 1800 * MM]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await expect.poll(async () => furniture(await docOf(page, project)).filter((f) => f.catalogue === 'dining-chair-450').length).toBe(chairs + 1);
  await settled(page);
  await page.keyboard.press('r');
  const b = await screenOf(page, [mid[0] + 900 * MM, mid[1] - 1800 * MM]);
  await page.mouse.move(b.x, b.y);
  await shoot(page, 'click-to-place');
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => furniture(await docOf(page, project)).filter((f) => f.catalogue === 'dining-chair-450').length).toBe(chairs + 2);
  await settled(page);
  const turned = furniture(await docOf(page, project)).filter((f) => f.catalogue === 'dining-chair-450').map((f) => f.host?.rotation ?? 0);
  expect(turned).toContain(-90_000_000);
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-tool', 'place');
  await page.keyboard.press('Escape');
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-tool', 'select');

  // ── Quick add: / at the pointer, "small tree", Enter — a plant, free on the level.
  // In the yard east of the Den.
  const yard = await screenOf(page, [east + 2_500 * MM, (Math.min(...ysOnEast) + Math.max(...ysOnEast)) / 2]);
  await page.mouse.move(yard.x, yard.y);
  const trees = plants(await docOf(page, project)).length;
  await page.keyboard.press('/');
  const quick = page.getByRole('dialog', { name: 'Quick add' });
  await expect(quick).toBeVisible();
  await page.getByRole('combobox', { name: 'Add to the plan' }).fill('small tree');
  await expect(quick.getByRole('option').first()).toContainText('Small tree');
  await expect(quick.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await shoot(page, 'quick-add');
  await axe(page, '.fs-quick');
  await page.keyboard.press('Enter');
  await expect(quick).toBeHidden();
  await expect.poll(async () => plants(await docOf(page, project)).length).toBe(trees + 1);
  await settled(page);
  const tree = plants(await docOf(page, project)).find((p) => p.catalogue === 'tree-small' && p.host?.mode === 'free' && p.host.level === 'L1');
  expect(tree).toBeDefined();

  // ── The keyboard alone: I, a search, Enter starts placing it, the arrows move it, Enter places.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('i');
  await page.keyboard.type('armchair');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-tool', 'place');
  const armchairs = furniture(await docOf(page, project)).filter((f) => f.catalogue === 'armchair-850').length;
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => furniture(await docOf(page, project)).filter((f) => f.catalogue === 'armchair-850').length).toBe(armchairs + 1);
  await settled(page);
  await page.keyboard.press('Escape');

  // ── Favourites and recents.
  await page.keyboard.press('i');
  await page.getByRole('searchbox', { name: 'Search the library to add' }).fill('');
  await drawer.getByRole('button', { name: 'Add Three-seat sofa to favourites' }).click();
  await expect(drawer.getByRole('region', { name: 'Favourites' }).getByRole('button', { name: /Three-seat sofa/ })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Recent' }).getByRole('button', { name: /Armchair/ })).toBeVisible();
  await shoot(page, 'drawer');

  // ── A finger: tap a card, tap the plan.
  const touch = await browser.newContext({ baseURL: baseURL!, hasTouch: true, viewport: { width: 1440, height: 900 }, storageState: await page.context().storageState() });
  const tablet = await touch.newPage();
  await tablet.goto(`/projects/${project}/editor`);
  await settled(tablet);
  await tablet.waitForFunction(() => (window as unknown as Hook).__floorspecPlacing !== undefined);
  await tablet.getByRole('tab', { name: 'Library' }).tap();
  await tablet.getByRole('searchbox', { name: 'Search the library to add' }).fill('coffee table');
  const sides = furniture(await docOf(page, project)).filter((f) => f.category === 'coffeeTable').length;
  await tablet.locator('.fs-lib-card').first().tap();
  await expect(tablet.locator('.fs-canvas')).toHaveAttribute('data-tool', 'place');
  const spot = await screenOf(tablet, [mid[0], mid[1] + 1500 * MM]);
  await tablet.touchscreen.tap(spot.x, spot.y);
  await expect.poll(async () => furniture(await docOf(page, project)).filter((f) => f.category === 'coffeeTable').length).toBe(sides + 1);
  await touch.close();
});
