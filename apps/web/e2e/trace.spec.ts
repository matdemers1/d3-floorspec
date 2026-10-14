/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { OFFICIAL_READER } from '@floorspec/engine';
import { renderPlan } from '@floorspec/render2d';
import { count, firstRunSetup, FT, IN, modelOf, password, projectIn, settled, type Doc } from './support.js';

/**
 * FLR-T-18.12: trace and reference. The Courtyard House's main floor, rendered by the server as a
 * blueprint PNG, is the drawing a homeowner starts from: imported as the underlay of Level 1 of a
 * blank project. Its scale is set from two clicks on the drawing — the guest bedroom's south wall,
 * 22 ft between its corners — and the typed 22'; it is moved by a point, its south-west corner
 * clicked and then the plan point it goes to. Then the bedroom is traced: four walls clicked on the
 * drawing's corners, which land — on a 6" grid — exactly where the Courtyard House has them,
 * shifted by the move. Opacity, a turn and back, the lock, Ghost and Off; the underlay kept across
 * a reload. On Level 2 the reference shows Level 1 below in its ghost colour: a wall drawn there
 * snaps to the corners of Level 1's walls ("Wall corner on Level 1"), and a click on Level 1's walls
 * selects nothing. Finally the underlay is replaced by page 2 of a two-page PDF, rasterised in the
 * browser, kept as wide on the plan as before. axe on the Layers drawer's trace section, the
 * set-scale field and the reference in both themes. Screenshots land in test-results/trace-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** render2d's default scale: 24 px a foot, at the SVG's own size (the PNG with no `width`). */
const PX_PER_FT = 24;

interface Stored {
  sha256: string;
  name: string | null;
  width: number;
  height: number;
  origin: [number, number];
  scale: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  state: string;
  page?: number;
}

/** The underlay of a level, as the editor keeps it: view data, in this browser. */
async function storedOf(page: Page, project: string, level: string): Promise<Stored | undefined> {
  return page.evaluate(
    ([p, l]) => {
      const raw = localStorage.getItem(`floorspec.underlay.${p}`);
      return raw === null ? undefined : (JSON.parse(raw) as { levels: Record<string, Stored> }).levels[l];
    },
    [project, level] as const,
  );
}

/** Image pixel → plan, as the editor places it (transform.ts), for a turn of 0. */
const toPlan = (u: Stored, ix: number, iy: number): [number, number] => [u.origin[0] + ix * u.scale, u.origin[1] - iy * u.scale];

/** The plan canvas: where a world point (base units) is on the page — an empty level framed 40 × 28 ft about the origin (viewport.ts `fit`). */
interface Camera {
  at: (x: number, y: number) => { x: number; y: number };
}

function feetOf(m: RegExpMatchArray): number {
  const [, sign, feet, inches, num, den] = m;
  const value = Number(feet) * FT + Number(inches) * (FT / 12) + (num === undefined ? 0 : (Number(num) / Number(den)) * (FT / 12));
  return sign === '-' ? -value : value;
}

async function cameraOf(page: Page, svg: Locator): Promise<Camera> {
  const box = (await svg.boundingBox())!;
  const s = Math.min((box.width - 144) / (40 * FT), (box.height - 144) / (28 * FT));
  const camera: Camera = { at: (x, y) => ({ x: box.x + box.width / 2 + x * s, y: box.y + box.height / 2 - y * s }) };
  const probe = camera.at(-10 * FT, -6 * FT);
  await page.mouse.move(probe.x, probe.y);
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [x, y] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map(feetOf);
      return x !== undefined && y !== undefined && Math.abs(x + 10 * FT) <= FT / 12 && Math.abs(y + 6 * FT) <= FT / 12;
    })
    .toBe(true);
  return camera;
}

