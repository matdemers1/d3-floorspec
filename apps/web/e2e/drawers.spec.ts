import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { firstRunSetup, password, projectIn, settled } from './support.js';

/**
 * FLR-T-18.2: full screen and the edge drawers, after the board's "18.2 · Full screen" frames and the
 * drawer spec. On the Ranch template: the side panels collapsed and summoned back outside full
 * screen; F into full screen with only the plan, three grips and the HUD left; each edge's 20 px hot
 * zone peeking its drawer after the intent delay, the pointer onto the peek opening it and off it
 * putting it away; a menu from the top drawer holding it open; pinning; the shortcuts moving focus
 * in and Esc back out; F6 round the drawers; a touch swipe; reduced motion fading instead of
 * sliding; the 3D and split views with the same drawers. axe (WCAG 2.0/2.1/2.2 A and AA) runs on
 * every state in both themes, and screenshots land in test-results/drawers-*.png.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(200);
}

/** axe in both themes, and a screenshot of each. */
async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await still(page);
    await page.screenshot({ path: `test-results/drawers-${state}-${theme}.png` });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  }
}

const drawer = (page: Page, side: 'left' | 'top' | 'right'): Locator => page.locator(`[data-drawer="${side}"]`);
const frame = (page: Page): Locator => page.locator('.fs-editor');

async function stateOf(page: Page, side: 'left' | 'top' | 'right'): Promise<string | null> {
  return drawer(page, side).getAttribute('data-state');
}

