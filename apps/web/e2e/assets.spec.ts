/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Package, validate } from '@floorspec/engine';
import { FT, IN, firstRunSetup, historyOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-8.2, the P8 exit demo's texture step: "Drop in a tile photo, set it to 12 inches, apply it
 * to the kitchen backsplash region" — and see it in 3D at that size.
 *
 * A kitchen whose north wall carries a backsplash region (36" to 54", primed) is built through the
 * API. In the editor the wall is chosen, a 512 px photo of one 12-inch tile is dropped on the
 * Materials dialog, uploaded into the content-addressed asset store, calibrated in "Calibrate
 * texture" by typing 12" for its width, and applied to the region: one Ops batch, one undo step.
 * model.json then has the asset (by its SHA-256, at `assets/<sha256>.png`), the material at a
 * 12 × 12 in tile and the region using it, and model.json with the image beside it is a valid
 * package to the engine's package validator. In 3D the region is drawn with the photo, its texture
 * coordinates in tiles from the region's corner — 8 tiles along an 8 ft region, 1.5 up an 18" one.
 * axe runs on the upload and calibration states in both themes; screenshots of each land in
 * test-results/assets-*.png.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// ── A real PNG: one square tile with grout on two edges and a mark in its top-left corner. ──────

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function tilePhoto(px: number): Buffer {
  const raw = Buffer.alloc((px * 3 + 1) * px);
  const grout = Math.round(px / 32);
  for (let y = 0; y < px; y++) {
    raw[y * (px * 3 + 1)] = 0;
    for (let x = 0; x < px; x++) {
      const g = x < grout || y < grout;
      const mark = x > px / 8 && x < px / 3 && y > px / 8 && y < px / 4;
      // A gentle gradient across the glaze, so a tile reads as a tile.
      const shade = Math.round(16 * Math.sin((x + y) / (px / 3)));
      const c = g ? [236, 233, 226] : mark ? [62 + shade, 130 + shade, 124 + shade] : [94 + shade, 166 + shade, 160 + shade];
      raw.set(c, y * (px * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

// ── The kitchen: 12 × 10 ft, drawn counter-clockwise, so the room is on each wall's left. ──────

const KITCHEN = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', name: 'Level 1', elevation: 0, height: 9 * FT } },
  { op: 'addElement', collection: 'types', id: 'INT', element: { kind: 'wallType', name: '2x4 partition', layers: [{ thickness: 16_256, function: 'finish' }, { thickness: 113_792, function: 'core' }, { thickness: 16_256, function: 'finish' }] } },
  { op: 'addElement', collection: 'materials', id: 'PAINT', element: { name: 'Eggshell paint', color: '#e9e6df', roughness: 700 } },
  { op: 'addElement', collection: 'materials', id: 'PRIMER', element: { name: 'Primer', color: '#f4f2ee' } },
  ...([[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]] as const).map((position, i) => ({ op: 'addElement', collection: 'junctions', id: `J${String(i + 1)}`, element: { level: 'L1', position } })),
  ...[1, 2, 3, 4].map((i) => ({
    op: 'addElement',
    collection: 'walls',
    id: `W${String(i)}`,
    element: {
      level: 'L1',
      start: `J${String(i)}`,
      end: `J${String((i % 4) + 1)}`,
      type: 'INT',
      // The north wall, running west: its left face looks into the kitchen. The backsplash runs
      // 8 ft between the counter (36") and the wall cabinets (54").
      ...(i === 3 ? { finishes: { left: { regions: [{ from: 2 * FT, to: 10 * FT, bottom: 36 * IN, top: 54 * IN, material: 'PRIMER' }] } } } : {}),
    },
  })),
  { op: 'addElement', collection: 'rooms', id: 'KIT', element: { level: 'L1', anchor: [6 * FT, 5 * FT], name: 'Kitchen', function: 'kitchen', wallFinish: 'PAINT' } },
];

interface Model {
  assets?: Record<string, { path?: string; sha256: string; mediaType: string; byteLength?: number; name?: string }>;
  materials?: Record<string, { name?: string; color?: string; texture?: { asset?: string; size: [number, number] } }>;
  walls?: Record<string, { finishes?: { left?: { regions?: { from: number; to: number; bottom: number; top: number; material: string }[] } } }>;
}

interface Textured {
  part: string;
  material: string;
  sha256: string;
  loaded: boolean;
  u: [number, number];
  v: [number, number];
}

async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/assets-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the P8 texture demo: drop in a tile photo, set it to 12 inches, apply it to the kitchen backsplash, see it in 3D', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Tiler', email: 'tiler@example.test', password: password('assets') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Tiled kitchen');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: KITCHEN } });
  expect(applied.status(), await applied.text()).toBe(201);

  await page.goto(`/projects/${project}/editor`);
  await settled(page);

  // The north wall, chosen in the project tree: the one with the backsplash.
  const walls = page.getByRole('treeitem', { name: /^Walls/ });
  if ((await walls.getAttribute('aria-expanded')) !== 'true') await walls.click();
  await page.getByRole('treeitem', { name: /^Wall W3\b/ }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('region', { name: /^Left face of / }).getByRole('list', { name: 'Regions of the left face' })).toContainText('Primer');

  // ── Drop the photo on the Materials dialog.
  await page.getByRole('button', { name: 'Materials' }).click();
  const materials = page.getByRole('dialog', { name: /^Materials/ });
  await expect(materials.getByRole('button', { name: 'Upload texture' })).toBeVisible();
  await audit(page, 'materials-upload');
  const photo = tilePhoto(512);
  const sha256 = createHash('sha256').update(photo).digest('hex');
  const drop = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'zellige-seafoam.png', { type: 'image/png' }));
    return dt;
  }, photo.toString('base64'));
  const zone = materials.getByTestId('texture-drop');
  await zone.dispatchEvent('dragover', { dataTransfer: drop });
  await zone.dispatchEvent('drop', { dataTransfer: drop });

  // ── "Calibrate texture": the photo, its whole width as the span until one is dragged, 12".
  const dialog = page.getByRole('dialog', { name: 'Calibrate texture' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('zellige-seafoam.png · 512 × 512');
  await expect(dialog).toContainText(`sha256 ${sha256.slice(0, 4)}…${sha256.slice(-4)}`);
  await expect(dialog.getByRole('img', { name: /^The uploaded image/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save & apply' })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Apply to' })).toContainText('Kitchen · region on');
  await audit(page, 'calibrate-empty');
  const span = dialog.getByLabel('This span is');
  await span.fill('12"');
  await span.press('Enter');
  await expect(dialog.getByTestId('calibrate-stored')).toHaveText('size 390,144 × 390,144 units');
  await expect(dialog.getByTestId('calibrate-repeat')).toContainText('(1 tile)');
  await expect(dialog).toContainText('1 px = 0.023 in');
  await expect(dialog.getByRole('img', { name: /^Measured span: 512 px, 1'/ })).toBeVisible();

  // Dragging across half the photo and calling that 12" would make the whole photo 24"; back to the whole width.
  const box = (await dialog.getByTestId('calibrate-span').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(dialog.getByTestId('calibrate-stored')).toHaveText(/^size 7\d\d,\d\d\d × 7\d\d,\d\d\d units$/);
  await dialog.getByRole('button', { name: 'Measure the whole width' }).click();
  await expect(dialog.getByTestId('calibrate-stored')).toHaveText('size 390,144 × 390,144 units');
  await audit(page, 'calibrate-set');

  const before = (await historyOf(page, project)).length;
  await dialog.getByRole('button', { name: 'Save & apply' }).click();
  await expect(dialog).toBeHidden();

  // ── model.json: the asset by its digest, the material at 12 × 12 in, the region using it — one op.
  await expect.poll(async () => Object.keys(((await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Model).assets ?? {}).length).toBe(1);
  const model = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Model;
  const [assetId, asset] = Object.entries(model.assets!)[0]!;
  expect(asset).toEqual({ path: `assets/${sha256}.png`, sha256, mediaType: 'image/png', byteLength: photo.length, name: 'zellige-seafoam.png' });
  const [materialId, material] = Object.entries(model.materials!).find(([, m]) => m.texture !== undefined)!;
  expect(material.texture).toEqual({ asset: assetId, size: [12 * IN, 12 * IN] });
  expect(material.name).toBe('zellige seafoam');
  expect(material.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(model.walls!['W3']!.finishes!.left!.regions).toEqual([{ from: 2 * FT, to: 10 * FT, bottom: 36 * IN, top: 54 * IN, material: materialId }]);
  const history = await historyOf(page, project);
  expect(history.length - before).toBe(1);

  // model.json with the image beside it at its path is a valid package (Core 18.4).
  const bytes = new Uint8Array(await (await page.request.get(`/api/projects/${project}/model.json`)).body());
  const file = new Uint8Array(await (await page.request.get(`/api/projects/${project}/assets/${sha256}?download`)).body());
  const checked = validate(bytes, { package: new Package({ [asset.path!]: file }) });
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  expect(checked.diagnostics.filter((d) => /^FS-INV-100[5-7]$/.test(d.code))).toEqual([]);

  // The material card shows the photo; the image is listed, to download.
  await page.getByRole('button', { name: 'Materials' }).click();
  await expect(materials.getByRole('list', { name: 'Images' })).toContainText('zellige-seafoam.png');
  await expect(materials.getByRole('link', { name: 'Download zellige-seafoam.png' })).toHaveAttribute('href', `/api/projects/${project}/assets/${sha256}?download`);
  await audit(page, 'materials-textured');
  await page.keyboard.press('Escape');

  // ── 3D: the backsplash drawn with the photo, 8 tiles along and 1.5 up from its corner.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => ((window as unknown as { __floorspec3d?: { textured: Textured[] } }).__floorspec3d?.textured ?? []).some((t) => t.loaded), undefined, { timeout: 30_000 });
  const textured = await page.evaluate(() => (window as unknown as { __floorspec3d: { textured: Textured[] } }).__floorspec3d.textured);
  expect(textured).toHaveLength(1);
  const t = textured[0]!;
  expect(t).toMatchObject({ part: 'wall:W3', material: materialId, sha256, loaded: true });
  expect(t.u[0]).toBeCloseTo(0, 3);
  expect(t.u[1]).toBeCloseTo(8, 3);
  expect(t.v[0]).toBeCloseTo(0, 3);
  expect(t.v[1]).toBeCloseTo(1.5, 3);
  await page.waitForTimeout(500);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/assets-3d-backsplash-${theme}.png` });
  }

  // Standing in the kitchen at eye height, facing the backsplash on the north wall.
  await page.evaluate((at) => {
    (window as unknown as { __floorspec3d: { walk(from: { x: number; y: number; yaw: number; level: string }): void } }).__floorspec3d.walk({ x: at.x, y: at.y, yaw: Math.PI / 2, level: 'L1' });
  }, { x: 6 * FT, y: 3 * FT });
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { walking: boolean } }).__floorspec3d?.walking === true);
  await page.waitForTimeout(500);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/assets-3d-walk-${theme}.png` });
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { walking: boolean } }).__floorspec3d?.walking === false);

  // Undo takes the whole texture away in one step: asset, material and finish.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Object.keys(((await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Model).assets ?? {}).length).toBe(0);
});
