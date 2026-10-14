/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-18.3: trade modes, after the board's "18.3" frames. The Courtyard House is imported and
 * opened with every layer, as before modes. The switcher in the top bar puts it in Electrical: the
 * building turns to a grey ghost, the other trades go, the rail offers the electrical devices, the
 * status bar says so — and a click on the ghosted kitchen island goes through it until the Layers
 * drawer turns casework back On. ⌥1 is Construction, the command palette reaches Plumbing, the mode
 * menu previews every mode on this plan and picks Decorator, and the current layers are saved as a
 * mode of one's own, which a reload remembers. Full screen's HUD and top drawer carry the mode. The
 * plan render takes a mode, and a PDF of the electrical plan is made from the inspector. axe runs in
 * both themes on the switcher, the menu, the Layers drawer and the save dialog; screenshots of every
 * mode land in test-results/modes-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MODES = ['construction', 'decorator', 'electrical', 'plumbing', 'mechanical', 'lowvoltage', 'landscape'] as const;
const LABELS: Record<(typeof MODES)[number], string> = { construction: 'Construction', decorator: 'Decorator', electrical: 'Electrical', plumbing: 'Plumbing', mechanical: 'Mechanical', lowvoltage: 'Low-voltage', landscape: 'Landscape' };

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

/** Screenshots in both themes; axe too, scoped when asked. */
async function shoot(page: Page, name: string, axe: string | null = null): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await still(page);
    await page.screenshot({ path: `test-results/modes-${name}-${theme}.png` });
    if (axe !== null) {
      const builder = new AxeBuilder({ page }).withTags(TAGS);
      const results = await (axe === '' ? builder : builder.include(axe)).analyze();
      expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${name} (${theme})`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('trade modes: the switcher, ghosts that are not picked, keys, the palette, the menu, a mode of one’s own, full screen, render and PDF — axe in both themes', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Trades', email: 'trades@example.test', password: password('modes') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const switcher = page.getByRole('group', { name: 'Mode' });
  const canvas = page.locator('.fs-canvas');
  const rail = page.getByRole('navigation', { name: 'Tools' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const status = page.locator('.fs-statusbar');
  const layer = (name: string) => page.getByRole('radiogroup', { name: `${name} layer` });

  // ── No mode: every layer as the editor has always opened; no ghosts; the whole rail.
  for (const m of MODES) await expect(switcher.getByRole('button', { name: `${LABELS[m]} mode` })).toHaveAttribute('aria-pressed', 'false');
  await expect(canvas).not.toHaveAttribute('data-ghost');
  await expect(rail.getByRole('button', { name: 'Draw walls' })).toBeVisible();
  await expect(layer('Walls').getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');

  // ── Electrical, from the switcher: layers, dimming, rail and inspector in one step.
  await switcher.getByRole('button', { name: 'Electrical mode' }).click();
  await expect(switcher.getByRole('button', { name: 'Electrical mode' })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveAttribute('data-ghost', /\bwalls\b/);
  await expect(canvas).toHaveAttribute('data-ghost', /\bcasework\b/);
  await expect(layer('Walls').getByRole('radio', { name: 'Ghost' })).toHaveAttribute('aria-checked', 'true');
  await expect(layer('Plumbing').getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.fs-sym--plumbing')).toHaveCount(0);
  await expect(page.locator('.fs-sym--electrical').first()).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Place a receptacle' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Draw walls' })).toHaveCount(0);
  await expect(status).toContainText('Electrical mode');
  await expect(inspector.getByRole('region', { name: 'Electrical summary' })).toContainText('Receptacle');
  // The walls are drawn grey and faint.
  const ghostWalls = await page.locator('.fs-plan2__walls').first().evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(ghostWalls)).toBeLessThan(0.5);
  await shoot(page, 'electrical', '');

  // ── A ghost is not picked: the island goes unselected until casework is On again.
  const island = page.locator('[data-furniture="KIT-ISLAND"]');
  const box = (await island.boundingBox())!;
  const spot = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 };
  await page.mouse.click(spot.x, spot.y);
  await expect(inspector.getByRole('heading', { level: 2, name: /Kitchen island|Cooktop/ })).toHaveCount(0);
  await layer('Casework').getByRole('radio', { name: 'On' }).click();
  await expect(page.locator('.fs-layers__row').filter({ hasText: 'Casework' }).locator('.fs-layers__dot')).toBeVisible();
  await page.mouse.click(spot.x, spot.y);
  await expect(inspector.getByRole('heading', { level: 2, name: /Kitchen island|Cooktop/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Reset puts the preset back.
  await page.locator('.fs-layers__preset').getByRole('button', { name: 'Reset' }).click();
  await expect(layer('Casework').getByRole('radio', { name: 'Ghost' })).toHaveAttribute('aria-checked', 'true');

  // ── ⌥1: Construction — walls drawn, furniture gone, the drawing tools on the rail.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Alt+Digit1');
  await expect(switcher.getByRole('button', { name: 'Construction mode' })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).not.toHaveAttribute('data-ghost', /\bwalls\b/);
  await expect(page.locator('[data-furniture][data-layer="furniture"]')).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Draw walls' })).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Construction summary' })).toContainText('Doors');

  // ── The command palette lists the modes: Plumbing.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('Plumbing mode');
  await page.keyboard.press('Enter');
  await expect(switcher.getByRole('button', { name: 'Plumbing mode' })).toHaveAttribute('aria-pressed', 'true');

  // ── The mode menu: each mode previewed on this plan; Decorator chosen from it.
  await page.getByRole('button', { name: 'Modes menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(9); // seven modes, save, show every layer
  await expect(menu.locator('svg.fs-mode-thumb')).toHaveCount(7);
  await shoot(page, 'menu', '[role="menu"]');
  await menu.getByRole('menuitem', { name: /Decorator/ }).click();
  await expect(switcher.getByRole('button', { name: 'Decorator mode' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-furniture]').first()).toBeVisible();

  // ── Every mode, shot in both themes.
  for (const m of MODES) {
    await switcher.getByRole('button', { name: `${LABELS[m]} mode` }).click();
    await expect(status).toContainText(`${LABELS[m]} mode`);
    await shoot(page, m);
  }

  // ── A mode of one's own: the current layers saved, named, and remembered across a reload.
  await switcher.getByRole('button', { name: 'Plumbing mode' }).click();
  await layer('Casework').getByRole('radio', { name: 'On' }).click();
  await page.getByRole('button', { name: 'Modes menu' }).click();
  await page.getByRole('menuitem', { name: 'Save the current layers as a new mode…' }).click();
  const save = page.getByRole('dialog', { name: 'Save the current layers as a new mode' });
  await save.getByRole('textbox').fill('Kitchen remodel');
  await shoot(page, 'save', '[role="dialog"]');
  await save.getByRole('button', { name: 'Save mode' }).click();
  await expect(status).toContainText('Kitchen remodel mode');
  await page.reload();
  await settled(page);
  await expect(status).toContainText('Kitchen remodel mode');
  await expect(layer('Casework').getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
  await shoot(page, 'layers', '.fs-editor__tree');

  // ── Full screen: the HUD carries the mode; the top drawer shows every mode's name.
  await switcher.getByRole('button', { name: 'Electrical mode' }).click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('f');
  await expect(page.locator('.fs-editor')).toHaveAttribute('data-chrome', 'full');
  await expect(page.locator('.fs-hud')).toContainText('Electrical');
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  await expect(page.locator('[data-drawer="top"]')).not.toHaveAttribute('data-state', 'hidden');
  await expect(page.locator('[data-drawer="top"] .fs-modes__label').filter({ hasText: 'Landscape' })).toBeVisible();
  await shoot(page, 'fullscreen-top-drawer', '[data-drawer="top"]');
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await expect(page.locator('.fs-editor')).toHaveAttribute('data-chrome', 'windowed');

  // ── The plan render takes a mode (floorspec_render's `mode`).
  const plain = await page.request.get(`/api/projects/${project}/render?width=600`);
  const electrical = await page.request.get(`/api/projects/${project}/render?width=600&mode=electrical`);
  expect(electrical.status()).toBe(200);
  expect(electrical.headers()['content-type']).toBe('image/png');
  expect(Buffer.compare(await plain.body(), await electrical.body())).not.toBe(0);

  // ── The electrical plan as a PDF, from the inspector's lead: the drawing chosen is the mode's.
  await inspector.getByRole('button', { name: 'Export the electrical plan (PDF)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Courtyard House' });
  await expect(dialog.getByRole('combobox', { name: 'Drawing' })).toContainText('Electrical plan');
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(file.suggestedFilename()).toMatch(/-electrical-plans\.pdf$/);
});
