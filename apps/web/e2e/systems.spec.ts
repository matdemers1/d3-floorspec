import { expect, test, type Locator, type Page } from '@playwright/test';
import { check, OFFICIAL_READER, type Derived } from '@floorspec/engine';
import { firstRunSetup, FT, IN, password, projectIn, settled } from './support.js';

/**
 * The Phase 5 exit demo (FLR-T-5.7, FLR-T-5.8): "Place a panel, kitchen receptacles on two 20 A
 * circuits, a toilet and a water heater; move a wall and watch them follow; open the file in a
 * core-only reader and see their fallbacks; schedules update live." Placed with the pointer and
 * from the keyboard, each step checked in the model the server holds — its placements derived by
 * the same engine, reading as the server reads (implementing the official extensions).
 */

interface Camera {
  at: (x: number, y: number) => { x: number; y: number };
}

/** `-10'-0 1/16"` as base units. */
function feetOf(m: RegExpMatchArray): number {
  const [, sign, feet, inches, num, den] = m;
  const value = Number(feet) * FT + Number(inches) * IN + (num === undefined ? 0 : (Number(num) / Number(den)) * IN);
  return sign === '-' ? -value : value;
}

/** Where the status bar says the pointer is, in base units. */
async function cursorAt(page: Page, x: number, y: number): Promise<[number, number]> {
  await page.mouse.move(x, y);
  let out: [number, number] = [NaN, NaN];
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [a, b] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map(feetOf);
      if (a === undefined || b === undefined) return false;
      out = [a, b];
      return true;
    })
    .toBe(true);
  return out;
}

/** The camera, read off the status bar at two points: a fitted level is not at a fixed place. */
async function cameraOf(page: Page, svg: Locator): Promise<Camera> {
  const box = await svg.boundingBox();
  if (box === null) throw new Error('the plan canvas has no box');
  const p0 = { x: box.x + 120, y: box.y + 140 };
  const p1 = { x: box.x + box.width - 140, y: box.y + box.height - 160 };
  const w0 = await cursorAt(page, p0.x, p0.y);
  const w1 = await cursorAt(page, p1.x, p1.y);
  const sx = (p1.x - p0.x) / (w1[0] - w0[0]);
  const sy = (p1.y - p0.y) / (w1[1] - w0[1]);
  return { at: (x, y) => ({ x: p0.x + (x - w0[0]) * sx, y: p0.y + (y - w0[1]) * sy }) };
}

