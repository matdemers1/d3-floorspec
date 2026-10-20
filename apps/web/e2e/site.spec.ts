/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-15.1: terrain and grading on the Courtyard House (the worker's fixture, with no site), in
 * Landscape mode — the P15 board's "15.1 · Site", "15.1 · Terrain" and "15.1 · Terrain in 3D" frames.
 *
 * The lot tool (⇧B) draws the lot corner by corner: one setProperty of $site /boundary. The setback
 * tool (⇧K) clicks the street edge: FS_site's setbacks, the setback line drawn and the panel saying the
 * house sits inside it. Five spot elevations typed in the Site panel and clicked on the plan make a
 * surface: contours appear under the house, and the patios, the drive and the walk are cut and filled.
 * A contour line at 813′ is drawn through three points. "Set the house on a pad" fits a pad to the
 * walls; the panel gives the cut and the fill as estimates. In 3D the Terrain button opens its panel:
 * the ground is drawn graded, contours on it, cut and fill tinted, and the vertical scale stretches the
 * view and nothing else. axe passes in both themes, plan and 3D. Screenshots: test-results/site-*.png
 * (and FLR151_SHOTS, when set).
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** The Courtyard House on its gently sloping Georgia lot (make/courtyard-on-its-lot.mjs). */
const ON_ITS_LOT = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ft = (x: number, y: number): [number, number] => [Math.round(x * FT), Math.round(y * FT)];
/** The lot: the street on the west, where the drive and the front walk meet it. */
const LOT = [ft(-34, 88), ft(-34, -20), ft(106, -20), ft(106, 88)];
const SPOTS: [[number, number], string][] = [[ft(-33, 87), '809.40'], [ft(-33, -19), '809.10'], [ft(105, -19), '816.80'], [ft(105, 87), '817.10'], [ft(40, 70), '815.00']];

interface Doc {
  site?: { boundary?: [number, number][] };
  extensionsUsed?: Record<string, string>;
  extensions?: { FS_site?: { benchmark?: number; spots?: Record<string, { at: number[]; elevation: number }>; contours?: Record<string, { elevation: number; points: number[][] }>; setbacks?: { street: number[] }; pads?: Record<string, { name?: string; elevation: number }> } };
}
type Hook = { __floorspec3d?: { ready: boolean }; __floorspecTerrain?: { triangles: number; cut: boolean; fill: boolean; contours: number; exaggeration: number } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;

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
    const path = `test-results/site-${name}-${theme}.png`;
    await page.screenshot({ path });
    const out = process.env['FLR151_SHOTS'];
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      copyFileSync(path, `${out}/site-${name}-${theme}.png`);
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

/** Where the pointer is on the plan, as the status bar reads it out. */
async function readout(page: Page, x: number, y: number): Promise<[number, number]> {
  await page.mouse.move(x, y);
  let at: [number, number] | null = null;
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [wx, wy] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map((m) => (m[1] === '-' ? -1 : 1) * (Number(m[2]) * FT + Number(m[3]) * IN + (m[4] === undefined ? 0 : (Number(m[4]) / Number(m[5])) * IN)));
      at = wx === undefined || wy === undefined ? null : [wx, wy];
      return at !== null;
    })
    .toBe(true);
  return at as unknown as [number, number];
}

/** The plan's camera, from two readouts: where a world point (base units) is on the page. */
async function cameraOf(page: Page): Promise<(p: readonly [number, number]) => { x: number; y: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return (p) => ({ x: a.x + (p[0] - wa[0]) * s, y: a.y - (p[1] - wa[1]) * s });
}

