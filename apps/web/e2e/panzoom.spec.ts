/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { asAgent, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-18.6: pan and zoom made easy, after the board's "18.6 · Pan and zoom" frame, on the
 * Courtyard House (imported as a project; the live project is never touched).
 *
 * ⇧0 zooms to 100% and ⇧1 fits, animated — the zoom readout passes through the zooms between — and
 * at once under reduced motion; ⇧2 frames the selection. The readout is editable: typed, 400% from
 * the menu, nonsense refused. The wheel: a mouse's notch zooms and a trackpad's scroll pans (Auto),
 * Pan and Zoom change that, and the choice is kept. H is the hand (dragging pans, selecting nothing)
 * and ⌥H the history. A double click on empty space zooms in, ⌥ out. ⇧N shows the minimap, whose
 * rectangle drags the plan, in full screen too. Saved views (⇧V, ⇧⌘S) bring back a level, a zoom and
 * a region, and outlast a reload. Selecting from the tree, the palette's Go to and a proposal's
 * changes brings the element into view — onto its level when it is on another. axe runs on each
 * state in both themes; screenshots land in test-results/panzoom-*.png (or PANZOOM_SHOTS).
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url));
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SHOTS = process.env['PANZOOM_SHOTS'] ?? 'test-results';

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('.fs-canvas[data-zooming]') === null, undefined, { timeout: 5_000 });
  await page.waitForTimeout(150);
}

