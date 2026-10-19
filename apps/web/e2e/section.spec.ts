/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-14.6: cut the house anywhere, and lift the floors apart — the board's frames "14.6 · Section
 * box" and "14.6 · Exploded axonometric" on the Courtyard House.
 *
 * The Section box on the Experiences cluster (and X) opens the Section panel and cuts the house with a
 * box at the current level: every material of the house clipped by six planes, the cut faces capped —
 * the caps' pixels found by drawing them once in a colour of their own — and the outside ghosted. The
 * south face (or another the panel leaves clear) is dragged in by its handle, then nudged by the keys (← a 3″
 * module in, ⇧→ four out), its value
 * said as the tag says it; the caps switched off and on; the single plane; a PNG still. The exploded
 * view, from the Section panel: an orthographic camera, the upper floor and the roofs lifted apart,
 * eased, with a leader label on each; Space brings them together and apart again — at once under
 * reduced motion; an SVG still with its labels as text. axe passes on both panels in both themes.
 * Screenshots land in test-results/section-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Box = { min: [number, number, number]; max: [number, number, number] };
type Hook = {
  __floorspec3d?: {
    ready: boolean;
    section: { mode: string; box: Box | null; plane: { face: string; at: number } | null; clipped: number; planes: number; caps: string[]; ghosts: number };
    capCoverage(): number;
    explode: { active: boolean; progress: number; camera: 'orthographic' | 'perspective' | null; lifts: Record<string, number> };
  };
};

