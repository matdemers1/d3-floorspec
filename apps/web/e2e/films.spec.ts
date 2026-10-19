/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, modelOf, settled } from './support.js';

/**
 * FLR-T-14.1: films (the board's "14.1 · Film" frames). The Courtyard House (the worker's fixture)
 * with five saved views. From the Camera panel's footer, Film… opens the timeline at the bottom of the
 * 3D view; two saved views are added as keyframes — each an Op on the document's extras — the second
 * dragged to a second in and nudged on with the arrows, eased linearly and held; the film plays and the 3D camera follows it; the
 * render dialog makes a draft, day to night, as a small MP4; the job card counts its frames and, done,
 * plays the film and downloads it — an MP4 whose first box is `ftyp`. axe passes on the timeline, the
 * keyframe popover, the dialog and the job card in both themes; screenshots land in test-results/films-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const M = 1_280_000;
const p = (x: number, y: number, z: number) => [Math.round(x * M), Math.round(y * M), Math.round(z * M)];

/** The house with its saved views: a walk in from the lawn, through the foyer and the great room to the kitchen, and back out to the courtyard. */
function withViews(): Record<string, unknown> {
  const doc = structuredClone(HOUSE) as { extensionsUsed: Record<string, string>; extensions: Record<string, unknown> };
  doc.extensionsUsed['FS_views'] = '0.1.0';
  doc.extensions['FS_views'] = {
    views: {
      SV1: { name: 'Hero exterior', eye: p(-14, 8.8, 1.7), target: p(10.4, 8.8, 2.6), focalLength: 24, twoPoint: true, aspect: '16:9', at: '2026-06-21T15:00' },
      SV2: { name: 'Foyer', eye: p(11.4, 4.6, 1.6), target: p(13.5, 9.5, 1.5), focalLength: 20, aspect: '16:9' },
      SV3: { name: 'Great room', eye: p(12.0, 8.0, 1.6), target: p(18, 12.5, 2.2), focalLength: 20, twoPoint: true, aspect: '16:9' },
      SV4: { name: 'Kitchen', eye: p(12.5, 12.6, 1.6), target: p(17, 17.5, 0.9), focalLength: 24, aspect: '4:5' },
      SV5: { name: 'Courtyard at dusk', eye: p(3.0, 9.4, 1.7), target: p(12.5, 10.2, 2.6), focalLength: 20, twoPoint: true, aspect: '16:9', sky: 'dusk', at: '2026-06-21T19:30', lights: 'on' },
    },
  };
  return doc;
}

