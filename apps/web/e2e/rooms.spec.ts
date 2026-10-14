/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-18.10: rooms you can grab, on the Courtyard House (the worker's fixture, a copy of the owner's
 * house) imported as a project, with two separators drawn across the west end of its garage to leave
 * two strips of floor with no room.
 *
 * The pantry, picked in the tree, shows an edge handle on each of its four sides. Its east handle
 * dragged 18″ out shows the room it would be, dashed, with a dimension tag ("7′-6⅜″ → 9′-0⅜″"), and on
 * release is one resizeRoom (Ops 4.4) — the pantry's south-east corner moved east, a jog where its
 * east wall continues north as the kitchen's — undone in one step. From the keyboard, ⌥← pushes the
 * west side out by the nudge step and ⌥⇧← pulls it back, each a resizeRoom; ↑ moves the room (moveRoom);
 * and the room dragged by its floor is one moveRoom (Ops 4.3).
 *
 * The magic wand (Construction's rail) clicked in the middle strip chooses it, with its neighbour
 * offered: Tab chooses the neighbour, ⇧Tab comes back; a name typed on the plan starts the prompt's
 * name, which guesses the function; Enter makes the room — one addRoom, one undo step. Axe passes on
 * the prompt and on the selected room's inspector in both themes. Screenshots land in
 * test-results/rooms-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The pantry's south-east corner, on its walls' location lines. */
const PANTRY_SE: [number, number] = [24_188_928, 24_969_216];

interface Op { op: string; room?: string; side?: string; by?: number | number[]; name?: string; function?: string; at?: number[] }
interface Entry { seq: number; kind: string; ops: Op[] }
type Doc = { junctions: Record<string, { level: string; position: [number, number] }>; rooms: Record<string, { name?: string; function?: string; anchor: [number, number] }> };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const historyOf = async (page: Page, project: string): Promise<Entry[]> => ((await (await page.request.get(`/api/projects/${project}/history`)).json()) as { ops: Entry[] }).ops;
const lastOps = async (page: Page, project: string): Promise<Op[]> => (await historyOf(page, project))[0]?.ops ?? [];
/** A junction on the ground floor at a point (the upper floor has its own at the same points). */
const hasJunctionAt = (d: Doc, p: readonly [number, number]) => Object.values(d.junctions).some((j) => j.level === 'L1' && j.position[0] === p[0] && j.position[1] === p[1]);

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/rooms-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A `64'-11 3/8"` match as base units. */
function feetOf(m: RegExpMatchArray): number {
  const [, sign, feet, inches, num, den] = m;
  const value = Number(feet) * FT + Number(inches) * IN + (num === undefined ? 0 : (Number(num) / Number(den)) * IN);
  return sign === '-' ? -value : value;
}

/** Where the pointer is on the plan, as the status bar reads it out. */
async function readout(page: Page, x: number, y: number): Promise<[number, number]> {
  await page.mouse.move(x, y);
  let at: [number, number] | null = null;
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [wx, wy] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map(feetOf);
      at = wx === undefined || wy === undefined ? null : [wx, wy];
      return at !== null;
    })
    .toBe(true);
  return at as unknown as [number, number];
}

/** The plan's camera, from two readouts: where a world point (base units) is on the page. */
async function cameraOf(page: Page): Promise<(x: number, y: number) => { x: number; y: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return (x, y) => ({ x: a.x + (x - wa[0]) * s, y: a.y - (y - wa[1]) * s });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 10, from.y + ((to.y - from.y) * k) / 10);
  if (during !== undefined) await during();
  await page.mouse.up();
}