async function click(page: Page, camera: Camera, x: number, y: number): Promise<void> {
  const p = camera.at(x, y);
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

interface SystemsDoc {
  extensionsUsed?: Record<string, string>;
  extensions?: Record<string, { collections?: Record<string, Record<string, Record<string, unknown>>>; circuits?: Record<string, { panel: string; breaker: number; volts: number; loads?: string[] }> }>;
}

/** The head model as the server holds it, and what the engine derives from it as the server reads it. */
async function headOf(page: Page, project: string): Promise<{ doc: SystemsDoc; derived: Derived }> {
  const res = await page.request.get(`/api/projects/${project}/model.json`);
  expect(res.ok()).toBe(true);
  const text = await res.text();
  const r = check(text, OFFICIAL_READER);
  expect(r.valid, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
  return { doc: JSON.parse(text) as SystemsDoc, derived: r.derived as Derived };
}

const ids = (doc: SystemsDoc, extension: string, collection: string) => Object.keys(doc.extensions?.[extension]?.collections?.[collection] ?? {}).sort();

/** Do something that edits the model, and wait until the server's head has moved. */
async function edits(page: Page, project: string, action: () => Promise<void>): Promise<void> {
  const head = async () => (await page.request.get(`/api/projects/${project}/model.json`)).text();
  const before = await head();
  await action();
  await expect.poll(head).not.toBe(before);
  await settled(page);
}

/** Select an element in the project tree, opening its group first if it is closed. */
async function pick(tree: Locator, group: RegExp, item: RegExp): Promise<void> {
  const row = tree.getByRole('treeitem', { name: group });
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
  await tree.getByRole('treeitem', { name: item }).click();
  await expect(tree.getByRole('treeitem', { name: item })).toHaveAttribute('aria-selected', 'true');
}

/** How many extension elements the head holds. */
async function elementCount(page: Page, project: string): Promise<number> {
  const { doc } = await headOf(page, project);
  return Object.values(doc.extensions ?? {}).reduce((n, x) => n + Object.values(x.collections ?? {}).reduce((m, c) => m + Object.keys(c).length, 0), 0);
}

/** Place a device from the palette, by typing where, and wait for the server to hold it. */
async function placeTyped(page: Page, project: string, text: string): Promise<void> {
  const before = await elementCount(page, project);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search commands and the plan' });
  await input.fill('place a device by typing');
  await page.getByRole('option', { name: /^Place a device by typing/ }).click();
  await input.fill(text);
  await expect(page.getByRole('option').first()).toContainText('Place:');
  await page.keyboard.press('Enter');
  await expect.poll(() => elementCount(page, project)).toBe(before + 1);
  await settled(page);
}

test('the P5 demo: a panel, receptacles on two 20 A circuits, a toilet and a water heater; a wall moved; a core-only reader', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Systems Path', email: 'systems@example.test', password: password('systems') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('Blank');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: 'Projects' }).first().click();
  await page.getByText('Three-room house').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  // A new project is Floorspec 0.3, and the official extensions at 0.1.0 check and derive only
  // Floorspec 0.2 plans (each one's 1.2): this demo is about what they derive — circuits, loads,
  // devices by room — so its house declares 0.2, by an op like any other. When the extensions take
  // Core 0.3, drop this and run the demo on the template as it is.
  const pinned = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' }] } });
  expect(pinned.status(), await pinned.text()).toBe(201);
  await page.goto(`/projects/${project}/editor`);
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await settled(page);
  const svg = page.getByRole('application', { name: /^Plan of / });
  const camera = await cameraOf(page, svg);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const tree = page.getByRole('tree');

  // ── A panel, with the pointer: the electrical tool, the Panel kind, a click on the living room's west wall.
  await rail.getByRole('button', { name: 'Place electrical devices' }).click();
  await inspector.getByRole('button', { name: 'Panel', exact: true }).click();
  await edits(page, project, () => click(page, camera, 6 * IN, 4 * FT));
  let head = await headOf(page, project);
  expect(head.doc.extensionsUsed).toEqual({ FS_electrical: '0.1.0' });
  const [panel] = ids(head.doc, 'FS_electrical', 'panels');
  expect(panel).toBeDefined();
  expect(head.doc.extensions?.['FS_electrical']?.collections?.['panels']?.[panel as string]?.['host']).toMatchObject({ mode: 'wallFace', wall: 'WW', side: 'right' });

  // ── Kitchen receptacles on the kitchen face of WI2: two typed in the palette, two from the keyboard
  //    with the wall selected (the device tool centres on it; a typed length is from the nearer end).
  await page.keyboard.press('Escape');
  await placeTyped(page, project, `gfci receptacle on WI2 at 2' from start, 42" high toward Kitchen`);
  await placeTyped(page, project, `gfci receptacle on WI2 at 6' from start, 42" high toward Kitchen`);
  await page.keyboard.press('Escape');
  for (const at of ["10'", "14'"]) {
    await pick(tree, /^Walls/, /^Wall WI2\b/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('e');
    await inspector.getByRole('button', { name: 'Receptacle', exact: true }).click();
    await inspector.getByRole('switch', { name: /^GFCI/ }).check();
    // An interior wall: the tool aims at its right face; the kitchen is on its left.
    await inspector.getByRole('radio', { name: 'Left (Kitchen)' }).click();
    await page.locator('.fs-editor').focus();
    await page.keyboard.type(at);
    await edits(page, project, () => page.keyboard.press('Enter'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  head = await headOf(page, project);
  const receptacles = ids(head.doc, 'FS_electrical', 'receptacles');
  expect(receptacles).toHaveLength(4);
  expect(head.derived.extensions?.FS_electrical?.rooms['KIT']).toEqual(receptacles);

  // ── A toilet backed onto the bedroom's east wall, with the pointer; a water heater, typed.
  await rail.getByRole('button', { name: 'Place plumbing devices' }).click();
  await inspector.getByRole('button', { name: 'Toilet', exact: true }).click();
  await edits(page, project, () => click(page, camera, 35 * FT, 6 * FT));
  await page.keyboard.press('Escape');
  await placeTyped(page, project, `water heater in Living room at 2', 21'`);
  head = await headOf(page, project);
  const [toilet] = ids(head.doc, 'FS_plumbing', 'fixtures');
  expect(head.doc.extensions?.['FS_plumbing']?.collections?.['fixtures']?.[toilet as string]?.['host']).toMatchObject({ mode: 'surface', room: 'BED', surface: 'floor', rotation: 180_000_000 });
  expect(ids(head.doc, 'FS_plumbing', 'waterHeaters')).toHaveLength(1);
  expect(head.doc.extensionsUsed).toEqual({ FS_electrical: '0.1.0', FS_plumbing: '0.1.0' });

  // ── Two 20 A circuits on the panel, from its inspector; two receptacles on each, from theirs.
  await pick(tree, /^Electrical/, /^P1\b/);
  await edits(page, project, () => inspector.getByRole('button', { name: 'Add circuit' }).click());
  await pick(tree, /^Electrical/, /^P1\b/);
  await edits(page, project, () => inspector.getByRole('button', { name: 'Add circuit' }).click());
  head = await headOf(page, project);
  const circuits = Object.keys(head.doc.extensions?.['FS_electrical']?.circuits ?? {}).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  expect(circuits).toHaveLength(2);
  for (const [i, r] of receptacles.entries()) {
    await pick(tree, /^Electrical/, new RegExp(`^Receptacle ${r}\\b`));
    await inspector.getByRole('combobox', { name: 'Circuit' }).click();
    await edits(page, project, () => page.getByRole('option', { name: new RegExp(`^${circuits[i < 2 ? 0 : 1] ?? ''} `) }).click());
  }
  head = await headOf(page, project);
  const derivedCircuits = head.derived.extensions?.FS_electrical?.circuits ?? {};
  expect(Object.values(derivedCircuits).map((c) => [c.panel, c.loads.length, c.capacity])).toEqual([
    [panel, 2, 2400],
    [panel, 2, 2400],
  ]);
  for (const c of circuits) expect(head.doc.extensions?.['FS_electrical']?.circuits?.[c]).toMatchObject({ breaker: 20, volts: 120 });
  // The home runs are drawn: one per circuit.
  await expect(page.locator('.fs-run')).toHaveCount(2);

  // ── Move the kitchen's south wall a foot north: the receptacles follow; the toilet stays.
  const before = head.derived.placements ?? {};
  await pick(tree, /^Walls/, /^Wall WI2\b/);
  await inspector.getByLabel('Move by').fill("1'");
  await edits(page, project, () => inspector.getByLabel('Move by').press('Enter'));
  head = await headOf(page, project);
  const after = head.derived.placements ?? {};
  for (const r of receptacles) {
    expect(after[r]?.point[0]).toBe(before[r]?.point[0]);
    expect((after[r]?.point[1] ?? 0) - (before[r]?.point[1] ?? 0)).toBe(FT);
  }
  expect(after[toilet as string]).toEqual(before[toilet as string]);
  expect(after[panel as string]).toEqual(before[panel as string]);

  // ── The core-only reader: every element as its fallback box, and nothing of the extensions.
  await page.keyboard.press('Escape');
  const devices = receptacles.length + 3;
  await expect(page.locator('.fs-systems .fs-sym')).toHaveCount(devices);
  await page.getByRole('switch', { name: 'Show as core-only' }).click();
  await expect(page.locator('.fs-core-note')).toBeVisible();
  await expect(page.locator('.fs-fallback')).toHaveCount(devices);
  await expect(page.locator('.fs-systems .fs-sym')).toHaveCount(0);
  await expect(page.locator('.fs-run')).toHaveCount(0);
  // A reader without the extensions derives the same fallbacks and placements: they are Core's.
  const coreOnly = check(await (await page.request.get(`/api/projects/${project}/model.json`)).text());
  expect(coreOnly.derived?.extensions).toBeUndefined();
  expect(coreOnly.derived?.fallbacks).toEqual(head.derived.fallbacks);
  expect(coreOnly.derived?.placements).toEqual(head.derived.placements);
  await page.getByRole('switch', { name: 'Show as core-only' }).click();

  // ── Schedules, live (FLR-T-5.8): open beside the editor, they follow every change made there.
  const schedules = await page.context().newPage();
  await schedules.goto(`/projects/${project}/schedules?tab=receptacles`);
  await expect(schedules.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  const rows = schedules.getByRole('tabpanel').locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('GFCI');
  await expect(rows.first()).toContainText('Kitchen');
  await schedules.getByRole('tab', { name: /^Fixtures/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(schedules.getByRole('tabpanel')).toContainText('Toilet');
  await expect(schedules.getByRole('tabpanel')).toContainText('Water heater');
  await schedules.getByRole('tab', { name: /^Receptacles/ }).click();
  const download = schedules.waitForEvent('download');
  await schedules.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await (await download).path();
  expect((await import('node:fs')).readFileSync(csv, 'utf8')).toMatch(/^Mark,Circuit,Panel,Rating,Type,Room,Wall,Height\r\n/);

  // ── The electrical assistant (FLR-T-5.8): it says what it finds and that it is advice, opens its
  //    proposal as a changeset, and accepting it puts the receptacles in the schedule, live.
  await page.bringToFront();
  await page.keyboard.press('e');
  const card = inspector.getByRole('region', { name: 'Electrical assistant' });
  await expect(card).toContainText('Advisory, not a code check');
  await expect(card).not.toContainText(/complian|NEC/i);
  // The gaps it finds are drawn along their walls, the longest labelled.
  await expect(page.locator('.fs-gap__text')).toContainText(/without a receptacle|between receptacles/);
  expect(await page.locator('.fs-gap').count()).toBeGreaterThan(0);
  await card.getByRole('button', { name: 'Review as changeset' }).click();
  const proposal = page.getByRole('complementary', { name: 'Proposal' });
  await expect(proposal.getByRole('heading', { name: /^Electrical layout/ })).toBeVisible();
  await edits(page, project, () => proposal.getByRole('button', { name: 'Accept changeset' }).click());
  head = await headOf(page, project);
  const added = ids(head.doc, 'FS_electrical', 'receptacles').length;
  expect(added).toBeGreaterThan(4);
  await expect(rows).toHaveCount(added);
  await schedules.close();
});
