/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-16.4: the thermal envelope of the Courtyard House in Atlanta (courtyard-house-envelope.json) — the
 * P16 board's "16.4 · Wall type — layer by layer", "16.4 · Heat loss room by room" and "16.4 · Heat-loss
 * map in 3D" frames.
 *
 * The kitchen wall (W24) is chosen in the project tree, and its type opened layer by layer: the section,
 * each layer with its R, the cavity and the framing in parallel, the effective R and U, the thermal mass,
 * and brick tried in the siding's place showing what it does to the house. The Kitchen's heat loss and
 * gain part by part, as ranges, with the method named. The heat-loss map in 3D: the envelope coloured by
 * band, its panel with the shares and the whole house's loads. The energy screen's room-by-room table.
 * Never "compliant"; axe in both themes. Screenshots: test-results/envelope-*.png (and FLR164_SHOTS, when set).
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house-envelope.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
type Hook = { __floorspec3d?: { ready: boolean; screenPoint(id: string): { x: number; y: number } | null }; __floorspecHeatLoss?: { triangles: number; bands: Record<string, number> } };

async function themeSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
      }));
    }),
    undefined,
    { timeout: 30_000, polling: 250 },
  );
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(600);
    await themeSettled(page);
    const path = `test-results/envelope-${name}-${theme}.png`;
    await page.screenshot({ path });
    const out = process.env['FLR164_SHOTS'];
    if (out !== undefined && out !== '') {
      mkdirSync(out, { recursive: true });
      copyFileSync(path, `${out}/envelope-${name}-${theme}.png`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(800);
    await themeSettled(page);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the envelope: the kitchen wall type layer by layer, brick tried in the siding’s place, the Kitchen’s heat loss by part, the heat-loss map in 3D, the energy screen’s rooms — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Envelope', email: 'envelope@example.test', password: password('envelope') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House envelope') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── The kitchen wall, from the tree, and its type layer by layer.
  const walls = page.getByRole('treeitem', { name: /^Walls/ }).first();
  if ((await walls.getAttribute('aria-expanded')) !== 'true') await walls.click();
  await page.getByRole('treeitem', { name: /^Wall W24\b/ }).click();
  await inspector.getByRole('button', { name: 'Wall type, layer by layer' }).click();
  const type = inspector.getByRole('region', { name: 'Thermal · layer by layer' });
  await expect(type).toBeVisible();
  await expect(type.getByRole('list', { name: 'At a glance' })).toContainText(/R-\d+ effective/);
  await expect(type.getByRole('list', { name: 'At a glance' })).toContainText('framing 23%');
  const layers = type.getByRole('list', { name: /^Layers of 2x6 exterior wall, fibre-cement siding, outside in$/ });
  await expect(layers.getByRole('listitem')).toHaveCount(5);
  await expect(layers.getByRole('listitem').first()).toContainText('Fibre-cement lap siding');
  await expect(layers.getByRole('listitem').first()).toContainText(/R-0\.\d/);
  const drawing = type.getByRole('img', { name: /^Section through 2x6 exterior wall, fibre-cement siding/ });
  await expect(drawing).toBeVisible();
  expect((await drawing.boundingBox())!.width).toBeGreaterThan(200);
  await expect(type.getByText(/Through the cavity · 77%/)).toBeVisible();
  await expect(type.getByText(/Through the framing · 23%/)).toBeVisible();
  await expect(type.getByTestId('wall-type-effective')).toContainText(/R-\d+ · U-0\.0\d+/);
  await expect(type).toContainText('Thermal mass');
  await expect(type).toContainText('ASHRAE parallel-path method');
  await expect(type).not.toContainText(/compliant/i);
  await shoot(page, 'wall-type');
  await axe(page, 'the kitchen wall type, layer by layer');

  // ── Brick tried in the siding's place: the wall's R and the house's heating, before and after.
  const tryLayer = type.locator('[data-region="try-layer"]');
  await tryLayer.getByRole('combobox', { name: 'Material to try' }).click();
  await page.getByRole('option', { name: 'Brick, common' }).click();
  const compare = tryLayer.getByRole('status');
  await expect(compare).toContainText(/This wall\s*R-\d+ → R-\d+/);
  await expect(compare).toContainText(/The house, heating\s*\d+–\d+ kBtu\/h → \d+–\d+ kBtu\/h/);
  await expect(compare).toContainText('Advisory');

  // ── The Kitchen: its heat loss and gain, part by part.
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).click();
  const room = inspector.getByRole('region', { name: 'Heat loss and gain' });
  await expect(room).toBeVisible();
  await expect(room).toContainText('Atlanta, zone 3A');
  await expect(room).toContainText(/Heating · design day, \d+ °F/);
  await expect(room.getByTestId('room-heating')).toContainText(/Heating, this room\s*[\d,]+–[\d,]+ Btu\/h/);
  await expect(room.getByTestId('room-cooling')).toContainText(/Cooling, this room\s*[\d,]+–[\d,]+ Btu\/h/);
  await expect(room).toContainText(/Walls · R-\d+/);
  await expect(room).toContainText(/Cooling · Jul 21, \d+ (am|pm)/);
  await expect(room).toContainText('Manual J-style');
  await expect(room).not.toContainText(/compliant/i);
  await shoot(page, 'room');
  await axe(page, 'the Kitchen’s heat loss and gain');

  // ── The heat-loss map in 3D.
  await room.getByRole('button', { name: 'See the heat-loss map in 3D' }).click();
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__floorspecHeatLoss?.triangles ?? 0), { timeout: 60_000 }).toBeGreaterThan(100);
  const bands = await page.evaluate(() => (window as unknown as Hook).__floorspecHeatLoss!.bands);
  expect(bands['high'] ?? 0).toBeGreaterThan(0);
  expect(bands['low'] ?? 0).toBeGreaterThan(0);
  const panel = page.locator('[data-region="heat-loss-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Share of the heating load');
  await expect(panel).toContainText('Windows');
  await expect(panel.getByTestId('house-heating')).toContainText(/Heating design load\s*\d+–\d+ kBtu\/h/);
  await expect(panel).toContainText('High');
  await expect(panel).toContainText('Advisory');
  await expect(page.getByRole('toolbar', { name: 'Experiences' }).getByRole('button', { name: 'Heat-loss map' })).toHaveAttribute('aria-pressed', 'true');
  // Closer: wheel in over the kitchen wall, for the picture.
  const at = await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.screenPoint('W24'));
  if (at !== null) {
    await page.mouse.move(at.x, at.y);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -240);
    await page.waitForTimeout(800);
  }
  await shoot(page, 'map-3d');
  await axe(page, 'the heat-loss map in 3D');

  // ── The energy screen: heat loss room by room.
  await page.goto(`/projects/${project}/energy`);
  await expect(page.getByRole('heading', { name: 'Energy & comfort', level: 1 })).toBeVisible();
  const rooms = page.getByRole('table', { name: /^Heating and cooling for each room on the design days/ });
  await expect(rooms).toBeVisible();
  await expect(rooms.getByRole('row', { name: /^Kitchen/ })).toContainText(/[\d,]+–[\d,]+ Btu\/h/);
  await expect(rooms.getByRole('row', { name: /^Great room/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Assemblies · layer by layer' })).toBeVisible();
  await expect(page.locator('[aria-labelledby="fs-energy-climate"]')).toContainText('Atlanta, GA · zone 3A');
  await expect(page.getByRole('main')).not.toContainText(/compliant/i);
  await shoot(page, 'energy');
  await axe(page, 'the energy screen, room by room');
});
