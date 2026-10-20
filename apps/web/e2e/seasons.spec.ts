/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-15.4: seasons and weather on the Courtyard House — looks, never the model's.
 *
 * The Sky and sun panel's season (Spring, Summer, Autumn, Winter, and "Follow the date") and its
 * weather tiles (Clear, Overcast, Rain-wet, Light snow) in the 3D view: the deciduous maples and
 * hornbeams bare in winter and in autumn colour, the evergreens kept, the lawn through the year;
 * rain wetting what stands outside; light snow on the roofs and the lawn, the walk cleared; the
 * inspector's "Plants through the year". The studio is the Camera panel's backdrop now. Through it
 * all the document is untouched (the same model.json), the saved views go to exactly the sky they
 * record — an overcast one, and a dusk, which is a time and keeps the Clear tile — and render the
 * same picture as before the look was changed; a render asked with a season is another picture.
 * axe on the panel and the inspector in both themes; the four seasons and the four weathers in
 * light and dark, in test-results/seasons-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const M = 1_280_000;
const p = (x: number, y: number, z: number) => [Math.round(x * M), Math.round(y * M), Math.round(z * M)];
const TREES = ['LS-T1', 'LS-T2', 'LS-T3', 'LS-T4'];

/** The house with two saved views: the garden under an overcast sky, and the courtyard at dusk. */
function withViews(): Record<string, unknown> {
  const doc = structuredClone(HOUSE) as { extensionsUsed: Record<string, string>; extensions: Record<string, unknown> };
  doc.extensionsUsed['FS_views'] = '0.1.0';
  doc.extensions['FS_views'] = {
    views: {
      SV1: { name: 'Garden', eye: p(-14, 8.8, 1.7), target: p(10.4, 8.8, 2.6), focalLength: 24, twoPoint: true, aspect: '16:9', sky: 'overcast', at: '2026-06-21T15:00' },
      SV2: { name: 'Courtyard at dusk', eye: p(3.0, 9.4, 1.7), target: p(12.5, 10.2, 2.6), focalLength: 20, twoPoint: true, aspect: '16:9', sky: 'dusk', at: '2026-06-21T19:30' },
    },
  };
  return doc;
}

interface Hook {
  __floorspec3d?: { ready: boolean; roles: Record<string, string[]>; wet: number };
  __floorspecSun?: { sky: { preset: string; band: string; look: { season: string; weather: string }; snow: boolean; lawnColor: [number, number, number] | null } | null };
}

const roles = (page: Page): Promise<Record<string, string[]>> => page.evaluate(() => (window as unknown as Hook).__floorspec3d?.roles ?? {});
const sky = (page: Page) => page.evaluate(() => (window as unknown as Hook).__floorspecSun?.sky ?? null);

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(300);
}

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

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(400);
    await themeSettled(page);
    await page.screenshot({ path: `test-results/seasons-${name}-${theme}.png` });
  }
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
}

