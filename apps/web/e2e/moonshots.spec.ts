// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-12.6, the moonshots: the advisory energy and comfort estimate of the standard's ranch — from
 * the dashboard's card to the screen, labelled as an estimate to compare options and never a code
 * calculation, its climate changed through Ops — and a path-traced still of the 3D view, rendered on
 * the job queue at the small size and draft quality, shown, and downloaded. axe on the states the
 * a11y suite cannot reach (a still rendering, and done), in both themes. WebGL through SwiftShader.
 */

type Hooked = { __floorspec3d?: { ready: boolean; parts: number } };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // A dialog's backdrop and a theme's colours fade in: axe measures contrast once they have finished.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

test('the energy estimate of a template, its climate changed, and a path-traced still of its 3D view', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Moonshots', email: 'moonshots@example.test', password: password('moonshots') });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // A project from the ranch template (the projects list offers the templates once it has a project).
  await page.getByRole('button', { name: 'New project' }).first().click();
  const blank = page.getByRole('dialog', { name: 'New project' });
  await blank.getByLabel('Name').fill('First house');
  await blank.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.goto('/projects');
  await page.getByRole('region', { name: 'Start from a template' }).getByText('Ranch', { exact: true }).click();
  await page.getByRole('dialog', { name: 'New project from Ranch' }).getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());

  // ── The dashboard's card: loads as ranges, labelled advisory, the way in.
  const card = page.locator('[data-region="energy"]');
  await expect(card.getByRole('heading', { name: 'Energy & comfort' })).toBeVisible();
  await expect(card).toContainText('Advisory');
  await expect(card).toContainText(/Heating \d+–\d+ kBtu\/h · Cooling [\d.]+–\d+ kBtu\/h/);
  await expect(card).toContainText('not an energy-code calculation');
  await card.screenshot({ path: 'test-results/moonshots-dashboard-card.png' });
  await card.getByRole('button', { name: 'Open estimate' }).click();

  // ── The estimate.
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/energy$`));
  await expect(page.getByRole('heading', { name: 'Energy & comfort', level: 1 })).toBeVisible();
  await expect(page.getByText('An estimate to compare options — not an energy-code calculation.')).toBeVisible();
  await expect(page.getByText('Advisory — for comparing options')).toBeVisible();
  const loads = page.getByRole('group', { name: 'Loads' });
  await expect(loads).toContainText('Heating design load');
  await expect(loads).toContainText('Cooling, typical year');
  const facades = page.getByRole('table', { name: /by the way each wall faces/ });
  for (const f of ['North', 'East', 'South', 'West', 'Whole house']) await expect(facades.getByRole('row', { name: new RegExp(`^${f}`) })).toBeVisible();
  const envelope = page.getByRole('table', { name: /where the value came from/ });
  await expect(envelope).toContainText('Exterior walls');
  await expect(envelope).toContainText('Walls to unconditioned rooms');
  await expect(envelope).toContainText('R-22');
  await expect(envelope).toContainText(/Typical for zone 4/);
  await expect(page.locator('[aria-labelledby="fs-energy-climate"]')).toContainText('Assumed');
  await expect(page.locator('[aria-labelledby="fs-energy-notes"]')).toContainText('Hall bath has no window that opens');
  await expect(page.locator('main')).not.toContainText(/complian/i);
  const heatingBefore = await loads.locator('.d3-stat').first().locator('.d3-stat__number').textContent();
  await page.screenshot({ path: 'test-results/moonshots-energy.png', fullPage: true });

  // ── Climate & assumptions: zone 6A and a better window, saved as one op on the document's extras.
  await page.getByRole('button', { name: 'Climate & assumptions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Climate & assumptions' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Climate zone' }).click();
  await page.getByRole('option', { name: /^6A/ }).click();
  await dialog.getByRole('textbox', { name: /^Windows · \d+/ }).fill('5');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[aria-labelledby="fs-energy-climate"]')).toContainText('Zone 6A preset');
  await expect(envelope).toContainText('Your value');
  await expect.poll(async () => loads.locator('.d3-stat').first().locator('.d3-stat__number').textContent()).not.toBe(heatingBefore);
  const held = (await modelOf(page, project)) as { extras?: { d3floorspec?: { energy?: { zone?: string; assemblies?: Record<string, { u?: number }> } } } };
  expect(held.extras?.d3floorspec?.energy?.zone).toBe('6A');
  expect(held.extras?.d3floorspec?.energy?.assemblies?.['window']?.u).toBeCloseTo(5.678263 / 5, 6);
  expect((await historyOf(page, project))[0]?.kind).toBe('apply');

  // ── A path-traced still of the 3D view: small, draft, on the job queue.
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as Hooked).__floorspec3d?.ready === true, undefined, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Render still' }).click();
  const still = page.getByRole('dialog', { name: 'Render a still' });
  await expect(still).toContainText('approximate');
  await still.getByRole('combobox', { name: 'Size' }).click();
  await page.getByRole('option', { name: /^Small/ }).click();
  await still.getByRole('combobox', { name: 'Quality' }).click();
  await page.getByRole('option', { name: /^High/ }).click();
  await still.getByRole('combobox', { name: 'Quality' }).click();
  await page.getByRole('option', { name: /^Draft/ }).click();
  await still.getByRole('button', { name: 'Render still' }).click();
  const rendering = page.getByRole('dialog', { name: 'Rendering a still…' });
  await expect(rendering).toBeVisible();
  await expect(rendering.getByRole('progressbar', { name: 'Rendering progress' })).toBeVisible();
  await axe(page, 'render still, rendering');
  const ready = page.getByRole('dialog', { name: 'Your still is ready' });
  await expect(ready).toBeVisible({ timeout: 180_000 });
  await expect(ready).toContainText('Offline path-traced render — approximate lighting');
  const image = ready.getByRole('img', { name: /^Path-traced still: SW iso/ });
  await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640);
  await page.screenshot({ path: 'test-results/moonshots-still-dialog.png' });
  await axe(page, 'render still, ready');

  // The PNG, as Download fetches it.
  const jobs = (await (await page.request.get(`/api/projects/${project}/exports`)).json()) as { exports: { kind: string; status: string; download: string | null; result: { width?: number } | null }[] };
  const job = jobs.exports.find((j) => j.kind === 'still');
  expect(job?.status).toBe('done');
  const png = await page.request.get(job?.download ?? '');
  expect(png.headers()['content-type']).toBe('image/png');
  const bytes = await png.body();
  expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync('test-results/moonshots-still.png', bytes);

  // The still is under Exports on the dashboard.
  await page.goto(`/projects/${project}`);
  await expect(page.locator('[data-region="exports"]')).toContainText(/still-sw-/);
  expect(errors).toEqual([]);
});