async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await still(page);
    await page.screenshot({ path: `${SHOTS}/panzoom-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const readout = (page: Page): Locator => page.locator('.fs-zoom__value');
async function zoomOf(page: Page): Promise<number> {
  await still(page);
  return Number(/(\d+)%/.exec((await readout(page).textContent()) ?? '')?.[1] ?? NaN);
}

/** Every zoom the readout shows from now on, kept in the page. */
async function recordZooms(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __zooms: string[]; __zoomObserver?: MutationObserver };
    w.__zoomObserver?.disconnect();
    w.__zooms = [];
    const el = document.querySelector('.fs-zoom__value');
    if (el === null) throw new Error('no zoom readout');
    w.__zoomObserver = new MutationObserver(() => { w.__zooms.push(el.textContent); });
    w.__zoomObserver.observe(el, { subtree: true, characterData: true, childList: true });
  });
}
const recorded = (page: Page): Promise<string[]> => page.evaluate(() => [...new Set((window as unknown as { __zooms: string[] }).__zooms)]);

/** The selected element's outline on the plan, and whether it is inside the canvas. */
async function selectedInView(page: Page): Promise<boolean> {
  await still(page);
  const canvas = (await page.locator('.fs-canvas__svg').boundingBox())!;
  const box = await page.locator('.fs-selection .fs-hl--selected').first().boundingBox();
  if (box === null) return false;
  return box.x >= canvas.x - 1 && box.y >= canvas.y - 1 && box.x + box.width <= canvas.x + canvas.width + 1 && box.y + box.height <= canvas.y + canvas.height + 1;
}

/** Where a room's label is drawn: a stand-in for where the plan is. */
async function labelAt(page: Page, name: string): Promise<{ x: number; y: number }> {
  await still(page);
  const box = (await page.locator('.fs-plan2__labels text', { hasText: name }).first().boundingBox())!;
  return { x: box.x, y: box.y };
}

/** A wheel event as a trackpad's two-finger scroll sends it: small, fractional, sometimes sideways. */
async function trackpadScroll(page: Page, at: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.evaluate(({ x, y, dx, dy }) => {
    const target = document.elementFromPoint(x, y);
    if (target === null) throw new Error('nothing under the point');
    for (let i = 0; i < 6; i++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX: dx / 6, deltaY: dy / 6, deltaMode: 0 }));
  }, { x: at.x, y: at.y, dx, dy });
}

test('pan and zoom: keys, animation, the editable zoom, the wheel, the hand, double click, the minimap, saved views and go-to', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Navigator', email: 'navigator@example.test', password: password('panzoom') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: HOUSE,
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const canvas = page.locator('.fs-canvas__svg');
  await expect(page.getByRole('application', { name: 'Plan of Main floor' })).toBeVisible();
  const bar = page.getByRole('toolbar', { name: 'Zoom and navigate' });
  await expect(bar).toBeVisible();
  const fitted = await zoomOf(page);
  const box = (await canvas.boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // ── ⇧0: 100%, animated — the readout passes through the zooms between.
  await recordZooms(page);
  await page.keyboard.press('Shift+Digit0');
  await expect(readout(page)).toHaveText('100%');
  await still(page);
  expect((await recorded(page)).length).toBeGreaterThan(2);
  // ⇧1: fit, animated, back where it started.
  await recordZooms(page);
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  expect((await recorded(page)).length).toBeGreaterThan(2);
  // Under reduced motion the view moves at once: the readout changes once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recordZooms(page);
  await page.keyboard.press('Shift+Digit0');
  await expect(readout(page)).toHaveText('100%');
  await page.waitForTimeout(300);
  expect(await recorded(page)).toEqual(['100%']);
  await expect(page.locator('.fs-canvas[data-zooming]')).toHaveCount(0);
  await page.keyboard.press('Shift+Digit1');
  await expect(readout(page)).toHaveText(`${String(fitted)}%`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ── The zoom readout is editable: typed, chosen, nonsense refused.
  await readout(page).click();
  const menu = page.getByRole('dialog', { name: 'Zoom' });
  await expect(menu).toBeVisible();
  const typed = menu.getByRole('textbox', { name: 'Zoom, percent' });
  await expect(typed).toBeFocused();
  await expect(menu.getByRole('radiogroup', { name: 'Scroll wheel' })).toBeVisible();
  await expect(menu).toContainText('Auto: trackpads pan and pinch-zoom; mouse wheels zoom.');
  await audit(page, 'zoom-menu');
  await typed.fill('lots');
  await typed.press('Enter');
  await expect(menu.getByRole('alert')).toContainText('A zoom from 5% to 4000%');
  await typed.fill('180');
  await typed.press('Enter');
  await expect(menu).toBeHidden();
  await expect(readout(page)).toHaveText('180%');
  await expect(readout(page)).toBeFocused();
  await readout(page).click();
  await menu.getByRole('button', { name: '400%' }).click();
  await expect(readout(page)).toHaveText('400%');
  await readout(page).click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);

  // ── The wheel. Auto: a mouse's notch zooms; a trackpad's scroll pans.
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted);
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  let before = await labelAt(page, 'Great room');
  await trackpadScroll(page, middle, 0, 60);
  await expect.poll(async () => (await labelAt(page, 'Great room')).y).toBeLessThan(before.y - 30);
  expect(await zoomOf(page)).toBe(fitted);
  // Pan: the mouse's notch pans.
  await readout(page).click();
  await menu.getByRole('radio', { name: 'Pan' }).click();
  await expect(menu).toContainText('Pan: the wheel scrolls the plan');
  await page.keyboard.press('Escape');
  before = await labelAt(page, 'Great room');
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await labelAt(page, 'Great room')).y).toBeLessThan(before.y - 30);
  expect(await zoomOf(page)).toBe(fitted);
  // Zoom: the trackpad's scroll zooms; the choice is kept across a reload.
  await readout(page).click();
  await menu.getByRole('radio', { name: 'Zoom' }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  await settled(page);
  await readout(page).click();
  await expect(menu.getByRole('radio', { name: 'Zoom' })).toBeChecked();
  await page.keyboard.press('Escape');
  await trackpadScroll(page, middle, 0, -60);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted);
  await readout(page).click();
  await menu.getByRole('radio', { name: 'Auto' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);

  // ── H: the hand. Dragging pans and selects nothing; ⌥H is the history now.
  await page.keyboard.press('h');
  await expect(page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true');
  before = await labelAt(page, 'Great room');
  const great = before;
  await page.mouse.move(great.x + 10, great.y + 4);
  await page.mouse.down();
  await page.mouse.move(great.x + 90, great.y + 64, { steps: 6 });
  await page.mouse.up();
  const after = await labelAt(page, 'Great room');
  expect(after.x - before.x).toBeCloseTo(80, -1);
  expect(after.y - before.y).toBeCloseTo(60, -1);
  await expect(page.locator('.fs-selection .fs-hl--selected')).toHaveCount(0);
  await page.keyboard.press('Alt+KeyH');
  await expect(page.getByRole('button', { name: 'Hide the history' })).toBeVisible();
  await page.keyboard.press('Alt+KeyH');
  await expect(page.getByRole('button', { name: 'Show the history' })).toBeVisible();
  await page.keyboard.press('v');
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);

  // ── A double click on empty space zooms in about it; with ⌥, out.
  const empty = { x: box.x + 30, y: box.y + 30 };
  await page.mouse.dblclick(empty.x, empty.y);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted * 1.8);
  const doubled = await zoomOf(page);
  await page.keyboard.down('Alt');
  await page.mouse.dblclick(empty.x, empty.y);
  await page.keyboard.up('Alt');
  await expect.poll(() => zoomOf(page)).toBeLessThan(doubled * 0.6);
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);

  // ── ⇧2: the selection, framed. The Great room picked from the tree.
  const tree = page.getByRole('tree');
  await tree.getByRole('treeitem', { name: /^Great room/ }).click();
  expect(await selectedInView(page)).toBe(true);
  await page.keyboard.press('Shift+Digit2');
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted);
  expect(await selectedInView(page)).toBe(true);
  const framed = (await page.locator('.fs-selection .fs-hl--selected').first().boundingBox())!;
  expect(framed.width).toBeGreaterThan(box.width * 0.4);

  // ── Selecting from the tree brings an element out of view into it.
  await page.keyboard.press('Shift+Digit0');
  await readout(page).click();
  await menu.getByRole('button', { name: '400%' }).click();
  await tree.getByRole('treeitem', { name: /^Garage/ }).click();
  await expect.poll(() => selectedInView(page)).toBe(true);
  // From the palette's Go to: the Pantry.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('Pantry');
  await page.getByRole('option', { name: /^Pantry/ }).first().click();
  await expect.poll(() => selectedInView(page)).toBe(true);
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: /Pantry/ }).first()).toBeVisible();

  // ── ⇧N: the minimap. Its rectangle drags the plan.
  await page.keyboard.press('Shift+Digit1');
  await page.keyboard.press('Shift+Digit0');
  await expect(readout(page)).toHaveText('100%');
  await page.keyboard.press('Shift+KeyN');
  const minimap = page.getByRole('region', { name: 'Minimap' });
  await expect(minimap).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Minimap' })).toHaveAttribute('aria-pressed', 'true');
  const rect = page.getByTestId('minimap-viewport');
  const r0 = (await rect.boundingBox())!;
  before = await labelAt(page, 'Great room');
  await page.mouse.move(r0.x + r0.width / 2, r0.y + r0.height / 2);
  await page.mouse.down();
  await page.mouse.move(r0.x + r0.width / 2 + 20, r0.y + r0.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  const r1 = (await rect.boundingBox())!;
  expect(r1.x - r0.x).toBeCloseTo(20, -1);
  expect(r1.y - r0.y).toBeCloseTo(10, -1);
  const moved = await labelAt(page, 'Great room');
  expect(moved.x).toBeLessThan(before.x - 20);
  expect(moved.y).toBeLessThan(before.y - 10);
  // A press elsewhere on it brings the view there.
  const mini = (await minimap.locator('svg[aria-roledescription="minimap"]').boundingBox())!;
  await page.mouse.click(mini.x + 12, mini.y + mini.height - 12);
  await still(page);
  const r2 = (await rect.boundingBox())!;
  expect(Math.abs(r2.x + r2.width / 2 - (mini.x + 12))).toBeLessThan(4);
  // The keyboard pans it too.
  await minimap.locator('svg[aria-roledescription="minimap"]').focus();
  await page.keyboard.press('ArrowRight');
  await still(page);
  expect((await rect.boundingBox())!.x).toBeGreaterThan(r2.x);

  // ── Saved views: ⇧V, ⇧⌘S names the view, a click brings it back; kept across a reload.
  await page.keyboard.press('Shift+Digit1');
  await tree.getByRole('treeitem', { name: /^Great room/ }).click();
  await page.keyboard.press('Shift+Digit2');
  await still(page);
  const seating = await zoomOf(page);
  const seatingAt = await labelAt(page, 'Great room');
  await page.keyboard.press('ControlOrMeta+Shift+KeyS');
  const views = page.getByRole('region', { name: 'Saved views' });
  await expect(views).toBeVisible();
  const name = views.getByRole('textbox', { name: 'Name this view' });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue(`Main floor · ${String(seating)}%`);
  await name.fill('Great room seating');
  await name.press('Enter');
  await expect(views.getByRole('button', { name: /^Great room seating/ })).toContainText(`Main floor · ${String(seating)}%`);
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  await views.getByRole('button', { name: 'Save this view' }).click();
  await expect(name).toHaveValue('Main floor — whole level');
  await name.press('Enter');
  await expect(views.getByRole('button', { name: /^Main floor — whole level/ })).toContainText('Main floor · fit');
  await audit(page, 'minimap-saved-views');
  await page.reload();
  await settled(page);
  await page.keyboard.press('Shift+KeyV');
  await expect(views.getByRole('button', { name: /^Great room seating/ })).toBeVisible();
  await views.getByRole('button', { name: /^Great room seating/ }).click();
  await expect.poll(() => zoomOf(page)).toBe(seating);
  const back = await labelAt(page, 'Great room');
  expect(Math.abs(back.x - seatingAt.x)).toBeLessThan(3);
  expect(Math.abs(back.y - seatingAt.y)).toBeLessThan(3);
  // From another level, it goes back to its own.
  await page.keyboard.press('PageUp');
  await expect(page.getByRole('application', { name: 'Plan of Upper floor' })).toBeVisible();
  await views.getByRole('button', { name: /^Great room seating/ }).click();
  await expect(page.getByRole('application', { name: 'Plan of Main floor' })).toBeVisible();
  await expect.poll(() => zoomOf(page)).toBe(seating);
  // The palette lists them.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('whole level');
  await page.getByRole('option', { name: 'Go to the view Main floor — whole level' }).click();
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  await views.getByRole('button', { name: 'Delete the view Main floor — whole level' }).click();
  await expect(views.getByRole('button', { name: /^Main floor — whole level/ })).toHaveCount(0);

  // ── In full screen the zoom bar steps aside; the minimap and the saved views stay, and their keys work.
  await page.keyboard.press('f');
  await expect(page.locator('.fs-editor')).toHaveAttribute('data-chrome', 'full');
  await expect(bar).toBeHidden();
  await expect(minimap).toBeVisible();
  await expect(page.getByRole('note', { name: 'View' })).toBeVisible();
  await audit(page, 'full-screen-minimap');
  await page.keyboard.press('Shift+KeyV');
  await expect(views).toBeHidden();
  await page.keyboard.press('Shift+KeyN');
  await expect(minimap).toBeHidden();
  await page.keyboard.press('f');
  await expect(page.locator('.fs-editor')).toHaveAttribute('data-chrome', 'windowed');

  // ── A proposal's change, picked in its panel, brings the element into view — onto its level.
  const minted = await page.request.post('/api/tokens', { data: { name: 'Claude', kind: 'agent', projectId: project } });
  expect(minted.status(), await minted.text()).toBe(201);
  const agent = await asAgent(baseURL!, ((await minted.json()) as { token: string }).token);
  const proposal = await agent.post(`/api/projects/${project}/changesets`, {
    data: { name: 'Rename the primary bedroom', batch: [{ op: 'setProperty', id: 'R17', path: '/name', value: 'Main bedroom' }] },
  });
  expect(proposal.status(), await proposal.text()).toBe(201);
  const panel = page.getByRole('complementary', { name: 'Proposal' });
  await expect(panel.getByRole('heading', { name: 'Rename the primary bedroom' })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Plan of Main floor' })).toBeVisible();
  await panel.getByRole('button', { name: /bedroom/i }).first().click();
  await expect(page.getByRole('application', { name: 'Plan of Upper floor' })).toBeVisible();
  await expect.poll(() => selectedInView(page)).toBe(true);
  // The "Claude is proposing" toast sits over the bar for a while: audit once it has gone.
  await expect(page.locator('.d3-toast')).toHaveCount(0, { timeout: 15_000 });
  await audit(page, 'proposal-go-to');
  await agent.dispose();
});
