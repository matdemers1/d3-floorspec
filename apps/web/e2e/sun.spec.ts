/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-8.6, FLR-REQ-123: "With site orientation and latitude, a date/time control positions the
 * sun and casts shadows in 3D."
 *
 * The house is the three suite's (e2e/fixtures/l-stair-hip-roof.json), built through the API with
 * no site. In the 3D view the toolbar's Sun turns the study on; the panel asks for the site's place,
 * which is typed into its fields and lands in the document as Ops on `$site` (Core 1.8). The date
 * is typed, the time set from the keyboard on the slider, the offset chosen; then the light three.js
 * draws with is read through the sun's test hook (navigator.webdriver only) and must point where the
 * solar module says, turned by true north. The sun sets, the walkthrough keeps it, play with reduced
 * motion steps rather than sweeps, and axe passes on the panel in both themes. Screenshots of each
 * state, in light and dark, land in test-results/sun-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RAD = Math.PI / 180;

function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Record<string, unknown>).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

type V3 = [number, number, number];

interface SunHook {
  on: boolean;
  located: boolean;
  study: { azimuth: number; altitude: number; vector: V3; night: boolean; instant: string } | null;
  light: { direction: V3; intensity: number; castShadow: boolean; mapSize: number; frustum: number } | null;
  shadowMap: boolean;
  casters: number;
  receivers: number;
  ground: boolean;
  set(clock: { date?: string; minutes?: number; offset?: number | 'auto' }): void;
}

declare global {
  interface Window {
    __floorspecSun?: SunHook;
  }
}

const sunHook = (page: Page) =>
  page.evaluate(() => {
    const h = window.__floorspecSun;
    if (h === undefined) return null;
    return { on: h.on, located: h.located, study: h.study, light: h.light, shadowMap: h.shadowMap, casters: h.casters, receivers: h.receivers, ground: h.ground };
  });

