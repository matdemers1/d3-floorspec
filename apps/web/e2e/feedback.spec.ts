/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, password, settled } from './support.js';

/**
 * FLR-T-18.14: live feedback while editing, on the Courtyard House (the worker's fixture) imported as
 * a project — after the board's "18.14 · Clearance halos while dragging" and "History slider" frames.
 *
 * The kitchen framed, the island is dragged towards the counter of base cabinets: while it moves,
 * its working space and its neighbours' envelopes draw as halos — the island's clear at first, red
 * once its working space runs into the counter, with a card saying how much clear there is, what it
 * needs, and that releasing places it anyway (rules advise, never block: FLR-ADR-011). The frame
 * rate of the drag is measured, and the halos' own cost per frame. Let go, the island is placed
 * where it is; one undo takes it back.
 *
 * ⌥H opens the history and its scrubber. Scrubbed back one version, the plan is the island moved,
 * the island marked as moved since; Restore writes it back as one new op (the log only grows), and
 * Branch from an earlier version opens a changeset at it, main unmoved. axe passes on the halos'
 * card and legend and on the scrubber and its panel, in both themes. Screenshots land in
 * test-results/feedback-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ISLAND = 'KIT-ISLAND';

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/feedback-${name}-${theme}.png` });
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

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const positionOf = async (page: Page, project: string, id = ISLAND): Promise<number[]> => {
  const doc = (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as { extensions: { FS_furniture: { collections: Record<string, Record<string, { host: { position: number[] } }>> } } };
  return Object.values(doc.extensions.FS_furniture.collections).find((c) => id in c)![id]!.host.position;
};

const islandTone = (page: Page) => page.locator(`[data-testid="halos"] polygon[data-owner="${ISLAND}"]`).first().getAttribute('data-tone');

test('live feedback: clearance halos turn red as the island nears the counter, at interactive frame rates; the history scrubber back one version, restore and branch — axe in both themes', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Planner', email: 'planner@example.test', password: password('feedback') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  // ── The kitchen framed: picked in the tree, zoomed to (⇧2).
  await page.getByRole('treeitem', { name: /^Kitchen\b/ }).first().click();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit2');
  await still(page);
  await page.keyboard.press('Escape');

  // ── The island grabbed (the cooktop is set into its middle) and dragged towards the counter.
  const island = page.locator(`[data-furniture="${ISLAND}"]`);
  await expect(island).toBeVisible();
  const box = (await island.boundingBox())!;
  const counter = await centreOf(page, '[data-furniture="KIT-B5"]');
  // Along its length, clear of the cooktop at its middle: the item follows the pointer from there.
  const from = box.width > box.height ? { x: box.x + box.width * 0.12, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y + box.height * 0.12 };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const toward = { x: counter.x - centre.x, y: counter.y - centre.y };
  const length = Math.hypot(toward.x, toward.y);
  const unit = { x: toward.x / length, y: toward.y / length };
  const before = await positionOf(page, project);
  const cooktop = await positionOf(page, project, 'KIT-COOKTOP');
  const history = (await historyOf(page, project)).length;

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.evaluate(() => { (window as unknown as { __floorspecHalos?: unknown }).__floorspecHalos = undefined; });
  // A short way first: the halos show, the island's working space clear.
  for (let k = 1; k <= 3; k++) await page.mouse.move(from.x + unit.x * 4 * k, from.y + unit.y * 4 * k);
  await expect(page.getByTestId('halos')).toBeVisible();
  // FLR-T-18.18: grabbed off its middle, it does not jump there — it has moved as far as the pointer
  // (to the grid and the guides), and its cooktop moves with it, still in its middle.
  const dragged = page.locator(`[data-testid="halos"] .fs-halo-item[data-item="${ISLAND}"]`);
  await expect(dragged).toHaveCount(1);
  const now = (await dragged.boundingBox())!;
  const shift = { x: now.x + now.width / 2 - centre.x, y: now.y + now.height / 2 - centre.y };
  expect(Math.hypot(shift.x - unit.x * 12, shift.y - unit.y * 12)).toBeLessThan(10);
  const top = (await page.locator(`[data-testid="halos"] .fs-halo-item[data-item="KIT-COOKTOP"]`).boundingBox())!;
  expect(Math.abs(top.x + top.width / 2 - (now.x + now.width / 2))).toBeLessThan(Math.max(4, now.width / 4));
  expect(Math.abs(top.y + top.height / 2 - (now.y + now.height / 2))).toBeLessThan(Math.max(4, now.height / 4));
  await expect.poll(() => islandTone(page)).toBe('clear');
  await expect(page.locator('.fs-halo-legend')).toContainText('Tight (within 10 %)');
  // Neighbours' halos too: the counter's door clearances.
  await expect(page.locator('[data-testid="halos"] polygon[data-owner="KIT-B5"]')).toHaveCount(1);
  await shoot(page, 'halos-clear');

  // On towards the counter, measuring the drag's frame rate on the way, until the halo turns red.
  await page.evaluate(() => {
    const w = window as unknown as { __fps?: { frames: number; start: number; stop: boolean } };
    w.__fps = { frames: 0, start: performance.now(), stop: false };
    const tick = () => {
      if (w.__fps === undefined || w.__fps.stop) return;
      w.__fps.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  let red = false;
  let step: number;
  const t0 = Date.now();
  for (step = 4; step <= 120 && !red; step++) {
    await page.mouse.move(from.x + unit.x * 4 * step, from.y + unit.y * 4 * step);
    if (step % 4 === 0) red = (await islandTone(page)) === 'conflict';
  }
  const fps = await page.evaluate(() => {
    const w = window as unknown as { __fps: { frames: number; start: number; stop: boolean }; __floorspecHalos?: { frames: number; totalMs: number; maxMs: number } };
    w.__fps.stop = true;
    const seconds = (performance.now() - w.__fps.start) / 1000;
    const h = w.__floorspecHalos;
    return { fps: w.__fps.frames / seconds, haloFrames: h?.frames ?? 0, haloMeanMs: h === undefined ? 0 : h.totalMs / h.frames, haloMaxMs: h?.maxMs ?? 0 };
  });
  const updates = step - 4;
  console.log(`[feedback] drag: ${fps.fps.toFixed(1)} fps over ${String(updates)} pointer moves in ${String(Date.now() - t0)} ms; halos computed ${String(fps.haloFrames)} times, mean ${fps.haloMeanMs.toFixed(2)} ms, max ${fps.haloMaxMs.toFixed(2)} ms`);
  expect(red).toBe(true);
  // Interactive: a halo frame costs a small part of a 60 fps frame (16.7 ms). The drag's own rate is the
  // preview's — rigid since FLR-T-18.18 (the moving set moved, no apply or derive per frame; 45+ fps on
  // an M-series laptop) — reported, and held only to a floor a shared CI runner keeps.
  expect(fps.haloMeanMs).toBeLessThan(8);
  expect(fps.fps).toBeGreaterThan(5);

  // The card: the working space's clear distance, what it needs, the counter named; advisory.
  const card = page.getByTestId('halo-card');
  await expect(card).toHaveAttribute('data-tone', 'conflict');
  await expect(card).toContainText(/Working space .+ — needs 3'-3/);
  await expect(card).toContainText(/Between the kitchen island and the /);
  await expect(card).toContainText('Release to place it anyway');
  await expect(card).not.toContainText(/complian/i);
  await expect(page.getByTestId('halo-chip')).toBeVisible();
  await shoot(page, 'halos-conflict');
  await axe(page, '.fs-halo-card');
  await axe(page, '.fs-halo-legend');

  // ── Let go: placed where it is (halos advise, they never block) — one op; the halos go.
  await page.mouse.up();
  await settled(page);
  await expect(page.getByTestId('halos')).toHaveCount(0);
  const moved = await positionOf(page, project);
  expect(moved).not.toEqual(before);
  // The cooktop set into it went with it, by as much, in the same op (FLR-T-18.18).
  expect(await positionOf(page, project, 'KIT-COOKTOP')).toEqual([cooktop[0]! + moved[0]! - before[0]!, cooktop[1]! + moved[1]! - before[1]!]);
  expect((await historyOf(page, project)).length - history).toBe(1);
  await shoot(page, 'island-placed');

  // ── ⌥H: the history and its scrubber, at now.
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Alt+KeyH');
  const scrubber = page.getByRole('region', { name: 'History scrubber' });
  await expect(scrubber).toBeVisible();
  const slider = scrubber.getByRole('slider', { name: 'Version' });
  await expect(slider).toHaveAttribute('aria-valuetext', /, now$/);
  await expect(scrubber.getByRole('button', { name: /^Restore v/ })).toBeDisabled();

  // Scrubbed back one version: the plan before the move — the island marked as moved since.
  const log = await historyOf(page, project);
  const previous = log[1]!;
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`^v${String(previous.seq)}: `));
  // The island, and what sits on it: its cooktop, the gas cooktop on its top, the fruit bowl.
  await expect(page.getByTestId('scrubber-counts')).toHaveText(`0 added · 0 removed · 4 moved since v${String(previous.seq)}`);
  await expect(page.locator(`[data-testid="diffs"] .fs-diff--moved`).first()).toBeVisible();
  const panel = page.getByRole('group', { name: 'Changes since a version' });
  await expect(panel.getByRole('heading', { name: new RegExp(`^v${String(previous.seq)} → v${String(log[0]!.seq)}$`) })).toBeVisible();
  await expect(panel.getByTestId('changes-since')).toContainText(/Moved kitchen island \d+'-/);
  // The plan drawn is that version: the island where it was.
  const was = (await island.boundingBox())!;
  expect(Math.abs(was.x - box.x) + Math.abs(was.y - box.y)).toBeLessThan(4);
  await shoot(page, 'scrubbed-back');
  await axe(page, '[aria-label="History scrubber"]');
  await axe(page, '[aria-label="Changes since a version"]');

  // ── Restore: one new op, main at exactly that version; the log only grows.
  await scrubber.getByRole('button', { name: `Restore v${String(previous.seq)}` }).click();
  await settled(page);
  await expect.poll(() => positionOf(page, project)).toEqual(before);
  const after = await historyOf(page, project);
  expect(after.length).toBe(log.length + 1);
  expect(after[0]!.after).toBe(previous.after);
  await expect(page.getByRole('listbox', { name: 'Versions, newest first' })).toContainText(`Returned the plan to v${String(previous.seq)}`);
  await expect(slider).toHaveAttribute('aria-valuetext', /, now$/);
  await shoot(page, 'restored');

  // ── Branch from the version with the island moved: a changeset at it, main unmoved.
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`^v${String(log[0]!.seq)}: `));
  await scrubber.getByRole('button', { name: `Branch from v${String(log[0]!.seq)}` }).click();
  await expect(page.getByText(/Branched “From v\d+”/).first()).toBeVisible();
  const changesets = (await (await page.request.get(`/api/projects/${project}/changesets`)).json()) as { changesets: { name: string; head: string | null }[] };
  const branch = changesets.changesets.find((c) => c.name === `From v${String(log[0]!.seq)}`)!;
  expect(branch.head).toBe(log[0]!.after);
  expect(await positionOf(page, project)).toEqual(before);
  await shoot(page, 'branched');
});