async function clickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/trace-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // Past the theme's colour transitions: axe reads the colours as they end, not as they pass.
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test('trace and reference: a rendered plan imported as an underlay, its scale set, moved, a room traced on it exactly; opacity, turn, lock, ghost, off, kept; the level below as a reference snapped to and never picked; a PDF page — axe in both themes', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync('test-results', { recursive: true });
  await firstRunSetup(page, { name: 'Tracer', email: 'tracer@example.test', password: password('trace') });

  // ── The drawing: the Courtyard House's main floor as the server renders it, a blueprint. Where its
  // pixels are on the house is read from the same render in Node: the blueprint grid's pattern is
  // anchored at the plan's origin, at 24 px a foot.
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const courtyard = ((await imported.json()) as { id: string }).id;
  const rendered = await page.request.get(`/api/projects/${courtyard}/render?level=L1&style=blueprint`);
  expect(rendered.status(), await rendered.text()).toBe(200);
  const png = await rendered.body();
  writeFileSync('test-results/trace-underlay-source.png', png);
  const svgText = renderPlan(HOUSE, { level: 'L1', style: 'blueprint', reader: OFFICIAL_READER });
  expect(svgText).toContain(`${String(PX_PER_FT)} px = 1' 0"`);
  const W = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svgText)![1]);
  const H = Number(/<svg[^>]*\sheight="(\d+)"/.exec(svgText)![1]);
  expect(pngSize(png)).toEqual({ width: W, height: H });
  const anchor = /id="fs-grid"[^>]*patternTransform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(svgText)!;
  const [X0, Y0] = [Number(anchor[1]), Number(anchor[2])];
  /** The drawing's pixel of a Courtyard House point, in feet. */
  const px = (x: number, y: number): [number, number] => [X0 + x * PX_PER_FT, Y0 - y * PX_PER_FT];

  // ── A blank project, Level 1, snapping on a 6" grid.
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill('Traced house');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  await page.getByRole('button', { name: 'Open editor' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor$`));
  await page.getByRole('button', { name: 'Add Level 1' }).click();
  const levelPicker = page.getByRole('combobox', { name: 'Level', exact: true });
  await expect(levelPicker).toContainText('Level 1');
  await settled(page);
  const L1 = Object.keys((await modelOf(page, project)).levels ?? {})[0]!;
  const canvas = page.getByRole('application', { name: /^Plan of / });
  const camera = await cameraOf(page, canvas);

  await page.locator('.fs-snapstatus__button').click();
  const snapMenu = page.getByRole('dialog', { name: 'Snapping' });
  await snapMenu.getByRole('combobox', { name: 'Grid step' }).click();
  await page.getByRole('option', { name: '6"', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(snapMenu).toBeHidden();
  await expect(page.locator('.fs-snapstatus__button')).toContainText('grid 6"');

  // ── Import: the Layers drawer's "Import a plan to trace…", a PNG.
  const trace = page.locator('.fs-trace');
  await trace.scrollIntoViewIfNeeded();
  await expect(trace.getByText(`None on Level 1`)).toBeVisible();
  await axe(page, '.fs-trace');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trace.getByRole('button', { name: 'Import a plan to trace…' }).click()]);
  const loaded = page.waitForResponse((r) => r.url().includes(`/api/projects/${project}/assets/`) && r.request().method() === 'GET');
  await chooser.setFiles({ name: 'courtyard-main-floor.png', mimeType: 'image/png', buffer: png });
  const image = canvas.locator(`image[data-underlay="${L1}"]`);
  await expect(image).toHaveCount(1);
  expect((await loaded).status()).toBe(200);
  await expect(trace.getByTestId('underlay-size')).toContainText(`${String(W)} × ${String(H)} px`);
  await expect(trace.getByRole('radiogroup', { name: 'Underlay layer' }).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
  const first = (await storedOf(page, project, L1))!;
  expect(first.name).toBe('courtyard-main-floor.png');
  expect(first.state).toBe('on');
  await shoot(page, 'imported');
  await axe(page, '.fs-trace');

  /** Where a pixel of the drawing is on the page (unturned: its box is its frame). */
  const onImage = async (p: [number, number]) => {
    const b = (await image.boundingBox())!;
    return { x: b.x + (p[0] * b.width) / W, y: b.y + (p[1] * b.height) / H };
  };

  // ── Set scale: the bedroom's south wall, J1 (0, 0) to J10 (22 ft, 0), is 22'.
  await trace.getByRole('button', { name: 'Set scale' }).click();
  const prompt = page.locator('.fs-underlay-prompt');
  await expect(prompt).toContainText('click the start of a length you know');
  await clickAt(page, await onImage(px(0, 0)));
  await expect(prompt).toContainText('click the end of that length');
  await clickAt(page, await onImage(px(22, 0)));
  const length = page.getByLabel('Length between the points');
  await expect(length).toBeFocused();
  await expect(prompt).toContainText('type the length');
  await shoot(page, 'set-scale');
  await axe(page, '.fs-underlay-length');
  await axe(page, '.fs-underlay-prompt');
  // Nonsense is refused in place; the length is taken.
  await length.fill('wide');
  await length.press('Enter');
  await expect(page.locator('.fs-underlay-length__hint')).toContainText('Not a length');
  await length.fill(`22'`);
  await length.press('Enter');
  await expect(prompt).toHaveCount(0);
  const scaled = (await storedOf(page, project, L1))!;
  // 22 ft between two clicks a pixel or so either way: the drawing's own 24 px a foot, within 1%.
  expect(Math.abs(scaled.scale - FT / PX_PER_FT) / (FT / PX_PER_FT)).toBeLessThan(0.01);

  // ── Move: the drawing's J1 to the plan's (−11 ft, −7 ft) — the second click snaps (to the 6" grid here).
  await trace.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(prompt).toContainText('click a point on the drawing');
  await clickAt(page, await onImage(px(0, 0)));
  await expect(prompt).toContainText('click where that point goes');
  await clickAt(page, camera.at(-11 * FT, -7 * FT));
  await expect(prompt).toHaveCount(0);
  const moved = (await storedOf(page, project, L1))!;
  const corner = toPlan(moved, ...px(0, 0));
  expect(Math.abs(corner[0] + 11 * FT)).toBeLessThan(IN);
  expect(Math.abs(corner[1] + 7 * FT)).toBeLessThan(IN);
  await shoot(page, 'moved');

  // ── Trace the guest bedroom: its four corners clicked on the drawing, closing on the first.
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  for (const [x, y] of [[0, 0], [22, 0], [22, 14], [0, 14], [0, 0]] as const) await clickAt(page, await onImage(px(x, y)));
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);
  await page.keyboard.press('Escape');
  const traced = await modelOf(page, project);
  const corners = Object.values(traced.junctions ?? {}).map((j) => j.position).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Exactly the Courtyard House's corners, less the move: the drawing traced at its true size.
  expect(corners).toEqual([[-11 * FT, -7 * FT], [-11 * FT, 7 * FT], [11 * FT, -7 * FT], [11 * FT, 7 * FT]]);
  await shoot(page, 'traced');

  // ── Opacity, a turn and back, the lock.
  const opacity = trace.getByLabel('Opacity');
  await opacity.focus();
  await opacity.press('ArrowLeft');
  await opacity.press('ArrowLeft');
  await expect(image).toHaveAttribute('opacity', '0.5');
  const rotation = trace.getByLabel('Rotation');
  await rotation.fill('90');
  await rotation.press('Enter');
  await expect.poll(async () => (await storedOf(page, project, L1))?.rotation).toBe(90);
  await shoot(page, 'turned');
  await trace.getByLabel('Rotation').fill('0');
  await trace.getByLabel('Rotation').press('Enter');
  await expect.poll(async () => (await storedOf(page, project, L1))?.rotation).toBe(0);
  const back = (await storedOf(page, project, L1))!;
  expect(Math.hypot(back.origin[0] - moved.origin[0], back.origin[1] - moved.origin[1])).toBeLessThan(1);
  const lock = trace.getByRole('switch', { name: 'Lock the underlay' });
  await lock.click();
  await expect(lock).toBeChecked();
  await expect(trace.getByRole('button', { name: 'Set scale' })).toBeDisabled();
  await expect(trace.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
  await expect(trace.getByLabel('Rotation')).toBeDisabled();
  expect((await storedOf(page, project, L1))!.locked).toBe(true);

  // ── Ghost and Off, from the Layers drawer.
  const underlayLayer = trace.getByRole('radiogroup', { name: 'Underlay layer' });
  await underlayLayer.getByRole('radio', { name: 'Ghost' }).click();
  await expect(canvas.locator('.fs-underlay[data-state="ghost"]')).toHaveCount(1);
  await expect(image).toHaveAttribute('opacity', '0.225');
  await underlayLayer.getByRole('radio', { name: 'Off' }).click();
  await expect(image).toHaveCount(0);
  await underlayLayer.getByRole('radio', { name: 'On' }).click();
  await expect(image).toHaveCount(1);

  // ── Kept: a reload brings it back as it was, the file from the project's assets.
  const before = (await storedOf(page, project, L1))!;
  const again = page.waitForResponse((r) => r.url().includes(`/api/projects/${project}/assets/${before.sha256}`));
  await page.reload();
  await settled(page);
  expect([200, 304]).toContain((await again).status());
  await expect(image).toHaveCount(1);
  expect(await storedOf(page, project, L1)).toEqual(before);
  await expect(trace.getByRole('switch', { name: 'Lock the underlay' })).toBeChecked();
  await trace.getByRole('switch', { name: 'Lock the underlay' }).click();

  // ── The reference: Level 2 above, Level 1 below drawn in the ghost colour.
  await page.getByRole('button', { name: 'Add a level' }).click();
  await expect.poll(async () => count((await modelOf(page, project)).levels)).toBe(2);
  await settled(page);
  if (!((await levelPicker.textContent()) ?? '').includes('Level 2')) {
    await levelPicker.click();
    await page.getByRole('option', { name: /Level 2/ }).click();
  }
  await expect(levelPicker).toContainText('Level 2');
  const L2 = Object.keys((await modelOf(page, project)).levels ?? {}).find((id) => id !== L1)!;
  await expect(canvas.locator('.fs-reference')).toHaveCount(0);
  await expect(trace.getByText('None on Level 2')).toBeVisible();
  const referenceRow = trace.getByRole('radiogroup', { name: 'Reference level' });
  await expect(referenceRow.getByRole('radio', { name: 'Above' })).toBeDisabled();
  await referenceRow.getByRole('radio', { name: 'Below' }).click();
  const reference = canvas.locator(`.fs-reference[data-level="${L1}"]`);
  await expect(reference).toHaveCount(1);
  await expect(reference.locator('.fs-reference__walls polygon:not(.fs-reference__fill)')).toHaveCount(4);
  expect(await reference.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await expect(trace).toContainText('Level 1 drawn for reference');
  const view2 = await cameraOf(page, canvas);
  await shoot(page, 'reference');
  await axe(page, '.fs-trace');

  // Never picked: a click on Level 1's north wall, with the select tool, selects nothing.
  await rail.getByRole('button', { name: 'Select', exact: true }).click();
  await clickAt(page, view2.at(0, 7 * FT));
  await page.waitForTimeout(300);
  await expect(page.locator('.fs-tree__row.is-selected')).toHaveCount(0);

  // Snapped to: a wall along the outside face of Level 1's south wall, from corner to corner.
  const wall = Object.values(traced.walls ?? {})[0] as unknown as { type?: string; thickness?: number };
  const type = (traced.types ?? {})[wall.type ?? ''] as unknown as { layers?: { thickness: number }[]; thickness?: number } | undefined;
  const t = wall.thickness ?? type?.thickness ?? (type?.layers ?? []).reduce((sum, l) => sum + l.thickness, 0);
  expect(t).toBeGreaterThan(0);
  const sw: [number, number] = [Math.round(-11 * FT - t / 2), Math.round(-7 * FT - t / 2)];
  const se: [number, number] = [Math.round(11 * FT + t / 2), Math.round(-7 * FT - t / 2)];
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  const tag = page.locator('.fs-guidetag');
  const near = (p: [number, number]) => { const q = view2.at(p[0], p[1]); return { x: q.x + 1, y: q.y + 1 }; };
  await page.mouse.move(near(sw).x - 6, near(sw).y);
  await page.mouse.move(near(sw).x, near(sw).y, { steps: 3 });
  // The first point of a wall shows no tag until it is placed; the second's does.
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(near(se).x - 6, near(se).y, { steps: 3 });
  await page.mouse.move(near(se).x, near(se).y, { steps: 2 });
  await expect(tag).toHaveText('Wall corner on Level 1');
  await shoot(page, 'reference-snap');
  await page.mouse.down();
  await page.mouse.up();
  // An open chain is applied when it is finished.
  await page.keyboard.press('Escape');
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(5);
  await settled(page);
  const upper = await modelOf(page, project);
  const ends = Object.values(upper.junctions ?? {}).filter((j) => j.level === L2).map((j) => j.position).sort((a, b) => a[0] - b[0]);
  expect(ends).toEqual([sw, se]);
  // Off the 6" grid: the reference, not the grid, put them there.
  expect(sw[0] % (6 * IN)).not.toBe(0);

  // ── A PDF: page 2 of two, drawn in the browser, in place of the PNG on Level 1 — as wide as before.
  const printer = await page.context().newPage();
  const data = `data:image/png;base64,${png.toString('base64')}`;
  await printer.setContent(`<!doctype html><style>@page{size:${String(W)}px ${String(H)}px;margin:0}html,body{margin:0}img{display:block;width:${String(W)}px;height:${String(H)}px}.next{break-before:page}</style><img src="${data}"><img class="next" src="${data}">`);
  await printer.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const pdf = await printer.pdf({ width: `${String(W)}px`, height: `${String(H)}px`, printBackground: true });
  await printer.close();
  writeFileSync('test-results/trace-underlay-source.pdf', pdf);
  await levelPicker.click();
  await page.getByRole('option', { name: /Level 1/ }).click();
  await expect(levelPicker).toContainText('Level 1');
  const kept = (await storedOf(page, project, L1))!;
  const [pdfChooser] = await Promise.all([page.waitForEvent('filechooser'), trace.getByRole('button', { name: 'Replace…' }).click()]);
  await pdfChooser.setFiles({ name: 'courtyard-listing.pdf', mimeType: 'application/pdf', buffer: pdf });
  const pages = trace.getByRole('group', { name: 'Choose the PDF’s page' });
  await expect(pages).toContainText('courtyard-listing.pdf has 2 pages.');
  await axe(page, '.fs-trace');
  await pages.getByRole('combobox', { name: 'Page' }).click();
  await page.getByRole('option', { name: 'Page 2' }).click();
  await pages.getByRole('button', { name: 'Import page 2' }).click();
  await expect(pages).toHaveCount(0);
  await expect(trace.getByText('courtyard-listing — page 2.png')).toBeVisible();
  const fromPdf = (await storedOf(page, project, L1))!;
  expect(fromPdf.page).toBe(2);
  expect(fromPdf.sha256).not.toBe(kept.sha256);
  expect(Math.max(fromPdf.width, fromPdf.height)).toBe(3300);
  // The same width on the plan, the same corner, the same turn: still calibrated.
  expect(Math.abs(fromPdf.width * fromPdf.scale - kept.width * kept.scale)).toBeLessThan(1);
  expect(fromPdf.origin).toEqual(kept.origin);
  await expect(image).toHaveCount(1);
  await page.waitForTimeout(500);
  await shoot(page, 'pdf');
  const doc: Doc = await modelOf(page, project);
  // Nothing of the underlay is in the house: no asset, no extension — view data only.
  expect(JSON.stringify(doc)).not.toContain(fromPdf.sha256);
});
