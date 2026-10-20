/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-15.2: outdoor rooms on the Courtyard House on its lot, in Landscape mode — the P15 board's
 * "15.2 · Outdoor rooms", "15.2 · Fence and gate", "15.2 · Pergola selected" and "15.2 · The back
 * terrace in 3D" frames.
 *
 * The library opens on its Outdoor shelf: a plunge pool is dropped south of the back terrace — one
 * placeElement of FS_outdoor, FS_outdoor declared on the way — and drawn with its water and coping. The
 * fence tool (⇧F) draws a privacy fence along the side yard, point to point; "Add gate" opens a gate
 * in its line. A pergola dropped over the terrace has eight posts; its front handle stretched 8′ gives
 * it ten — re-spaced, each still 6″ square. An outdoor kitchen goes along the terrace's north edge. In
 * 3D the back terrace is drawn. axe passes in both themes, plan and 3D. Screenshots:
 * test-results/outdoor-*.png (and FLR152_SHOTS, when set).
 */

const ON_ITS_LOT = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ft = (x: number, y: number): [number, number] => [Math.round(x * FT), Math.round(y * FT)];

type Box = { min: number[]; max: number[] };
type El = Record<string, unknown> & { fallback: { box: Box }; host?: { position?: number[] }; catalogue?: string; points?: number[][]; gates?: { offset: number; width: number }[]; postSize?: number };
interface Doc {
  extensionsUsed?: Record<string, string>;
  extensions?: { FS_outdoor?: { collections?: Record<string, Record<string, El>> } };
}
type Hook = { __floorspec3d?: { ready: boolean } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const coll = (d: Doc, c: string): [string, El][] => Object.entries(d.extensions?.FS_outdoor?.collections?.[c] ?? {});

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

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(600);
    await themeSettled(page);
    const path = `test-results/outdoor-${name}-${theme}.png`;
    await page.screenshot({ path });
    const out = process.env['FLR152_SHOTS'];
    if (out !== undefined && out !== '') {
      mkdirSync(out, { recursive: true });
      copyFileSync(path, `${out}/outdoor-${name}-${theme}.png`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
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
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Where the pointer is on the plan, as the status bar reads it out. */
async function readout(page: Page, x: number, y: number): Promise<[number, number]> {
  await page.mouse.move(x, y);
  let at: [number, number] | null = null;
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [wx, wy] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map((m) => (m[1] === '-' ? -1 : 1) * (Number(m[2]) * FT + Number(m[3]) * IN + (m[4] === undefined ? 0 : (Number(m[4]) / Number(m[5])) * IN)));
      at = wx === undefined || wy === undefined ? null : [wx, wy];
      return at !== null;
    })
    .toBe(true);
  return at as unknown as [number, number];
}

/** The plan's camera, from two readouts: where a world point (base units) is on the page, and its scale. */
async function cameraOf(page: Page): Promise<{ at: (p: readonly [number, number]) => { x: number; y: number }; s: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return { at: (p) => ({ x: a.x + (p[0] - wa[0]) * s, y: a.y - (p[1] - wa[1]) * s }), s };
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Pick a card on the library's Outdoor shelf and click it onto the plan at a world point; then stop placing. */
async function place(page: Page, entry: string, where: [number, number]): Promise<void> {
  const drawer = page.locator('.fs-lib');
  if (!(await drawer.isVisible())) {
    await page.locator('.fs-editor').focus();
    await page.keyboard.press('i');
  }
  await expect(drawer).toBeVisible();
  await drawer.locator(`.fs-lib-card[data-entry="${entry}"]`).click();
  const { at } = await cameraOf(page);
  const q = at(where);
  await page.mouse.move(q.x, q.y);
  await expect(page.getByTestId('placing-ghost')).toBeVisible();
  await page.mouse.click(q.x, q.y);
  await page.keyboard.press('Escape');
}

const near = (a: number, b: number, tol = FT) => Math.abs(a - b) < tol;

test('outdoor rooms: drop a plunge pool, draw a fence with a gate, stretch a pergola (its posts re-space), place an outdoor kitchen, see the back terrace in 3D — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Landscaper', email: 'landscaper@example.test', password: password('outdoor') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House on its lot') },
    data: Buffer.from(JSON.stringify(ON_ITS_LOT)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── Landscape mode: the fence tool on its rail; the library opens on its Outdoor shelf.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Landscape mode' }).click();
  await expect(page.getByRole('button', { name: 'Draw a fence' })).toBeVisible();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('i');
  const drawer = page.locator('.fs-lib');
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Outdoor' })).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['outdoor:plunge-pool-8x14', 'outdoor:pergola-12x16', 'outdoor:kitchen-10', 'outdoor:fire-pit-4']) await expect(drawer.locator(`.fs-lib-card[data-entry="${key}"]`)).toBeVisible();
  await axe(page, 'the library on its Outdoor shelf');

  // ── A plunge pool dropped south of the back terrace: one op, FS_outdoor declared on the way.
  await place(page, 'outdoor:plunge-pool-8x14', ft(69, 15));
  await expect.poll(async () => coll(await docOf(page, project), 'pools').length).toBe(1);
  const doc1 = await docOf(page, project);
  expect(doc1.extensionsUsed?.['FS_outdoor']).toBe('0.1.0');
  const [, pool] = coll(doc1, 'pools')[0]!;
  expect(pool.catalogue).toBe('plunge-pool-8x14');
  expect(near(pool.host!.position![0]!, 69 * FT, 2 * FT) && near(pool.host!.position![1]!, 15 * FT, 2 * FT)).toBe(true);
  await expect(page.locator('[data-kind="FS_outdoor:pools"] [data-water]').first()).toBeAttached();
  await expect(inspector.getByRole('region', { name: 'Water' })).toContainText('gal');
  await expect(inspector).not.toContainText('compliant');
  await shoot(page, 'pool');

  // ── The fence tool (⇧F): a privacy fence along the side yard, three points, then a gate in its line.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+KeyF');
  await expect(inspector.getByTestId('fence-panel')).toBeVisible();
  await expect(inspector.getByTestId('fence-panel')).toContainText('A pool barrier is a rule for a rules pack');
  let cam = await cameraOf(page);
  for (const p of [ft(86, 60), ft(86, 0), ft(60, 0)]) {
    const q = cam.at(p);
    await page.mouse.click(q.x, q.y);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => coll(await docOf(page, project), 'fences').length).toBe(1);
  const [fenceId, fence] = coll(await docOf(page, project), 'fences')[0]!;
  expect(fence.points!.length).toBe(3);
  expect(fence['style']).toBe('privacy');
  expect(fence.fallback.box.max[2]).toBe(6 * FT);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // select it on the plan, and open a gate in its line
  cam = await cameraOf(page);
  const onFence = cam.at(ft(86, 30));
  await page.mouse.click(onFence.x, onFence.y);
  await expect(inspector.getByRole('region', { name: 'Fence' })).toBeVisible();
  await inspector.getByTestId('add-gate').click();
  await expect.poll(async () => (await docOf(page, project)).extensions!.FS_outdoor!.collections!['fences']![fenceId]!.gates?.length ?? 0).toBe(1);
  await expect(page.locator(`[data-id="${fenceId}"] [data-gate]`).first()).toBeAttached();
  await expect(page.locator(`[data-id="${fenceId}"] [data-posts]`)).toHaveAttribute('data-posts', /\d+/);
  await shoot(page, 'fence');

  // ── A pergola over the back terrace: eight posts; stretched 8′ by its front handle, ten — re-spaced, never wider.
  await page.keyboard.press('Escape');
  await place(page, 'outdoor:pergola-12x16', ft(70.25, 33));
  await expect.poll(async () => coll(await docOf(page, project), 'shelters').length).toBe(1);
  const [pergolaId, pergola] = coll(await docOf(page, project), 'shelters')[0]!;
  const shelterOnPlan = page.locator(`[data-id="${pergolaId}"] [data-posts]`);
  await expect(shelterOnPlan).toHaveAttribute('data-posts', '8');
  await expect(inspector.getByRole('region', { name: 'Structure' })).toContainText('8 ·');
  await expect(page.getByTestId('resize-handles')).toBeVisible();
  cam = await cameraOf(page);
  const front = await centreOf(page, '[data-testid="resize-handle-front"]');
  const back = await centreOf(page, '[data-testid="resize-handle-back"]');
  const away = { x: front.x - back.x, y: front.y - back.y };
  const len = Math.hypot(away.x, away.y);
  const pull = 8 * FT * cam.s;
  await page.mouse.move(front.x, front.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(front.x + (away.x / len) * (pull * k) / 10, front.y + (away.y / len) * (pull * k) / 10);
  await expect(page.getByTestId('resize-ghost')).toBeVisible();
  await expect(page.getByTestId('resize-posts')).toHaveAttribute('data-posts', '10');
  await page.screenshot({ path: 'test-results/outdoor-pergola-stretching-light.png' });
  await page.mouse.up();
  await expect.poll(async () => {
    const s = (await docOf(page, project)).extensions!.FS_outdoor!.collections!['shelters']![pergolaId]!;
    return s.fallback.box.max[0]! - s.fallback.box.min[0]!;
  }).toBe(20 * FT);
  const stretched = (await docOf(page, project)).extensions!.FS_outdoor!.collections!['shelters']![pergolaId]!;
  expect(stretched.postSize).toBe(pergola.postSize);
  expect(stretched.fallback.box.max[1]! - stretched.fallback.box.min[1]!).toBe(pergola.fallback.box.max[1]! - pergola.fallback.box.min[1]!);
  await expect(shelterOnPlan).toHaveAttribute('data-posts', '10');
  await expect(inspector.getByRole('region', { name: 'Structure' })).toContainText('10 ·');
  await settled(page);
  await shoot(page, 'pergola');

  // ── An outdoor kitchen along the terrace's north edge.
  await page.keyboard.press('Escape');
  await place(page, 'outdoor:kitchen-10', ft(70, 47));
  await expect.poll(async () => coll(await docOf(page, project), 'kitchens').length).toBe(1);
  await expect(page.locator('[data-kind="FS_outdoor:kitchens"] [data-appliance]').first()).toBeAttached();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await shoot(page, 'plan');
  await axe(page, 'Landscape mode with the back terrace');

  // ── The back terrace in 3D: the pergola, the pool with its coping and water, the kitchen.
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForTimeout(2_000);
  await shoot(page, '3d');
  await axe(page, 'the 3D view with the back terrace');
  // the model is as the plan left it: four outdoor rooms
  const last = await docOf(page, project);
  expect(['pools', 'fences', 'shelters', 'kitchens'].map((c) => coll(last, c).length)).toEqual([1, 1, 1, 1]);
});
