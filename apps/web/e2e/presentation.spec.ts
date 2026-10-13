/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { embedLibraryMaterial } from '@floorspec/mesh/materials';
import { firstRunSetup, password, projectIn, settled } from './support.js';

/**
 * FLR-T-13.7: the 3D view's Presentation quality — the board's "08 · Editor — 3D presentation
 * quality" frame. A house with windows, a kitchen finished in library materials and sixteen
 * downlights is built through the API; in the 3D view the chips' Quality control switches Draft to
 * Presentation (here, on SwiftShader, Draft is the default and Presentation is offered). Checked:
 * every pass of its frame is drawn and the sky is prefiltered for reflections; the view is exposed
 * and tone-mapped as Draft is (one exposure, one curve, the renderers'), so the picture's mean
 * brightness stays within a band of Draft's; with every lamp on, every shader program links within
 * WebGL 2's 16 texture units and one lamp fewer casts shadows (the sky's reflection map takes a unit);
 * the choice is kept across a reload; axe in both themes. Screenshots land in
 * test-results/presentation-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Record<string, unknown>).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

type Programs = { units: number; list: { name: string; linked: boolean; samplers: number }[] };
type Quality = { ready: boolean; refined: number; passes: string[]; env: boolean; scale: number };
type View = {
  __floorspec3d?: { ready: boolean; programs: Programs; lights: { on: boolean; lamps: { id: string; shadow: boolean }[] } };
  __floorspecSun?: { sky: { exposure: number | null; preset: string } | null };
  __floorspecQuality?: Quality;
};

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(500);
}

/** Wait for Presentation's first full frame. */
async function presented(page: Page): Promise<Quality> {
  await page.waitForFunction(() => {
    const q = (window as unknown as View).__floorspecQuality;
    return q?.ready === true && q.refined >= 1;
  }, undefined, { timeout: 120_000 });
  return (await page.evaluate(() => (window as unknown as View).__floorspecQuality))!;
}

/** The mean luminance (Rec. 709, of sRGB values 0–1) of the 3D canvas as the screen shows it. */
async function meanLuminance(page: Page): Promise<number> {
  const png = await page.locator('.fs-three__gl canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `test-results/presentation-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const downlight = { min: [-128_000, -128_000, -192_000], max: [128_000, 128_000, 0] };

test('Presentation: chosen from the chips, every pass drawn, the same exposure, every program within 16 texture units', async ({ page }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, { name: 'Presenter', email: 'presenter@example.test', password: password('presentation') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Presented house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const house = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(house.status(), await house.text()).toBe(201);
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as unknown;
  const pending = new Map<string, string>();
  const oak = embedLibraryMaterial(doc, 'white-oak-plank', {}, pending);
  const paint = embedLibraryMaterial(doc, 'paint-eggshell', {}, pending);
  // A 4 × 4 grid over the kitchen (x 5 440 000–9 088 000, y 128 000–6 784 000 base units).
  const lights = Array.from({ length: 16 }, (_, i) => ({
    op: 'placeElement', id: `LT${String(i + 1)}`, extension: 'FS_electrical', collection: 'lights',
    host: { mode: 'surface', room: 'Kitchen', surface: 'ceiling', at: [5_440_000 + Math.round(((i % 4) + 0.5) * 912_000), 128_000 + Math.round((Math.floor(i / 4) + 0.5) * 1_664_000)] },
    element: { fixture: 'recessed', fallback: { box: downlight } },
  }));
  const kitchen = Object.entries((HOUSE['rooms'] ?? {}) as Record<string, { name?: string }>).find(([, r]) => r.name === 'Kitchen')?.[0];
  expect(kitchen).toBeDefined();
  const finished = await page.request.post(`/api/projects/${project}/ops`, {
    data: {
      batch: [
        ...oak.ops, ...paint.ops,
        { op: 'setProperty', id: kitchen, path: '/floorFinish', value: oak.id },
        { op: 'setProperty', id: kitchen, path: '/ceilingFinish', value: paint.id },
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
        ...lights,
      ],
    },
  });
  expect(finished.status(), await finished.text()).toBe(201);

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);

  // ── Draft, the default where WebGL is drawn in software; Presentation offered beside it.
  const quality = page.getByRole('radiogroup', { name: 'Quality' });
  await expect(quality.getByRole('radio', { name: 'Draft' })).toHaveAttribute('aria-checked', 'true');
  await expect(quality.getByRole('radio', { name: 'Presentation' })).toBeEnabled();
  await expect(page.locator('.fs-three__stats')).toContainText('WebGL · Draft');
  await page.waitForTimeout(1500);
  const exposure = await page.evaluate(() => (window as unknown as View).__floorspecSun?.sky?.exposure ?? null);
  expect(exposure).not.toBeNull();
  const draftLuma = await meanLuminance(page);
  await page.screenshot({ path: 'test-results/presentation-draft.png' });

  // ── Presentation: loaded on first use, every pass of its frame drawn, the sky prefiltered.
  await quality.getByRole('radio', { name: 'Presentation' }).click();
  const q = await presented(page);
  expect(q.passes).toEqual(['scene', 'gtao', 'resolve:ao+ssr', 'bloom', 'output:tone+srgb', 'smaa|accumulate']);
  expect(q.env).toBe(true);
  await expect(page.locator('.fs-three__stats')).toContainText('WebGL · Presentation');
  // One exposure and one curve: the sky's, as Draft and the renderers have it.
  expect(await page.evaluate(() => (window as unknown as View).__floorspecSun?.sky?.exposure ?? null)).toBe(exposure);
  await page.waitForTimeout(1500);
  const presentationLuma = await meanLuminance(page);
  await page.screenshot({ path: 'test-results/presentation-presentation.png' });
  // Occlusion darkens corners and reflections brighten glossy floors, but the picture is exposed the same.
  expect(presentationLuma / draftLuma, `mean luminance ${presentationLuma.toFixed(3)} against Draft's ${draftLuma.toFixed(3)}`).toBeGreaterThan(0.8);
  expect(presentationLuma / draftLuma).toBeLessThan(1.15);

  // ── Every lamp on: every program links within 16 units, and one lamp fewer casts a shadow than in Draft.
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Lights' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps.length)).toBe(16);
  await presented(page);
  await page.waitForTimeout(3000);
  const programs = await page.evaluate(() => (window as unknown as View).__floorspec3d!.programs);
  expect(programs.list.length).toBeGreaterThan(0);
  expect.soft(programs.list.filter((p) => !p.linked).map((p) => p.name), 'programs that failed to link').toEqual([]);
  expect.soft(Math.max(...programs.list.map((p) => p.samplers)), 'the most texture units a program samples').toBeLessThanOrEqual(16);
  const shadowed = await page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps.filter((l) => l.shadow).length);
  expect(shadowed, 'shadowed lamps in Presentation').toBe(10);
  await axe(page, 'lights-on');

  // ── Kept in this browser: a reload opens Presentation again; Draft puts the view back as it was.
  await page.reload();
  await ready(page);
  await expect(quality.getByRole('radio', { name: 'Presentation' })).toHaveAttribute('aria-checked', 'true');
  await presented(page);
  await quality.getByRole('radio', { name: 'Draft' }).click();
  await expect(page.locator('.fs-three__stats')).toContainText('WebGL · Draft');
  await expect.poll(() => page.evaluate(() => (window as unknown as View).__floorspecQuality === undefined)).toBe(true);
  await page.waitForTimeout(1500);
  expect(Math.abs((await meanLuminance(page)) - draftLuma) / draftLuma, 'Draft again, as it was').toBeLessThan(0.03);
});
