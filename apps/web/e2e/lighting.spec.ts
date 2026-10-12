/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-13.12: lighting design in 3D. The three suite's house (e2e/fixtures/l-stair-hip-roof.json)
 * with a ceiling light in the kitchen, two downlights in the living room and a switch on the living
 * room's west wall that controls the downlights alone, and an "Evening" scene (FS_lighting 0.1.0):
 * the kitchen light at 40 %, warm; the downlights off.
 *
 * In the 3D view, with its lights off, clicking the switch only selects it. With the lights on, it
 * turns exactly its two downlights off and on again, said in a live region; the Lighting panel lists
 * All on, Evening and Off, and Evening draws one lamp at 40 % of its candela. A dimmer dragged marks
 * the scene changed; it is saved over Evening and as a new scene, renamed and deleted — every one an
 * Op on the document. axe passes on the panel in both themes; screenshots land in
 * test-results/lighting-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Record<string, unknown>).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

type Lamp = { id: string; kind: 'point' | 'spot'; shadow: boolean; intensity: number };
type View = { __floorspec3d?: { ready: boolean; lights: { on: boolean; lamps: Lamp[] }; screenPoint(id: string): { x: number; y: number } | null } };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300);
}

const lamps = (page: Page) => page.evaluate(() => (window as unknown as View).__floorspec3d?.lights.lamps.map((l) => ({ id: l.id, intensity: l.intensity })).sort((a, b) => (a.id < b.id ? -1 : 1)) ?? null);
const lampIds = async (page: Page) => (await lamps(page))?.map((l) => l.id) ?? null;

