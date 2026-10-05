import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, projectIn } from './support.js';

/**
 * FLR-T-9.3: the P9 exit demo's drawings — "the PDF prints a dimensioned sheet per level." A
 * two-level house is built through the API exactly as an edit is (one Ops batch), then exported
 * from the editor's Export dialog and from the dashboard: the server queues the job, its own drain
 * draws it (no worker runs in this suite: JOB_DRAIN is inline outside production), and the browser
 * downloads a PDF with a sheet per level and a schedule sheet, and a ZIP of one DXF per level.
 */

type Elements = Record<string, Record<string, unknown> | undefined>;
const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/two-storey.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/** The fixture as one batch of addElement operations, in reference order. */
function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Elements).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

async function download(page: Page, act: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), act()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path) };
}

test('exports a dimensioned PDF sheet per level and DXF drawings', async ({ page }) => {
  await firstRunSetup(page, { name: 'Drawings', email: 'drawings@example.test', password: password('drawings') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Two-storey ranch');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());

  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(applied.status(), await applied.text()).toBe(201);

  // ── From the editor: Export opens the dialog; the dimensioned PDF is the default choice.
  await page.goto(`/projects/${project}/editor`);
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Two-storey ranch' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Dimensioned PDF/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('radio', { name: /IFC4 Reference View/ })).toBeDisabled();
  await expect(dialog).toContainText('Main floor + Upper floor');
  await page.waitForTimeout(400); // the dialog's entrance, so the picture is of the dialog
  await page.screenshot({ path: 'test-results/exports-dialog.png' });

  const pdf = await download(page, () => dialog.getByRole('button', { name: 'Export' }).click());
  expect(pdf.name).toMatch(/^two-storey-ranch-v\d+-plans\.pdf$/);
  const latin = pdf.bytes.toString('latin1');
  expect(latin.startsWith('%PDF-1.7')).toBe(true);
  // A sheet per level, and the schedule sheet a Tabloid page has no room for beside the plans.
  expect((latin.match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
  await expect(dialog).toBeHidden();

  // ── DXF, one level: a single file.
  await page.getByRole('button', { name: 'Export' }).click();
  await dialog.getByRole('radio', { name: /DXF/ }).click();
  await dialog.getByRole('combobox', { name: 'Levels' }).click();
  await page.getByRole('option', { name: 'Upper floor' }).click();
  const dxf = await download(page, () => dialog.getByRole('button', { name: 'Export' }).click());
  expect(dxf.name).toMatch(/^two-storey-ranch-v\d+-upper-floor\.dxf$/);
  const text = dxf.bytes.toString('utf8');
  expect(text).toContain('AC1015');
  expect(text).toContain('A-WALL-EXTR');
  expect(text).toContain('BEDROOM 3');

  // ── From the dashboard: DXF for every level, a ZIP, listed among the recent exports.
  await page.goto(`/projects/${project}`);
  const card = page.locator('[data-region="exports"]');
  const zip = await download(page, () => card.getByRole('button', { name: 'DXF' }).click());
  expect(zip.name).toMatch(/^two-storey-ranch-v\d+-dxf\.zip$/);
  expect(zip.bytes.readUInt32LE(0)).toBe(0x04034b50);
  await expect(card.getByRole('list', { name: 'Recent exports' })).toContainText('dxf.zip · 2 files');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/exports-dashboard.png', fullPage: true });
});
