/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { OFFICIAL_READER, Package, validate } from '@floorspec/engine';
import { FT, firstRunSetup, historyOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-8.3, the P8 exit demo's furniture step: "place a fridge whose door clearance shows".
 *
 * A 12 × 10 ft kitchen is built through the API. In the editor the furniture library opens from
 * the rail (the board's frame 14), a search finds the starter library's refrigerator, and "Place in
 * Kitchen" copies its glTF model and SVG symbol into the project's asset store and places it in one
 * Ops batch: FS_furniture declared, two assets, one element backed onto the kitchen's longest wall
 * with its default door envelope — drawn on the plan with its symbol, the door's clearance showing.
 * model.json and the two files beside it are a valid package with FS_furniture known. An island
 * placed next lands in front of the door: FS-FURN-LINT-004 is a note in the refrigerator's
 * inspector and the blocked clearance turns to the warning tone. In 3D the refrigerator is its
 * model. Undo takes the island away in one step and the note goes with it. axe runs on the library
 * and the inspector in both themes; screenshots of each land in test-results/furniture-*.png.
 * Through a share link, with no account, the symbol and the model load from the link's own asset
 * route (FLR-T-9.6).
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const KITCHEN = [
  { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' },
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', name: 'Level 1', elevation: 0, height: 9 * FT } },
  { op: 'addElement', collection: 'types', id: 'INT', element: { kind: 'wallType', name: '2x4 partition', layers: [{ thickness: 16_256, function: 'finish' }, { thickness: 113_792, function: 'core' }, { thickness: 16_256, function: 'finish' }] } },
  ...([[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]] as const).map((position, i) => ({ op: 'addElement', collection: 'junctions', id: `J${String(i + 1)}`, element: { level: 'L1', position } })),
  ...[1, 2, 3, 4].map((i) => ({ op: 'addElement', collection: 'walls', id: `W${String(i)}`, element: { level: 'L1', start: `J${String(i)}`, end: `J${String((i % 4) + 1)}`, type: 'INT' } })),
  { op: 'addElement', collection: 'rooms', id: 'KIT', element: { level: 'L1', anchor: [6 * FT, 5 * FT], name: 'Kitchen', function: 'kitchen' } },
];

interface Model {
  floorspec: string;
  extensionsUsed?: Record<string, string>;
  assets?: Record<string, { path: string; sha256: string; mediaType: string; byteLength: number }>;
  extensions?: { FS_furniture?: { collections: Record<string, Record<string, { category: string; catalogue?: string; clearances?: Record<string, { purpose: string }>; fallback: { asset: string; symbol: string }; host: { mode: string } }>> } };
}

const modelOf = async (page: Page, project: string): Promise<Model> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Model;
const furniture = (m: Model) => Object.entries(m.extensions?.FS_furniture?.collections ?? {}).flatMap(([kind, els]) => Object.entries(els).map(([id, el]) => ({ id, kind, ...el })));

async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/furniture-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the P8 furniture demo: place a fridge from the library, its door clearance shows, an island in its way is a note, 3D shows the model, undo', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Fitter', email: 'fitter@example.test', password: password('furniture') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Furnished kitchen');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: KITCHEN } });
  expect(applied.status(), await applied.text()).toBe(201);

  await page.goto(`/projects/${project}/editor`);
  await settled(page);

  // ── The library, from the rail: cards by kind, a search, the chosen item in detail.
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Furniture and appliances' }).click();
  const library = page.getByRole('dialog', { name: 'Furniture & appliances' });
  await expect(library).toBeVisible();
  await expect(library.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(25);
  await audit(page, 'library');
  await library.getByRole('radio', { name: /^Appliances/ }).click();
  await expect(library.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(9);
  await library.getByRole('searchbox', { name: 'Search the library' }).fill('refrigerator');
  await expect(library.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(1);
  await library.getByRole('button', { name: /Refrigerator, 900 mm/ }).click();
  const detail = library.getByRole('region', { name: 'Refrigerator, 900 mm, in detail' });
  await expect(detail).toContainText('35 × 28 × 70 in');
  await expect(detail).toContainText('envelope “door”, swing');
  await expect(detail.getByRole('img', { name: /plan symbol and clearance envelopes/ })).toBeVisible();

  const before = (await historyOf(page, project)).length;
  await detail.getByRole('button', { name: 'Place in Kitchen' }).click();
  await expect(library).toBeHidden();

  // ── One batch: Core 0.3, FS_furniture declared, the model and symbol as assets, the element.
  await expect.poll(async () => furniture(await modelOf(page, project)).length).toBe(1);
  const model = await modelOf(page, project);
  expect(model.extensionsUsed).toEqual({ FS_furniture: '0.1.0' });
  const [fridge] = furniture(model);
  expect(fridge).toMatchObject({ kind: 'appliances', category: 'refrigerator', catalogue: 'refrigerator-900', clearances: { door: { purpose: 'swing' } }, host: { mode: 'surface' } });
  expect(model.assets![fridge!.fallback.asset]).toMatchObject({ mediaType: 'model/gltf-binary' });
  expect(model.assets![fridge!.fallback.symbol]).toMatchObject({ mediaType: 'image/svg+xml' });
  expect((await historyOf(page, project)).length - before).toBe(1);

  // model.json and both files at their paths: a valid package, with FS_furniture known and implemented.
  const files: Record<string, Uint8Array> = {};
  for (const a of Object.values(model.assets!)) files[a.path] = new Uint8Array(await (await page.request.get(`/api/projects/${project}/assets/${a.sha256}?download`)).body());
  const bytes = new Uint8Array(await (await page.request.get(`/api/projects/${project}/model.json`)).body());
  const checked = validate(bytes, { package: new Package(files), ...OFFICIAL_READER });
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  expect(checked.diagnostics).toEqual([]);

  // ── On the plan: the symbol over its footprint, and the door's clearance showing.
  const item = page.locator(`[data-furniture="${fridge!.id}"]`);
  await expect(item.locator('image')).toHaveAttribute('href', `/api/projects/${project}/assets/${model.assets![fridge!.fallback.symbol]!.sha256}`);
  await expect(page.getByRole('button', { name: 'Clearances', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.fs-clearances polygon')).toHaveCount(1);
  await expect(page.locator('.fs-clearance--blocked')).toHaveCount(0);

  // ── The inspector: what it is, where it is, its clearance; no notes.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: /^Refrigerator, 900 mm/ })).toBeVisible();
  await expect(inspector.getByRole('combobox', { name: 'Category' })).toContainText('Refrigerator');
  await expect(inspector.getByRole('region', { name: 'Clearances' })).toContainText('door · swing · 35 in');
  await expect(inspector.getByRole('region', { name: 'Notes' })).toHaveCount(0);
  await audit(page, 'inspector');

  // The arrow keys move it, and Undo puts it back.
  const hostBefore = JSON.stringify((furniture(await modelOf(page, project))[0] as unknown as { host: unknown }).host);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => JSON.stringify((furniture(await modelOf(page, project))[0] as unknown as { host: unknown }).host)).not.toBe(hostBefore);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => JSON.stringify((furniture(await modelOf(page, project))[0] as unknown as { host: unknown }).host)).toBe(hostBefore);

  // ── An island in front of the door: a note, never an error.
  await page.keyboard.press('f');
  await expect(library).toBeVisible();
  // The library keeps its kind and search between visits: back to every kind.
  await library.getByRole('radio', { name: /^All/ }).click();
  await library.getByRole('searchbox', { name: 'Search the library' }).fill('island');
  await library.getByRole('button', { name: /Kitchen island/ }).click();
  await library.getByRole('region', { name: /Kitchen island.*in detail/ }).getByRole('button', { name: 'Place in Kitchen' }).click();
  await expect(library).toBeHidden();
  await expect.poll(async () => furniture(await modelOf(page, project)).length).toBe(2);
  const island = furniture(await modelOf(page, project)).find((f) => f.category === 'island')!;
  await expect(page.locator('.fs-statusbar')).toContainText('Model valid');
  await expect(page.locator('.fs-clearance--blocked')).toHaveCount(1);
  await expect(page.locator(`[data-furniture="${fridge!.id}"]`)).toHaveClass(/fs-furn-item--blocked/);
  // Select the refrigerator again: its note says what is in the door's way.
  const fridgeBox = (await item.boundingBox())!;
  await page.mouse.click(fridgeBox.x + fridgeBox.width / 2, fridgeBox.y + fridgeBox.height / 2);
  await expect(inspector.getByRole('heading', { name: /^Refrigerator, 900 mm/ })).toBeVisible();
  const notes = inspector.getByRole('region', { name: 'Notes' });
  await expect(notes).toContainText('FS-FURN-LINT-004');
  await expect(notes).toContainText('Its clearance runs into');
  await audit(page, 'inspector-blocked');

  // ── 3D: the refrigerator is its glTF model, not its fallback box.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForFunction((id) => ((window as unknown as { __floorspecFurniture3d?: { drawn: string[] } }).__floorspecFurniture3d?.drawn ?? []).includes(id), fridge!.id, { timeout: 30_000 });
  const drawn = await page.evaluate(() => (window as unknown as { __floorspecFurniture3d: { drawn: string[]; failed: string[] } }).__floorspecFurniture3d);
  expect(drawn.failed).toEqual([]);
  expect(drawn.drawn).toEqual([fridge!.id, island.id].sort());
  // Clicking the model selects the refrigerator, as clicking its symbol does on the plan.
  const at = await page.evaluate((id) => (window as unknown as { __floorspec3d: { screenPoint(id: string): { x: number; y: number } | null } }).__floorspec3d.screenPoint(id), fridge!.id);
  if (at !== null) {
    await page.mouse.click(at.x, at.y);
    await expect(inspector.getByRole('heading', { name: /^Refrigerator, 900 mm/ })).toBeVisible();
  }
  await page.waitForTimeout(500);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/furniture-3d-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '2D plan' }).click();

  // ── Undo takes the island — its element and its two assets — back in one step, and the note with it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => furniture(await modelOf(page, project)).length).toBe(1);
  await expect(page.locator('.fs-clearance--blocked')).toHaveCount(0);
  expect(Object.keys((await modelOf(page, project)).assets ?? {})).toHaveLength(2);

  // ── FLR-T-9.6's follow-up: somebody with no account opens a share link and sees the refrigerator
  // as its symbol on the plan and its model in 3D — both from the link's own asset route, never
  // the owner's, so nothing falls back to an outline or a box.
  const shared = await page.request.post(`/api/projects/${project}/shares`, { data: {} });
  expect(shared.status(), await shared.text()).toBe(201);
  const { url } = (await shared.json()) as { url: string };
  const via = `/api/share/${url.split('/s/')[1]!}/assets/`;
  const fileOf = (key: string) => model.assets![key]!.sha256;
  const stranger = await browser.newContext({ baseURL: baseURL! });
  const viewer = await stranger.newPage();
  const answered = new Map<string, number>();
  viewer.on('response', (r) => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/') && path.includes('/assets/')) answered.set(path, r.status()); });
  await viewer.goto(url);
  await expect(viewer.locator(`[data-furniture="${fridge!.id}"] image`)).toHaveAttribute('href', `${via}${fileOf(fridge!.fallback.symbol)}`);
  await expect.poll(() => answered.get(`${via}${fileOf(fridge!.fallback.symbol)}`)).toBe(200);
  await viewer.getByRole('radio', { name: '3D' }).click();
  await viewer.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await viewer.waitForFunction((id) => ((window as unknown as { __floorspecFurniture3d?: { drawn: string[] } }).__floorspecFurniture3d?.drawn ?? []).includes(id), fridge!.id, { timeout: 30_000 });
  expect((await viewer.evaluate(() => (window as unknown as { __floorspecFurniture3d: { failed: string[] } }).__floorspecFurniture3d)).failed).toEqual([]);
  expect(answered.get(`${via}${fileOf(fridge!.fallback.asset)}`)).toBe(200);
  // Every file the viewer asked for came through the link; the owner's route was never tried.
  expect([...answered.keys()].filter((p) => !p.startsWith(via))).toEqual([]);
  await viewer.waitForTimeout(400); // the frame the model arrived in, so the picture is of the model
  await viewer.screenshot({ path: 'test-results/furniture-shared-3d.png' });
  await stranger.close();

  // ── Upload your own: a model made facing +Z, turned to face +X; a symbol with a script in it.
  await page.keyboard.press('f');
  await library.getByRole('button', { name: 'Upload glTF' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload a model' });
  await expect(upload).toBeVisible();
  await upload.getByLabel('Model file').setInputFiles(new URL('../../../packages/engine/standard/registry/FS_furniture/library/models/sofa-2100.glb', import.meta.url).pathname);
  // Read from the model's accessors: 2100 wide, 900 deep, 850 tall …
  await expect(upload.getByTestId('upload-size')).toHaveText('83 × 35 × 33 in');
  // … and, turned from +Z to +X (Core 12.6's note), its depth and width trade places.
  await upload.getByRole('switch', { name: /faces \+Z/ }).click();
  await expect(upload.getByTestId('upload-size')).toHaveText('35 × 83 × 33 in');
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 2100" onload="alert(1)"><script>alert(2)</script><rect x="5" y="5" width="890" height="2090" fill="#fff" stroke="#000" stroke-width="10"/></svg>';
  await upload.getByLabel('Plan symbol file').setInputFiles({ name: 'sofa-plan.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(evil) });
  await expect(upload).toContainText('sofa-plan.svg');
  const name = upload.getByLabel('Name');
  await name.fill('Turned sofa');
  await name.press('Enter');
  await upload.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'Sofa' }).click();
  await expect(upload).toContainText('front (access)');
  await audit(page, 'upload');
  await upload.getByRole('button', { name: 'Upload and place in Kitchen' }).click();
  await expect(upload).toBeHidden();
  await expect.poll(async () => furniture(await modelOf(page, project)).length).toBe(2);
  const after = await modelOf(page, project);
  const sofa = furniture(after).find((f) => f.category === 'sofa')! as unknown as { kind: string; name: string; clearances: Record<string, { purpose: string }>; fallback: { asset: string; symbol: string; box: { min: number[]; max: number[] } } };
  expect(sofa).toMatchObject({ kind: 'pieces', name: 'Turned sofa', clearances: { front: { purpose: 'access' } } });
  expect(sofa.fallback.box).toEqual({ min: [-1_344_000, 0, 0], max: [1_344_000, 1_152_000, 1_088_000] });
  expect(after.assets![sofa.fallback.asset]).toMatchObject({ mediaType: 'model/gltf-binary' });
  const symbolAsset = after.assets![sofa.fallback.symbol]!;
  expect(symbolAsset.mediaType).toBe('image/svg+xml');
  const stored = await (await page.request.get(`/api/projects/${project}/assets/${symbolAsset.sha256}`)).text();
  expect(stored).not.toMatch(/script|onload|alert/);
  expect(stored).toContain('<rect x="5" y="5" width="890" height="2090"');
  // Placed, it validates as a package with the turned model and the cleaned symbol beside it.
  const files2: Record<string, Uint8Array> = {};
  for (const a of Object.values(after.assets!)) files2[a.path] = new Uint8Array(await (await page.request.get(`/api/projects/${project}/assets/${a.sha256}?download`)).body());
  const checked2 = validate(new Uint8Array(await (await page.request.get(`/api/projects/${project}/model.json`)).body()), { package: new Package(files2), ...OFFICIAL_READER });
  expect(checked2.valid, JSON.stringify(checked2.diagnostics)).toBe(true);
});