async function clickElement(page: Page, id: string): Promise<void> {
  const at = await page.evaluate((x) => (window as unknown as View).__floorspec3d?.screenPoint(x) ?? null, id);
  expect(at, `${id} is on screen`).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/lighting-${name}-${theme}.png` });
  }
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The theme's colours transition; with the 3D view drawing, give them time to land.
    await page.waitForTimeout(1000);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

const plate = { min: [0, -51200, -76800], max: [32000, 51200, 76800] };
const downlight = { min: [-128_000, -128_000, -192_000], max: [128_000, 128_000, 0] };

test('lighting design in 3D: a switch toggles its lights, scenes, a dimmer, and scenes saved as Ops', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Lumen', email: 'lumen@example.test', password: password('lighting') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Lit house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const house = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(house.status(), await house.text()).toBe(201);
  const fixtures = await page.request.post(`/api/projects/${project}/ops`, {
    data: {
      batch: [
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_lighting', value: '0.1.0' },
        { op: 'placeElement', id: 'LT1', extension: 'FS_electrical', collection: 'lights', host: { mode: 'surface', room: 'Kitchen', surface: 'ceiling', at: [7_296_000, 3_840_000] }, element: { fixture: 'ceiling', fallback: { box: { min: [-217_600, -217_600, -153_600], max: [217_600, 217_600, 0] } } } },
        { op: 'placeElement', id: 'LT2', extension: 'FS_electrical', collection: 'lights', host: { mode: 'surface', room: 'Living', surface: 'ceiling', at: [2_000_000, 2_400_000] }, element: { fixture: 'recessed', fallback: { box: downlight } } },
        { op: 'placeElement', id: 'LT3', extension: 'FS_electrical', collection: 'lights', host: { mode: 'surface', room: 'Living', surface: 'ceiling', at: [2_000_000, 4_800_000] }, element: { fixture: 'recessed', fallback: { box: downlight } } },
        { op: 'placeElement', id: 'SW1', extension: 'FS_electrical', collection: 'switches', host: { mode: 'wallFace', wall: 'GEF', toward: 'Living', at: "8' from start", height: "4'" }, element: { name: 'Living switch', fallback: { box: plate }, control: 'dimmer', controls: ['LT2', 'LT3'] } },
        { op: 'setProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS1', value: { name: 'Evening', on: { LT1: { output: 40, cct: 2400 } } } },
      ],
    },
  });
  expect(fixtures.status(), await fixtures.text()).toBe(201);

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);
  const toolbar = page.getByRole('toolbar', { name: '3D view' });
  const lightsButton = toolbar.getByRole('button', { name: 'Lights' });
  await expect(lightsButton).toHaveAttribute('aria-pressed', 'false');
  expect(await lampIds(page)).toEqual([]);

  // Lights off: the switch is selected, and nothing lights.
  await clickElement(page, 'SW1');
  await expect(page.locator('.fs-three__label')).toContainText('Living switch');
  await page.waitForTimeout(300);
  expect(await lampIds(page)).toEqual([]);

  // Lights on: every light, and the chip says "All on".
  await lightsButton.click();
  await expect.poll(() => lampIds(page)).toEqual(['LT1', 'LT2', 'LT3']);
  const full = (await lamps(page))!.find((l) => l.id === 'LT1')!.intensity;
  const chip = page.getByRole('button', { name: /^Lighting · All on\. Open the lighting$/ });
  await expect(chip).toBeVisible();

  // The switch turns exactly its two downlights off, and on again; each flip is announced.
  await clickElement(page, 'SW1');
  await expect.poll(() => lampIds(page)).toEqual(['LT1']);
  await expect(page.getByRole('status').filter({ hasText: 'Living switch: 2 lights off' })).toHaveCount(1);
  await page.waitForTimeout(300);
  await shoot(page, 'switched-off');
  await clickElement(page, 'SW1');
  await expect.poll(() => lampIds(page)).toEqual(['LT1', 'LT2', 'LT3']);
  // The keyboard: Enter on the selected switch flips it too.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => lampIds(page)).toEqual(['LT1']);
  await page.keyboard.press('Enter');
  await expect.poll(() => lampIds(page)).toEqual(['LT1', 'LT2', 'LT3']);

  // The Lighting panel: All on, Evening, Off. Evening lights the kitchen alone, at 40 %.
  await chip.click();
  const panel = page.getByRole('region', { name: 'Lighting' });
  await expect(panel).toBeVisible();
  const scenes = panel.getByRole('radiogroup', { name: 'Lighting scene' });
  await expect(scenes.getByRole('radio')).toHaveText([/All on/, /Evening/, /Off/]);
  await expect(scenes.getByRole('radio', { name: /All on/ })).toHaveAttribute('aria-checked', 'true');
  await scenes.getByRole('radio', { name: /Evening/ }).click();
  await expect.poll(() => lampIds(page)).toEqual(['LT1']);
  const evening = (await lamps(page))![0]!.intensity;
  expect(evening / full).toBeCloseTo(0.4, 2);
  await expect(panel.getByRole('status')).toHaveText('1 of 3 lights on · 1 dimmed');
  await scenes.getByRole('radio', { name: /Off/ }).click();
  await expect.poll(() => lampIds(page)).toEqual([]);
  await scenes.getByRole('radio', { name: /Evening/ }).click();
  await expect.poll(() => lampIds(page)).toEqual(['LT1']);
  await axe(page, 'lighting panel');

  // The kitchen light selected (in the tree: the panel covers the kitchen in this view): its dimmer,
  // dragged to 70 %, marks Evening changed — saved over it.
  await page.getByRole('treeitem', { name: 'Ceiling light LT1' }).click();
  await expect(panel.getByText('Ceiling light · Kitchen')).toBeVisible();
  await panel.getByLabel('Dimmer').fill('70');
  await expect.poll(async () => (await lamps(page))![0]!.intensity / full).toBeCloseTo(0.7, 2);
  await expect(panel.getByText('Changed')).toBeVisible();
  await shoot(page, 'panel-changed');
  await axe(page, 'lighting panel, a light selected and the scene changed');
  await panel.getByRole('button', { name: 'Save “Evening”' }).click();
  await settled(page);
  await expect.poll(async () => ((await modelOf(page, project)) as { extensions: { FS_lighting: { scenes: Record<string, unknown> } } }).extensions.FS_lighting.scenes['LS1']).toEqual({ name: 'Evening', on: { LT1: { output: 70, cct: 2400 } } });
  await expect(panel.getByText('Changed')).toBeHidden();

  // Saved as a new scene, then renamed and deleted: each an Op on the document.
  await panel.getByRole('button', { name: 'Save as scene…' }).click();
  await panel.getByLabel('New scene').fill('Dinner');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await settled(page);
  await expect(scenes.getByRole('radio', { name: /Dinner/ })).toHaveAttribute('aria-checked', 'true');
  type Scenes = { extensions: { FS_lighting: { scenes: Record<string, { name: string }> } } };
  await expect.poll(async () => Object.values(((await modelOf(page, project)) as Scenes).extensions.FS_lighting.scenes).map((s) => s.name).sort()).toEqual(['Dinner', 'Evening']);
  await panel.getByRole('button', { name: 'More for Dinner' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await panel.getByLabel('Rename “Dinner”').fill('Supper');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await settled(page);
  await expect(scenes.getByRole('radio', { name: /Supper/ })).toBeVisible();
  await panel.getByRole('button', { name: 'More for Supper' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await settled(page);
  await expect(scenes.getByRole('radio')).toHaveText([/All on/, /Evening/, /Off/]);
  await expect.poll(async () => Object.keys(((await modelOf(page, project)) as Scenes).extensions.FS_lighting.scenes)).toEqual(['LS1']);
  await shoot(page, 'panel');

  // Closed with Escape: the chip stands for it, naming the scene.
  await panel.getByRole('radio', { name: /Evening/ }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: /^Lighting · Evening\. Open the lighting$/ })).toBeVisible();
});
