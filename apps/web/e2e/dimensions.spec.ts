/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-18.11: dimensions and annotation on the Courtyard House (the worker's fixture) imported as a
 * project — the board's "Technical plan style with overall dimensions", "Construction mode area
 * summary and tag toggles" and "Keep as a dimension" frames.
 *
 * The plan's exterior strings say no span under 6" (the arc bay's facets and the walls' thickness
 * steps are merged), with the house's overall 65'-8 15/16". In Construction, framed on the den, each
 * room has its own strings and every door and window its tag; the inspector gives the level's gross,
 * net and finished area and the whole house's, toggles that hide the room strings, and the door and
 * window schedule by type. The dimension tool (⇧D) measures the den's south wall from junction to
 * junction — one setProperty of FS_annotation on $document, the string drawn and its card saying
 * 16'-0" — and the string follows the den's east wall when the wall moves a foot. The note tool (⇧T)
 * drags a leader to the island and takes its text; the note is picked on the plan and deleted with
 * ⌫. The measure tool's "Keep as a dimension" keeps a measurement. axe passes on the summary, the
 * cards and the note's input in both themes. Screenshots land in test-results/dimensions-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The den's south-west and south-east corners, on the ground floor (J16, J8). */
const DEN_SW: [number, number] = [17_946_624, 0];
const DEN_SE: [number, number] = [24_188_928, 0];
/** The centre of the den's west window on its south wall (W7): 3'-8 3/4" from its south-west corner. */
const DEN_WINDOW: [number, number] = [17_946_624 + 1_454_912, 0];