test('rooms you can grab: the pantry resized by its east edge and from the keys, moved by its floor, and a room made with the magic wand', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Roomer', email: 'roomer@example.test', password: password('rooms') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  // Two strips of floor with no room, across the west end of the garage.
  const strips = await page.request.post(`/api/projects/${project}/ops`, {
    data: {
      batch: [
        { op: 'drawSeparator', level: 'L1', from: [2_000_000, 17_166_336], to: [2_000_000, 24_969_216] },
        { op: 'drawSeparator', level: 'L1', from: [3_500_000, 17_166_336], to: [3_500_000, 24_969_216] },
      ],
    },
  });
  expect(strips.status(), await strips.text()).toBe(201);

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── The pantry, picked in the tree: four edge handles.
  await page.getByRole('treeitem', { name: /^Pantry/ }).first().click();
  await expect(inspector.getByRole('heading', { name: /Pantry/ })).toBeVisible();
  const handles = page.getByTestId('room-handles').locator('rect');
  await expect(handles).toHaveCount(4);
  // Framed, so a handle and a drag are a good many pixels per inch.
  await page.getByRole('button', { name: 'Zoom to selection' }).click();
  await page.waitForTimeout(800); // the animated move of the view settles
  const at = await cameraOf(page);
  await shoot(page, 'pantry-selected');
  await axe(page, '[aria-label="Inspector"]');

  // ── The east handle dragged 18″ out: the room it would be, a dimension tag, then one resizeRoom.
  const east = (await page.getByTestId('room-handle-east').boundingBox())!;
  const from = { x: east.x + east.width / 2, y: east.y + east.height / 2 };
  const px = at(18 * IN, 0).x - at(0, 0).x;
  const before = (await historyOf(page, project)).length;
  await drag(page, from, { x: from.x + px, y: from.y }, async () => {
    await expect(page.getByTestId('room-drag')).toBeVisible();
    await expect(page.getByTestId('room-dimension-tag')).toContainText('→');
    await shoot(page, 'east-edge-dragged');
  });
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(before + 1);
  const resized = (await lastOps(page, project))[0]!;
  expect(resized).toMatchObject({ op: 'resizeRoom', room: 'R9', side: 'east' });
  const by = resized.by as number;
  expect(by % (IN / 2)).toBe(0);
  expect(Math.abs(by - 18 * IN)).toBeLessThanOrEqual(2 * IN);
  // The south-east corner went with the side; the walls followed (a jog where the east wall runs on north).
  const wider = await docOf(page, project);
  expect(hasJunctionAt(wider, [PANTRY_SE[0] + by, PANTRY_SE[1]])).toBe(true);
  expect(hasJunctionAt(wider, PANTRY_SE)).toBe(false);
  await settled(page);
  await shoot(page, 'east-edge-resized');

  // ── Undo: one step back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => hasJunctionAt(await docOf(page, project), PANTRY_SE)).toBe(true);
  await settled(page);

  // ── From the keyboard: ⌥← pushes the west side out, ⌥⇧← pulls it in, each one resizeRoom of the
  //    nudge step (the west side ends at corners, so it moves without a jog); ↑ moves it (moveRoom).
  await expect(inspector.getByRole('heading', { name: /Pantry/ })).toBeVisible();
  await page.locator('.fs-editor').focus();
  let n = (await historyOf(page, project)).length;
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(n + 1);
  expect((await lastOps(page, project))[0]).toMatchObject({ op: 'resizeRoom', room: 'R9', side: 'west', by: IN });
  await settled(page);
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(n + 2);
  expect((await lastOps(page, project))[0]).toMatchObject({ op: 'resizeRoom', room: 'R9', side: 'west', by: -IN });
  await settled(page);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(n + 3);
  expect((await lastOps(page, project))[0]).toMatchObject({ op: 'moveRoom', room: 'R9', by: [0, IN] });
  await settled(page);

  // ── Dragged by its floor (clear of its ceiling light): one moveRoom, about a foot north.
  n = (await historyOf(page, project)).length;
  const floor = at(22_000_000, 23_000_000 + IN);
  await drag(page, floor, { x: floor.x, y: floor.y - (at(12 * IN, 0).x - at(0, 0).x) }, async () => {
    await expect(page.getByTestId('room-drag')).toHaveAttribute('data-kind', 'room');
    await expect(page.getByTestId('room-dimension-tag')).toContainText('Move');
  });
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(n + 1);
  const moved = (await lastOps(page, project))[0]!;
  expect(moved.op).toBe('moveRoom');
  expect((moved.by as number[])[0]).toBe(0);
  expect(Math.abs((moved.by as number[])[1]! - 12 * IN)).toBeLessThanOrEqual(2 * IN);
  await settled(page);
  await page.keyboard.press('Escape');

  // ── The magic wand: a click in the middle strip, its neighbour offered. The whole floor framed first.
  await page.getByRole('button', { name: 'Zoom to fit' }).click();
  await page.waitForTimeout(800);
  const whole = await cameraOf(page);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Make a room (magic wand)' }).click();
  await expect(inspector.getByRole('heading', { name: 'Make a room' })).toBeVisible();
  const strip = whole(2_750_000, 21_000_000);
  await page.mouse.move(strip.x - 4, strip.y - 4);
  await page.mouse.move(strip.x, strip.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  const prompt = page.getByTestId('wand-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('status')).toContainText('Space 1 of 2');
  await expect(page.getByTestId('wand-candidates')).toHaveAttribute('data-index', '0');
  await shoot(page, 'wand-picked');
  // Tab: the strip beside it; ⇧Tab back; Tab again.
  await page.keyboard.press('Tab');
  await expect(prompt.getByRole('status')).toContainText('Space 2 of 2');
  await expect(page.getByTestId('wand-candidates')).toHaveAttribute('data-index', '1');
  await page.keyboard.press('Shift+Tab');
  await expect(prompt.getByRole('status')).toContainText('Space 1 of 2');
  await page.keyboard.press('Tab');
  await expect(prompt.getByRole('status')).toContainText('Space 2 of 2');
  await shoot(page, 'wand-tabbed');
  await axe(page, '[data-testid="wand-prompt"]');

  // A name typed on the plan starts the prompt's name; the function follows it; Enter makes the room.
  n = (await historyOf(page, project)).length;
  await page.keyboard.press('B');
  const name = prompt.getByLabel('Name');
  await expect(name).toBeFocused();
  await page.keyboard.type('ike store');
  await expect(name).toHaveValue('Bike store');
  await expect(prompt.getByRole('combobox', { name: 'Function' })).toContainText('Storage');
  await shoot(page, 'wand-named');
  await name.press('Enter');
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(n + 1);
  const made = await lastOps(page, project);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ op: 'addRoom', level: 'L1', name: 'Bike store', function: 'storage' });
  const doc = await docOf(page, project);
  const bike = Object.values(doc.rooms).find((r) => r.name === 'Bike store')!;
  expect(bike.function).toBe('storage');
  expect(bike.anchor[0]).toBeLessThan(2_000_000);
  await expect(prompt).toBeHidden();
  await settled(page);
  await shoot(page, 'wand-made');

  // One undo takes the room back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Object.values((await docOf(page, project)).rooms).some((r) => r.name === 'Bike store')).toBe(false);
});
