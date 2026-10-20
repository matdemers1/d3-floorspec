/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-14.5: X-ray — the board's frames "14.5 · X-ray — inside the kitchen wall (framing, insulation,
 * plumbing, wiring, ducts)" and its light theme, on the Courtyard House.
 *
 * The house (the worker's fixture) with a furnace in the garage feeding a supply register in the
 * kitchen's ceiling and a return grille in the mudroom's floor, so every system has something to
 * draw. X-ray from the Experiences cluster: the finishes faded to 70 % and every system drawn — studs,
 * batts, supply, drains and vents, circuits, ducts — each counted in its row; each system switched off
 * (nothing of it drawn) and on again; ⌥X off and on; Fade finishes to 100 % from the keyboard. The
 * kitchen's north wall (W24): its studs, the sink's and the
 * dishwasher's supply, drain and vent, and the kitchen's receptacle circuits in it; chosen in the tree,
 * the inspector's layers to scale and the callouts over the view. "Section box here" cuts into it with FLR-T-14.6's box: the systems clipped by its
 * planes. axe in both themes; screenshots of the kitchen wall in both themes land in test-results/xray-*.png
 * (and in $XRAY_SHOTS when it is set).
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as {
  extensions: Record<string, { collections?: Record<string, Record<string, unknown>> }>;
};
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SYSTEMS = ['framing', 'insulation', 'supply', 'drain', 'electrical', 'ducts'] as const;
const LABELS: Record<(typeof SYSTEMS)[number], string> = {
  framing: 'Framing',
  insulation: 'Insulation',
  supply: 'Plumbing · supply',
  drain: 'Plumbing · drain and vent',
  electrical: 'Electrical',
  ducts: 'Ducts',
};
const SHOTS = process.env['XRAY_SHOTS'];

/** A furnace in the garage, a supply register in the kitchen's ceiling and a return grille in the mudroom's floor. */
function withDucts(): unknown {
  const doc = structuredClone(HOUSE);
  const free = (x: number, y: number) => ({ mode: 'free', level: 'L1', position: [x, y], rotation: 0 });
  doc.extensions['FS_mechanical']!.collections!['equipment'] = {
    F1: { equipment: 'furnace', fuel: 'electric', name: 'Furnace', fallback: { level: 'L1', box: { min: [-380000, -380000, 0], max: [380000, 380000, 1_600_000] } }, host: free(7_600_000, 22_400_000) },
  };
  doc.extensions['FS_mechanical']!.collections!['terminals'] = {
    'KIT-SR1': { terminal: 'supply', equipment: 'F1', name: 'Kitchen register', fallback: { level: 'L1', box: { min: [-160000, -160000, 3_480_000], max: [160000, 160000, 3_511_296] } }, host: free(17_000_000, 21_000_000) },
    'MUD-RG1': { terminal: 'return', equipment: 'F1', name: 'Mudroom return', fallback: { level: 'L1', box: { min: [-250000, -250000, 0], max: [250000, 250000, 25_600] } }, host: free(11_300_000, 21_000_000) },
  };
  return doc;
}

type Drawn = Record<string, { meshes: number; pieces: number; triangles: number; clipped: number }>;
type Wall = { studs: number; kings: number; jacks: number; batts: number; supply: string[]; drain: string[]; vent: string[]; circuits: string[]; devices: string[]; framing: { system: string; spacing?: number; source: string } };
type Hook = {
  __floorspec3d?: { ready: boolean; screenPoint(id: string): { x: number; y: number } | null; section: { mode: string; planes: number; clipped: number } };
  __floorspecXray?: {
    on: boolean;
    fade: number;
    systems: Record<string, boolean>;
    counts: Record<string, number> | null;
    drawn: Drawn;
    faded: { materials: number; min: number | null; max: number | null };
    wall(id: string): Wall | null;
  };
};

const xray = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as Hook).__floorspecXray;
  return h === undefined ? null : { on: h.on, fade: h.fade, systems: h.systems, counts: h.counts, drawn: h.drawn, faded: h.faded };
});
const wallOf = (page: Page, id: string) => page.evaluate((w) => (window as unknown as Hook).__floorspecXray!.wall(w), id);

