/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, password, settled } from './support.js';

/**
 * FLR-T-18.8: multi-select and arrange, on the Courtyard House (the worker's fixture, a copy of the
 * owner's house) imported as a project.
 *
 * A crossing marquee dragged leftwards over the backs of the great room's three west dining chairs
 * catches them and not the table (AutoCAD's convention); the selection toolbar and the inspector say
 * "3 dining chairs". ⌘D duplicates them as one batch — three new chairs, one history entry — and
 * one undo takes all three back. A window marquee (dragged rightwards) catches only what is wholly
 * inside it; ⇧-click takes one out; ⌘C and ⌘V on the upper floor paste the rest there. A recessed light is arrayed with ⌥A: the popover previews the
 * copies as ghosts, and "Add" writes them on the light's ceiling as one batch, kept on its circuit;
 * undo is one step. Axe passes on the toolbar, the popover and the inspector in both themes.
 * Screenshots land in test-results/arrange-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WEST = ['GR-CW0', 'GR-CW1', 'GR-CW2'];

interface Host { mode: string; room?: string; surface?: string; position?: number[] }
type Doc = { extensions: { FS_furniture: { collections: Record<string, Record<string, { host: Host }>> }; FS_electrical: { collections: { lights: Record<string, { host: Host }> }; circuits: Record<string, { loads?: string[] }> } } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const pieces = (d: Doc) => d.extensions.FS_furniture.collections['pieces']!;

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/arrange-${name}-${theme}.png` });
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

/** The screen box around some items on the plan. */
async function boxAround(page: Page, ids: readonly string[], attr = 'data-furniture'): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const boxes = await Promise.all(ids.map(async (id) => (await page.locator(`[${attr}="${id}"]`).first().boundingBox())!));
  return {
    left: Math.min(...boxes.map((b) => b.x)),
    top: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.x + b.width)),
    bottom: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}

