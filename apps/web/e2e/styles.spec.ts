import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-18.5: plan styles, after the board's "18.5" frames. The Courtyard House opens in Colour: each
 * room in its floor finish (white oak, porcelain, terrazzo, epoxy) with its pattern at true scale,
 * names on pills. The style menu in the top bar switches to Presentation, Technical and Blueprint;
 * Construction mode draws Technical by default with its wall-type legend, and a style chosen there
 * stays with Construction. The inspector's Plan style section turns a detail off, chooses a style for
 * exports only, and exports a still; the plan render takes a style; the choice survives a reload.
 * axe runs in both themes on the canvas with its labels, the menu and the section; screenshots of
 * every style in both themes land in test-results/styles-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STYLES = ['colour', 'presentation', 'technical', 'blueprint'] as const;
const LABELS: Record<(typeof STYLES)[number], string> = { colour: 'Colour', presentation: 'Presentation', technical: 'Technical', blueprint: 'Blueprint' };

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string, axe: string | null = null): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.fs-canvas')).toHaveAttribute('data-plan-theme', theme);
    await still(page);
    await page.screenshot({ path: `test-results/styles-${name}-${theme}.png` });
    if (axe !== null) {
      const builder = new AxeBuilder({ page }).withTags(TAGS);
      const results = await (axe === '' ? builder : builder.include(axe)).analyze();
      expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${name} (${theme})`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function choose(page: Page, style: (typeof STYLES)[number]): Promise<void> {
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: /^Plan style: / }).click();
  const item = page.getByRole('menuitem', { name: new RegExp(`^${LABELS[style]}`) });
  await expect(item).toBeVisible();
  await still(page);
  await item.click();
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-plan-style', style);
}

test('plan styles: Colour by default, the menu, Construction’s Technical and legend, details, exports only, a still, the render — axe in both themes', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Styles', email: 'styles@example.test', password: password('styles') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const canvas = page.locator('.fs-canvas');

  // ── Colour by default: the great room in white oak at true scale, the kitchen in terrazzo, names on pills.
  await expect(canvas).toHaveAttribute('data-plan-style', 'colour');
  await expect(page.getByRole('button', { name: 'Plan style: Colour' })).toBeVisible();
  await expect(canvas.locator('path[data-floor="white-oak-floor"]').first()).toHaveAttribute('style', /url\("?#fsx-floor-white-oak-floor"?\)/);
  await expect(canvas.locator('pattern#fsx-floor-terrazzo')).toHaveCount(1);
  await expect(canvas.locator('.fs-plan2__pill').first()).toBeVisible();
  await expect(canvas.locator('[data-wall-class="exterior"]').first()).toBeAttached();
  // The styles are shown in Decorator mode, as the board shows them: floors and furniture, no trades.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Decorator mode' }).click();
  await expect(canvas).toHaveAttribute('data-plan-style', 'colour');
  // …with the walls and the garden drawn rather than ghosted, as the board's colour plan has them.
  const layer = (name: string) => page.getByRole('radiogroup', { name: `${name} layer` });
  await layer('Walls').getByRole('radio', { name: 'On' }).click();
  await layer('Landscape').getByRole('radio', { name: 'On' }).click();
  await expect(canvas).not.toHaveAttribute('data-ghost', /\bwalls\b/);
  await shoot(page, 'colour', '.fs-canvas');
  // Close in, the floors' patterns read at their true size: boards, tile, terrazzo, pavers.
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  for (let i = 0; i < 3; i++) await zoomIn.click();
  await shoot(page, 'colour-close', null);
  await page.keyboard.press('Shift+Digit1');

  // ── The menu: each style in turn.
  await page.getByRole('button', { name: /^Plan style: / }).click();
  for (const s of STYLES) await expect(page.getByRole('menuitem', { name: new RegExp(`^${LABELS[s]}`) })).toBeVisible();
  await shoot(page, 'menu', '[role="menu"]');
  await page.keyboard.press('Escape');
  await choose(page, 'presentation');
  await expect(canvas.locator('.fs-plan2__walls').first()).toHaveCSS('filter', /drop-shadow/);
  await shoot(page, 'presentation', '.fs-canvas');
  await choose(page, 'technical');
  await expect(canvas.locator('pattern#fsx-wall-hatch')).toHaveCount(1);
  await expect(canvas.locator('path[data-grid]').first()).toBeAttached();
  await expect(canvas.locator('.fs-plan2__pill')).toHaveCount(0);
  await expect(canvas.locator('.fs-plan2__name', { hasText: 'GREAT ROOM' })).toBeVisible();
  await shoot(page, 'technical', '.fs-canvas');
  await choose(page, 'blueprint');
  await expect(canvas).toHaveCSS('background-color', 'rgb(29, 76, 138)');
  await shoot(page, 'blueprint', '.fs-canvas');
  await choose(page, 'colour');

  // ── Construction mode draws Technical by default, walls by type with the legend; its choice is its own.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Construction mode' }).click();
  await expect(canvas).toHaveAttribute('data-plan-style', 'technical');
  const legend = page.getByRole('group', { name: 'Wall types' });
  await expect(legend).toContainText('2x6 exterior wall, brick veneer');
  await expect(legend).toContainText('Door leaves and swings');
  await expect(canvas.locator('[data-wall-type="wall-2x6-exterior-brick-veneer"]').first()).toBeAttached();
  await shoot(page, 'construction', '.fs-wall-legend');
  await choose(page, 'blueprint');
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Decorator mode' }).click();
  await expect(canvas).toHaveAttribute('data-plan-style', 'colour');
  await expect(legend).toHaveCount(0);

  // ── The inspector's Plan style section: a detail off, a style for exports only.
  await page.keyboard.press('Escape');
  const section = page.getByRole('region', { name: 'Plan style' });
  await expect(section.getByRole('radio', { name: /^Colour/ })).toHaveAttribute('aria-checked', 'true');
  await section.getByRole('switch', { name: 'Floor patterns to scale' }).click();
  await expect(canvas.locator('pattern[id^="fsx-floor-"]')).toHaveCount(0);
  await expect(canvas.locator('path[data-floor="white-oak-floor"]').first()).toHaveAttribute('style', /fill: rgb\(185, 162, 131\)/);
  await section.getByRole('switch', { name: 'Floor patterns to scale' }).click();
  await shoot(page, 'section', '#fs-plan-style');
  await section.getByRole('radio', { name: 'PDF export only' }).click();
  await section.getByRole('radio', { name: /^Presentation/ }).click();
  await expect(canvas).toHaveAttribute('data-plan-style', 'colour');
  await expect(section.getByRole('radio', { name: /^Presentation/ })).toHaveAttribute('aria-checked', 'true');

  // ── A still of the plan, from the plan render in this style.
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), section.getByRole('button', { name: 'Export a still (PNG)' }).click()]);
  expect(file.suggestedFilename()).toMatch(/-presentation-plan\.png$/);

  // ── The plan render takes a style (floorspec_render's `style`); Construction draws Technical unless told.
  const plain = await page.request.get(`/api/projects/${project}/render?width=600`);
  const colour = await page.request.get(`/api/projects/${project}/render?width=600&style=colour`);
  expect(colour.status()).toBe(200);
  expect(colour.headers()['content-type']).toBe('image/png');
  expect(Buffer.compare(await colour.body(), await plain.body())).not.toBe(0);
  expect((await page.request.get(`/api/projects/${project}/render?style=sepia`)).status()).toBe(400);

  // ── Remembered for this project: a reload keeps Decorator's Colour, Construction's Blueprint, the export's Presentation.
  await page.reload();
  await settled(page);
  await expect(canvas).toHaveAttribute('data-plan-style', 'colour');
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Construction mode' }).click();
  await expect(canvas).toHaveAttribute('data-plan-style', 'blueprint');
});