/** The theme switched and settled: two frames after the switch, and no CSS transition still running (edit3d.spec.ts). */
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
    await page.waitForTimeout(800);
    await themeSettled(page);
    await page.screenshot({ path: `test-results/xray-${name}-${theme}.png` });
    if (SHOTS !== undefined) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/xray-${name}-${theme}.png` });
    }
  }
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

test('X-ray: the finishes faded, every system drawn and toggled, the kitchen wall’s studs, pipes and circuits, a section box into it — axe in both themes', async ({ page }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, { name: 'X-rayer', email: 'xray@example.test', password: password('xray') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(withDucts())),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1_000);
  expect((await xray(page))!.on).toBe(false);

  // ── X-ray from the Experiences cluster: the panel, the finishes faded to 70 %, every system drawn.
  const cluster = page.getByRole('toolbar', { name: 'Experiences' });
  const button = cluster.getByRole('button', { name: 'X-ray' });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'X-ray' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('70 %')).toBeVisible();
  await expect.poll(async () => Object.keys((await xray(page))!.drawn).sort(), { timeout: 30_000 }).toEqual([...SYSTEMS].sort());
  const on = (await xray(page))!;
  expect(on.faded.materials).toBeGreaterThan(10);
  expect(on.faded.max!).toBeLessThanOrEqual(0.3 + 1e-6);
  const counts = on.counts!;
  expect(counts['studs']).toBeGreaterThan(500);
  expect(counts['batts']).toBeGreaterThan(100);
  expect(counts['supply']).toBeGreaterThan(10);
  expect(counts['drain']).toBeGreaterThan(5);
  expect(counts['circuits']).toBeGreaterThan(5);
  expect(counts['ducts']).toBe(2);
  for (const s of SYSTEMS) expect(on.drawn[s]!.pieces, s).toBeGreaterThan(0);
  // Each row says what it counts, beside its swatch and its switch.
  await expect(panel.locator('[data-system="framing"]')).toContainText(`${counts['studs']!.toLocaleString('en-US')} studs`);
  await expect(panel.locator('[data-system="electrical"]')).toContainText(`${String(counts['circuits'])} circuits`);
  await expect(panel.locator('[data-system="ducts"]')).toContainText('2 runs');

  // ── Each system switched off — nothing of it drawn — and on again.
  for (const s of SYSTEMS) {
    const sw = panel.getByRole('switch', { name: LABELS[s] });
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await expect.poll(async () => (await xray(page))!.drawn[s]).toBeUndefined();
    // The others still drawn.
    const others = (await xray(page))!.drawn;
    for (const o of SYSTEMS) if (o !== s) expect(others[o]?.pieces ?? 0, `${o} with ${s} off`).toBeGreaterThan(0);
    await sw.click();
    await expect.poll(async () => (await xray(page))!.drawn[s]?.pieces ?? 0).toBeGreaterThan(0);
  }

  // ── Fade finishes from the keyboard: all the way, then back to 70 %.
  const slider = panel.getByRole('slider', { name: 'Fade finishes' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(panel.getByText('100 %')).toBeVisible();
  await expect.poll(async () => (await xray(page))!.faded.max).toBe(0);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await expect(panel.getByText('70 %')).toBeVisible();

  // ── ⌥X: off (the finishes as they were), and on again.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Alt+KeyX');
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await xray(page))!.faded.materials).toBe(0);
  expect(Object.keys((await xray(page))!.drawn)).toEqual([]);
  await page.keyboard.press('Alt+KeyX');
  await expect(panel).toBeVisible();
  await expect.poll(async () => Object.keys((await xray(page))!.drawn).length).toBe(SYSTEMS.length);

  // ── The kitchen's north wall: its studs, pipes and circuits.
  const w24 = (await wallOf(page, 'W24'))!;
  expect(w24.framing).toMatchObject({ system: 'studs', spacing: 520_192, source: 'default' });
  expect(w24.studs).toBeGreaterThan(3);
  expect(w24.kings).toBeGreaterThan(0);
  expect(w24.batts).toBeGreaterThan(0);
  expect(w24.supply).toEqual(expect.arrayContaining(['KIT-SINK:cold', 'KIT-SINK:hot']));
  expect(w24.drain).toContain('KIT-SINK:drain');
  expect(w24.vent).toContain('KIT-SINK:vent');
  expect(w24.circuits).toEqual(expect.arrayContaining(['C6', 'C7']));
  expect(w24.devices.length).toBeGreaterThan(3);

  // Chosen in the project tree (the main floor's walls): the inspector shows its layers to scale and what is in it.
  const walls = page.getByRole('treeitem', { name: /^Walls/ }).first();
  if ((await walls.getAttribute('aria-expanded')) !== 'true') await walls.click();
  await page.getByRole('treeitem', { name: /^Wall W24\b/ }).click();
  const inspector = page.getByRole('region', { name: 'X-ray · layers, outside → inside' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('img', { name: /^Layers to scale: Fibre-cement lap siding/ })).toBeVisible();
  await expect(inspector.getByText(/insulated cavities · .+ @ .+ \+ batts/)).toBeVisible();
  await expect(inspector.getByText(/supply · \d+ drain · \d+ vent/)).toBeVisible();
  await expect(inspector.getByText(/C6, C7/)).toBeVisible();
  // And its callouts over the view: the framing, the sink's supply and drain, the counter's circuits.
  const callouts = page.locator('.fs-xray__overlay');
  await expect(callouts.locator('[data-label="framing:W24"]')).toContainText('2×6 @');
  await expect(callouts.locator('[data-label="supply:KIT-SINK"]')).toContainText('supply');
  await expect(callouts.locator('[data-label="supply:KIT-SINK"]')).toContainText('cold · hot');
  await expect(callouts.locator('[data-label="drain:KIT-SINK"]')).toContainText('vent');
  await expect(callouts.locator('[data-label^="circuit:"]').first()).toContainText(/Circuit C\d+ · 20 A/);

  // ── "Section box here": FLR-T-14.6's box around the wall, its planes on X-ray's systems too.
  await panel.getByRole('button', { name: 'Section box here' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.section)).planes).toBe(6);
  expect((await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.section)).mode).toBe('box');
  await expect.poll(async () => {
    const d = (await xray(page))!.drawn;
    return SYSTEMS.filter((s) => d[s] !== undefined).every((s) => d[s]!.clipped === d[s]!.meshes);
  }).toBe(true);
  // Closer in on the corner, for the pictures.
  await page.locator('.fs-three__gl').focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('=');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(2_000);
  await shoot(page, 'kitchen-wall');

  await axe(page, 'X-ray on, the kitchen wall selected and cut by the section box');
});
