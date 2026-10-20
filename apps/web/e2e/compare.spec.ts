/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { asAgent, firstRunSetup, IN, password, settled } from './support.js';

/**
 * FLR-T-14.4: compare in 3D — the board's frames "14.4 · Compare in 3D — swipe divider, choosing B
 * (option set or changeset)" and "— side by side, cameras linked" on the Courtyard House.
 *
 * An agent proposes "Bigger island" (the island 10 ft long, one resizeElement). Compare on the
 * Experiences cluster opens with that changeset as B: main on the left, the changeset on the right of
 * a swipe divider, one camera for both, the island outlined in B; the Comparing panel lists what B
 * changes. The B picker groups pending changesets and versions; the divider is dragged and moved by
 * the keys; side by side the cameras are linked, then unlinked and linked again; Flip; and Render
 * pair… renders a matched pair on the server — both pictures and their composites. axe in both
 * themes on each state. Screenshots land in test-results/compare-*.png (and COMPARE_SHOTS, when set).
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SHOTS = process.env['COMPARE_SHOTS'];

type CompareHook = {
  open: boolean;
  mode: string;
  divider: number;
  flipped: boolean;
  linked: boolean;
  a: string;
  b: string | null;
  drawn: { a: boolean; b: boolean };
  meshes: { a: number; b: number };
  built: { a?: { status: string; parts: number }; b?: { status: string; parts: number } };
  changed: string[];
};
type Hook = { __floorspec3d?: { ready: boolean }; __floorspecCompare?: CompareHook };

const compareState = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as Hook).__floorspecCompare;
  return h === undefined ? null : { open: h.open, mode: h.mode, divider: h.divider, flipped: h.flipped, linked: h.linked, a: h.a, b: h.b, drawn: h.drawn, meshes: h.meshes, built: h.built, changed: h.changed };
});

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/compare-${name}-${theme}.png` });
    if (SHOTS !== undefined) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/compare-${name}-${theme}.png` });
    }
  }
}

/** The theme switched and settled: two frames after the switch, and no CSS transition still running (as edit3d.spec.ts). */
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