const section = (page: Page) => page.evaluate(() => (window as unknown as Hook).__floorspec3d!.section);
const explode = (page: Page) => page.evaluate(() => (window as unknown as Hook).__floorspec3d!.explode);
const coverage = (page: Page) => page.evaluate(() => (window as unknown as Hook).__floorspec3d!.capCoverage());

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/section-${name}-${theme}.png` });
  }
}

async function axe(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

test('the section box and the exploded axonometric: a capped, hatched cut dragged and nudged, a plane, stills, the levels lifted apart and back — axe in both themes', async ({ page }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, { name: 'Sectioner', email: 'section@example.test', password: password('section') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  // The whole house, so the box is what cuts it.
  await page.getByRole('combobox', { name: 'Levels in 3D' }).click();
  await page.getByRole('option', { name: /^Whole house/ }).click();
  await page.waitForTimeout(500);
  expect((await section(page)).mode).toBe('off');

  // ── The Section box: the panel, six planes on every material of the house, the cut capped and the outside ghosted.
  const cluster = page.getByRole('toolbar', { name: 'Experiences' });
  await cluster.getByRole('button', { name: 'Section box' }).click();
  const panel = page.getByRole('region', { name: 'Section' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Box', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await section(page)).planes).toBe(6);
  const opened = await section(page);
  expect(opened.mode).toBe('box');
  expect(opened.clipped).toBeGreaterThan(5);
  // At the main floor's band: its top cuts every wall, and its sides stand off the house.
  expect(opened.caps).toEqual(['top']);
  expect(opened.ghosts).toBeGreaterThan(0);
  await expect(panel.getByText(/\(Main floor\)/)).toBeVisible();
  await expect.poll(() => coverage(page)).toBeGreaterThan(0.001);

  // ── A face dragged in by its handle — the first of the faces the camera sees whose handle the panel leaves clear —
  // the way in on screen read from a nudge of the face.
  const faceOf = { west: 'West', south: 'South', top: 'Top' } as const;
  let chosen: keyof typeof faceOf = 'south';
  for (const f of ['south', 'west', 'top'] as const) {
    const h = page.getByRole('slider', { name: `${faceOf[f]} face of the section box` });
    const clear = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[role="slider"]') === el;
    });
    if (clear) {
      chosen = f;
      break;
    }
  }
  const axis = chosen === 'top' ? 2 : chosen === 'south' ? 1 : 0;
  // Each face's "in": up the y and x axes for the south and west faces, down for the top.
  const inward = chosen === 'top' ? -1 : 1;
  const coord = (b: Box) => (chosen === 'top' ? b.max[axis] : b.min[axis]);
  const faceHandle = page.getByRole('slider', { name: `${faceOf[chosen]} face of the section box` });
  const before = opened.box!;
  const centreOf = async () => {
    const b = (await faceHandle.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  await faceHandle.focus();
  const from = await centreOf();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => inward * (coord((await section(page)).box!) - coord(before))).toBeGreaterThan(0);
  // The handle follows once the frame is drawn (SwiftShader takes its time).
  await expect.poll(async () => {
    const c = await centreOf();
    return Math.hypot(c.x - from.x, c.y - from.y);
  }, { timeout: 20_000 }).toBeGreaterThan(1);
  const to = await centreOf();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => coord((await section(page)).box!)).toBeCloseTo(coord(before), 6);
  await expect.poll(async () => {
    const c = await centreOf();
    return Math.hypot(c.x - from.x, c.y - from.y);
  }, { timeout: 20_000 }).toBeLessThan(1);
  const norm = Math.hypot(to.x - from.x, to.y - from.y);
  const way = { x: (to.x - from.x) / norm, y: (to.y - from.y) / norm };
  const centre = await centreOf();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(centre.x + way.x * i * 16, centre.y + way.y * i * 16);
  await page.mouse.up();
  await expect.poll(async () => inward * (coord((await section(page)).box!) - coord(before))).toBeGreaterThan(0.5);
  const dragged = (await section(page)).box!;
  // Now the face cuts through the house further in, capped.
  await expect.poll(async () => (await section(page)).caps).toEqual(chosen === 'top' ? ['top'] : [chosen, 'top'].sort());
  await expect(faceHandle).toHaveAttribute('aria-valuetext', chosen === 'top' ? /above/ : chosen === 'south' ? /from S wall$/ : /from W wall$/);
  await shoot(page, 'box');
  await axe(page, 'the section panel and its handles');

  // ── By the keys: ← a 3″ module in, ⇧→ four out.
  await faceHandle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => coord((await section(page)).box!)).toBeCloseTo(coord(dragged) + inward * 0.0762, 6);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => coord((await section(page)).box!)).toBeCloseTo(coord(dragged) + inward * (0.0762 - 4 * 0.0762), 6);
  await expect(page.locator('.fs-section__tag')).toContainText(chosen === 'top' ? 'above' : 'wall');
  await page.keyboard.press('Escape');
  await expect(page.locator('.fs-three__gl')).toBeFocused();

  // ── Uncapped, the cut is seen into; capped again, hatched.
  await panel.getByRole('switch', { name: 'Cap cut faces' }).click();
  await expect.poll(async () => (await section(page)).caps).toEqual([]);
  expect(await coverage(page)).toBe(0);
  await panel.getByRole('switch', { name: 'Cap cut faces' }).click();
  await expect.poll(() => coverage(page)).toBeGreaterThan(0.001);

  // ── Fit to selection: the kitchen picked in the tree, the box around it and up its level.
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).first().click();
  await panel.getByRole('button', { name: 'Fit to selection' }).click();
  await expect.poll(async () => {
    const b = (await section(page)).box!;
    return (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]);
  }).toBeLessThan(80);
  await expect.poll(() => coverage(page)).toBeGreaterThan(0.0001);
  await shoot(page, 'kitchen');

  // ── A PNG still of the view as drawn.
  await panel.getByRole('button', { name: 'Export still…' }).click();
  const png = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'PNG image' }).click();
  const pngFile = await png;
  expect(pngFile.suggestedFilename()).toBe('Courtyard House — section.png');
  const pngPath = 'test-results/section-still.png';
  await pngFile.saveAs(pngPath);
  const pngBytes = readFileSync(pngPath);
  expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
  expect(pngBytes.length).toBeGreaterThan(20_000);

  // ── The single plane: one plane, cutting away the side the camera looks from.
  await panel.getByRole('button', { name: 'Plane', exact: true }).click();
  await expect.poll(async () => (await section(page)).planes).toBe(1);
  const plane = (await section(page)).plane!;
  expect(['south', 'west']).toContain(plane.face);
  await expect.poll(async () => (await section(page)).caps).toEqual([plane.face]);
  const handle = page.getByRole('slider', { name: /^Section plane/ });
  await handle.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await section(page)).plane!.at).not.toBeCloseTo(plane.at, 3);
  await shoot(page, 'plane');
  await panel.getByRole('button', { name: 'Box', exact: true }).click();
  await expect.poll(async () => (await section(page)).planes).toBe(6);

  // ── The exploded view: orthographic, the upper floor and the roofs lifted apart, a leader label on each.
  await panel.getByRole('button', { name: 'Exploded view' }).click();
  const exploded = page.getByRole('region', { name: 'Exploded view' });
  await expect(exploded).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(cluster.getByRole('button', { name: 'Exploded view' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await explode(page)).camera).toBe('orthographic');
  await expect.poll(async () => (await explode(page)).progress, { timeout: 15_000 }).toBe(1);
  const apart = await explode(page);
  expect(apart.lifts['level:L1']).toBe(0);
  expect(apart.lifts['level:L2']).toBeGreaterThan(2);
  expect(Math.max(...Object.entries(apart.lifts).filter(([k]) => k.startsWith('roof:')).map(([, v]) => v))).toBeGreaterThan(apart.lifts['level:L2']!);
  // Cut by nothing unless asked: the whole house, lifted.
  expect((await section(page)).planes).toBe(0);
  await expect(page.locator('.fs-explode__pin')).toHaveCount(Object.keys(apart.lifts).length);
  const titles = page.locator('.fs-explode__title');
  await expect(titles.getByText('Main floor', { exact: true })).toBeVisible();
  await expect(titles.getByText('Upper floor', { exact: true })).toBeVisible();
  await expect(page.locator('.fs-explode__plumb').first()).toBeAttached();
  await shoot(page, 'exploded');
  await axe(page, 'the exploded view');

  // Only what the section box keeps: its upright planes, the main floor alone.
  await exploded.getByRole('switch', { name: 'Only what the section box keeps' }).click();
  await expect.poll(async () => (await section(page)).planes).toBe(4);
  await expect(titles.getByText('Upper floor', { exact: true })).toHaveCount(0);
  await shoot(page, 'exploded-kept');
  await exploded.getByRole('switch', { name: 'Only what the section box keeps' }).click();
  await expect.poll(async () => (await section(page)).planes).toBe(0);

  // Space: together, eased (half way along at some point), and apart again.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await explode(page)).progress, { timeout: 15_000 }).toBe(0);
  expect((await explode(page)).active).toBe(true);
  // Under reduced motion, at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  // The first frame drawn after it is already apart: no step in between.
  const seen: number[] = [];
  await expect.poll(async () => {
    seen.push((await explode(page)).progress);
    return seen[seen.length - 1];
  }, { intervals: [20], timeout: 10_000 }).toBe(1);
  expect(seen.filter((p) => p > 0 && p < 1)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ── An SVG still: the picture, transparent, and its labels as text.
  await exploded.getByRole('button', { name: 'Export still…' }).click();
  const svg = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /^SVG/ }).click();
  const svgFile = await svg;
  expect(svgFile.suggestedFilename()).toBe('Courtyard House — exploded axonometric.svg');
  const svgPath = 'test-results/section-exploded.svg';
  await svgFile.saveAs(svgPath);
  const text = readFileSync(svgPath, 'utf8');
  expect(text).toContain('<svg');
  expect(text).toContain('data:image/png;base64,');
  expect(text).toContain('>Main floor</text>');
  expect(text).toContain('>Upper floor</text>');

  // ── Closed: the levels come down, then the view's own camera is back.
  await exploded.getByRole('button', { name: 'Close the exploded view' }).click();
  await expect(exploded).toBeHidden();
  await expect.poll(async () => (await explode(page)).active, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await explode(page)).camera).toBe('perspective');
  await expect.poll(async () => (await section(page)).planes).toBe(6);

  // X opens and closes the Section panel from the view.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('x');
  await expect(panel).toBeVisible();
  await page.keyboard.press('x');
  await expect(panel).toBeHidden();
  // Off: nothing is cut.
  await page.keyboard.press('x');
  await panel.getByRole('button', { name: 'Off', exact: true }).click();
  await expect.poll(async () => (await section(page)).planes).toBe(0);
  expect((await section(page)).clipped).toBe(0);
});
