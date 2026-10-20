/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-15.3: context on the Courtyard House on its lot, in Landscape mode — the P15 board's "15.3 ·
 * Context — the street, neighbours and trees beyond, generated from the street side" and "15.3 · Context
 * in 3D" frames.
 *
 * The Context tool (⇧X) opens the Context panel: Generate writes Laurel Ridge Drive along the lot's street
 * edge (west), a neighbour on each side at the lot's setbacks and trees beyond — FS_context's records, one
 * batch — drawn in the plan's neutral context style with its tags. Show: Ghost greys it, Off hides it, On
 * brings it back. A tree planted by hand is dragged with the Context tool; Regenerate keeps it. Every
 * schedule is the same before the context and after it. In 3D the house stands on its street, the
 * neighbours in neutral massing; the Context layer hides them there too. axe passes in both themes.
 * Screenshots: test-results/context-*.png (and FLR153_SHOTS, when set).
 */

const ON_ITS_LOT = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house-outdoor.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ft = (x: number, y: number): [number, number] => [Math.round(x * FT), Math.round(y * FT)];

type Rec = Record<string, unknown> & { at?: number[]; extras?: unknown; name?: string };
interface Doc {
  extensionsUsed?: Record<string, string>;
  extensions?: { FS_context?: { streets?: Record<string, Rec>; neighbours?: Record<string, Rec>; trees?: Record<string, Rec> } };
}
type Hook = { __floorspec3d?: { ready: boolean; kinds: Record<string, number>; shown: Record<string, number> } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const records = (d: Doc, m: 'streets' | 'neighbours' | 'trees'): [string, Rec][] => Object.entries(d.extensions?.FS_context?.[m] ?? {});

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
    const path = `test-results/context-${name}-${theme}.png`;
    await page.screenshot({ path });
    const out = process.env['FLR153_SHOTS'];
    if (out !== undefined && out !== '') {
      mkdirSync(out, { recursive: true });
      copyFileSync(path, `${out}/context-${name}-${theme}.png`);
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

/** The plan's camera, from two readouts: where a world point (base units) is on the page. */
async function cameraOf(page: Page): Promise<{ at: (p: readonly [number, number]) => { x: number; y: number }; s: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return { at: (p) => ({ x: a.x + (p[0] - wa[0]) * s, y: a.y - (p[1] - wa[1]) * s }), s };
}

/** Every schedule's tab and its table, as the Schedules screen shows them. */
async function schedulesOf(page: Page, project: string): Promise<Record<string, string>> {
  await page.goto(`/projects/${project}/schedules`);
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  const out: Record<string, string> = {};
  const tabs = page.getByRole('tab');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    const tab = tabs.nth(i);
    const name = ((await tab.textContent()) ?? '').trim();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    out[name] = ((await page.getByRole('tabpanel').textContent()) ?? '').replace(/\s+/g, ' ');
  }
  return out;
}

test('context: generate the street, neighbours and trees from the street side, show, ghost and hide them, plant and drag a tree, schedules unchanged, the house on its street in 3D — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Landscaper', email: 'context@example.test', password: password('context') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House on its street') },
    data: Buffer.from(JSON.stringify(ON_ITS_LOT)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  const before = await schedulesOf(page, project);
  expect(Object.keys(before).length).toBeGreaterThan(2);

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── Landscape mode: the Context tool (⇧X) on its rail opens the Context panel.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Landscape mode' }).click();
  await expect(page.getByRole('button', { name: 'Context (⇧X)' })).toBeVisible();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+KeyX');
  const panel = inspector.getByRole('region', { name: 'Context' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('never part of the design');
  await expect(panel.getByTestId('context-never')).toContainText('Quantities and schedulesexcluded');
  await expect(panel.getByTestId('context-never')).toContainText('casts shade');
  // FS_site's street edge is the west: the panel says so before it is told
  await expect(panel.getByRole('radio', { name: 'West' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel).not.toContainText('compliant');
  await axe(page, 'the Context panel');

  // ── Generate: one batch — a street on the west, a neighbour each side at the setbacks, trees beyond.
  await panel.getByRole('button', { name: 'Generate' }).click();
  await expect.poll(async () => records(await docOf(page, project), 'neighbours').length).toBe(2);
  const doc1 = await docOf(page, project);
  expect(doc1.extensionsUsed?.['FS_context']).toBe('0.1.0');
  const [[, street]] = records(doc1, 'streets') as [[string, Rec & { points: number[][]; width: number; sidewalk: number }]];
  expect(street.width).toBe(30 * FT);
  expect(street.sidewalk).toBe(5 * FT);
  // the street runs north–south, west of the lot's west line (about x = −34′)
  expect(street.points.every((p) => p[0]! < -40 * FT)).toBe(true);
  const trees = records(doc1, 'trees').length;
  expect(trees).toBeGreaterThan(4);
  // drawn in the context style, with its tags
  await expect(page.getByTestId('context-under').locator('[data-context="neighbour"]')).toHaveCount(2);
  await expect(page.getByTestId('context-under').locator('[data-context="street"]')).toHaveCount(1);
  await expect(page.getByTestId('context-over')).toContainText('Context · neighbour massing');
  await expect(page.getByTestId('context-over')).toContainText('Context · street, curb, sidewalk');
  await expect(page.getByTestId('context-over')).toContainText('Context · trees beyond the lot');
  await expect(panel.getByText('Generated', { exact: true })).toBeVisible();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit1');
  await settled(page);
  await shoot(page, 'plan');

  // ── Show: Ghost greys it and leaves it unpicked, Off hides it, On brings it back.
  const show = panel.getByRole('radiogroup', { name: 'Show context' });
  await show.getByRole('radio', { name: 'Ghost' }).click();
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-ghost', /\bcontext\b/);
  await expect(page.getByTestId('context-under')).toBeAttached();
  await show.getByRole('radio', { name: 'Off' }).click();
  await expect(page.getByTestId('context-under')).toHaveCount(0);
  await expect(page.getByTestId('context-over')).toHaveCount(0);
  await show.getByRole('radio', { name: 'On' }).click();
  await expect(page.getByTestId('context-under')).toBeAttached();
  await expect(page.locator('.fs-canvas')).not.toHaveAttribute('data-ghost', /\bcontext\b/);

  // ── By hand: a tree just north of the lot, then dragged 10′ east with the Context tool; Regenerate keeps it.
  const draw = panel.getByRole('radiogroup', { name: 'Draw by hand' });
  await draw.getByRole('radio', { name: 'Tree', exact: true }).click();
  let cam = await cameraOf(page);
  const plant = cam.at(ft(60, 106));
  await page.mouse.click(plant.x, plant.y);
  await expect.poll(async () => records(await docOf(page, project), 'trees').length).toBe(trees + 1);
  const [handId, hand] = records(await docOf(page, project), 'trees').find(([, t]) => t.extras === undefined)!;
  await inspector.getByRole('region', { name: 'Context' }).getByRole('radiogroup', { name: 'Draw by hand' }).getByRole('radio', { name: 'Move' }).click();
  cam = await cameraOf(page);
  const from = cam.at([hand.at![0]!, hand.at![1]!]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + (10 * FT * cam.s * k) / 8, from.y);
  await page.mouse.up();
  await expect.poll(async () => (records(await docOf(page, project), 'trees').find(([id]) => id === handId)?.[1].at?.[0] ?? 0) - hand.at![0]!).toBeGreaterThan(8 * FT);
  await inspector.getByRole('region', { name: 'Context' }).getByRole('button', { name: 'Regenerate' }).click();
  await expect.poll(async () => records(await docOf(page, project), 'trees').some(([id]) => id === handId)).toBe(true);
  expect(Object.values((await docOf(page, project)).extensions!.FS_context!.neighbours!)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await axe(page, 'Landscape mode with the house on its street');

  // ── Never part of the design: every schedule is the same with the context.
  const after = await schedulesOf(page, project);
  expect(after).toEqual(before);
  for (const text of Object.values(after)) expect(text).not.toMatch(/Laurel Ridge|Neighbour|massing/);

  // ── The house on its street in 3D: neutral massing, the street, the trees — and the Context layer hides them.
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 120_000 });
  const kinds = await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.kinds);
  expect(kinds['context'] ?? 0).toBeGreaterThan(10);
  const shownContext = () => page.evaluate(() => Object.entries((window as unknown as Hook).__floorspec3d!.shown).filter(([k]) => k.endsWith(':context')).reduce((s, [, n]) => s + n, 0));
  expect(await shownContext()).toBeGreaterThan(10);
  await page.waitForTimeout(2_000);
  await shoot(page, '3d');
  await axe(page, 'the 3D view with the house on its street');
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+KeyX');
  const panel3d = inspector.getByRole('region', { name: 'Context' });
  await expect(panel3d).toBeVisible();
  await panel3d.getByRole('radiogroup', { name: 'Show context' }).getByRole('radio', { name: 'Off' }).click();
  await expect.poll(shownContext).toBe(0);
  await panel3d.getByRole('radiogroup', { name: 'Show context' }).getByRole('radio', { name: 'On' }).click();
  await expect.poll(shownContext).toBeGreaterThan(10);
});
