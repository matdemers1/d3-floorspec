/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-15.5: exterior lighting on the Courtyard House.
 *
 * In Electrical mode the rail's exterior group: a path light placed a foot off the front walk's edge,
 * the next one snapped 8' along it on the other side ("8'-0" to X…"), an uplight aimed into the big
 * front tree's canopy — each one placeElement — and their beams on the plan (a pool, a cone), the
 * uplight's beam changed to a 15° spot in the inspector. With a path light's tool in hand, the
 * electrical assistant's exterior card names the walks dark after dusk, draws them on the plan, and
 * "Review as changeset" opens a pending changeset — main keeps its own lights. In 3D the Lighting
 * panel's "Night exterior" puts the house under the night sky with the grounds' lamps on, every
 * program linked within 16 texture units. axe in both themes on the plan with the card and on the
 * inspector; screenshots in test-results/extlighting-*.png.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const IN = 32_512;
const FT = 12 * IN;
// The front walk (SL4): its south edge, and the big front tree (LS-T2).
const WALK_SOUTH = 10_143_744;
const TREE: [number, number] = [-7_680_000, 2_944_000];
const TREE_R = 4_480_000;

type Light = { fixture?: string; host: { mode: string; position?: [number, number]; rotation?: number }; extras?: { d3floorspec?: { exterior?: { kind: string; beam?: number; reach?: number } } } };
type Doc = { extensions: { FS_electrical: { collections: { lights: Record<string, Light> } } } };
type Placing = { __floorspecPlacing?: { screenPoint(x: number, y: number): { x: number; y: number } | null } };
type View = { __floorspec3d?: { ready: boolean; lights: { on: boolean; lamps: { id: string; kind: string; shadow: boolean }[] }; programs: { list: { name: string; linked: boolean; samplers: number }[] } }; __floorspecSun?: { sky: { preset: string } | null } };

const screenOf = async (page: Page, x: number, y: number) => (await page.evaluate(([px, py]) => (window as unknown as Placing).__floorspecPlacing?.screenPoint(px, py) ?? null, [x, y] as const))!;
const exterior = (doc: Doc) => Object.entries(doc.extensions.FS_electrical.collections.lights).filter(([, l]) => l.extras?.d3floorspec?.exterior !== undefined);

/** The theme switched and settled: two frames after it, no CSS transition still running (as edit3d.spec.ts). */
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

async function inTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(400);
  await themeSettled(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    await page.screenshot({ path: `test-results/extlighting-${name}-${theme}.png` });
  }
  await inTheme(page, 'light');
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await inTheme(page, 'light');
}

