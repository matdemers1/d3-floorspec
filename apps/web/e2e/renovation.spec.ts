/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, modelOf, password, settled } from './support.js';

/**
 * FLR-T-18.13: renovation plans, on a kitchen remodel of the Courtyard House (FS_renovation 0.1.0) —
 * the pantry's walls, door and room and the old cabinets, refrigerator and island to come down; a new
 * feature wall, window, island, cabinets and refrigerator. The Renovation menu beside the plan style
 * switches the plan between Existing, Demolition, Proposed and Combined: the existing plan has the
 * pantry and none of the new work, the demolition plan dashes what goes, the proposed plan has the
 * kitchen with the pantry's floor and the new work in solid poché, the combined plan all three, each
 * with its legend. Two base cabinets marked "To demolish" from the multi-select inspector are one
 * batch, and one undo; the 3D view shows the demolition plan's state with what goes ghosted in red;
 * the plan render and the PDF and DXF exports take the filter. axe runs on the menu and the legend in
 * both themes. Screenshots land in test-results/renovation-*.png.
 */

const REMODEL = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-remodel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LABELS = { existing: 'Existing', demolition: 'Demolition', proposed: 'Proposed', combined: 'Combined' } as const;

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function choose(page: Page, filter: keyof typeof LABELS, plan = true): Promise<void> {
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: /^Renovation plan: / }).click();
  const item = page.getByRole('menuitem', { name: new RegExp(`^${LABELS[filter]}`) });
  await expect(item).toBeVisible();
  await still(page);
  await item.click();
  if (plan) await expect(page.locator('.fs-canvas')).toHaveAttribute('data-renovation-filter', filter);
  else await expect(page.getByRole('button', { name: `Renovation plan: ${LABELS[filter]}` })).toBeVisible();
  await still(page);
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('renovation plans: Existing, Demolition, Proposed and Combined in the plan and 3D, statuses from the inspector, the render and the drawings — axe in both themes', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Remodeller', email: 'remodel@example.test', password: password('remodel') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard remodel') },
    data: Buffer.from(JSON.stringify(REMODEL)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const canvas = page.locator('.fs-canvas');
  // Decorator mode, as a homeowner's remodel is drawn: walls, floors and furniture, the trades ghosted.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Decorator mode' }).click();
  await page.getByRole('radiogroup', { name: 'Walls layer' }).getByRole('radio', { name: 'On' }).click();
  // The kitchen framed: picked in the tree, zoomed to (⇧2), the selection let go.
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).first().click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit2');
  await still(page);
  await page.keyboard.press('Escape');

  // ── Combined by default: the pantry's walls dashed, the feature wall in solid poché, existing work subdued, a legend.
  await expect(canvas).toHaveAttribute('data-renovation-filter', 'combined');
  await expect(page.getByRole('button', { name: 'Renovation plan: Combined' })).toBeVisible();
  await expect(canvas.locator('.fs-plan2__wall--demolished')).toHaveCount(1);
  await expect(canvas.locator('.fs-plan2__wall--new')).toHaveCount(1);
  await expect(canvas.locator('.fs-reno-existing').first()).toBeAttached();
  await expect(canvas.locator('style[data-renovation-css]')).toContainText('[data-furniture="KIT-ISLAND"]');
  const legend = page.getByRole('note', { name: 'Combined plan legend' });
  await expect(legend).toContainText('Existing');
  await expect(legend).toContainText('To demolish');
  await expect(legend).toContainText('New');
  await page.screenshot({ path: 'test-results/renovation-combined.png' });

  // ── Existing: the house as it stands — the pantry a room, none of the new work, no legend.
  await choose(page, 'existing');
  await expect(canvas.locator('[data-room-face="R9"]')).toHaveCount(1);
  await expect(canvas.locator('[data-furniture="KIT-ISLAND-N"]')).toHaveCount(0);
  await expect(canvas.locator('.fs-plan2__wall--new')).toHaveCount(0);
  await expect(canvas.locator('.fs-plan2__wall--demolished')).toHaveCount(0);
  await expect(page.locator('.fs-reno-legend')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/renovation-existing.png' });

  // ── Demolition: the same house, what comes down dashed in red.
  await choose(page, 'demolition');
  await expect(canvas.locator('.fs-plan2__wall--demolished')).toHaveCount(1);
  await expect(canvas.locator('[data-furniture="KIT-FRIDGE"]')).toHaveCount(1);
  await expect(canvas.locator('[data-furniture="KIT-FRIDGE-N"]')).toHaveCount(0);
  await expect(canvas.locator('[data-room-label="R9"]')).toContainText('TO DEMOLISH');
  await expect(page.getByRole('note', { name: 'Demolition plan legend' })).not.toContainText('New');
  await page.screenshot({ path: 'test-results/renovation-demolition.png' });

  // ── Proposed: the kitchen with the pantry's floor, the new work in solid poché, nothing demolished.
  await choose(page, 'proposed');
  await expect(canvas.locator('[data-room-face="R9"]')).toHaveCount(0);
  await expect(canvas.locator('.fs-plan2__wall--demolished')).toHaveCount(0);
  await expect(canvas.locator('.fs-plan2__wall--new')).toHaveCount(1);
  await expect(canvas.locator('[data-furniture="KIT-FRIDGE-N"]')).toHaveCount(1);
  await expect(canvas.locator('[data-furniture="KIT-ISLAND"]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/renovation-proposed.png' });

  // ── axe on the menu and the legend, in both themes.
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByRole('button', { name: /^Renovation plan: / }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await still(page);
    await page.screenshot({ path: `test-results/renovation-menu-${theme}.png` });
    const menu = await new AxeBuilder({ page }).withTags(TAGS).include('[role="menu"]').analyze();
    expect.soft(menu.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `menu (${theme})`).toEqual([]);
    await page.keyboard.press('Escape');
    const legendAxe = await new AxeBuilder({ page }).withTags(TAGS).include('.fs-reno-legend').analyze();
    expect.soft(legendAxe.violations.map((v) => `${v.id}: ${v.help}`), `legend (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // ── Two existing base cabinets marked "To demolish" from the multi-select inspector: one batch, one undo.
  await choose(page, 'combined');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const b0 = await centreOf(page, '[data-furniture="KIT-B0"]');
  const b1 = await centreOf(page, '[data-furniture="KIT-B1"]');
  await page.mouse.click(b0.x, b0.y);
  await expect(inspector.getByRole('combobox', { name: 'Renovation' })).toContainText('Existing');
  await page.keyboard.down('Shift');
  await page.mouse.click(b1.x, b1.y);
  await page.keyboard.up('Shift');
  await expect(inspector).toContainText('2 items');
  const field = inspector.getByRole('combobox', { name: 'Renovation' });
  await field.click();
  await page.getByRole('option', { name: 'To demolish' }).click();
  await expect(field).toContainText('To demolish');
  await expect(canvas.locator('style[data-renovation-css]')).toContainText('[data-furniture="KIT-B1"]');
  const model = (await modelOf(page, project)) as unknown as { extensions: { FS_renovation: { elements: Record<string, string> } } };
  expect(model.extensions.FS_renovation.elements['KIT-B0']).toBe('demolish');
  expect(model.extensions.FS_renovation.elements['KIT-B1']).toBe('demolish');
  await page.screenshot({ path: 'test-results/renovation-multi.png' });
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).toContainText('Existing');

  // ── The plan render takes the filter; a 3D render refuses it.
  const render = await page.request.get(`/api/projects/${project}/render?renovation=demolition`);
  expect(render.status(), await render.text()).toBe(200);
  expect(render.headers()['content-type']).toBe('image/png');
  const refused = await page.request.get(`/api/projects/${project}/render?view=3d&renovation=demolition`);
  expect(refused.status()).toBe(400);

  // ── The PDF in the demolition plan, from the Export dialog's Renovation choice.
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: /^Export / });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('combobox', { name: 'Renovation plan' }).click();
  await page.getByRole('option', { name: /^Demolition plan/ }).click();
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export' }).click()]);
  expect(file.suggestedFilename()).toMatch(/demolition-plans\.pdf$/);
  await file.saveAs('test-results/renovation-demolition.pdf');

  // ── 3D: the demolition plan's state, what goes ghosted in red.
  await choose(page, 'demolition');
  const views = page.getByRole('radiogroup', { name: 'View' });
  await views.getByRole('radio', { name: '3D' }).click();
  await expect(page).toHaveURL(/[?&]view=3d\b/);
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await still(page);
  await page.screenshot({ path: 'test-results/renovation-3d-demolition.png' });
  await choose(page, 'proposed', false);
  await still(page);
  await page.screenshot({ path: 'test-results/renovation-3d-proposed.png' });
});
