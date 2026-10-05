/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Package, validate } from '@floorspec/engine';
import { DEFAULT_LIMITS, readPackage, readZip } from '@floorspec/package';
import { FT, IN, firstRunSetup, password, projectIn } from './support.js';

/**
 * FLR-T-9.1: the `.floorspec` package, end to end. A kitchen whose backsplash region is finished
 * with an uploaded tile photo is exported from the editor's Export dialog as a `.floorspec`
 * package — model.json and the photo, one ZIP — then imported from the projects list as a new
 * project: the import dialog reads the package in the browser (axe on it, both themes), the server
 * stores the photo and builds the project by Ops, and the new project's 3D view draws the
 * backsplash with the photo. Screenshots land in test-results/package-*.png.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 128 px tile: teal glaze with grout on two edges. */
function tilePhoto(px: number): Buffer {
  const raw = Buffer.alloc((px * 3 + 1) * px);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) raw.set(x < 4 || y < 4 ? [236, 233, 226] : [94, 166, 160], y * (px * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

const KITCHEN = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', name: 'Level 1', elevation: 0, height: 9 * FT } },
  { op: 'addElement', collection: 'types', id: 'INT', element: { kind: 'wallType', name: '2x4 partition', layers: [{ thickness: 16_256, function: 'finish' }, { thickness: 113_792, function: 'core' }, { thickness: 16_256, function: 'finish' }] } },
  { op: 'addElement', collection: 'materials', id: 'PAINT', element: { name: 'Eggshell paint', color: '#e9e6df', roughness: 700 } },
  ...([[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]] as const).map((position, i) => ({ op: 'addElement', collection: 'junctions', id: `J${String(i + 1)}`, element: { level: 'L1', position } })),
  ...[1, 2, 3, 4].map((i) => ({ op: 'addElement', collection: 'walls', id: `W${String(i)}`, element: { level: 'L1', start: `J${String(i)}`, end: `J${String((i % 4) + 1)}`, type: 'INT' } })),
  { op: 'addElement', collection: 'rooms', id: 'KIT', element: { level: 'L1', anchor: [6 * FT, 5 * FT], name: 'Kitchen', function: 'kitchen', wallFinish: 'PAINT' } },
];

interface Textured {
  part: string;
  sha256: string;
  loaded: boolean;
}

async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/package-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('exports a textured kitchen as a .floorspec package and imports it as a new project, the texture drawn in 3D', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Packer', email: 'packer@example.test', password: password('package') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Tiled kitchen');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());

  // ── The kitchen, the photo uploaded into the asset store, and the backsplash region finished with it.
  const photo = tilePhoto(128);
  const sha256 = createHash('sha256').update(photo).digest('hex');
  const uploaded = await page.request.post(`/api/projects/${project}/assets`, { data: photo, headers: { 'content-type': 'application/octet-stream', 'x-asset-name': 'zellige.png' } });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const { asset } = (await uploaded.json()) as { asset: { path: string; byteLength: number } };
  const batch = [
    ...KITCHEN,
    { op: 'addElement', collection: 'assets', id: 'ZELLIGE', element: { path: asset.path, sha256, mediaType: 'image/png', byteLength: asset.byteLength, name: 'zellige.png' } },
    { op: 'addElement', collection: 'materials', id: 'TILE', element: { name: 'Zellige', color: '#5ea6a0', texture: { asset: 'ZELLIGE', size: [12 * IN, 12 * IN] } } },
    { op: 'setProperty', id: 'W3', path: '/finishes', value: { left: { regions: [{ from: 2 * FT, to: 10 * FT, bottom: 36 * IN, top: 54 * IN, material: 'TILE' }] } } },
  ];
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch } });
  expect(applied.status(), await applied.text()).toBe(201);

  // ── Export → Floorspec model → .floorspec package (the default form).
  await page.goto(`/projects/${project}/editor`);
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Tiled kitchen' });
  await dialog.getByRole('radio', { name: /Floorspec model/ }).click();
  await expect(dialog.getByRole('combobox', { name: 'Form' })).toContainText('.floorspec package');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/package-export-dialog.png' });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), dialog.getByRole('button', { name: 'Export' }).click()]);
  // The project's own name (filename*, UTF-8); `tiled-kitchen.floorspec` for a client that reads only filename.
  expect(download.suggestedFilename()).toBe('Tiled kitchen.floorspec');
  const exported = readFileSync(await download.path());
  const zip = new Uint8Array(exported);
  expect(readZip(zip, DEFAULT_LIMITS).entries.map((e) => e.name)).toEqual(['model.json', asset.path]);
  const opened = readPackage(zip);
  const model = new Uint8Array(await (await page.request.get(`/api/projects/${project}/model.json`)).body());
  expect(Buffer.from(opened.document).equals(Buffer.from(model))).toBe(true);
  expect(Buffer.from(opened.files.get(asset.path)!).equals(photo)).toBe(true);
  expect(validate(opened.document, { package: new Package(opened.files) }).valid).toBe(true);

  // ── Projects → Import: the package read in the browser, then created by the server.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Import Floorspec file' }).click();
  const importing = page.getByRole('dialog', { name: 'Import a Floorspec file' });
  await expect(importing).toBeVisible();
  await audit(page, 'import-empty');
  await importing.locator('input[type=file]').setInputFiles({ name: 'tiled-kitchen.floorspec', mimeType: 'application/zip', buffer: exported });
  await expect(importing.getByText('Tiled kitchen is a valid Floorspec package')).toBeVisible();
  await expect(importing).toContainText('1 asset file');
  await audit(page, 'import-checked');
  await importing.getByRole('button', { name: 'Create project' }).click();
  await expect(importing).toBeHidden();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const copy = projectIn(page.url());
  expect(copy).not.toBe(project);

  // The same model, byte for byte; the photo is the new project's own.
  const copied = new Uint8Array(await (await page.request.get(`/api/projects/${copy}/model.json`)).body());
  expect(Buffer.from(copied).equals(Buffer.from(model))).toBe(true);
  const file = await page.request.get(`/api/projects/${copy}/assets/${sha256}`);
  expect(file.status()).toBe(200);
  const uploads = (await (await page.request.get(`/api/projects/${copy}/assets`)).json()) as { uploads: { sha256: string }[] };
  expect(uploads.uploads.map((u) => u.sha256)).toEqual([sha256]);

  // ── 3D: the imported backsplash drawn with the photo.
  await page.goto(`/projects/${copy}/editor`);
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => ((window as unknown as { __floorspec3d?: { textured: Textured[] } }).__floorspec3d?.textured ?? []).some((t) => t.loaded), undefined, { timeout: 30_000 });
  const textured = await page.evaluate(() => (window as unknown as { __floorspec3d: { textured: Textured[] } }).__floorspec3d.textured);
  expect(textured).toHaveLength(1);
  expect(textured[0]).toMatchObject({ part: 'wall:W3', sha256, loaded: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/package-imported-3d.png' });
});