test('compare in 3D: main and a pending changeset swiped and side by side from one camera, B chosen from its picker, and a matched pair rendered — axe in both themes', async ({ page, baseURL }) => {
  test.setTimeout(600_000);
  await firstRunSetup(page, { name: 'Comparer', email: 'compare@example.test', password: password('compare') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  // An agent proposes a bigger island: one op on a changeset, never main.
  const minted = await page.request.post('/api/tokens', { data: { name: 'Claude', kind: 'agent', projectId: project } });
  expect(minted.status(), await minted.text()).toBe(201);
  const agent = await asAgent(baseURL!, ((await minted.json()) as { token: string }).token);
  const proposal = await agent.post(`/api/projects/${project}/changesets`, {
    data: { name: 'Bigger island', batch: [{ op: 'resizeElement', element: 'KIT-ISLAND', anchor: 'center', width: 120 * IN }] },
  });
  expect(proposal.status(), await proposal.text()).toBe(201);
  await agent.dispose();

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1_000);

  // ── Compare, from the Experiences cluster: B is the pending changeset.
  const cluster = page.getByRole('toolbar', { name: 'Experiences' });
  const button = cluster.getByRole('button', { name: 'Compare' });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const bar = page.getByRole('toolbar', { name: 'Compare' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: /^A: Main · v\d+$/ })).toBeVisible();
  const seq = /v(\d+)$/.exec((await bar.getByRole('button', { name: /^A: Main/ }).getAttribute('aria-label')) ?? '')![1]!;
  await expect(bar.getByRole('button', { name: 'B: #1 · Bigger island' })).toBeVisible();
  // B is read and built: its house drawn beside main's, the island outlined in it.
  await expect.poll(async () => (await compareState(page))?.built.b?.status, { timeout: 60_000 }).toBe('ready');
  const opened = (await compareState(page))!;
  expect(opened).toMatchObject({ open: true, mode: 'swipe', divider: 0.5, flipped: false, linked: true, a: 'main', drawn: { a: true, b: true } });
  expect(opened.b).toMatch(/^changeset:/);
  expect(opened.meshes.b).toBeGreaterThan(100);
  expect(opened.changed).toContain('KIT-ISLAND');
  await expect(page.getByRole('note').filter({ hasText: `A · Main · v${seq}` })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'B · Changeset #1 · Bigger island' })).toBeVisible();
  // The Comparing panel, in the right column: what B changes.
  const panel = page.getByRole('group', { name: 'Comparing' });
  await expect(panel.getByRole('heading', { name: 'Comparing' })).toBeVisible();
  await expect(panel.getByText('What B changes · 1 op')).toBeVisible();
  const change = panel.getByRole('button', { name: /Kitchen island/ });
  await expect(change).toBeVisible();
  await change.hover();
  await expect(change).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(10, 400);
  await expect(panel.getByRole('button', { name: 'Open in Review' })).toBeVisible();
  await shoot(page, 'swipe');
  await axe(page, 'Compare, swiped');

  // ── The B picker: pending changesets and versions, grouped; a version chosen, then the changeset again.
  await bar.getByRole('button', { name: 'B: #1 · Bigger island' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('group', { name: 'Pending changesets' })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Main' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /#1 · Bigger island.*\(shown\)/ })).toBeVisible();
  await shoot(page, 'picker');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // ── The divider: dragged to a third of the view, then by the keys.
  const view = (await page.locator('.fs-three').boundingBox())!;
  const handle = page.getByRole('slider', { name: 'Swipe divider' });
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(h.x + h.width / 2 - (i * (view.width * 0.2)) / 10, h.y + h.height / 2);
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await compareState(page))!.divider - 0.3)).toBeLessThan(0.01);
  await handle.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await compareState(page))!.divider).toBeCloseTo(0.4, 2);
  await expect(handle).toHaveAttribute('aria-valuenow', '40');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '60');
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '100');
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageDown');
  await expect(handle).toHaveAttribute('aria-valuenow', '40');
  await shoot(page, 'swipe-dragged');

  // ── Side by side: one camera for both halves; unlinked, then linked again.
  await bar.getByRole('radio', { name: 'Side by side' }).click();
  await expect.poll(async () => (await compareState(page))!.mode).toBe('side');
  await expect(page.getByRole('note').filter({ hasText: 'Cameras linked' })).toBeVisible();
  await expect(handle).toBeHidden();
  await shoot(page, 'side-by-side');
  await axe(page, 'Compare, side by side');
  const link = bar.getByRole('button', { name: 'Link the cameras' });
  await expect(link).toHaveAttribute('aria-pressed', 'true');
  await link.click();
  await expect.poll(async () => (await compareState(page))!.linked).toBe(false);
  await expect(page.getByRole('note').filter({ hasText: 'Cameras unlinked' })).toBeVisible();
  await link.click();
  await expect.poll(async () => (await compareState(page))!.linked).toBe(true);
  // Flip: B on the left.
  await bar.getByRole('button', { name: 'Flip' }).click();
  await expect.poll(async () => (await compareState(page))!.flipped).toBe(true);
  await bar.getByRole('button', { name: 'Flip' }).click();
  await bar.getByRole('radio', { name: 'Swipe' }).click();

  // ── Render pair…: A and B path-traced on the server from this camera, with their composites.
  await panel.getByRole('button', { name: 'Render pair…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render a matched pair' });
  await expect(dialog).toBeVisible();
  await axe(page, 'Render a matched pair');
  await dialog.getByRole('button', { name: 'Render the pair' }).click();
  const ready = page.getByRole('dialog', { name: 'Your matched pair is ready' });
  await expect(ready).toBeVisible({ timeout: 480_000 });
  await expect(ready.getByRole('img', { name: `A · Main · v${seq}, rendered` })).toBeVisible();
  await expect(ready.getByRole('img', { name: 'B · #1 · Bigger island, rendered' })).toBeVisible();
  await expect(ready.getByRole('img', { name: /swiped at the middle/ })).toBeVisible();
  await shoot(page, 'pair');
  const jobs = ((await (await page.request.get(`/api/projects/${project}/exports`)).json()) as { exports: { kind: string; status: string; pair: { a: { label: string }; b: { label: string }; shot: boolean }; result: { pair: { swipe: string } } }[] }).exports;
  const pair = jobs.find((j) => j.kind === 'pair')!;
  expect(pair).toMatchObject({ status: 'done', pair: { a: { label: `Main v${seq}` }, b: { label: 'Changeset · Bigger island' }, shot: true }, result: { pair: { swipe: 'swipe.png' } } });
  await ready.getByRole('button', { name: 'Close', exact: true }).click();

  // ⌥C closes Compare; main alone again, the inspector back.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Alt+KeyC');
  await expect(bar).toBeHidden();
  await expect.poll(async () => (await compareState(page))?.open ?? false).toBe(false);
});