type View = { __floorspec3d?: { ready: boolean; camera: { fov: number; shift: number } | null } };
type Films = { extras?: { d3floorspec?: { films?: Record<string, { name: string; keys: { at: number; view?: string; ease?: string; hold?: number }[] }> } } };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/films-${name}-${theme}.png` });
  }
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(800);
    // The WebGL canvas is aria-hidden; the keyframe chips over it are pointer conveniences the timeline repeats.
    const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('.fs-three__canvas').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

/** The suite's one account: the first test sets it up, the second signs in with it. */
const DIRECTOR = { name: 'Director', email: 'director@example.test', password: 'films-director-e2e-only' };

const filmOf = async (page: Page, project: string) => Object.values(((await modelOf(page, project)) as unknown as Films).extras?.d3floorspec?.films ?? {})[0];

test('a film: keyframes from saved views, eased and held, played, and rendered day to night as an MP4', async ({ page }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, DIRECTOR);
  // Larger than one batch may be: imported as a model.json, which the server builds as Ops (FLR-T-9.1).
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(withViews())),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);

  // ── Film… in the Camera panel's footer, beside the shot list: the timeline, empty.
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Camera' }).click();
  const panel = page.getByRole('region', { name: 'Camera' });
  await expect(panel.getByRole('button', { name: 'Shot list…' })).toBeVisible();
  await panel.getByRole('button', { name: 'Film…' }).click();
  await expect(panel).toBeHidden();
  const timeline = page.getByRole('region', { name: /^Film/ });
  await expect(timeline).toBeVisible();
  await expect(timeline.getByText('No keyframes yet: add a saved view, or record a walk.')).toBeVisible();
  await expect(timeline.getByRole('button', { name: 'Render film…' })).toBeDisabled();

  // ── Two saved views added: the film is made in the document's extras, its keys 5 s apart.
  for (const name of ['Hero exterior', 'Foyer']) {
    await timeline.getByRole('button', { name: 'Add view' }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${name} ·`) }).click();
    await settled(page);
  }
  await expect.poll(async () => (await filmOf(page, project))?.keys.map((k) => [k.at, k.view])).toEqual([[0, 'SV1'], [5000, 'SV2']]);
  const keys = timeline.getByRole('group', { name: 'Camera keyframes' }).getByRole('button');
  await expect(keys).toHaveCount(2);
  await expect(keys.nth(1)).toHaveAccessibleName('Keyframe 2, Foyer, at 0:05.0');

  // ── The second key dragged to about a second in, then nudged with the arrows: each move one Op.
  const lane = (await timeline.locator('.fs-film__lane').boundingBox())!;
  const key2 = (await keys.nth(1).boundingBox())!;
  await page.mouse.move(key2.x + key2.width / 2, key2.y + key2.height / 2);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width * 0.2, key2.y + key2.height / 2, { steps: 8 });
  await page.mouse.up();
  await settled(page);
  await expect.poll(async () => (await filmOf(page, project))?.keys[1]?.at).toBeLessThan(1600);
  const dragged = (await filmOf(page, project))!.keys[1]!.at;
  await keys.nth(1).focus();
  await page.keyboard.press('ArrowRight');
  await settled(page);
  await expect.poll(async () => (await filmOf(page, project))?.keys[1]?.at).toBe(dragged + 100);
  await page.keyboard.press('Shift+ArrowRight');
  await settled(page);
  await expect.poll(async () => (await filmOf(page, project))?.keys[1]?.at).toBe(dragged + 1100);

  // ── Its popover: linear into it, held half a second.
  await keys.nth(1).click();
  const popover = page.getByRole('dialog', { name: /^2 · Foyer/ });
  await expect(popover).toBeVisible();
  await expect(popover.getByText(/20 mm · 16:9 — from the saved view “Foyer”/)).toBeVisible();
  await popover.getByRole('radio', { name: 'Linear' }).click();
  await settled(page);
  await popover.getByLabel('Hold here').fill('0.5');
  await popover.getByLabel('Hold here').press('Enter');
  await settled(page);
  await expect.poll(async () => {
    const k = (await filmOf(page, project))?.keys[1];
    return [k?.ease, k?.hold];
  }).toEqual(['linear', 500]);
  await shoot(page, 'keyframe');
  await axe(page, 'film timeline with a keyframe’s popover');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // ── Played: the playhead runs to the end, and the 3D camera follows the film's lens.
  const playhead = timeline.getByRole('slider', { name: 'Playhead' });
  await expect(playhead).toHaveAttribute('aria-valuenow', /^\d/);
  const fov = async () => (await page.evaluate(() => (window as unknown as View).__floorspec3d?.camera?.fov ?? null))!;
  // At the Foyer's keyframe (20 mm); Home takes the playhead, and the lens, back to the Hero exterior's (24 mm).
  const atFoyer = await fov();
  await playhead.focus();
  await page.keyboard.press('Home');
  await expect(playhead).toHaveAttribute('aria-valuenow', '0');
  await expect.poll(fov).toBeLessThan(atFoyer);
  const fovAtStart = await fov();
  await timeline.getByRole('button', { name: 'Play (Space)' }).click();
  await expect(timeline.getByRole('button', { name: 'Play (Space)' })).toBeVisible({ timeout: 10_000 });
  const film = (await filmOf(page, project))!;
  const end = (film.keys[1]!.at + (film.keys[1]!.hold ?? 0)) / 1000;
  await expect(playhead).toHaveAttribute('aria-valuenow', String(Math.round(end * 10) / 10));
  await expect.poll(fov).toBeGreaterThan(fovAtStart);
  await shoot(page, 'timeline');

  // ── Render film…: a draft at 720p, 24 fps, day to night.
  await timeline.getByRole('button', { name: 'Render film…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render film' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Draft — raster/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: '720p' }).click();
  await dialog.getByRole('radio', { name: '24' }).click();
  await dialog.getByRole('radio', { name: /Day to night/ }).click();
  await expect(dialog.getByText(/^sunset \d+:\d\d pm$/)).toBeVisible();
  await expect(dialog.getByRole('switch', { name: /Lights come on at dusk/ })).toBeChecked();
  await expect(dialog.getByText(/^\d+ frames\. Renders on the server/)).toBeVisible();
  // A final at 4K is refused: drafts only.
  await dialog.getByRole('radio', { name: /Final — path-traced/ }).click();
  await expect(dialog.getByRole('radio', { name: '4K' })).toBeDisabled();
  await dialog.getByRole('radio', { name: /Draft — raster/ }).click();
  await shoot(page, 'dialog');
  await axe(page, 'render dialog, day to night');
  await dialog.getByRole('button', { name: 'Render film' }).click();
  await expect(dialog).toBeHidden();

  // ── The job card: frames done, never a time; then the film, to play and download.
  const card = page.getByRole('region', { name: 'Film job' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/^(Frame \d+ of \d+|\d+ frames)$/)).toBeVisible();
  await expect(card).not.toContainText(/left|remaining|minutes?|seconds?/);
  await expect(card.getByRole('heading', { name: 'Film ready' })).toBeVisible({ timeout: 300_000 });
  await expect(card.locator('video')).toHaveAttribute('src', /\/exports\/[0-9a-f-]{36}\/file$/);
  await expect(card.getByText(/^film-walk-through-[0-9a-f]{8}\.mp4 · 0:0\d · 720p · [\d.]+ (KB|MB)$/)).toBeVisible();
  await shoot(page, 'done');
  await axe(page, 'film job card, done');
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^film-.*\.mp4$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  expect(bytes.includes(Buffer.from('avc1'))).toBe(true);

  // The export is listed, and says what it is.
  const list = (await (await page.request.get(`/api/projects/${project}/exports`)).json()) as { exports: { kind: string; status: string; film: { light: string; frames: number; size: string } }[] };
  expect(list.exports[0]).toMatchObject({ kind: 'film', status: 'done', film: { light: 'day-to-night', size: '720p' } });
});