test('seasons and weather on the Courtyard House: foliage through the year, rain and snow, the studio a backdrop — and the model and its saved views untouched', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await firstRunSetup(page, { name: 'Seasons', email: 'seasons@example.test', password: password('seasons') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(withViews())),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  const model = async (): Promise<string> => await (await page.request.get(`/api/projects/${project}/model.json`)).text();
  const render = async (query: string): Promise<Buffer> => {
    const res = await page.request.get(`/api/projects/${project}/render?view=3d&width=160&${query}`, { timeout: 180_000 });
    expect(res.status(), query).toBe(200);
    return res.body();
  };
  const before = await model();
  // The saved views as they render before any look is chosen.
  const garden = await render('savedView=Garden');

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);

  // The whole house, its roofs on: where the snow lies.
  await page.getByRole('combobox', { name: 'Levels in 3D' }).click();
  await page.getByRole('option', { name: /^Whole house/ }).click();
  await expect(page.getByRole('combobox', { name: 'Levels in 3D' })).toContainText('Whole house');

  // ── A summer's day by default, the trees in full leaf.
  await expect.poll(async () => (await sky(page))?.preset).toBe('clear');
  expect((await sky(page))!.look).toEqual({ season: 'summer', weather: 'clear' });
  let r = await roles(page);
  for (const id of TREES) expect(r[id]!.some((x) => x.startsWith('foliage'))).toBe(true);
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Sky and sun' }).click();
  const panel = page.getByRole('region', { name: 'Sky and sun' });
  await expect(panel).toBeVisible();
  const seasons = panel.getByRole('radiogroup', { name: 'Season' });
  const weathers = panel.getByRole('radiogroup', { name: 'Weather' });
  await expect(seasons.getByRole('radio', { name: 'Summer' })).toHaveAttribute('aria-checked', 'true');
  await expect(weathers.getByRole('radio', { name: 'Clear' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('Dusk and night follow the time below; the Studio backdrop moved to Camera ▸ Backdrop.')).toBeVisible();
  await shoot(page, 'summer');

  // ── The inspector beside it, with nothing selected: the plants through the year.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Plants through the year' })).toBeVisible();
  const foliage = inspector.getByRole('region', { name: 'Foliage (FS_landscape)' });
  await expect(foliage).toContainText('Deciduous · 4 trees');
  await expect(foliage).toContainText('full leaf');
  await expect(foliage).toContainText('Evergreen');
  await expect(foliage).toContainText('unchanged');

  // ── Autumn: the maples red, the hornbeams gold, leaves on the lawn and the beds; the lawn yellowing.
  await seasons.getByRole('radio', { name: 'Autumn' }).click();
  await expect.poll(async () => (await sky(page))?.look.season).toBe('autumn');
  r = await roles(page);
  expect(r['LS-T1']).toEqual(expect.arrayContaining(['autumnRed', 'trunk']));
  expect(r['LS-T3']!.some((x) => x === 'autumnGold')).toBe(true);
  for (const id of TREES) expect(r[id]!.some((x) => x.startsWith('foliage'))).toBe(false);
  expect(r['LS-S2']!.some((x) => x.startsWith('foliage'))).toBe(true);
  expect(r['LS-L1']).toEqual(['lawnAutumn']);
  await expect(foliage).toContainText('autumn colour');
  await shoot(page, 'autumn');

  // ── Overcast: the sky and the board's frame — autumn under cloud, contact shadows only.
  await weathers.getByRole('radio', { name: 'Overcast' }).click();
  await expect.poll(async () => (await sky(page))?.preset).toBe('overcast');
  await expect(panel.getByRole('status')).toContainText('Overcast: the sun is behind cloud');
  await expect(inspector.getByRole('region', { name: 'This look' })).toContainText('overcast · diffuse');
  await expect(inspector.getByRole('region', { name: 'Over MCP' })).toContainText('season: "autumn", weather: "overcast"');
  await shoot(page, 'autumn-overcast');
  await axe(page, 'sky and sun panel and plants through the year, autumn overcast');

  // ── Winter: the deciduous trees bare, a crown of limbs; the evergreens keep their leaves; the lawn dormant.
  await seasons.getByRole('radio', { name: 'Winter' }).click();
  await expect.poll(async () => (await sky(page))?.look.season).toBe('winter');
  r = await roles(page);
  for (const id of TREES) expect(r[id]).toEqual(['trunk']);
  expect(r['LS-S2']!.some((x) => x.startsWith('foliage'))).toBe(true);
  expect(r['LS-L1']).toEqual(['lawnWinter']);
  await expect(foliage).toContainText('bare');
  await shoot(page, 'winter');

  // ── Light snow: on the roofs, the lawn and the evergreens; the stepping stones cleared; a field of snow.
  await weathers.getByRole('radio', { name: 'Light snow' }).click();
  await expect.poll(async () => (await sky(page))?.look.weather).toBe('snow');
  expect((await sky(page))!.preset).toBe('overcast');
  expect((await sky(page))!.snow).toBe(true);
  r = await roles(page);
  for (const roof of ['RF1', 'RF2', 'RF3']) expect(r[roof], roof).toContain('snow');
  expect(r['LS-L1']).toContain('snow');
  expect(r['LS-S2']).toContain('snow');
  expect(r['LS-H1'] ?? []).not.toContain('snow');
  await expect(panel.getByRole('status')).toContainText('Light snow');
  await shoot(page, 'winter-snow');
  await axe(page, 'sky and sun panel, winter light snow');

  // ── Spring in the rain: fresh leaves, everything outside wet and darker.
  await seasons.getByRole('radio', { name: 'Spring' }).click();
  await weathers.getByRole('radio', { name: 'Rain-wet' }).click();
  await expect.poll(async () => (await sky(page))?.look).toEqual({ season: 'spring', weather: 'rain' });
  r = await roles(page);
  expect(r['LS-T1']).toContain('leafSpring');
  expect(r['LS-L1']).toEqual(['lawnSpring']);
  expect(await page.evaluate(() => (window as unknown as Hook).__floorspec3d?.wet ?? 0)).toBeGreaterThan(10);
  const wetLawn = (await sky(page))!.lawnColor!;
  expect(wetLawn[0]).toBeLessThan(0.7);
  await shoot(page, 'spring-rain');

  // ── Summer and clear again, then the four weathers' pictures in summer.
  await seasons.getByRole('radio', { name: 'Summer' }).click();
  for (const [name, w] of [['clear', 'Clear'], ['overcast', 'Overcast'], ['rain', 'Rain-wet'], ['snow', 'Light snow']] as const) {
    await weathers.getByRole('radio', { name: w }).click();
    await expect(weathers.getByRole('radio', { name: w })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(400);
    await shoot(page, `weather-${name}`);
  }
  await seasons.getByRole('radio', { name: 'Spring' }).click();
  await shoot(page, 'spring');
  await seasons.getByRole('radio', { name: 'Summer' }).click();
  await weathers.getByRole('radio', { name: 'Clear' }).click();

  // ── Follow the date: the clock's date picks the season (Boston's June: summer; January: winter).
  const follow = panel.getByRole('switch', { name: /^Follow the date/ });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-checked', 'true');
  await panel.getByLabel('Date', { exact: true }).fill('2026-01-15');
  await expect.poll(async () => (await sky(page))?.look.season).toBe('winter');
  await expect(follow).toHaveAccessibleName('Follow the date · Jan 15 is winter');
  await seasons.getByRole('radio', { name: 'Summer' }).click();
  await expect(follow).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await sky(page))?.look.season).toBe('summer');

  // ── The studio is the Camera panel's backdrop; the site comes back under the weather picked.
  await weathers.getByRole('radio', { name: 'Overcast' }).click();
  const cameraButton = page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Camera' });
  await cameraButton.click();
  const camera = page.getByRole('region', { name: 'Camera' });
  const backdrop = camera.getByRole('radiogroup', { name: 'Backdrop' });
  await backdrop.getByRole('radio', { name: 'Studio' }).click();
  await expect.poll(async () => await sky(page)).toBeNull();
  await axe(page, 'camera panel, studio backdrop');
  await backdrop.getByRole('radio', { name: 'Site' }).click();
  await expect.poll(async () => (await sky(page))?.preset).toBe('overcast');

  // ── A saved view goes to exactly the sky it records: overcast; then a dusk — a time, under the Clear tile.
  const views = camera.getByRole('radiogroup', { name: 'Saved view' });
  await views.getByRole('radio', { name: /Courtyard at dusk/ }).click();
  await expect.poll(async () => (await sky(page))?.preset).toBe('dusk');
  await views.getByRole('radio', { name: /Garden/ }).click();
  await expect.poll(async () => (await sky(page))?.preset).toBe('overcast');
  await views.getByRole('radio', { name: /Courtyard at dusk/ }).click();
  await expect.poll(async () => (await sky(page))?.preset).toBe('dusk');
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Sky and sun' }).click();
  await expect(weathers.getByRole('radio', { name: 'Clear' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('status')).toContainText('Dusk: just after sunset');

  // ── None of it touched the model: the same document, and the saved view the same picture as before.
  expect(await model()).toBe(before);
  expect((await render('savedView=Garden')).equals(garden)).toBe(true);
  // floorspec_render's season and weather: another picture, the model still the same.
  const winter = await render('savedView=Garden&season=winter&weather=snow');
  expect(winter.equals(garden)).toBe(false);
  expect(await model()).toBe(before);
  expect(errors).toEqual([]);
});