test('exterior lighting: path lights and an uplight placed with their beams, the assistant’s exterior changeset, and the night look', async ({ page }) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await firstRunSetup(page, { name: 'Lights', email: 'lights@example.test', password: password('extlighting') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(HOUSE),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  const doc = async (): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Electrical mode' }).click();
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await expect(rail.getByRole('separator', { name: 'Exterior lights' })).toBeAttached();

  // ── A path light a foot off the front walk's south edge, facing the walk.
  await rail.getByRole('button', { name: 'Place a path light' }).click();
  await expect(page.getByRole('region', { name: 'Electrical assistant · exterior' })).toBeVisible();
  const first = await screenOf(page, -10_000_000, WALK_SOUTH - 2 * FT);
  await page.mouse.move(first.x, first.y);
  await expect(page.locator('.fs-ext-hint')).toHaveAttribute('data-hint', 'Along the walk · 8\'-0" apart · alternating sides');
  await expect(page.locator('.fs-beam--ghost')).toHaveAttribute('data-shape', 'pool');
  await page.mouse.click(first.x, first.y);
  await expect.poll(async () => exterior(await doc()).length).toBe(1);
  await settled(page);
  const [firstId, firstLight] = exterior(await doc())[0]!;
  expect(firstLight.extras?.d3floorspec?.exterior?.kind).toBe('path');
  expect(firstLight.fixture).toBe('exterior');
  expect(firstLight.host.mode).toBe('free');
  expect(firstLight.host.position![1]).toBe(WALK_SOUTH - 12 * IN);

  // ── The next one, pointed at 7' along: snapped to 8' from the first, across the walk.
  const next = await screenOf(page, -10_000_000 + 7 * FT, WALK_SOUTH - 2 * FT);
  await page.mouse.move(next.x, next.y);
  await expect(page.locator('.fs-ext-tag--accent')).toContainText(`8'-0" to ${firstId}`);
  await shoot(page, 'placing-path');
  await page.mouse.click(next.x, next.y);
  await expect.poll(async () => exterior(await doc()).length).toBe(2);
  await settled(page);
  const second = exterior(await doc()).find(([id]) => id !== firstId)![1];
  expect(Math.abs(second.host.position![0] - firstLight.host.position![0] - 8 * FT)).toBeLessThanOrEqual(1);
  expect(second.host.position![1]).toBeGreaterThan(WALK_SOUTH);

  // ── An uplight east of the big front tree: just outside its canopy, aimed at its trunk.
  await rail.getByRole('button', { name: 'Place an uplight' }).click();
  const up = await screenOf(page, TREE[0] + TREE_R + 2 * FT, TREE[1]);
  await page.mouse.move(up.x, up.y);
  await expect(page.locator('.fs-ext-tag--accent')).toContainText('into the canopy');
  await expect(page.locator('.fs-beam--ghost')).toHaveAttribute('data-shape', 'cone');
  await page.mouse.click(up.x, up.y);
  await expect.poll(async () => exterior(await doc()).length).toBe(3);
  await settled(page);
  const [upId, upLight] = exterior(await doc()).find(([, l]) => l.extras?.d3floorspec?.exterior?.kind === 'uplight')!;
  expect(upLight.host.rotation).toBe(180_000_000);
  expect(upLight.extras?.d3floorspec?.exterior?.reach).toBeGreaterThan(TREE_R);

  // ── Their beams on the plan: two pools and a cone.
  const beams = page.locator('.fs-beams');
  await expect(beams.locator('[data-shape="pool"]')).toHaveCount(2);
  await expect(beams.locator(`[data-beam="${upId}"]`)).toHaveAttribute('data-shape', 'cone');

  // ── The uplight in the inspector: a 15° spot, an op on its record.
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: new RegExp(`Uplight.*${upId}`) }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByText('Exterior light', { exact: true })).toBeVisible();
  await expect(inspector.getByText('they are a drawing of the fixture, not a lighting calculation', { exact: false })).toBeVisible();
  await inspector.getByRole('combobox', { name: 'Beam' }).click();
  await page.getByRole('option', { name: '15° spot' }).click();
  await expect.poll(async () => (await doc()).extensions.FS_electrical.collections.lights[upId]?.extras?.d3floorspec?.exterior?.beam).toBe(15);
  await settled(page);
  await expect(page.locator('.fs-beams .fs-ext-tag')).toContainText('Uplight · 15° spot');
  await shoot(page, 'uplight-inspector');
  await axe(page, 'the uplight in the inspector');

  // ── The electrical assistant for the grounds: the dark stretches on the plan, its card, a pending changeset.
  await rail.getByRole('button', { name: 'Place a path light' }).click();
  const card = page.getByRole('region', { name: 'Electrical assistant · exterior' });
  await expect(card).toContainText('Dark after dusk');
  await expect(card).toContainText('No code is checked or cited');
  await expect(card).not.toContainText(/complian/i);
  await expect(page.locator('.fs-gaps--exterior [data-stretch="SL3"]')).toBeVisible();
  await shoot(page, 'assistant');
  await axe(page, 'the exterior assistant on the plan');
  const lightsBefore = exterior(await doc()).length;
  await card.getByRole('button', { name: 'Review as changeset' }).click();
  const proposal = page.getByRole('complementary', { name: 'Proposal' });
  await expect(proposal.getByRole('heading', { name: /^Exterior lighting/ })).toBeVisible();
  const { changesets } = (await (await page.request.get(`/api/projects/${project}/changesets`)).json()) as { changesets: { name: string; status?: string }[] };
  expect(changesets.some((c) => c.name.startsWith('Exterior lighting') && (c.status ?? 'pending') === 'pending')).toBe(true);
  // Main keeps its own lights until a person accepts it.
  expect(exterior(await doc()).length).toBe(lightsBefore);
  await page.keyboard.press('Escape');

  // ── 3D: the night exterior — the night sky, the grounds' lamps on, every program linked within 16 units.
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Lighting' }).click();
  const panel = page.getByRole('region', { name: 'Lighting' });
  await panel.getByRole('button', { name: 'Night exterior' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as View).__floorspecSun?.sky?.preset)).toBe('night');
  await expect(panel).toContainText(/\d+ exterior on · 0 interior on/);
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps)).map((l) => l.id)).toEqual(expect.arrayContaining([firstId, upId]));
  const lamps = await page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps);
  expect(lamps.find((l) => l.id === upId)?.kind).toBe('spot');
  expect(lamps.filter((l) => [firstId, upId].includes(l.id)).every((l) => !l.shadow)).toBe(true);
  await page.waitForTimeout(1500);
  const programs = await page.evaluate(() => (window as unknown as View).__floorspec3d!.programs);
  expect.soft(programs.list.filter((p) => !p.linked).map((p) => p.name), 'programs that failed to link').toEqual([]);
  expect.soft(Math.max(0, ...programs.list.map((p) => p.samplers)), 'the most texture units a program samples').toBeLessThanOrEqual(16);
  await shoot(page, 'night-3d');
  await axe(page, 'the Lighting panel at night');

  expect(errors).toEqual([]);
});
