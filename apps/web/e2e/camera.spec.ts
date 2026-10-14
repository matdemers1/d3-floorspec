/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-13.10: a camera for photographs (the board's "30 · Editor — 3D camera" and "31 · Shot list").
 * The three suite's house (e2e/fixtures/l-stair-hip-roof.json) with one saved view, "Garden" (FS_views
 * 0.1.0): 50 mm, square, two-point, looking up at the house from the lawn.
 *
 * The Camera button opens the panel and puts the frame up. Going to "Garden" sets the lens — the
 * three.js camera's field of view and a lens shift, which two-point perspective's switch takes away —
 * and the frame's shape; a preset lens widens the view; exposure compensation brightens it. The view is
 * saved as "Hero", renamed and deleted, each an Op on the document. The shot list renders "Garden" on
 * the server and shows the still. axe passes on the panel and the shot list in both themes;
 * screenshots land in test-results/camera-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const M = 1_280_000;

function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Record<string, unknown>).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

type View = { __floorspec3d?: { ready: boolean; camera: { fov: number; shift: number; toneExposure: number } | null } };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300);
}

const camera = (page: Page) => page.evaluate(() => (window as unknown as View).__floorspec3d?.camera ?? null);

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/camera-${name}-${theme}.png` });
  }
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(1000);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

type Views = { extensionsUsed: Record<string, string>; extensions: { FS_views?: { views: Record<string, { name: string; focalLength?: number; aspect?: string }> } } };

test('a camera for photographs: saved views, the lens, two-point perspective, exposure, the frame and a shot list', async ({ page }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, { name: 'Lens', email: 'lens@example.test', password: password('camera') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Photographed house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const house = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(house.status(), await house.text()).toBe(201);
  const garden = await page.request.post(`/api/projects/${project}/ops`, {
    data: {
      batch: [
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_views', value: '0.1.0' },
        { op: 'setProperty', id: '$document', path: '/extensions/FS_views/views/SV1', value: { name: 'Garden', eye: [-16 * M, -16 * M, 1.6 * M], target: [4 * M, 3 * M, 4 * M], focalLength: 50, twoPoint: true, aspect: '1:1', sky: 'clear', at: '2026-06-21T17:00-04:00' } },
      ],
    },
  });
  expect(garden.status(), await garden.text()).toBe(201);

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await ready(page);
  const free = (await camera(page))!;
  expect(free.fov).toBe(45);
  expect(free.shift).toBe(0);

  // The Camera button: the panel, the default lens and the frame over the view.
  const toolbar = page.getByRole('toolbar', { name: '3D view' });
  await toolbar.getByRole('button', { name: 'Camera' }).click();
  const panel = page.getByRole('region', { name: 'Camera' });
  await expect(panel).toBeVisible();
  await expect(page.locator('.fs-camera__frame')).toBeVisible();
  await expect.poll(async () => (await camera(page))!.fov).not.toBe(45);

  // Going to "Garden": 50 mm, square, two-point — the lens shifted up, the frame square.
  const views = panel.getByRole('radiogroup', { name: 'Saved view' });
  await expect(views.getByRole('radio')).toHaveText([/Garden.*50 mm · 1:1 · two-point/]);
  await views.getByRole('radio', { name: /Garden/ }).click();
  await expect(views.getByRole('radio', { name: /Garden/ })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await camera(page))!.shift).toBeGreaterThan(0.05);
  const box = (await page.locator('.fs-camera__frame').boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
  await expect(panel.getByText('50 mm · 40° across')).toBeVisible();
  const at50 = (await camera(page))!.fov;
  await shoot(page, 'garden');
  await axe(page, 'camera panel at a saved view');

  // A wider lens, two-point off, exposure up a stop.
  await panel.getByRole('button', { name: '24 mm', exact: true }).click();
  await expect.poll(async () => (await camera(page))!.fov).toBeGreaterThan(at50 * 1.8);
  await panel.getByRole('switch', { name: 'Two-point perspective' }).click();
  await expect.poll(async () => (await camera(page))!.shift).toBe(0);
  const before = (await camera(page))!.toneExposure;
  await panel.getByLabel('Exposure').fill('10');
  await expect(panel.getByText('+1.0 EV')).toBeVisible();
  await expect.poll(async () => (await camera(page))!.toneExposure / before).toBeCloseTo(2, 3);

  // Saved as "Hero" — an Op on $document — then renamed and deleted.
  await panel.getByRole('button', { name: 'Save view…' }).click();
  await panel.getByLabel('Name').fill('Hero');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await settled(page);
  await expect(views.getByRole('radio', { name: /Hero/ })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => {
    const doc = (await modelOf(page, project)) as unknown as Views;
    return Object.values(doc.extensions.FS_views?.views ?? {}).map((v) => [v.name, v.focalLength ?? 35]).sort();
  }).toEqual([['Garden', 50], ['Hero', 24]]);
  await panel.getByRole('button', { name: 'More for Hero' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await panel.getByLabel('Rename “Hero”').fill('Front lawn');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await settled(page);
  await expect(views.getByRole('radio', { name: /Front lawn/ })).toBeVisible();
  await panel.getByRole('button', { name: 'More for Front lawn' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await settled(page);
  await expect(views.getByRole('radio')).toHaveText([/Garden/]);
  await expect.poll(async () => Object.keys(((await modelOf(page, project)) as unknown as Views).extensions.FS_views?.views ?? {})).toEqual(['SV1']);

  // The shot list: "Garden", on the server, small and quick; the still shown when it is done.
  await panel.getByRole('button', { name: 'Shot list…' }).click();
  const shots = page.getByRole('dialog', { name: 'Shot list' });
  await expect(shots).toBeVisible();
  await expect(shots.getByRole('checkbox', { name: 'Garden' })).toBeChecked();
  await shots.getByRole('radio', { name: 'The server' }).click();
  await shots.getByRole('combobox').nth(0).click();
  await page.getByRole('option', { name: /^Small/ }).click();
  await shots.getByRole('combobox').nth(1).click();
  await page.getByRole('option', { name: /^Draft/ }).click();
  await shoot(page, 'shot-list');
  await axe(page, 'shot list');
  await shots.getByRole('button', { name: 'Render 1 shot' }).click();
  const done = page.getByRole('dialog', { name: 'Your shots are ready' });
  await expect(done).toBeVisible({ timeout: 300_000 });
  await expect(done.getByRole('img', { name: 'Garden, rendered' })).toBeVisible();
  await expect(done.getByText('1:1 · 960 × 960')).toBeVisible();
  await shoot(page, 'shots-done');
  await done.getByRole('button', { name: 'Close', exact: true }).click();

  // Closed with Escape: the chip stands for the camera, and its × goes back to the free view.
  await panel.getByRole('radio', { name: /Garden/ }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: /^Camera · Garden\. Open the camera$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the free view' }).click();
  await expect(page.locator('.fs-camera__frame')).toBeHidden();
  await expect.poll(async () => (await camera(page))!.fov).toBe(45);
});