test('multi-select and arrange: a crossing marquee, duplicate as one undo, a window marquee, ⇧-click, and an array of recessed lights', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Arranger', email: 'arranger@example.test', password: password('arrange') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const toolbar = page.getByTestId('selection-toolbar');

  // Frame the great room's dining table — selected, then the toolbar's "Zoom to selection" — so the
  // chairs around it are big enough to catch by their backs.
  const table = (await page.locator('[data-furniture="GR-TABLE"]').boundingBox())!;
  await page.mouse.click(table.x + table.width / 2, table.y + table.height * 0.2);
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Zoom to selection' }).click();
  await expect(page.locator('.fs-canvas[data-zooming]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(toolbar).toHaveCount(0);

  // ── A crossing marquee, dragged leftwards over the west chairs' backs: the three chairs, not the table.
  const west = await boxAround(page, WEST);
  const tableNow = (await page.locator('[data-furniture="GR-TABLE"]').boundingBox())!;
  const from = { x: Math.min(tableNow.x - 4, west.left + (west.right - west.left) * 0.5), y: west.bottom + 12 };
  const to = { x: west.left - 12, y: west.top - 12 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await expect(page.locator('.fs-marquee--crossing')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Drag left → crossing' })).toBeVisible();
  await shoot(page, 'crossing-marquee');
  await page.mouse.up();

  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: /3 chairs selected/ })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: '3 dining chairs' })).toBeVisible();
  await expect(inspector.getByText('Same catalogue item · dining-chair-450')).toBeVisible();
  await shoot(page, 'selection-toolbar');
  await axe(page, '[data-testid="selection-toolbar"]');
  await axe(page, '[data-testid="multi-inspector"]');

  // ── ⌘D: three new chairs in one batch, beside the originals; one undo takes all three back.
  const opsBefore = (await historyOf(page, project)).length;
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => Object.keys(pieces(await docOf(page, project))).filter((id) => /^GR-CW\d-2$/.test(id)).sort()).toEqual(['GR-CW0-2', 'GR-CW1-2', 'GR-CW2-2']);
  expect((await historyOf(page, project)).length).toBe(opsBefore + 1);
  const copy = pieces(await docOf(page, project))['GR-CW0-2']!;
  const original = pieces(await docOf(page, project))['GR-CW0']!;
  expect(copy.host.room).toBe('R7');
  expect(copy.host.position![0]).not.toBe(original.host.position![0]);
  await expect(inspector.getByRole('heading', { name: '3 dining chairs' })).toBeVisible();
  await settled(page);
  await shoot(page, 'duplicated');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Object.keys(pieces(await docOf(page, project))).filter((id) => /-2$/.test(id) && id.startsWith('GR-CW'))).toEqual([]);
  await settled(page);

  // ── A window marquee (dragged rightwards) around the east chairs only: wholly inside, so three.
  await page.keyboard.press('Escape');
  const east = await boxAround(page, ['GR-CE0', 'GR-CE1', 'GR-CE2']);
  await page.mouse.move(east.left - 10, east.top - 10);
  await page.mouse.down();
  await page.mouse.move(east.right + 10, east.bottom + 10, { steps: 6 });
  await expect(page.locator('.fs-marquee').first()).toBeVisible();
  await expect(page.locator('.fs-marquee--crossing')).toHaveCount(0);
  await shoot(page, 'window-marquee');
  await page.mouse.up();
  await expect(inspector.getByRole('heading', { name: '3 dining chairs' })).toBeVisible();
  // ⇧-click takes one back out.
  const ce1 = (await page.locator('[data-furniture="GR-CE1"]').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.click(ce1.x + ce1.width * 0.8, ce1.y + ce1.height / 2);
  await page.keyboard.up('Shift');
  await expect(inspector.getByRole('heading', { name: '2 dining chairs' })).toBeVisible();

  // ── ⌘C, then ⌘V on the upper floor: the two chairs pasted there in place, as one batch.
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('PageUp');
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Upper floor');
  await page.keyboard.press('ControlOrMeta+v');
  type Piece = { host: Host; fallback?: { level?: string } };
  await expect.poll(async () => {
    const all = pieces(await docOf(page, project)) as Record<string, Piece>;
    return ['GR-CE0-2', 'GR-CE2-2'].map((id) => all[id]?.fallback?.level ?? null);
  }).toEqual(['L2', 'L2']);
  await settled(page);
  await shoot(page, 'pasted-upper-floor');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Escape');

  // ── ⌥A on a recessed light in the great room: the array popover, the copies as ghosts, one batch.
  await page.keyboard.press('0');
  await page.waitForTimeout(400);
  await expect(page.locator('.fs-canvas[data-zooming]')).toHaveCount(0);
  const far = (await page.locator('[data-device="L-GR-R1"]').boundingBox())!;
  await page.mouse.click(far.x + far.width / 2, far.y + far.height / 2);
  await expect(toolbar).toBeVisible();
  // Framed with room around it for the row: the light, then zoomed back out a few steps.
  await toolbar.getByRole('button', { name: 'Zoom to selection' }).click();
  await expect(page.locator('.fs-canvas[data-zooming]')).toHaveCount(0);
  for (let i = 0; i < 4; i++) await page.keyboard.press('-');
  await page.waitForTimeout(400);
  await expect(page.locator('.fs-canvas[data-zooming]')).toHaveCount(0);
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('Alt+a');
  const popover = page.getByTestId('array-popover');
  await expect(popover).toBeVisible();
  await popover.getByLabel('Count').fill('3');
  await expect(page.getByTestId('array-ghost')).toHaveCount(2);
  await shoot(page, 'array-along-wall');
  await axe(page, '[data-testid="array-popover"]');
  const circuitOf = (d: Doc) => Object.entries(d.extensions.FS_electrical.circuits).find(([, c]) => c.loads?.includes('L-GR-R1'))?.[0];
  const before = await docOf(page, project);
  const opsBeforeArray = (await historyOf(page, project)).length;
  await popover.getByRole('button', { name: /^Add 2 / }).click();
  await expect.poll(async () => Object.keys((await docOf(page, project)).extensions.FS_electrical.collections.lights).filter((id) => id.startsWith('L-GR-R1-')).sort()).toEqual(['L-GR-R1-2', 'L-GR-R1-3']);
  const after = await docOf(page, project);
  expect(after.extensions.FS_electrical.collections.lights['L-GR-R1-2']!.host).toMatchObject({ mode: 'surface', surface: 'ceiling', room: 'R7' });
  const circuit = circuitOf(before);
  if (circuit !== undefined) expect(after.extensions.FS_electrical.circuits[circuit]!.loads).toEqual(expect.arrayContaining(['L-GR-R1-2', 'L-GR-R1-3']));
  expect((await historyOf(page, project)).length).toBe(opsBeforeArray + 1);
  await settled(page);
  await shoot(page, 'arrayed');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Object.keys((await docOf(page, project)).extensions.FS_electrical.collections.lights).filter((id) => id.startsWith('L-GR-R1-'))).toEqual([]);
});
