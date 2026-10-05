/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { check } from '@floorspec/engine';
import { count, firstRunSetup, FT, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-7.2, 7.3: a roof and a stair drawn in the editor, checked through the model the server
 * holds (`model.json`) and the values the engine derives from it. A blank project gets a 20 ft ×
 * 12 ft room on Level 1 and a Level 2 above it; the stair tool places an L stair — its foot, then the
 * way it rises — that rises to Level 2; the roof tool roofs the walls as a 6:12 hip.
 */

interface Camera {
  at: (x: number, y: number) => { x: number; y: number };
}

/** An empty level is framed by viewport.ts's `fit(null, w, h)`: 40 ft × 28 ft around the origin, 72 px of padding. */
async function cameraOf(svg: Locator): Promise<Camera> {
  const box = await svg.boundingBox();
  if (box === null) throw new Error('the plan canvas has no box');
  const s = Math.min((box.width - 144) / (40 * FT), (box.height - 144) / (28 * FT));
  return { at: (x, y) => ({ x: box.x + box.width / 2 + x * s, y: box.y + box.height / 2 - y * s }) };
}

async function click(page: Page, camera: Camera, x: number, y: number): Promise<void> {
  const p = camera.at(x, y);
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

interface Derived {
  roofs: Record<string, { kind: string; surface: { faces: unknown[]; lines: { kind: string }[] } | null }>;
  stairs: Record<string, { risers: number; riserHeight: number; rise: number; steps?: { landing?: boolean }[]; walkline?: { points: unknown[] }; footRoom?: string }>;
}

test('a hip roof over the walls and an L stair to the level above, as the model holds them', async ({ page }) => {
  await firstRunSetup(page, { name: 'Roofs and stairs', email: 'roofs@example.test', password: password('roofs') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill('Roof and stair house');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  await page.getByRole('button', { name: 'Open editor' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor$`));
  await page.getByRole('button', { name: 'Add Level 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');
  await settled(page);

  // Level 2 above it, added while both are empty; then back to Level 1, framed as an empty level.
  await page.getByRole('button', { name: 'Add a level' }).click();
  await expect.poll(async () => count((await modelOf(page, project)).levels)).toBe(2);
  await settled(page);
  const levelPicker = page.getByRole('combobox', { name: 'Level' });
  if (!((await levelPicker.textContent()) ?? '').includes('Level 1')) {
    await levelPicker.click();
    await page.getByRole('option', { name: /Level 1/ }).click();
  }
  await expect(levelPicker).toContainText('Level 1');

  // A 20 ft × 12 ft room around the origin, named.
  const svg = page.getByRole('application', { name: /^Plan of / });
  const camera = await cameraOf(svg);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  for (const [x, y] of [[-10, -6], [10, -6], [10, 6], [-10, 6], [-10, -6]] as const) await click(page, camera, x * FT, y * FT);
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Name a room' }).click();
  await click(page, camera, 5 * FT, 3 * FT);
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  await settled(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ── The stair tool: an L stair turning left, its foot at (−8 ft, −4 ft), rising east.
  await rail.getByRole('button', { name: 'Place a stair' }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Place a stair' })).toBeVisible();
  await inspector.getByRole('radio', { name: 'L', exact: true }).click();
  await click(page, camera, -8 * FT, -4 * FT);
  await click(page, camera, 0, -4 * FT);
  await expect.poll(async () => count((await modelOf(page, project)).stairs)).toBe(1);
  await settled(page);
  let doc = await modelOf(page, project);
  const [stairId, stair] = Object.entries(doc.stairs ?? {})[0]!;
  const level1 = Object.entries(doc.levels ?? {}).find(([, l]) => l.name === 'Level 1')![0];
  expect(stair).toMatchObject({ level: level1, position: [-8 * FT, -4 * FT], form: { kind: 'lShaped', turn: 'left' } });
  expect(stair.rotation ?? 0).toBe(0);
  await expect(inspector.getByText('Derived')).toBeVisible();
  await expect(svg.locator(`[data-stair="${stairId}"] .fs-stair__step`).first()).toBeVisible();

  // ── The roof tool's "Roof over the walls": a 6:12 hip on the outside faces of the walls.
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Draw a roof' }).click();
  await inspector.getByRole('button', { name: 'Roof over the walls' }).click();
  await expect.poll(async () => count((await modelOf(page, project)).roofs)).toBe(1);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Roof', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(svg.locator('.fs-plan2__roofs .fs-roof__line--ridge')).toHaveCount(1);

  // ── What the server holds, and what the engine derives from it.
  doc = await modelOf(page, project);
  const roof = Object.values(doc.roofs ?? {})[0]!;
  expect(roof).toMatchObject({ level: level1, pitch: { rise: 6, run: 12 }, overhang: FT });
  expect(roof.footprint).toHaveLength(4);
  const r = check(doc);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  const derived = r.derived as unknown as Derived;
  const derivedRoof = Object.values(derived.roofs)[0]!;
  expect(derivedRoof.kind).toBe('hip');
  expect(derivedRoof.surface?.faces).toHaveLength(4);
  expect(derivedRoof.surface?.lines.map((l) => l.kind).sort()).toEqual(['hip', 'hip', 'hip', 'hip', 'ridge']);
  const d = derived.stairs[stairId]!;
  const level2 = Object.entries(doc.levels ?? {}).find(([id]) => id !== level1)![1] as { elevation: number };
  expect(d.rise).toBe(level2.elevation);
  expect(d.risers).toBe(Math.ceil(level2.elevation / 251_968));
  expect(d.steps?.filter((s) => s.landing === true)).toHaveLength(1);
  expect(d.walkline?.points).toHaveLength(3);
  expect(d.footRoom).toBe(Object.keys(doc.rooms ?? {})[0]);
});