type Doc = {
  junctions: Record<string, { level: string; position: [number, number] }>;
  extensionsUsed?: Record<string, string>;
  extensions?: { FS_annotation?: { dimensions?: Record<string, { level: string; direction: number[]; anchors: Record<string, unknown>[] }>; notes?: Record<string, { text: string; leader?: number[] }> } };
};
interface Entry { seq: number; kind: string; ops: { op: string; path?: string }[] }

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const lastOps = async (page: Page, project: string) => ((await (await page.request.get(`/api/projects/${project}/history`)).json()) as { ops: Entry[] }).ops[0]?.ops ?? [];

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/dimensions-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** `64'-11 3/8"` as base units; `5 1/2"` too. */
function lengthOf(text: string): number | null {
  const m = /^(\d+)'-(\d+)(?: (\d+)\/(\d+))?"$/.exec(text) ?? /^()(\d+)(?: (\d+)\/(\d+))?"$/.exec(text) ?? /^()()(\d+)\/(\d+)"$/.exec(text);
  if (m === null) return null;
  const [, feet, inches, num, den] = m;
  return Number(feet || 0) * FT + Number(inches || 0) * IN + (num === undefined ? 0 : (Number(num) / Number(den)) * IN);
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
async function cameraOf(page: Page): Promise<(p: readonly [number, number]) => { x: number; y: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return (p) => ({ x: a.x + (p[0] - wa[0]) * s, y: a.y - (p[1] - wa[1]) * s });
}

test('dimensions and annotation: clean exterior strings, room strings and tags, the area summary and schedule, the dimension and note tools, keep a measurement', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Draughtsman', email: 'draughtsman@example.test', password: password('dimensions') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── The exterior strings: the overall size, and no span under 6".
  const exterior = page.locator('.fs-annotation [data-anno^="ext:"] .fs-dim__text');
  await expect(exterior.first()).toBeVisible();
  const lengths = (await exterior.allTextContents()).map((t) => t.trim());
  expect(lengths).toContain(`65'-8 15/16"`);
  for (const t of lengths) {
    const v = lengthOf(t);
    expect(v, t).not.toBeNull();
    expect(v!, t).toBeGreaterThanOrEqual(6 * IN - 1);
  }
  await shoot(page, 'plan');

  // ── Construction, framed on the den: room strings and tags; the area, the toggles, the schedule.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Construction mode' }).click();
  const summary = inspector.getByRole('region', { name: 'Construction summary' });
  await expect(summary.getByTestId('area-summary')).toContainText('Gross (to exterior faces)');
  await expect(summary.getByTestId('area-summary')).toContainText('Net (rooms)');
  await expect(summary.getByTestId('area-summary')).toContainText('Finished (Z765)');
  await expect(summary.getByTestId('area-summary')).toContainText('Whole house');
  await page.getByRole('treeitem', { name: /^Den\b/ }).first().click();
  await page.getByRole('button', { name: 'Zoom to selection' }).first().click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await expect(page.locator('.fs-annotation [data-anno="room:R6:h"]')).toHaveCount(1);
  await expect(page.locator('.fs-annotation .fs-anno__tagtext').first()).toHaveText(/^[DW]\d+$/);
  await summary.getByRole('button', { name: /Door and window schedule/ }).click();
  const schedule = summary.getByRole('list', { name: 'Door and window schedule' });
  await expect(schedule.getByRole('listitem').first()).toBeVisible();
  const counted = (await schedule.locator('.fs-schedule-panel__count').allTextContents()).reduce((s, n) => s + Number(n.replace('×', '')), 0);
  const typed = HOUSE as { openings: Record<string, { fill?: string }>; types: Record<string, { kind: string }> };
  expect(counted).toBe(Object.values(typed.openings).filter((o) => ['doorType', 'windowType'].includes(typed.types[o.fill ?? '']?.kind ?? '')).length);
  await shoot(page, 'construction');
  await axe(page, '[aria-label="Inspector"]');
  await summary.getByRole('switch', { name: 'Room dimensions' }).click();
  await expect(page.locator('.fs-annotation [data-anno^="room:"]')).toHaveCount(0);
  await summary.getByRole('switch', { name: 'Room dimensions' }).click();
  await expect(page.locator('.fs-annotation [data-anno="room:R6:h"]')).toHaveCount(1);

  // ── The dimension tool: the den's south wall, corner to window to corner, placed inside the den.
  let at = await cameraOf(page);
  await page.keyboard.press('Shift+KeyD');
  await expect(page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Dimension', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.fs-anno-hint')).toContainText('click a junction');
  for (const p of [DEN_SW, DEN_WINDOW, DEN_SE]) {
    const q = at(p);
    await page.mouse.move(q.x, q.y);
    await page.mouse.click(q.x, q.y);
  }
  const inside = at([21_000_000, 2_000_000]);
  await page.mouse.move(inside.x, inside.y);
  await expect(page.locator('.fs-anno-draft .fs-anno-draft__text')).toHaveText([`3'-8 3/4"`, `12'-3 1/4"`]);
  await page.mouse.click(inside.x, inside.y);
  await settled(page);
  let doc = await docOf(page, project);
  expect(doc.extensionsUsed?.['FS_annotation']).toBe('0.1.0');
  const dm1 = doc.extensions?.FS_annotation?.dimensions?.['DM1'];
  expect(dm1).toBeDefined();
  expect(dm1!.level).toBe('L1');
  expect(dm1!.direction).toEqual([1, 0]);
  expect(dm1!.anchors).toEqual([{ junction: 'J16' }, { opening: 'O37' }, { junction: 'J8' }]);
  expect((await lastOps(page, project)).some((o) => o.op === 'setProperty' && o.path === '/extensions/FS_annotation/dimensions/DM1')).toBe(true);
  const dm1Text = page.locator('.fs-annotation [data-anno="DM1"] .fs-dim__text');
  await expect(dm1Text).toHaveText([`3'-8 3/4"`, `12'-3 1/4"`]);
  const card = page.getByTestId('annotation-card');
  await expect(card).toContainText('Dimension DM1');
  await expect(card).toContainText(`3'-8 3/4" · 12'-3 1/4"`);
  await shoot(page, 'dimension-tool');
  await axe(page, '[data-testid="annotation-card"]');

  // ── It stays with what it measures: the window a foot along its wall, and the string follows it.
  const moved = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: [{ op: 'moveOpening', opening: 'O37', by: FT }] } });
  expect(moved.status(), await moved.text()).toBe(201);
  await page.reload();
  await settled(page);
  await expect(dm1Text).toHaveCount(2);
  const after = (await dm1Text.allTextContents()).map((t) => lengthOf(t.trim())!);
  expect(after).toHaveLength(2);
  expect(Math.abs(after[0]! - (3 * FT + 8.75 * IN))).toBeCloseTo(FT, -1);
  expect(after[0]! + after[1]!).toBeCloseTo(16 * FT, -1);

  // ── The note tool: a leader from the den's middle, the text where it is let go.
  at = await cameraOf(page);
  await page.keyboard.press('Shift+KeyT');
  await expect(page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Note', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const tip = at([21_000_000, 4_500_000]);
  const text = at([22_500_000, 6_500_000]);
  await page.mouse.move(tip.x, tip.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(tip.x + ((text.x - tip.x) * k) / 8, tip.y + ((text.y - tip.y) * k) / 8);
  await page.mouse.up();
  const input = page.getByRole('dialog', { name: 'New note' });
  await expect(input).toBeVisible();
  await axe(page, '.fs-note-input');
  await input.getByRole('textbox').fill('Verify the header over the den doors');
  await page.keyboard.press('Enter');
  await settled(page);
  doc = await docOf(page, project);
  const nt1 = doc.extensions?.FS_annotation?.notes?.['NT1'];
  expect(nt1?.text).toBe('Verify the header over the den doors');
  expect(nt1?.leader).toHaveLength(2);
  const noteText = page.locator('.fs-annotation [data-anno="NT1"] .fs-anno__note');
  await expect(noteText).toHaveText('Verify the header over the den doors');
  await shoot(page, 'note');

  // ── Picked on the plan with the select tool, and deleted with ⌫.
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await noteText.click();
  await expect(page.getByTestId('annotation-card')).toContainText('Note NT1');
  await page.keyboard.press('Backspace');
  await settled(page);
  await expect(noteText).toHaveCount(0);
  doc = await docOf(page, project);
  expect(doc.extensions?.FS_annotation?.notes?.['NT1']).toBeUndefined();

  // ── The measure tool's "Keep as a dimension": junction to junction along the den's west wall.
  at = await cameraOf(page);
  await page.keyboard.press('Shift+KeyM');
  const a = at([17_946_624, 0]);
  const b = at([17_946_624, 8_583_168]);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('Enter');
  const keep = page.getByTestId('measure-panel').getByRole('button', { name: 'Keep as a dimension' });
  await expect(keep).toBeEnabled();
  await keep.click();
  await settled(page);
  doc = await docOf(page, project);
  const kept = doc.extensions?.FS_annotation?.dimensions?.['DM2'];
  expect(kept?.anchors).toEqual([{ junction: 'J16' }, { junction: 'J17' }]);
  await expect(page.locator('.fs-annotation [data-anno="DM2"] .fs-dim__text')).toHaveText(`22'-0"`);
  await shoot(page, 'kept');
});