/** The walk-in film the board draws: seven keyframes, five of them saved views, one held, one linear. */
function withFilm(): Record<string, unknown> {
  const doc = withViews();
  doc['extras'] = {
    d3floorspec: {
      films: {
        F1: {
          name: 'Courtyard walk-in',
          keys: [
            { at: 0, view: 'SV1' },
            { at: 4500, eye: p(5.5, 5.4, 1.6), target: p(12.5, 5.1, 1.6), focalLength: 22, name: 'Courtyard path' },
            { at: 8000, view: 'SV2' },
            { at: 14000, view: 'SV3', ease: 'linear' },
            { at: 21000, view: 'SV4', hold: 2000 },
            { at: 26000, eye: p(11.6, 10.1, 1.6), target: p(4, 9.6, 1.8), focalLength: 22, name: 'Out to the courtyard' },
            { at: 30000, view: 'SV5' },
          ],
        },
      },
    },
  };
  return doc;
}

test('the Courtyard walk-in: its keyframes over the house, a film rendering frame by frame, folded away and cancelled', async ({ page }) => {
  test.setTimeout(300_000);
  // The suite's database was set up by the test before: signed in with its account.
  const signedIn = await page.request.post('/auth/login', { data: { email: DIRECTOR.email, password: DIRECTOR.password } });
  expect(signedIn.status(), await signedIn.text()).toBeLessThan(300);
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(withFilm())),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);

  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('region', { name: 'Camera' }).getByRole('button', { name: 'Film…' }).click();
  const timeline = page.getByRole('region', { name: 'Film · Courtyard walk-in' });
  await expect(timeline).toBeVisible();
  await expect(timeline.getByText('0:30', { exact: true })).toBeVisible();
  const keys = timeline.getByRole('group', { name: 'Camera keyframes' }).getByRole('button');
  await expect(keys).toHaveCount(7);
  await expect(keys.nth(4)).toHaveAccessibleName('Keyframe 5, Kitchen, at 0:21.0, holds 2 s');
  // The path over the house, and a chip at each named keyframe.
  await expect(page.locator('.fs-film-mark')).toHaveCount(7);
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => page.locator('.fs-film-mark').evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility === 'visible').length)).toBeGreaterThan(2);
  // The Kitchen's keyframe, picked from its chip over the 3D view.
  await page.locator('.fs-film-mark[data-key="4"]').dispatchEvent('click');
  const popover = page.getByRole('dialog', { name: /^5 · Kitchen/ });
  await expect(popover).toBeVisible();
  await expect(popover.getByLabel('Hold here')).toHaveValue('2');
  await expect(timeline.getByText('Hold 2 s · Ease')).toBeVisible();
  await shoot(page, 'walk-in');
  await page.keyboard.press('Escape');

  // Day to night at 1080p and 30 fps: 900 frames.
  await timeline.getByRole('button', { name: 'Render film…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render film' });
  await expect(dialog.getByText('Courtyard walk-in · 7 keyframes · 0:30')).toBeVisible();
  await dialog.getByRole('radio', { name: /Day to night/ }).click();
  await expect(dialog.getByText(/^900 frames\./)).toBeVisible();
  await shoot(page, 'walk-in-dialog');
  await dialog.getByRole('button', { name: 'Render film' }).click();

  // Rendering: the frame just made, frames done of 900, the clock at the site — never a time left.
  const card = page.getByRole('region', { name: 'Film job' });
  await expect(card.getByRole('heading', { name: 'Rendering film · Draft' })).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText(/^Frame \d+ of 900$/)).toBeVisible();
  await expect(card.getByText(/^\d+:\d\d [ap]m in the film$/)).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('img', { name: /^Frame \d+ of Courtyard walk-in$/ })).toBeVisible({ timeout: 60_000 });
  await expect(timeline.getByText(/· lights on at dusk$/)).toBeVisible();
  await shoot(page, 'rendering');
  await axe(page, 'film job card, rendering');

  // Folded away it keeps rendering; opened again, cancelled.
  await card.getByRole('button', { name: 'Keep editing' }).click();
  const pill = page.getByRole('status', { name: 'Film' });
  await expect(pill).toContainText(/^Film · frame \d+ of 900$/);
  await pill.getByRole('button', { name: 'Show the film’s card' }).click();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('heading', { name: 'Film cancelled' })).toBeVisible();
  await expect(card.getByText(/^Cancelled at frame \d+ of 900\./)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
  await shoot(page, 'cancelled');
  const list = (await (await page.request.get(`/api/projects/${project}/exports`)).json()) as { exports: { kind: string; status: string; cancelled: boolean }[] };
  expect(list.exports[0]).toMatchObject({ kind: 'film', status: 'failed', cancelled: true });
});