/** The 3D view's own hook (declared fully by three.spec.ts): only what this suite reads. */
type View = { __floorspec3d?: { ready: boolean; walking: boolean } };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as View).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/sun-${name}-${theme}.png` });
  }
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(200);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

const near = (a: readonly number[], b: readonly number[], eps: number) => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= eps);

test('the sun and shadow study: site, date and time place the sun and cast shadows in 3D', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Sunny', email: 'sunny@example.test', password: password('sun') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Sun study house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(applied.status(), await applied.text()).toBe(201);

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);

  // ── The sun is off: the view's even light, nothing casting.
  const sunButton = page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Sun and shadow' });
  await expect(sunButton).toBeEnabled();
  await expect(sunButton).toHaveAttribute('aria-pressed', 'false');
  expect((await sunHook(page))?.light).toBeNull();

  // ── On: the panel opens, and asks for the site's place.
  await sunButton.click();
  await expect(sunButton).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'Sun and shadow' });
  await expect(panel).toBeVisible();
  const status = panel.getByRole('status');
  await expect(status).toHaveText('The site has no location yet: add its latitude and longitude to place the sun.');
  expect((await sunHook(page))?.located).toBe(false);
  await axe(page, 'sun panel, no site location');

  // The site's place, typed: latitude waits for longitude, then both land as one Op on $site.
  await panel.getByLabel('Latitude').fill('42.3601 N');
  await panel.getByLabel('Latitude').press('Enter');
  await expect(panel.getByText('Add the longitude to place the site.')).toBeVisible();
  await panel.getByLabel('Longitude').fill('71.0589 W');
  await panel.getByLabel('Longitude').press('Enter');
  await settled(page);
  await panel.getByLabel('True north').fill('-12.5');
  await panel.getByLabel('True north').press('Enter');
  await settled(page);
  await expect.poll(async () => ((await modelOf(page, project)) as { site?: unknown }).site).toEqual({ location: { latitude: 42_360_100, longitude: -71_058_900 }, trueNorth: -12_500_000 });

  // ── The clock: a date typed, the offset chosen, the time set from the keyboard on the slider.
  await panel.getByLabel('Date', { exact: true }).fill('2026-10-04');
  await panel.getByRole('combobox', { name: 'Time zone' }).click();
  await page.getByRole('option', { name: 'UTC−04:00', exact: true }).click();
  const slider = panel.getByRole('slider', { name: 'Time' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', '12:00 am');
  for (let i = 0; i < 15; i++) await page.keyboard.press('PageUp'); // an hour each
  await expect(slider).toHaveAttribute('aria-valuetext', '3:00 pm');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '3:15 pm');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuetext', '3:00 pm');

  // ── Boston, 4 October 2026, 3 pm EDT: the sun in the south-west, about 225° and 32° up.
  await expect(status).toContainText('Sun in the south-west, 32° above the horizon: azimuth 225° (south-west), altitude 32.4°.');
  await page.waitForTimeout(300);
  const day = (await sunHook(page))!;
  expect(day.study!.instant).toBe('2026-10-04T19:00:00.000Z');
  // The solar module's own value (its accuracy is the unit tests' business, against published references).
  expect(Math.abs(day.study!.azimuth - 225.0005)).toBeLessThan(0.1);
  expect(Math.abs(day.study!.altitude - 32.449)).toBeLessThan(0.1);
  // The direction, turned into the project's frame by true north (−12.5°: 12.5° clockwise of +Y), worked out here independently…
  const { azimuth: A, altitude: h } = day.study!;
  const expected: V3 = [Math.sin((A + 12.5) * RAD) * Math.cos(h * RAD), Math.cos((A + 12.5) * RAD) * Math.cos(h * RAD), Math.sin(h * RAD)];
  expect(near(day.study!.vector, expected, 1e-9)).toBe(true);
  // …is the direction three.js lights the house from, and it casts shadows onto the house and the ground.
  expect(day.light).not.toBeNull();
  expect(near(day.light!.direction, expected, 1e-5)).toBe(true);
  expect(day.light!.castShadow).toBe(true);
  expect(day.light!.intensity).toBeGreaterThan(0);
  expect(day.light!.mapSize).toBeGreaterThanOrEqual(1024);
  expect(day.shadowMap).toBe(true);
  expect(day.casters).toBeGreaterThan(10);
  expect(day.receivers).toBeGreaterThan(10);
  expect(day.ground).toBe(true);
  await expect(panel.getByText(/^Sunrise 6:4\d am · solar noon 12:\d\d pm · sunset 6:2\d pm$/)).toBeVisible();
  // The whole house, roof on: what casts the long shadows.
  await page.getByRole('button', { name: /Cutaway · / }).click();
  await expect(page.getByRole('button', { name: 'Whole house' })).toBeVisible();
  // Back a little, so the shadows on the ground are in the picture.
  await page.getByRole('application', { name: /^3D view of / }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('-');
  await page.waitForTimeout(400);
  // From the north-east, where the afternoon shadows fall.
  await page.getByRole('button', { name: /View: SW iso/ }).click();
  await page.getByRole('button', { name: /View: SE iso/ }).click();
  await expect(page.getByRole('button', { name: /View: NE iso/ })).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, 'afternoon');
  for (const at of ['NE iso', 'NW iso', 'Top']) await page.getByRole('button', { name: new RegExp(`View: ${at}`) }).click();
  await expect(page.getByRole('button', { name: /View: SW iso/ })).toBeVisible();
  await page.getByRole('application', { name: /^3D view of / }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('-');
  await axe(page, 'sun panel, afternoon');

  // A solstice preset moves the date; the sun is higher at the June solstice's 3 pm.
  await panel.getByRole('button', { name: 'Jun solstice' }).click();
  await expect(panel.getByLabel('Date', { exact: true })).toHaveValue(/^\d{4}-06-2[01]$/);
  await expect.poll(async () => (await sunHook(page))!.study!.altitude).toBeGreaterThan(45);
  await panel.getByLabel('Date', { exact: true }).fill('2026-10-04');

  // ── Morning: the sun swings to the south-east, and the light with it.
  for (let i = 0; i < 6; i++) await slider.press('PageDown');
  await expect(slider).toHaveAttribute('aria-valuetext', '9:00 am');
  await expect(status).toContainText('Sun in the south-east');
  const morning = (await sunHook(page))!;
  expect(near(morning.light!.direction, morning.study!.vector, 1e-5)).toBe(true);
  expect(morning.light!.direction[0]).toBeGreaterThan(0); // east of the plan's middle
  await shoot(page, 'morning');

  // ── Night: below the horizon, no sun and nothing cast.
  await slider.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', '11:59 pm');
  await expect(status).toContainText('Night: the sun is');
  const night = (await sunHook(page))!;
  expect(night.study!.night).toBe(true);
  expect(night.light!.intensity).toBe(0);
  expect(night.light!.castShadow).toBe(false);
  await shoot(page, 'night');

  // ── Reduced motion: nothing plays by itself; Play steps a quarter-hour at a time.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await slider.press('Home');
  for (let i = 0; i < 12; i++) await slider.press('PageUp');
  await expect(slider).toHaveAttribute('aria-valuetext', '12:00 pm');
  await page.waitForTimeout(1200);
  await expect(slider).toHaveAttribute('aria-valuetext', '12:00 pm');
  await panel.getByRole('button', { name: 'Play the day' }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '12:15 pm', { timeout: 3000 });
  await panel.getByRole('button', { name: 'Pause' }).click();
  const paused = await slider.getAttribute('aria-valuetext');
  expect(paused).toMatch(/^12:(15|30) pm$/);
  await page.waitForTimeout(1300);
  await expect(slider).toHaveAttribute('aria-valuetext', paused!);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await panel.getByRole('button', { name: `Back 15 minutes` }).click();
  await panel.getByRole('button', { name: `Forward 15 minutes` }).click();
  for (let i = 0; i < 3; i++) await slider.press('PageUp');
  await expect(slider).toHaveAttribute('aria-valuetext', /^3:(00|15) pm$/);
  await slider.press('Home');
  for (let i = 0; i < 15; i++) await slider.press('PageUp');
  await expect(slider).toHaveAttribute('aria-valuetext', '3:00 pm');

  // ── Closed, the panel is a chip; the inspector's 3D section says what lights the view.
  await panel.getByRole('button', { name: 'Close the sun panel' }).click();
  await expect(panel).toBeHidden();
  const chip = page.getByRole('button', { name: 'Sun · Oct 4 · 3 pm. Open the sun panel' });
  await expect(chip).toBeVisible();
  await page.getByRole('treeitem', { name: /^Kitchen/ }).first().click();
  const three = page.getByRole('complementary', { name: 'Inspector' }).getByRole('region', { name: '3D' });
  await expect(three).toContainText('Shadows');
  await expect(three).toContainText('Sun · Oct 4 · 3 pm');
  await shoot(page, 'chip');

  // ── The walkthrough keeps the sun.
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Walk through' }).click();
  await page.waitForFunction(() => (window as View).__floorspec3d?.walking === true);
  const walking = (await sunHook(page))!;
  expect(walking.light!.castShadow).toBe(true);
  expect(near(walking.light!.direction, day.study!.vector, 1e-5)).toBe(true);
  await page.waitForTimeout(400);
  await shoot(page, 'walk');
  await page.getByRole('button', { name: 'Exit walkthrough' }).click();
  await ready(page);

  // ── The nothing-selected inspector edits the same site.
  await page.locator('body').focus();
  await page.keyboard.press('Escape');
  const site = page.getByRole('complementary', { name: 'Inspector' }).getByRole('region', { name: 'Site' });
  await expect(site.getByLabel('Latitude')).toHaveValue('42.3601° N');
  await expect(site.getByLabel('True north')).toHaveValue('-12.5°');

  // ── Off: the even light again.
  await sunButton.click();
  await expect(sunButton).toHaveAttribute('aria-pressed', 'false');
  await expect(chip).toBeHidden();
  await expect.poll(async () => (await sunHook(page))?.light ?? null).toBeNull();
});