test('terrain and grading: draw the lot, set the street, survey spots and a contour, see contours and cut and fill, set the house on a pad, the ground in 3D — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Surveyor', email: 'surveyor@example.test', password: password('site') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── Landscape mode: its rail has the site's tools, and the inspector the Site panel.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Landscape mode' }).click();
  const sitePanel = inspector.getByRole('region', { name: 'Lot and terrain' });
  await expect(sitePanel).toContainText('No lot yet');
  for (const label of ['Draw the lot', 'Setbacks: click the street edge', 'Add a spot elevation', 'Draw a contour line', 'Draw a grade pad']) await expect(page.getByRole('button', { name: label })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(400);
  let at = await cameraOf(page);

  // ── The lot, corner by corner, closed on the first: Core's site boundary.
  await page.keyboard.press('Shift+KeyB');
  for (const p of LOT) {
    const q = at(p);
    await page.mouse.click(q.x, q.y);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await docOf(page, project)).site?.boundary?.length ?? 0).toBe(4);
  const lot = (await docOf(page, project)).site!.boundary!;
  for (const [i, p] of LOT.entries()) for (const k of [0, 1]) expect(Math.abs(lot[i]![k]! - p[k]!), `corner ${String(i)}`).toBeLessThan(FT);
  await expect(page.getByTestId('site-lot')).toBeVisible();
  await expect(page.getByTestId('site-lot').locator('[data-lot]')).toHaveCount(1);

  // ── The street on the west: the setbacks, drawn, and the house inside them.
  await page.keyboard.press('Shift+KeyK');
  const west = at([(LOT[0]![0] + LOT[1]![0]) / 2, (LOT[0]![1] + LOT[1]![1]) / 2]);
  await page.mouse.click(west.x, west.y);
  await expect.poll(async () => (await docOf(page, project)).extensions?.FS_site?.setbacks?.street).toEqual([0]);
  expect((await docOf(page, project)).extensionsUsed?.['FS_site']).toBe('0.1.0');
  await expect(page.getByTestId('site-lot').locator('[data-setbacks]')).toHaveCount(1);
  await expect(page.getByTestId('site-lot')).toContainText('street line');

  // ── The survey's datum: the first floor is at 814.50′.
  const floorField = inspector.getByRole('region', { name: 'Lot and terrain' }).getByLabel('First floor');
  await floorField.fill('814.50');
  await floorField.press('Enter');
  await expect.poll(async () => (await docOf(page, project)).extensions?.FS_site?.benchmark).toBe(Math.round(814.5 * FT));

  // ── Five spots, each at the height typed in the Site panel: a surface, contours, cut and fill.
  await page.keyboard.press('Shift+KeyE');
  const toolPanel = inspector.getByRole('region', { name: 'Lot and terrain' });
  for (const [p, h] of SPOTS) {
    const field = toolPanel.getByLabel('Spot elevation');
    await field.fill(h);
    await field.press('Enter');
    at = await cameraOf(page);
    const q = at(p);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(300);
  }
  await expect.poll(async () => Object.keys((await docOf(page, project)).extensions?.FS_site?.spots ?? {}).length, { timeout: 20_000 }).toBe(5);
  const spots = Object.values((await docOf(page, project)).extensions!.FS_site!.spots!);
  expect(spots.map((s) => s.elevation).sort((a, b) => a - b)[0]).toBe(Math.round(809.1 * FT) - Math.round(814.5 * FT));
  await expect(page.getByTestId('site-spots').locator('[data-spot]')).toHaveCount(5);
  await expect(page.getByTestId('site-contours').locator('[data-contour]').first()).toBeAttached();
  expect(await page.getByTestId('site-contours').locator('[data-contour]').count()).toBeGreaterThanOrEqual(6);
  await expect(page.getByTestId('site-grading').locator('[data-fill]').first()).toBeAttached();
  await expect(page.getByTestId('site-grading').locator('[data-cut]').first()).toBeAttached();

  // ── A contour line at 813′, three points across the lot.
  await page.keyboard.press('Shift+KeyC');
  const contour = toolPanel.getByLabel('Contour line');
  await contour.fill('813');
  await contour.press('Enter');
  at = await cameraOf(page);
  for (const p of [ft(30, -15), ft(32, 30), ft(30, 82)]) {
    const q = at(p);
    await page.mouse.click(q.x, q.y);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => Object.values((await docOf(page, project)).extensions?.FS_site?.contours ?? {}).map((c) => c.elevation)).toEqual([Math.round(813 * FT) - Math.round(814.5 * FT)]);
  await expect(page.getByTestId('site-contours').locator('[data-contour-line]')).toHaveCount(1);

  // ── The house set on a pad fitted to its walls; the cut and the fill, as estimates.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const panel = inspector.getByRole('region', { name: 'Lot and terrain' });
  await panel.getByRole('button', { name: 'Set the house on a pad' }).click();
  await expect.poll(async () => Object.values((await docOf(page, project)).extensions?.FS_site?.pads ?? {}).map((p) => p.name)).toEqual(['House']);
  await expect(panel.getByRole('button', { name: 'Fit the pad to the house' })).toBeVisible();
  await expect(panel.getByTestId('cut-total')).toHaveText(/^\d+\.\d yd³$/);
  await expect(panel.getByTestId('fill-total')).toHaveText(/^\d+\.\d yd³$/);
  await expect(panel).toContainText('advisory, not an engineered grading plan');
  await expect(panel.getByTestId('setback-status')).toContainText('inside the setbacks');
  await expect(panel).not.toContainText('compliant');
  await shoot(page, 'plan');
  await axe(page, 'Landscape mode with the Site panel');

  // ── The ground in 3D: the Terrain panel, graded ground, contours, the vertical scale.
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => (window as unknown as Hook).__floorspecTerrain !== undefined, undefined, { timeout: 60_000 });
  const terrain = async () => page.evaluate(() => (window as unknown as Hook).__floorspecTerrain!);
  const t1 = await terrain();
  expect(t1.triangles).toBeGreaterThan(1000);
  expect(t1.cut && t1.fill).toBe(true);
  expect(t1.contours).toBeGreaterThan(50);
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Terrain' }).click();
  const terrainPanel = page.getByRole('region', { name: 'Terrain view' });
  await expect(terrainPanel).toBeVisible();
  await expect(terrainPanel.getByRole('img', { name: /Section through the site/ })).toBeVisible();
  await terrainPanel.getByRole('radio', { name: '1.6×' }).click();
  await expect.poll(async () => (await terrain()).exaggeration).toBe(1.6);
  // a view setting only: the document is as it was
  const before = await docOf(page, project);
  expect(before.extensions?.FS_site?.spots).toBeDefined();
  await page.waitForTimeout(1_500);
  await shoot(page, '3d');
  await axe(page, '3D view with the Terrain panel');
  await terrainPanel.getByRole('switch', { name: 'Contours on the ground' }).click();
  await expect.poll(async () => (await terrain()).contours).toBe(0);
  expect(await docOf(page, project)).toEqual(before);
  await terrainPanel.getByRole('switch', { name: 'Contours on the ground' }).click();

  // ── The Courtyard House on its lot: lot 14, Laurel Ridge Drive, falling to the street — plan and 3D.
  const lotProject = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House on its lot') },
    data: Buffer.from(JSON.stringify(ON_ITS_LOT)),
  });
  expect(lotProject.status(), await lotProject.text()).toBe(201);
  const onLot = ((await lotProject.json()) as { id: string }).id;
  await page.goto(`/projects/${onLot}/editor`);
  await settled(page);
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Landscape mode' }).click();
  const lotPanel = inspector.getByRole('region', { name: 'Lot and terrain' });
  await expect(lotPanel).toContainText('0.41 ac');
  await expect(lotPanel.getByTestId('setback-status')).toContainText('inside the setbacks');
  await expect(lotPanel.getByTestId('cut-total')).toHaveText(/^\d+\.\d yd³$/);
  await expect(page.getByTestId('site-spots').locator('[data-spot]')).toHaveCount(14);
  await shoot(page, 'courtyard-on-its-lot-plan');
  await page.goto(`/projects/${onLot}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => (window as unknown as Hook).__floorspecTerrain !== undefined, undefined, { timeout: 60_000 });
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Terrain' }).click();
  await expect(page.getByRole('region', { name: 'Terrain view' })).toBeVisible();
  await page.waitForTimeout(1_500);
  await shoot(page, 'courtyard-on-its-lot-3d');
});
