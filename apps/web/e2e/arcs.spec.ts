/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { check } from '@floorspec/engine';
import { count, firstRunSetup, FT, IN, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-11.1, arc walls (Core 0.4, chapter 21), from the Figma board's P11 Arcs frames: three walls drawn
 * by keyboard, then an arc wall closing them — the arc tool (A), its start and its chord typed, the bulge
 * flipped outward (Shift+F) and given as a radius (Tab) — in one batch of drawWall and setProperty /arc. A
 * room named in the curved space shows the net area the engine derives from the arc's polyline; the arc
 * wall selected shows its Arc section; and the 3D view meshes the curved wall. Screenshots of each state,
 * in both themes, land in test-results/arcs-*.png.
 */

async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search commands and the plan' });
  await expect(input).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/arcs-${name}-${theme}.png` });
  }
}

/** The 3D view's test hook (src/editor/three/ThreeView.tsx), present under automation only. */
type Hook = { ready: boolean; kinds: Record<string, number>; screenPoint(id: string): { x: number; y: number } | null };

async function threeReady(page: Page): Promise<Record<string, number>> {
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => (window as unknown as { __floorspec3d?: { kinds: Record<string, number> } }).__floorspec3d?.kinds ?? {});
}

test('an arc wall drawn by keyboard, the curved room it closes and its area, and the wall in 3D', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Arc Drawer', email: 'arcs@example.test', password: password('arcs') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Bay house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  // A building, a level and a 6" wall type, as one batch.
  const ready = await page.request.post(`/api/projects/${project}/ops`, {
    data: {
      batch: [
        { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
        { op: 'addElement', collection: 'levels', id: 'L1', element: { name: 'Level 1', building: 'B1', elevation: 0, height: 9 * FT } },
        { op: 'addElement', collection: 'types', id: 'T6', element: { kind: 'wallType', name: '6 in wall', layers: [{ thickness: 6 * IN, function: 'core' }] } },
      ],
    },
  });
  expect(ready.status(), await ready.text()).toBe(201);
  expect((await modelOf(page, project) as unknown as { floorspec: string }).floorspec).toBe('0.4');
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');

  // ── Three straight walls by keyboard: W, a typed start, then lengths aimed with the arrows; Esc ends the chain.
  await page.locator('body').focus();
  await page.keyboard.press('w');
  await page.keyboard.type(`0,12'`);
  await page.keyboard.press('Enter');
  for (const [arrow, length] of [['ArrowDown', `12'`], ['ArrowRight', `20'`], ['ArrowUp', `12'`]] as const) {
    await page.keyboard.press(arrow);
    await page.keyboard.type(length);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape');
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(3);
  await settled(page);

  // ── The arc wall: A, its start typed on the junction at (20', 12'), its chord aimed west and typed.
  await page.keyboard.press('Escape');
  await page.keyboard.press('a');
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await expect(rail.getByRole('button', { name: /Draw arc walls/ })).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Draw arc wall' })).toBeVisible();
  await page.keyboard.type(`20',12'`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(`20'`);
  await page.keyboard.press('Enter');
  // The bulge: it starts inward (to the left of west, south); Shift+F turns it outward, Tab asks for a radius.
  const entry = page.getByTestId('arc-entry');
  await expect(entry).toContainText('Sagitta');
  await expect(entry).toContainText(`Chord 20'`);
  await page.keyboard.press('Shift+F');
  await page.keyboard.press('Tab');
  await expect(entry).toContainText('Radius');
  await page.keyboard.type(`12'`);
  await shoot(page, 'drawing-by-keyboard');
  await page.keyboard.press('Enter');
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);

  // One batch: drawWall under a named ID, then its arc — R = 12', c = 20': h = 12' − √(12² − 10²)' outward.
  const doc = await modelOf(page, project);
  const arcWall = Object.entries(doc.walls ?? {}).find(([, w]) => (w as unknown as { arc?: unknown }).arc !== undefined);
  expect(arcWall).toBeDefined();
  const sagitta = (arcWall![1] as unknown as { arc: { sagitta: number } }).arc.sagitta;
  expect(sagitta).toBe(-Math.round(12 * FT - Math.sqrt((12 * FT) ** 2 - (10 * FT) ** 2)));
  const history = (await (await page.request.get(`/api/projects/${project}/history`)).json()) as { ops: { batch?: { op: string }[] }[] };
  const ops = JSON.stringify(history.ops[0]);
  expect(ops).toContain('"drawWall"');
  expect(ops).toContain('"/arc"');

  // ── A room named in the curved space: its net area is the engine's, from the arc's polyline.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await palette(page, 'name a room in');
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Living');
  await page.keyboard.press('Enter');
  await settled(page);
  const finished = await modelOf(page, project);
  const derived = check(finished).derived!;
  const [rid] = Object.keys(finished.rooms ?? {});
  const area2 = 2n * BigInt(derived.rooms[rid!]!.area.split('.')[0]!) + (derived.rooms[rid!]!.area.endsWith('.5') ? 1n : 0n);
  const perSqft = BigInt(FT) * BigInt(FT);
  const sqft = Number((area2 + perSqft) / (2n * perSqft));
  // Bigger than the room inside a straight north wall: the bay adds its segment.
  expect(sqft).toBeGreaterThan(Math.round((20 - 0.5) * (12 - 0.5)));
  await expect(inspector.getByText(`${sqft.toLocaleString('en-US')} ft²`).first()).toBeVisible();
  await expect(page.locator('.fs-canvas__svg')).toContainText(`${sqft.toLocaleString('en-US')} ft²`);
  await shoot(page, 'curved-room');

  // ── The arc wall selected: its Arc section, its bulge handle, its length along the arc.
  await page.getByRole('treeitem', { name: new RegExp(`Wall ${arcWall![0]}\\b`) }).click();
  await expect(inspector.getByRole('heading', { name: `Wall ${arcWall![0]}` })).toBeVisible();
  await expect(inspector.getByText('Sweep')).toBeVisible();
  await expect(inspector.getByText('Length along the wall')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Flip bulge' })).toBeVisible();
  await expect(page.getByTestId('arc-bulge-handle')).toBeVisible();
  await shoot(page, 'arc-wall-selected');

  // ── 3D: the curved wall is meshed, and can be found on screen.
  await page.locator('body').focus();
  await page.keyboard.press('Escape');
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  const kinds = await threeReady(page);
  expect(kinds['wall']).toBe(4);
  const at = await page.evaluate((id) => (window as unknown as { __floorspec3d?: Hook }).__floorspec3d?.screenPoint(id) ?? null, arcWall![0]);
  expect(at, 'the arc wall is on screen in 3D').not.toBeNull();
  await shoot(page, '3d');

  // ── The plan renderer's fixture (packages/render2d/test/fixtures/bay-house.json) through the API: a curved
  //    bay with a window on it, a curved partition with a door, in the plan and in 3D.
  const res = await page.request.post('/api/projects', { data: { name: 'Bay house fixture' } });
  expect(res.status(), await res.text()).toBe(201);
  const fixture = ((await res.json()) as { id: string }).id;
  const house = JSON.parse(readFileSync(new URL('./fixtures/bay-house.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
  const order = ['types', 'buildings', 'levels', 'junctions', 'walls', 'openings', 'rooms'];
  const batch = order.flatMap((collection) => Object.entries(house[collection] ?? {}).map(([id, element]) => ({ op: 'addElement', collection, id, element })));
  const applied = await page.request.post(`/api/projects/${fixture}/ops`, { data: { batch } });
  expect(applied.status(), await applied.text()).toBe(201);
  await page.goto(`/projects/${fixture}/editor`);
  await settled(page);
  await expect(page.locator('.fs-canvas__svg')).toContainText('Living');
  await expect(page.locator('.fs-canvas__svg')).toContainText('Kitchen');
  await shoot(page, 'bay-house-plan');
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  const fixtureKinds = await threeReady(page);
  expect(fixtureKinds['wall']).toBe(7);
  expect(fixtureKinds['opening']).toBe(3);
  await shoot(page, 'bay-house-3d');
});
