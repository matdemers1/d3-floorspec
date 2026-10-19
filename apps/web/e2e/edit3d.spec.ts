/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, password, settled } from './support.js';

/**
 * FLR-T-14.8: edit in 3D — the board's frames "14.8 · Edit in 3D — dragging an armchair on the floor
 * (snap, rotate, clearances)" and "— a window slid along its wall, the tape measure, undo" on the
 * Courtyard House.
 *
 * Edit in 3D on the Experiences cluster; the great room's armchair dragged on its floor — drawn moved
 * while it is dragged without the house meshed again, a guide and a clearance tag up — and dropped as
 * one op, the toast's Undo putting it back; turned by its rotate handle with the keys (15°) and the
 * pointer; a window slid along its wall as one op; the tape measure between two points of a floor,
 * its readout's length and Δx, Δy, Δz checked against the points; axe in both themes. What each drag
 * move cost is reported, and kept inside a 45 fps frame. Screenshots land in test-results/edit3d-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as {
  openings: Record<string, { wall: string; offset: number }>;
  walls: Record<string, { start: string; end: string }>;
  junctions: Record<string, { position: [number, number] }>;
};
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const K = 1_280_000;

type Vec3 = [number, number, number];
type Hook = {
  __floorspec3d?: {
    ready: boolean;
    screenPoint(id: string): { x: number; y: number } | null;
    screenOf(x: number, y: number, z: number): { x: number; y: number } | null;
    pickAt(x: number, y: number): string | null;
    edit: { tool: string | null; dragging: string | null; moved: string[]; tape: { points: Vec3[]; kinds: string[]; reading: { length: number; dx: number; dy: number; dz: number } | null }; stats: { moves: number; totalMs: number; maxMs: number } };
  };
};
type Doc = typeof HOUSE & { extensions: { FS_furniture: { collections: { pieces: Record<string, { host: { position: [number, number]; rotation?: number } }> } } } };

const editState = (page: Page) => page.evaluate(() => (window as unknown as Hook).__floorspec3d!.edit);
const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const chairOf = async (page: Page, project: string) => (await docOf(page, project)).extensions.FS_furniture.collections.pieces['GR-CHAIR1']!.host;

/** Wait until the camera has stopped easing: the armchair stays at the same point on screen. */
async function settledCamera(page: Page): Promise<void> {
  const seen: string[] = [];
  await expect.poll(async () => {
    seen.push(JSON.stringify(await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.screenPoint('GR-CHAIR1'))));
    const last = seen.slice(-4);
    return last.length === 4 && last.every((v) => v === last[0] && v !== 'null');
  }, { timeout: 30_000, intervals: [600] }).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/edit3d-${name}-${theme}.png` });
  }
}

/**
 * The theme switched and settled: its colours ease in (the chrome's CSS transitions), and on a runner
 * drawing a full-screen house in software a frame can hold the main thread long enough that a fixed
 * wait ends before those transitions have even begun — axe then measures the chrome between themes.
 * So: two frames after the switch, and no CSS transition still running.
 */
async function themeSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
      }));
    }),
    undefined,
    { timeout: 30_000, polling: 250 },
  );
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(800);
    await themeSettled(page);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

test('edit in 3D: an armchair dragged on its floor and turned, a window slid along its wall, each one op with undo; the tape measure — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Editor in 3D', email: 'edit3d@example.test', password: password('edit3d') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1_000);

  // ── Edit in 3D, from the Experiences cluster.
  const cluster = page.getByRole('toolbar', { name: 'Experiences' });
  const editButton = cluster.getByRole('button', { name: 'Edit in 3D' });
  await editButton.click();
  await expect(editButton).toHaveAttribute('aria-pressed', 'true');
  expect((await editState(page)).tool).toBe('move');
  await expect(page.getByRole('note').filter({ hasText: 'Edit in 3D' })).toBeVisible();

  // Closer in: the house fills the view — and the camera at rest before anything is picked.
  await page.locator('.fs-three__gl').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('=');
  await settledCamera(page);

  // ── The armchair dragged on the great room's floor: moved as it is dragged, then dropped as one op.
  const before = await chairOf(page, project);
  const ops = (await historyOf(page, project)).length;
  const at = await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d!.screenPoint('GR-CHAIR1'), undefined, { timeout: 20_000 }).then((h) => h.jsonValue() as Promise<{ x: number; y: number }>);
  expect(await page.evaluate(([x, y]) => (window as unknown as Hook).__floorspec3d!.pickAt(x, y), [at.x, at.y] as const)).toBe('GR-CHAIR1');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(at.x + i * 4, at.y + i);
    await page.waitForTimeout(30);
  }
  await expect.poll(async () => (await editState(page)).dragging).toBe('GR-CHAIR1');
  // Drawn moved — its parts, not the house meshed again.
  await expect.poll(async () => (await editState(page)).moved, { timeout: 20_000 }).toContain('GR-CHAIR1');
  await expect(page.getByRole('note').filter({ hasText: /Moving Armchair on the floor of Great room/ })).toBeVisible();
  await expect(page.locator('.fs-edit3d__tag').first()).toContainText(/to wall|tight|runs into/);
  await shoot(page, 'drag');
  await page.mouse.up();
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(ops + 1);
  await settled(page);
  const after = await chairOf(page, project);
  expect(after.position).not.toEqual(before.position);
  // On its floor still, in the great room.
  expect(after).toMatchObject({ mode: 'surface', room: 'R7', surface: 'floor' });
  const dropped = page.getByText(/Moved Armchair .* · one op/).first();
  await expect(dropped).toBeVisible();
  await expect(page.locator('.fs-edit3d [role="status"]')).toContainText('Moved Armchair');
  // The drag kept inside a frame: what each pointer move cost, reported.
  const stats = (await editState(page)).stats;
  console.log(`edit3d: ${String(stats.moves)} drag moves, ${(stats.totalMs / Math.max(1, stats.moves)).toFixed(2)} ms each on average, ${stats.maxMs.toFixed(2)} ms at most`);
  expect(stats.moves).toBeGreaterThan(5);
  expect(stats.totalMs / stats.moves).toBeLessThan(22);
  // Undo, from the toast: one more op, and the chair where it was.
  await page.locator('button.d3-toast__action', { hasText: 'Undo' }).click();
  await expect.poll(async () => (await chairOf(page, project)).position).toEqual(before.position);
  await settled(page);
  expect((await historyOf(page, project)).length).toBe(ops + 2);

  // ── Turned by its rotate handle: the keys, 15° a press, one op each — then the pointer.
  if ((await page.getByRole('slider', { name: 'Turn Armchair' }).count()) === 0) {
    const again = (await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.screenPoint('GR-CHAIR1')))!;
    await page.mouse.click(again.x, again.y);
  }
  const turn = page.getByRole('slider', { name: 'Turn Armchair' });
  await expect(turn).toBeVisible();
  await turn.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await chairOf(page, project)).rotation ?? 0).toBe(-15_000_000);
  await expect(turn).toHaveAttribute('aria-valuetext', 'Turned 15° right');
  await settled(page);
  const turned = (await historyOf(page, project)).length;
  const centre = (await page.getByRole('button', { name: /^Move Armchair/ }).boundingBox())!;
  const handle = (await turn.boundingBox())!;
  const cx = centre.x + centre.width / 2;
  const cy = centre.y + centre.height / 2;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  const r = Math.hypot(hx - cx, hy - cy);
  const a0 = Math.atan2(hy - cy, hx - cx);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const a = a0 + (i / 8) * (Math.PI / 3);
    await page.mouse.move(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(turned + 1);
  expect((await chairOf(page, project)).rotation ?? 0).not.toBe(-15_000_000);
  await expect(page.getByText(/Turned Armchair .* · one op/).first()).toBeVisible();
  await settled(page);
  await axe(page, 'Edit in 3D, the armchair selected');

  // ── A window slid along its wall: one op, its offset changed along the wall.
  let win: string | null = null;
  for (const id of ['O12', 'O3', 'O4', 'O10', 'O11']) {
    const p = await page.evaluate((x) => (globalThis as unknown as Hook).__floorspec3d!.screenPoint(x), id);
    if (p !== null) {
      win = id;
      break;
    }
  }
  expect(win, 'a window the camera sees').not.toBeNull();
  const opening = HOUSE.openings[win!]!;
  const wall = HOUSE.walls[opening.wall]!;
  const a = HOUSE.junctions[wall.start]!.position;
  const b = HOUSE.junctions[wall.end]!.position;
  const sa = (await page.evaluate(([x, y]) => (globalThis as unknown as Hook).__floorspec3d!.screenOf(x, y, 1.2), [a[0] / K, a[1] / K] as const))!;
  const sb = (await page.evaluate(([x, y]) => (globalThis as unknown as Hook).__floorspec3d!.screenOf(x, y, 1.2), [b[0] / K, b[1] / K] as const))!;
  const along = { x: (sb.x - sa.x) / Math.hypot(sb.x - sa.x, sb.y - sa.y), y: (sb.y - sa.y) / Math.hypot(sb.x - sa.x, sb.y - sa.y) };
  const offsetOf = async () => (await docOf(page, project)).openings[win!]!.offset;
  const offset0 = await offsetOf();
  const slideOps = (await historyOf(page, project)).length;
  const w0 = (await page.evaluate((x) => (globalThis as unknown as Hook).__floorspec3d!.screenPoint(x), win!))!;
  await page.mouse.move(w0.x, w0.y);
  await page.mouse.down();
  // Towards the wall's end when the window is nearer its start, else back towards the start.
  const towards = offset0 < 0.3 * Math.hypot(b[0] - a[0], b[1] - a[1]) ? 1 : -1;
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(w0.x + towards * along.x * i * 6, w0.y + towards * along.y * i * 6);
    await page.waitForTimeout(30);
  }
  await expect(page.getByRole('note').filter({ hasText: /Sliding .* along/ })).toBeVisible();
  await expect.poll(async () => (await editState(page)).moved, { timeout: 20_000 }).toContain(win);
  await shoot(page, 'slide');
  await page.mouse.up();
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(slideOps + 1);
  expect(Math.sign((await offsetOf()) - offset0)).toBe(towards);
  await expect(page.getByText(/Moved .* · one op/).first()).toBeVisible();
  await settled(page);

  // ── The tape measure: two points of the great room's floor by the kitchen, 1.5 m apart east to west.
  const tapeButton = cluster.getByRole('button', { name: 'Tape measure' });
  await tapeButton.click();
  await expect(tapeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(editButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('note').filter({ hasText: 'Tape measure · click to chain' })).toBeVisible();
  const p1 = (await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.screenOf(21_000_000 / 1_280_000, 16_200_000 / 1_280_000, 0)))!;
  const p2 = (await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.screenOf(22_920_000 / 1_280_000, 16_200_000 / 1_280_000, 0)))!;
  await page.mouse.move(p1.x, p1.y);
  await page.waitForTimeout(200);
  await page.mouse.click(p1.x, p1.y);
  await expect.poll(async () => (await editState(page)).tape.points.length).toBe(1);
  await page.mouse.move(p2.x, p2.y);
  await page.waitForTimeout(200);
  await page.mouse.click(p2.x, p2.y);
  await expect.poll(async () => (await editState(page)).tape.points.length).toBe(2);
  const tape = (await editState(page)).tape;
  const [q1, q2] = tape.points as [Vec3, Vec3];
  // On the same floor: no rise; about 1.5 m apart, east to west (a snap may move a point a little).
  expect(tape.reading).not.toBeNull();
  expect(Math.abs(q2[2] - q1[2])).toBeLessThan(0.01);
  expect(tape.reading!.dz).toBeLessThan(0.01 * K);
  expect(Math.abs(tape.reading!.length - Math.round(Math.hypot(q2[0] - q1[0], q2[1] - q1[1], q2[2] - q1[2]) * K))).toBeLessThanOrEqual(2);
  expect(Math.abs(tape.reading!.length - 1.5 * K)).toBeLessThan(0.15 * K);
  const card = page.getByTestId('tape-readout');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/^\d+′-\d/);
  // 1.5 m east to west: about 4′-11″, all of it along x.
  await expect(card).toContainText(/^4′-11/);
  await expect(card).toContainText(/Δx 4′-11[^·]*″ · Δy 0″ · Δz 0″/);
  await expect(page.locator('.fs-edit3d [role="status"]')).toContainText('Measured');
  await shoot(page, 'tape');
  await axe(page, 'The tape measure with a reading');
  // Esc finishes: the points go; a second Esc puts the tape away.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editState(page)).tape.points.length).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editState(page)).tool).toBeNull();
  await expect(tapeButton).toHaveAttribute('aria-pressed', 'false');
});
