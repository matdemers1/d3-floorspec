/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { embedLibraryMaterial, LIBRARY_FILES, MATERIAL_LIBRARY } from '@floorspec/mesh/materials';
import { FT, firstRunSetup, password, projectIn } from './support.js';

/**
 * FLR-T-13.6: real materials. A kitchen is built through the API; in the editor, Materials → the
 * material library (the board's frame 13c) → Wood → white oak plank is added: its three maps are
 * uploaded into the project's asset store, byte for byte the library's files, and the material is
 * embedded with its `source` naming the library and the item. The kitchen's floor is finished in
 * it, the texture turned 90° in the inspector (frame 13d), and the 3D view draws the floor with the
 * plank's maps at their real size — 1.7 m a tile, so a 12 ft floor is 2.15 tiles across. axe runs
 * on the library in both themes; screenshots land in test-results/materials-*.png.
 */

/** The suite's one account: set up by whichever test runs first, signed in to by the rest. */
const OWNER = { name: 'Finisher', email: 'finisher@example.test', password: password('materials') };

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  const setup = page.getByRole('heading', { name: 'Set up D3 Floorspec' });
  const signin = page.getByRole('button', { name: /Sign in/ }).first();
  await expect(setup.or(signin)).toBeVisible();
  if (await setup.isVisible()) {
    await firstRunSetup(page, OWNER);
    return;
  }
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await signin.click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const KITCHEN = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', name: 'Level 1', elevation: 0, height: 9 * FT } },
  { op: 'addElement', collection: 'types', id: 'INT', element: { kind: 'wallType', name: '2x4 partition', layers: [{ thickness: 16_256, function: 'finish' }, { thickness: 113_792, function: 'core' }, { thickness: 16_256, function: 'finish' }] } },
  ...([[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]] as const).map((position, i) => ({ op: 'addElement', collection: 'junctions', id: `J${String(i + 1)}`, element: { level: 'L1', position } })),
  ...[1, 2, 3, 4].map((i) => ({ op: 'addElement', collection: 'walls', id: `W${String(i)}`, element: { level: 'L1', start: `J${String(i)}`, end: `J${String((i % 4) + 1)}`, type: 'INT' } })),
  { op: 'addElement', collection: 'rooms', id: 'KIT', element: { level: 'L1', anchor: [6 * FT, 5 * FT], name: 'Kitchen', function: 'kitchen' } },
];

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
    await page.screenshot({ path: `test-results/materials-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('adds a library material with its maps, finishes a floor in it, and draws it in 3D at its real size', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Library kitchen');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: KITCHEN } });
  expect(applied.status(), await applied.text()).toBe(201);

  // ── Materials → the library → Wood → white oak plank.
  await page.goto(`/projects/${project}/editor`);
  await page.getByRole('button', { name: 'Materials' }).click();
  const dialog = page.getByRole('dialog', { name: /^Materials/ });
  const library = dialog.getByRole('region', { name: 'Material library' });
  await expect(library).toBeVisible();
  await library.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'Wood' }).click();
  await expect(library.getByTestId('library-material-white-oak-plank')).toBeVisible();
  await audit(page, 'library');
  await library.getByRole('button', { name: 'Tile' }).click();
  await expect(library.getByTestId('library-material-zellige-green')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/materials-library-tile.png' });
  await library.getByRole('button', { name: 'Wood' }).click();
  await library.getByRole('button', { name: 'Add White oak plank, 8 in, matte' }).click();
  await expect(dialog).toBeHidden();

  // model.json: the material, its source, and its three maps — each the library's file, in the store.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as { materials?: Record<string, unknown> }).materials?.['white-oak-plank'] !== undefined)
    .toBe(true);
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as { materials: Record<string, { source?: unknown; texture?: Record<string, unknown> }>; assets: Record<string, { sha256: string; path: string }> };
  const oak = doc.materials['white-oak-plank']!;
  expect(oak.source).toEqual({ library: MATERIAL_LIBRARY.library, version: MATERIAL_LIBRARY.version, item: 'white-oak-plank' });
  expect(oak.texture).toMatchObject({ asset: 'white-oak-plank.albedo', normal: 'white-oak-plank.normal', metallicRoughness: 'white-oak-plank.orm', occlusion: 'white-oak-plank.orm' });
  for (const map of ['albedo', 'normal', 'orm']) {
    const a = doc.assets[`white-oak-plank.${map}`]!;
    expect(a.sha256).toBe(LIBRARY_FILES[`white-oak-plank.${map}.jpg`]!.sha256);
    const served = await page.request.get(`/api/projects/${project}/assets/${a.sha256}`);
    expect(served.status(), `${map} is in the project's store`).toBe(200);
  }

  // ── The kitchen's floor in it, the planks turned to run north–south in the inspector.
  const floor = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: [{ op: 'setProperty', id: 'KIT', path: '/floorFinish', value: 'white-oak-plank' }] } });
  expect(floor.status(), await floor.text()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Materials' }).click();
  await page.getByRole('dialog', { name: /^Materials/ }).getByRole('list', { name: 'Materials', exact: true }).getByRole('button', { name: /^White oak plank/ }).click();
  const turn = page.getByRole('combobox', { name: 'Turn the texture of White oak plank, 8 in, matte' });
  await expect(page.getByText(`From the material library ${MATERIAL_LIBRARY.version} · White oak plank, 8 in, matte`)).toBeVisible();
  await turn.click();
  await page.getByRole('option', { name: '90°' }).click();
  await expect
    .poll(async () => ((await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as { materials: Record<string, { texture?: { rotation?: number } }> }).materials['white-oak-plank']!.texture?.rotation)
    .toBe(90_000_000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/materials-inspector.png' });

  // ── 3D: the floor drawn with the plank's maps, a tile every 1.7 m.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => ((window as unknown as { __floorspec3d?: { textured: Textured[] } }).__floorspec3d?.textured ?? []).some((t) => t.material === 'white-oak-plank' && t.loaded), undefined, { timeout: 30_000 });
  const textured = await page.evaluate(() => (window as unknown as { __floorspec3d: { textured: Textured[] } }).__floorspec3d.textured);
  const onFloor = textured.find((t) => t.part === 'floor:KIT' && t.material === 'white-oak-plank')!;
  expect(onFloor.sha256).toBe(LIBRARY_FILES['white-oak-plank.albedo.jpg']!.sha256);
  // Turned 90°: the floor's north–south run (10 ft between the walls' centre lines, less the walls)
  // is along the tile's u, its east–west run (12 ft, less the walls) along v — a tile every 1.7 m.
  const metres = (r: [number, number]) => (r[1] - r[0]) * 1.7;
  const inside = (ft: number) => [ft * 0.3048 - 0.2, ft * 0.3048] as const;
  expect(metres(onFloor.u)).toBeGreaterThan(inside(10)[0]);
  expect(metres(onFloor.u)).toBeLessThan(inside(10)[1]);
  expect(metres(onFloor.v)).toBeGreaterThan(inside(12)[0]);
  expect(metres(onFloor.v)).toBeLessThan(inside(12)[1]);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/materials-3d.png' });
});

/**
 * FLR-T-13.17: with every lamp on, a house dressed in the library still draws every surface. Each
 * shadowed lamp's shadow map is a texture unit in every lit surface's shader beside the surface's own
 * maps; over the GPU's limit (16 on most) a program fails to link and three.js draws nothing with it —
 * the Courtyard House's textured floors and walls vanished under "All on". Sixteen downlights over a
 * kitchen floored in white oak, its walls in brick with an occlusion map of their own (the most maps
 * a surface takes) and its ceiling painted: every program the view compiles links, and none samples
 * more than WebGL 2's guaranteed 16 units — on any GPU, SwiftShader's 32 included.
 */
test('All on over textured materials: every program links within 16 texture units, and every wall and floor is drawn', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Lit library kitchen');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  expect((await page.request.post(`/api/projects/${project}/ops`, { data: { batch: KITCHEN } })).status()).toBe(201);
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as unknown;
  const pending = new Map<string, string>();
  const oak = embedLibraryMaterial(doc, 'white-oak-plank', {}, pending);
  const brick = embedLibraryMaterial(doc, 'brick-red-running', {}, pending);
  const paint = embedLibraryMaterial(doc, 'paint-eggshell', {}, pending);
  const downlight = { min: [-128_000, -128_000, -192_000], max: [128_000, 128_000, 0] };
  const lights = Array.from({ length: 16 }, (_, i) => ({
    op: 'placeElement', id: `LT${String(i + 1)}`, extension: 'FS_electrical', collection: 'lights',
    host: { mode: 'surface', room: 'Kitchen', surface: 'ceiling', at: [Math.round(((i % 4) + 0.5) * 3 * FT * 0.9), Math.round((Math.floor(i / 4) + 0.5) * 2.5 * FT * 0.9)] },
    element: { fixture: 'recessed', fallback: { box: downlight } },
  }));
  const batch = [
    ...oak.ops, ...brick.ops, ...paint.ops,
    // The most maps a surface takes: an occlusion map apart from its metallic-roughness map.
    { op: 'setProperty', id: brick.id, path: '/texture/occlusion', value: 'brick-red-running.normal' },
    { op: 'setProperty', id: 'KIT', path: '/floorFinish', value: oak.id },
    { op: 'setProperty', id: 'KIT', path: '/wallFinish', value: brick.id },
    { op: 'setProperty', id: 'KIT', path: '/ceilingFinish', value: paint.id },
    { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
    ...lights,
  ];
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch } });
  expect(applied.status(), await applied.text()).toBe(201);

  type Programs = { units: number; list: { name: string; linked: boolean; samplers: number }[] };
  type View = { __floorspec3d?: { ready: boolean; textured: Textured[]; lights: { lamps: { shadow: boolean }[] }; programs: Programs; shown: Record<string, number> } };
  await page.goto(`/projects/${project}/editor`);
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => (window as unknown as View).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Lights' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps.length)).toBe(16);
  // Every map arrived, so every material has compiled with all its maps.
  await page.waitForFunction(() => {
    const t = (window as unknown as View).__floorspec3d!.textured;
    return ['white-oak-plank', 'brick-red-running'].every((m) => t.some((x) => x.material === m && x.loaded));
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const programs = await page.evaluate(() => (window as unknown as View).__floorspec3d!.programs);
  expect(programs.list.length).toBeGreaterThan(0);
  expect.soft(programs.list.filter((p) => !p.linked).map((p) => p.name), 'programs that failed to link').toEqual([]);
  expect.soft(Math.max(...programs.list.map((p) => p.samplers)), 'the most texture units a program samples').toBeLessThanOrEqual(16);
  const lamps = await page.evaluate(() => (window as unknown as View).__floorspec3d!.lights.lamps);
  expect(lamps.filter((l) => l.shadow).length, 'shadowed lamps').toBeLessThanOrEqual(11);
  const shown = await page.evaluate(() => (window as unknown as View).__floorspec3d!.shown);
  expect(shown['L1:wall'] ?? 0).toBe(4);
  expect(shown['L1:floor'] ?? 0).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/materials-all-on.png' });
});
