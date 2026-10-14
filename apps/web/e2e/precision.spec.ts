/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, IN, password, settled } from './support.js';

/**
 * FLR-T-18.9: precision without effort, on the Courtyard House (the worker's fixture) imported as a
 * project — after the board's "18.9 · Precision" and "measure tool + Alt-hover" frames.
 *
 * Door O22, the den's double door on W12, is selected: temporary dimensions run along its wall to
 * the walls that stop it. Its north one is clicked and typed into — Tab measures to the centre line
 * and the other face and back — and Enter moves the door: one moveOpening, one history entry, the
 * distance exactly as typed; one undo takes it back. The inspector's "Position on W12" types the
 * same distance from the keyboard. The status bar's snapping opens its menu: midpoints off and a 6"
 * grid show in the status bar, and the mode's defaults come back with Reset. The measure tool (⇧M)
 * chains the cooktop, the sink and the fridge and closes on the first: three sides, a total, the
 * area, and the work triangle against its guideline. ⌥ held over the island shows its distances to
 * its neighbours. axe passes on the dimensions, the snap menu, the inspector and the measure panel
 * in both themes. Screenshots land in test-results/precision-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const DOOR = 'O22';

const offsetOf = async (page: Page, project: string, id: string): Promise<number> => {
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as { openings: Record<string, { offset: number }> };
  return doc.openings[id]!.offset;
};

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/precision-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Until the view's animations (a zoom) have run. */
async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('precision: a temporary dimension typed (Tab: face, centre, other face), the inspector’s position, the snap menu, a measure chain closed on an area, ⌥ distances — axe in both themes', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Surveyor', email: 'surveyor@example.test', password: password('precision') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const status = page.locator('.fs-statusbar');

  // ── The den framed (zoomed to from the tree), and its double door selected on the plan: temporary
  // dimensions along W12 to the walls that stop it.
  await page.getByRole('treeitem', { name: /^Den\b/ }).first().click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit2');
  await still(page);
  const door = await centreOf(page, `[data-opening="${DOOR}"] .fs-plan2__gap`);
  await page.mouse.click(door.x, door.y);
  await expect(inspector.getByRole('heading', { name: new RegExp(DOOR) })).toBeVisible();
  const dims = page.getByRole('group', { name: /^Temporary dimensions of / });
  const north = dims.locator('[data-dim="opening:end"]');
  const south = dims.locator('[data-dim="opening:start"]');
  await expect(north).toBeVisible();
  await expect(south).toBeVisible();
  await expect(north).toHaveAccessibleName(/^From north face: .+ to the face of (Wall )?W\d+\. Type a new distance$/);
  await shoot(page, 'door-dimensions');
  await axe(page, '.fs-tempdims');

  // ── Clicked: a field, the Tab hint; Tab measures to the centre line, the other face, and back.
  const faceText = (await north.textContent())!;
  await north.click();
  const field = page.locator('input[data-dim="opening:end"]');
  await expect(field).toBeFocused();
  await expect(page.locator('.fs-tempdim__tab')).toContainText('face → centre → other face');
  await expect(page.locator('.fs-tempdim__ref--on')).toHaveText('face');
  const face = await field.inputValue();
  await field.press('Tab');
  await expect(page.locator('.fs-tempdim__ref--on')).toHaveText(/centre/);
  await expect(field).toBeFocused();
  const centre = await field.inputValue();
  expect(centre).not.toBe(face);
  await field.press('Tab');
  await expect(page.locator('.fs-tempdim__ref--on')).toHaveText(/other face/);
  await shoot(page, 'door-tab-other-face');
  await field.press('Shift+Tab');
  await field.press('Shift+Tab');
  await expect(page.locator('.fs-tempdim__ref--on')).toHaveText('face');
  await expect(field).toHaveValue(face);
  await axe(page, '.fs-tempdims');

  // ── Typed: 8'-4" to the north wall's face — one moveOpening, the distance exactly as typed.
  const before = await offsetOf(page, project, DOOR);
  const history = (await historyOf(page, project)).length;
  await field.fill(`8'4"`);
  await shoot(page, 'door-typing');
  await field.press('Enter');
  await expect(north).toHaveText(`8'-4"`);
  await settled(page);
  const after = await offsetOf(page, project, DOOR);
  expect(Number.isInteger(after)).toBe(true);
  expect(after).not.toBe(before);
  const ops = await historyOf(page, project);
  expect(ops.length - history).toBe(1);
  await expect(north).not.toHaveText(faceText);
  await shoot(page, 'door-moved');

  // One undo: back where it was.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => offsetOf(page, project, DOOR)).toBe(before);
  await expect(north).toHaveText(faceText);
  await settled(page);

  // ── From the keyboard: the inspector's Position on W12, the same distance, the same one batch.
  const position = inspector.getByRole('region', { name: /^Position on / });
  await expect(position).toBeVisible();
  const northField = position.getByLabel('From north face');
  await northField.fill(`8'4"`);
  await northField.press('Enter');
  await expect(north).toHaveText(`8'-4"`);
  await settled(page);
  expect(await offsetOf(page, project, DOOR)).toBe(after);
  await position.getByRole('radiogroup', { name: 'Measured to' }).getByRole('radio', { name: 'Centre' }).click();
  await expect(position.getByLabel('From north centre line')).toBeVisible();
  await position.getByRole('radiogroup', { name: 'Measured to' }).getByRole('radio', { name: 'Face', exact: true }).click();
  await axe(page, '[aria-label="Inspector"]');

  // ── Smart guides while drawing: the wall tool over W12's middle — 11' up the 22' wall, measured
  // from the 62" door's south edge where it now is — snaps to its midpoint and says so.
  const gap = (await page.locator(`[data-opening="${DOOR}"] .fs-plan2__gap`).boundingBox())!;
  const perInch = gap.height / 62;
  const southEdge = (await offsetOf(page, project, DOOR)) / IN;
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('w');
  await page.mouse.move(gap.x + gap.width / 2 + 3, gap.y + gap.height - (132 - southEdge) * perInch + 2, { steps: 4 });
  await expect(page.locator('.fs-guidetag')).toHaveText(/^Midpoint of (Wall )?W12$/);
  await shoot(page, 'wall-tool-midpoint');
  await page.keyboard.press('Escape');

  // ── The snap menu, from the status bar: what snaps is said there, and changes there.
  const snapButton = status.getByRole('button', { name: /^Snap: / });
  await expect(snapButton).toContainText('Snap · junctions, walls, +3, grid ½"');
  await snapButton.click();
  const menu = page.getByRole('dialog', { name: 'Snapping' });
  await expect(menu).toBeVisible();
  await shoot(page, 'snap-menu');
  await axe(page, '.fs-snapmenu');
  await menu.getByRole('checkbox', { name: 'Midpoints' }).click();
  await menu.getByRole('checkbox', { name: 'Items (furniture, fixtures)' }).click();
  await menu.getByRole('checkbox', { name: 'Smart guides and alignment' }).click();
  await menu.getByRole('combobox', { name: 'Grid step' }).click();
  await page.getByRole('option', { name: '6"', exact: true }).click();
  await expect(snapButton).toContainText('Snap · junctions, walls, grid 6"');
  await menu.getByRole('button', { name: /^Reset to / }).click();
  await expect(snapButton).toContainText('grid ½"');
  await menu.getByRole('switch', { name: 'Snap' }).click();
  await expect(snapButton).toContainText('Snap · off');
  await menu.getByRole('switch', { name: 'Snap' }).click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(snapButton).toBeFocused();

  // ── The measure tool, ⇧M: the cooktop, the sink, the fridge, and the cooktop again — an area.
  // The kitchen, framed: the island selected, zoomed to, a step out, and let go.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).first().click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit2');
  await still(page);
  // The kitchen selected: its clear width and depth, between its walls.
  await expect(page.getByRole('group', { name: 'Temporary dimensions of Kitchen' }).locator('[data-dim="room:x"]')).toHaveAccessibleName(/^Width: /);
  await shoot(page, 'kitchen-room');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+M');
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await expect(rail.getByRole('button', { name: 'Measure' })).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'Measurement' });
  await expect(panel).toContainText('Measure · point to point');
  const cooktop = await centreOf(page, '[data-furniture="KIT-COOKTOP"]');
  const sink = await centreOf(page, '[data-device="KIT-SINK"]');
  const fridge = await centreOf(page, '[data-furniture="KIT-FRIDGE"]');
  for (const p of [cooktop, sink, fridge]) {
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.click(p.x, p.y);
  }
  await expect(panel).toContainText('Measure · chained');
  await expect(panel.locator('.fs-measurepanel__row--total')).toBeVisible();
  await page.mouse.move(cooktop.x, cooktop.y, { steps: 3 });
  await page.mouse.click(cooktop.x, cooktop.y);
  await expect(panel).toContainText('Measure · area');
  await expect(panel.locator('.fs-measurepanel__row')).toHaveCount(5);
  await expect(panel).toContainText('Area enclosed');
  await expect(panel).toContainText('Cooktop → kitchen sink');
  await expect(panel).toContainText(/work-triangle guideline/);
  await expect(panel.getByRole('button', { name: 'Keep as a dimension' })).toBeDisabled();
  await shoot(page, 'measure-triangle');
  await axe(page, '[data-testid="measure-panel"]');
  await page.keyboard.press('Escape');
  await expect(panel).toContainText('Measure · point to point');
  await page.keyboard.press('Escape');
  await expect(rail.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');

  // ── ⌥ held over the island: its distances to its neighbours.
  const island = await centreOf(page, '[data-furniture="KIT-ISLAND"]');
  const islandBox = (await page.locator('[data-furniture="KIT-ISLAND"]').boundingBox())!;
  await page.mouse.move(islandBox.x + 4, island.y, { steps: 3 });
  await page.keyboard.down('Alt');
  await page.mouse.move(islandBox.x + 6, island.y + 2);
  await expect(page.locator('.fs-althint')).toContainText(/held over .* — distances to its neighbours/);
  expect(await page.locator('.fs-altdim__value').count()).toBeGreaterThanOrEqual(2);
  await shoot(page, 'alt-island');
  await page.keyboard.up('Alt');
  await expect(page.locator('.fs-althint')).toHaveCount(0);

  // ── The island selected: to the nearest wall or item each way.
  await page.mouse.click(islandBox.x + 4, island.y);
  await expect(page.getByRole('group', { name: /^Temporary dimensions of Kitchen island/ }).getByRole('button')).not.toHaveCount(0);
  await shoot(page, 'island-dimensions');

  // ── A mode brings its own snapping: Construction lays out on 6".
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Alt+Digit1');
  await expect(snapButton).toContainText('grid 6"');
});