test('full screen with edge drawers: hot zones, pins, keys, touch, reduced motion, 3D — and axe in both themes', async ({ page }) => {
  test.setTimeout(240_000);
  await firstRunSetup(page, { name: 'Drawer Tester', email: 'drawers@example.test', password: password('drawers') });
  // The templates show beside a first project.
  await page.getByRole('button', { name: 'New project' }).first().click();
  const blank = page.getByRole('dialog', { name: 'New project' });
  await blank.getByLabel('Name').fill('First house');
  await blank.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.goto('/projects');
  const templates = page.getByRole('region', { name: 'Start from a template' });
  await templates.getByText('Ranch', { exact: true }).click();
  await page.getByRole('dialog', { name: 'New project from Ranch' }).getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await expect(page.getByRole('application', { name: /^Plan of / })).toBeVisible();
  const canvas = page.getByRole('main', { name: 'Plan' });

  // ── Outside full screen every drawer is docked, as the editor always was.
  await expect(frame(page)).toHaveAttribute('data-chrome', 'windowed');
  for (const side of ['left', 'top', 'right'] as const) expect(await stateOf(page, side)).toBe('pinned');
  const docked = (await canvas.boundingBox())?.width ?? 0;

  // ── The side panels collapse on a desktop: unpinning the inspector gives the plan its width.
  await drawer(page, 'right').getByRole('button', { name: 'Pin the right drawer' }).click();
  await page.mouse.move(700, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(docked + 300);
  await expect(page.locator('.fs-grip--right')).toBeVisible();
  await audit(page, 'windowed-inspector-collapsed');
  // Its edge brings it back: the hot zone peeks it, the pointer onto the peek opens it.
  await page.mouse.move(1435, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('peeking');
  await expect(page.locator('.fs-grip--right')).toHaveAttribute('data-active', 'on');
  await page.mouse.move(1410, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('open');
  await drawer(page, 'right').getByRole('button', { name: 'Pin the right drawer' }).click();
  await expect.poll(() => stateOf(page, 'right')).toBe('pinned');
  await expect(page.getByRole('status').filter({ hasText: 'Right drawer pinned' })).toBeVisible();

  // ── F: full screen. Only the plan, three grips, the HUD and the notice.
  await frame(page).focus();
  await page.keyboard.press('f');
  await expect(frame(page)).toHaveAttribute('data-chrome', 'full');
  await expect(page.getByRole('status').filter({ hasText: 'Full screen. Move to an edge for tools' })).toBeVisible();
  for (const side of ['left', 'top', 'right'] as const) {
    expect(await stateOf(page, side)).toBe('hidden');
    await expect(page.locator(`.fs-grip--${side}`)).toBeVisible();
  }
  await expect(page.locator('.fs-statusbar')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Tools' })).toBeHidden();
  await expect(page.getByRole('note', { name: 'View' })).toContainText('Main floor');
  const full = await canvas.boundingBox();
  expect(full?.x).toBe(0);
  expect(full?.y).toBe(0);
  await audit(page, 'full-chrome-hidden');

  // ── The left edge: 120 ms in the hot zone peeks the tools only; onto the peek opens it all.
  // (Low on the edge, below the tools, so no tool's tooltip is part of the picture.)
  await page.mouse.move(700, 760);
  await page.mouse.move(6, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('peeking');
  await expect(page.getByRole('navigation', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Project' })).toBeHidden();
  await audit(page, 'full-left-peek');
  await page.mouse.move(30, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('open');
  await expect(page.getByRole('navigation', { name: 'Project' })).toBeVisible();
  await audit(page, 'full-left-open');
  // Off it, it slides away after 300 ms — not at once.
  await page.mouse.move(800, 450);
  expect(await stateOf(page, 'left')).toBe('open');
  await expect.poll(() => stateOf(page, 'left')).toBe('hidden');

  // FLR-T-18.17: a peek that missed the pointer coming onto it still opens. Here its pointerleave
  // is heard and the pointerenter back is lost — as on CI, where the 3D view replaced what was under
  // the resting pointer while the peek slid in — so the move further onto it crosses no boundary of
  // the drawer's, and only measuring the move against the drawer's box sees it there.
  await page.mouse.move(12, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('peeking');
  await still(page);
  await page.mouse.move(14, 760);
  await page.evaluate(() => {
    const under = document.elementFromPoint(14, 760);
    if (under === null || under.closest('[data-drawer="left"]') === null) throw new Error('the peek is not under the pointer');
    under.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 14, clientY: 760, relatedTarget: document.querySelector('.fs-editor__canvas') }));
  });
  await page.mouse.move(30, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('open');
  await page.mouse.move(800, 450);
  await expect.poll(() => stateOf(page, 'left')).toBe('hidden');

  // ── Pinned: docked flush, and the plan reflows beside it.
  await page.mouse.move(6, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('peeking');
  await still(page);
  await page.mouse.move(30, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('open');
  await drawer(page, 'left').getByRole('button', { name: 'Pin the left drawer' }).click();
  await expect.poll(() => stateOf(page, 'left')).toBe('pinned');
  await page.mouse.move(800, 450);
  await expect.poll(async () => (await canvas.boundingBox())?.x ?? 0).toBeGreaterThan(300);
  await expect(page.getByRole('status').filter({ hasText: 'Left drawer pinned' })).toBeVisible();
  await audit(page, 'full-left-pinned');

  // ── The top edge: the top bar. A menu opened from it holds it open while the pointer is away.
  await page.mouse.move(800, 4);
  await expect.poll(() => stateOf(page, 'top')).toBe('peeking');
  await still(page);
  await page.mouse.move(800, 30);
  await expect.poll(() => stateOf(page, 'top')).toBe('open');
  await audit(page, 'full-top-open');
  const level = page.getByRole('combobox', { name: 'Level', exact: true });
  await level.click();
  await expect(page.getByRole('option', { name: 'Main floor' })).toBeVisible();
  await page.mouse.move(800, 600);
  await page.waitForTimeout(700);
  expect(await stateOf(page, 'top')).toBe('open');
  // Esc closes the menu (focus back on its trigger, so the drawer stays); Esc again puts the drawer away.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option', { name: 'Main floor' })).toBeHidden();
  await page.waitForTimeout(500);
  expect(await stateOf(page, 'top')).toBe('open');
  await page.keyboard.press('Escape');
  await expect.poll(() => stateOf(page, 'top')).toBe('hidden');
  await expect(frame(page)).toBeFocused();

  // ── The keyboard: ⌘⇧\ opens the right drawer with focus in it; Esc back to the canvas.
  await page.keyboard.press('ControlOrMeta+Shift+Backslash');
  await expect.poll(() => stateOf(page, 'right')).toBe('open');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-drawer]')?.getAttribute('data-drawer') ?? null)).toBe('right');
  await audit(page, 'full-right-open-by-keyboard');
  // Again pins it; again hides it.
  // (Focus is in the inspector's first field, which keeps its keys to itself: the drawer keys still reach it.)
  await expect(page.locator('[data-drawer="right"] input').first()).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+Backslash');
  await expect.poll(() => stateOf(page, 'right')).toBe('pinned');
  await page.keyboard.press('ControlOrMeta+Shift+Backslash');
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');
  await expect(frame(page)).toBeFocused();
  // ⌘⌥\: the top drawer.
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  await expect.poll(() => stateOf(page, 'top')).toBe('open');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-drawer]')?.getAttribute('data-drawer') ?? null)).toBe('top');
  await page.keyboard.press('Escape');
  await expect.poll(() => stateOf(page, 'top')).toBe('hidden');

  // ── F6 cycles canvas → left (pinned) → top → right → canvas, nothing trapping focus.
  await frame(page).focus();
  const focusedSide = () => page.evaluate(() => document.activeElement?.closest('[data-drawer]')?.getAttribute('data-drawer') ?? 'canvas');
  for (const want of ['left', 'top', 'right', 'canvas']) {
    await page.keyboard.press('F6');
    await expect.poll(focusedSide).toBe(want);
  }
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');
  // Tab moves on out of a drawer too: nothing traps focus.
  await page.keyboard.press('ControlOrMeta+Shift+Backslash');
  await expect.poll(focusedSide).toBe('right');
  for (let i = 0; i < 40 && (await focusedSide()) === 'right'; i++) await page.keyboard.press('Tab');
  expect(await focusedSide()).not.toBe('right');
  await page.mouse.click(800, 500);
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');

  // ── Touch: a swipe in from the right edge peeks, then opens; a tap on the plan puts it away.
  await page.evaluate(() => {
    const main = document.querySelector('.fs-editor__canvas');
    const at = (type: string, x: number, target: EventTarget) =>
      target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 9, clientX: x, clientY: 450, bubbles: true, isPrimary: true }));
    if (main === null) throw new Error('no canvas');
    at('pointerdown', 1436, main);
    at('pointermove', 1420, window);
  });
  await expect.poll(() => stateOf(page, 'right')).toBe('peeking');
  await page.evaluate(() => {
    const at = (type: string, x: number) => window.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 9, clientX: x, clientY: 450, bubbles: true, isPrimary: true }));
    at('pointermove', 1300);
    at('pointerup', 1300);
  });
  await expect.poll(() => stateOf(page, 'right')).toBe('open');
  await page.mouse.click(800, 500);
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');

  // ── Reduced motion: a drawer fades where it stands instead of sliding.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const opacity = () => drawer(page, 'right').evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(opacity).toBe('0');
  const hiddenStyle = await drawer(page, 'right').evaluate((el) => ({ transform: getComputedStyle(el).transform, property: getComputedStyle(el).transitionProperty }));
  expect(hiddenStyle.transform).toBe('none');
  expect(hiddenStyle.property).not.toContain('transform');
  await page.mouse.move(1435, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('peeking');
  await still(page);
  await page.mouse.move(1410, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('open');
  await expect.poll(opacity).toBe('1');
  await page.mouse.move(800, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ── The 3D view and the split view use the same drawers, their pins kept per view.
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/[?&]view=3d\b/);
  await expect.poll(() => stateOf(page, 'left')).toBe('hidden');
  await expect(page.getByRole('main', { name: '3D view' })).toBeVisible();
  await page.mouse.move(700, 760);
  await page.mouse.move(6, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('peeking');
  await still(page);
  await page.mouse.move(30, 760);
  await expect.poll(() => stateOf(page, 'left')).toBe('open');
  await audit(page, 'full-3d-left-open');
  await page.mouse.move(800, 450);
  await expect.poll(() => stateOf(page, 'left')).toBe('hidden');
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/[?&]view=split\b/);
  await page.mouse.move(1435, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('peeking');
  await still(page);
  await page.mouse.move(1410, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('open');
  await audit(page, 'full-split-right-open');
  await page.mouse.move(800, 450);
  await expect.poll(() => stateOf(page, 'right')).toBe('hidden');
  // Back in the plan, the left drawer is pinned as it was left there.
  await page.keyboard.press('1');
  await expect.poll(() => stateOf(page, 'left')).toBe('pinned');

  // ── Esc with nothing else to escape leaves full screen: the first clears the selection the taps
  //    on the plan made, the next leaves. The windowed layout is as it was.
  await frame(page).focus();
  await page.keyboard.press('Escape');
  await expect(frame(page)).toHaveAttribute('data-inspector', 'idle');
  await expect(frame(page)).toHaveAttribute('data-chrome', 'full');
  await page.keyboard.press('Escape');
  await expect(frame(page)).toHaveAttribute('data-chrome', 'windowed');
  for (const side of ['left', 'top', 'right'] as const) expect(await stateOf(page, side)).toBe('pinned');
  await expect(page.locator('.fs-statusbar')).toBeVisible();
  // The top bar's button goes in and out too.
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(frame(page)).toHaveAttribute('data-chrome', 'full');
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(frame(page)).toHaveAttribute('data-chrome', 'windowed');

  // ── A tablet-width window keeps its own layout outside full screen: ⌘\ folds the tree as it always has.
  await page.setViewportSize({ width: 1024, height: 768 });
  const treeToggle = page.getByRole('button', { name: /the project tree$/ });
  await expect(treeToggle).toBeVisible();
  const was = await treeToggle.getAttribute('aria-pressed');
  await frame(page).focus();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(treeToggle).not.toHaveAttribute('aria-pressed', was ?? '');
  await audit(page, 'tablet-windowed');
  await page.setViewportSize({ width: 1440, height: 900 });
});
