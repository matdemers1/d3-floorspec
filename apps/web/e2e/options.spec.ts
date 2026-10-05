/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { check } from '@floorspec/engine';
import { count, firstRunSetup, FT, IN, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-8.4 and FLR-T-8.1 in the editor. Design options: an option set "Kitchen" with options A and
 * B, a different wall drawn in each (every batch carrying `context.option`), the two compared side
 * by side with the per-option room areas, and B made primary — checked through model.json and what
 * the engine derives from it. Finishes: a material, and a backsplash region on the kitchen's wall,
 * checked the same way, with the derived finish of that face.
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

type OptionDoc = Awaited<ReturnType<typeof modelOf>> & {
  optionSets?: Record<string, { primary: string; name?: string }>;
  options?: Record<string, { set: string; name?: string }>;
  walls?: Record<string, { start: string; end: string; option?: string; finishes?: { left?: { regions?: { from: number; to: number; bottom: number; top: number; material: string }[] } } }>;
  materials?: Record<string, { name?: string }>;
};

test('an option set with two kitchens, drawn, compared side by side and switched; a backsplash on the kitchen wall', async ({ page }) => {
  await firstRunSetup(page, { name: 'Options', email: 'options@example.test', password: password('options') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill('Two kitchens');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  await page.getByRole('button', { name: 'Open editor' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor$`));
  await page.getByRole('button', { name: 'Add Level 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');
  await settled(page);

  // A 20 ft × 12 ft room around the origin: the kitchen.
  const svg = page.getByRole('application', { name: /^Plan of / });
  const camera = await cameraOf(svg);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  for (const [x, y] of [[-10, -6], [10, -6], [10, 6], [-10, 6], [-10, -6]] as const) await click(page, camera, x * FT, y * FT);
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Name a room' }).click();
  await click(page, camera, 6 * FT, 3 * FT);
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  await settled(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const common = new Set(Object.keys((await modelOf(page, project)).walls ?? {}));

  // ── The option set: "Kitchen", A (primary) and B, created with named IDs.
  await page.getByRole('button', { name: /option sets?$|^Options$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Design options' });
  await expect(panel.getByRole('heading', { name: 'Design options' })).toBeVisible();
  await panel.getByLabel('Option set name').fill('Kitchen');
  await panel.getByRole('button', { name: 'Create option set' }).click();
  await expect.poll(async () => count(((await modelOf(page, project)) as OptionDoc).options)).toBe(2);
  await settled(page);
  let doc = (await modelOf(page, project)) as OptionDoc;
  const [setId, set] = Object.entries(doc.optionSets ?? {})[0]!;
  expect(set.name).toBe('Kitchen');
  const optionId = (name: string) => Object.entries(doc.options ?? {}).find(([, o]) => o.name === name)![0];
  const [A, B] = [optionId('A'), optionId('B')];
  expect(set.primary).toBe(A);
  const row = (name: string) => panel.getByRole('listitem').filter({ has: page.getByRole('radio', { name: `Show ${name}` }) });

  // ── Edit in B: a free-standing wall along the south of the kitchen, in B only.
  await row('B').getByRole('button', { name: 'Edit in' }).click();
  await expect(page.getByRole('button', { name: 'Editing Kitchen · B' })).toBeVisible();
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  await click(page, camera, -6 * FT, -2 * FT);
  await click(page, camera, 6 * FT, -2 * FT);
  await page.keyboard.press('Escape'); // finishes the chain: the wall is drawn
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(5);
  await settled(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ── Edit in A: another, along the north, in A only.
  await row('A').getByRole('button', { name: 'Edit in' }).click();
  await expect(page.getByRole('button', { name: 'Editing Kitchen · A' })).toBeVisible();
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  await click(page, camera, -6 * FT, 2 * FT);
  await click(page, camera, 6 * FT, 2 * FT);
  await page.keyboard.press('Escape'); // finishes the chain: the wall is drawn
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(6);
  await settled(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  doc = (await modelOf(page, project));
  const added = Object.entries(doc.walls ?? {}).filter(([id]) => !common.has(id));
  expect(added.map(([, w]) => w.option).sort()).toEqual([A, B].sort());
  for (const [, w] of added) {
    // Their junctions are in the option too (Ops 0.3, 2.8.1), so B's wall is not in A's design.
    expect(doc.junctions![w.start]).toMatchObject({ option: w.option });
  }
  for (const id of common) expect(doc.walls![id]!.option).toBeUndefined();
  // History says which option each edit was drawn in.
  const history = (await (await page.request.get(`/api/projects/${project}/history`)).json()) as { ops: { option: string | null }[] };
  expect(history.ops.filter((o) => o.option === B)).toHaveLength(1);
  expect(history.ops.filter((o) => o.option === A)).toHaveLength(1);

  // ── Side by side: two plans and the per-option room areas.
  await row('A').getByRole('button', { name: 'Editing' }).click();
  await panel.getByRole('button', { name: 'Compare side by side' }).click();
  await expect(page.getByRole('button', { name: 'Comparing Kitchen A ↔ B' })).toBeVisible();
  const region = page.getByRole('region', { name: 'Comparing Kitchen' });
  await expect(region.getByRole('region', { name: 'Design A (primary)' })).toBeVisible();
  await expect(region.getByRole('region', { name: 'Design B' })).toBeVisible();
  await expect(region.locator('svg')).toHaveCount(2);
  // Each pane draws its own option's wall, outlined as the option's.
  await expect(region.getByRole('region', { name: 'Design A (primary)' }).locator('polygon.fs-diff--added')).toHaveCount(1);
  await expect(region.getByRole('region', { name: 'Design B' }).locator('polygon.fs-diff--added')).toHaveCount(1);
  const compare = page.getByRole('complementary', { name: 'Design options' });
  const table = compare.getByRole('table', { name: /Kitchen/ });
  await expect(table.getByRole('row', { name: / area/ }).first()).toBeVisible();
  await expect(table.getByRole('row', { name: /Elements in option/ })).toContainText('3');

  // ── Make B primary.
  await compare.getByRole('button', { name: 'Make B primary' }).click();
  await expect.poll(async () => ((await modelOf(page, project)) as OptionDoc).optionSets![setId]!.primary).toBe(B);
  await settled(page);
  doc = (await modelOf(page, project));
  let r = check(doc);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  const options = (r.derived as unknown as { options: Record<string, { chosen: string; options: Record<string, { members: string[]; affected: string[] }> }> }).options;
  expect(options[setId]!.chosen).toBe(B);
  expect(options[setId]!.options[B]!.affected).toEqual([]);
  expect(options[setId]!.options[A]!.members).toHaveLength(3);
  await compare.getByRole('button', { name: 'End comparison' }).click();
  await expect(region).toBeHidden();

  // ── A material, and a backsplash on the kitchen's south wall: tile from 36" to 54", wall to wall.
  await page.getByRole('button', { name: 'Materials' }).click();
  const materials = page.getByRole('dialog', { name: /^Materials/ });
  await materials.getByRole('button', { name: 'New material' }).click();
  await expect.poll(async () => count(((await modelOf(page, project)) as OptionDoc).materials)).toBe(1);
  await settled(page);
  doc = (await modelOf(page, project));
  const material = Object.keys(doc.materials ?? {})[0]!;
  const south = Object.entries(doc.walls ?? {}).find(([id, w]) => common.has(id) && doc.junctions![w.start]!.position[1] === -6 * FT && doc.junctions![w.end]!.position[1] === -6 * FT)!;
  // The south wall, chosen in the project tree.
  const walls = page.getByRole('treeitem', { name: /^Walls/ });
  if ((await walls.getAttribute('aria-expanded')) !== 'true') await walls.click();
  await page.getByRole('treeitem', { name: new RegExp(`^Wall ${south[0]}\\b`) }).click();
  // The face towards the kitchen: the left one when the wall runs east (the room is north of it), else the right.
  const side: 'left' | 'right' = doc.junctions![south[1].start]!.position[0] < doc.junctions![south[1].end]!.position[0] ? 'left' : 'right';
  const Side = side === 'left' ? 'Left' : 'Right';
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const face = inspector.getByRole('region', { name: new RegExp(`^${Side} face of `) });
  await expect(face).toBeVisible();
  await expect(face.getByRole('button', { name: /^Room/ })).toBeVisible();
  await face.getByRole('button', { name: 'Add a region' }).click();
  await face.getByRole('button', { name: 'Add region' }).click();
  type Faces = { finishes?: Record<string, { regions?: { from: number; to: number; bottom: number; top: number; material: string }[] } | undefined> };
  const regionsOf = (d: OptionDoc) => ((d.walls![south[0]] as Faces).finishes?.[side]?.regions ?? []);
  await expect.poll(async () => regionsOf((await modelOf(page, project)) as OptionDoc).length).toBe(1);
  await settled(page);
  doc = (await modelOf(page, project));
  const region0 = regionsOf(doc)[0]!;
  expect(region0).toMatchObject({ from: 0, bottom: 36 * IN, top: 54 * IN, material });
  expect(region0.to).toBe(20 * FT);
  r = check(doc);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  const finishes = (r.derived as unknown as { finishes: { walls: Record<string, Record<string, { room?: string; regions: { material: string }[] } | undefined>> } }).finishes;
  const derivedFace = finishes.walls[south[0]]![side]!;
  expect(derivedFace.room).toBe(Object.keys(doc.rooms ?? {})[0]);
  expect(derivedFace.regions.map((x) => x.material)).toEqual([material]);
  await expect(face.getByRole('list', { name: `Regions of the ${side} face` }).getByRole('listitem')).toHaveCount(1);
});
