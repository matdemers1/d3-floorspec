/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, historyOf, IN, password, settled } from './support.js';

/**
 * FLR-T-18.16, the keyboard and accessibility pass over the new 2D editor — P3's keyboard-only walk
 * (keyboard.spec.ts) carried over Phase 18's features, on the Courtyard House. No click, no hover,
 * no drag: every step is a key, typed text, or focus moved to a control the way a screen reader's
 * "jump to" does (`locator.focus()`), then keys.
 *
 * ? opens the shortcut sheet — the registry's keys by group, searchable, Esc back to the plan — and
 * not while typing in a field; the palette shows each command's keys. ⌥L goes to the element list,
 * which mirrors the plan: ↑/↓, Space selects on the plan, ⇧↓ extends, ⌘Space toggles, ⌘A selects
 * all, the plan's selection found in it, a mode's ghosts listed but not picked, a layer turned off
 * left out. Tab from the plan comes to the selection's handles: → grows the island one 3″ module
 * (one resizeElement), ⇧← shrinks it four, Enter goes to its typed width, the rotate handle turns it
 * 15° a press, and a room's side is pushed out (one resizeRoom) — each said in a live region. The
 * drawers come by ⌘\, F6 and Esc in full screen; ⌥1–⌥7 switch modes. axe runs on the sheet, the
 * list and a focused handle in both themes, and the mode menu is shot as people with each kind of
 * colour blindness see it.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SHOTS = process.env['KEYS_SHOTS'] ?? 'test-results';

interface Host { position?: number[]; rotation?: number }
interface Item { host?: Host; fallback?: { box?: { min: number[]; max: number[] } } }
type Doc = { extensions: { FS_furniture: { collections: Record<string, Record<string, Item>> } } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const itemOf = (d: Doc, id: string): Item => Object.values(d.extensions.FS_furniture.collections).find((c) => id in c)![id]!;
const widthOf = (d: Doc, id: string): number => {
  const b = itemOf(d, id).fallback!.box!;
  return b.max[1]! - b.min[1]!;
};

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/keys-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function axe(page: Page, selector: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(150);
    const results = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
    expect.soft(results.violations.map((v) => `${theme} ${selector} ${v.id}: ${v.help} — ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(', ')}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const frame = (page: Page) => page.locator('.fs-editor');

/** A dialog fading out still keeps the plan's keys from the plan: wait until it has gone. */
const noDialog = async (page: Page) => {
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
};

/** ⌘K, a query, and Enter on the first result once it is the one wanted. */
async function palette(page: Page, query: string, first: RegExp): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search commands and the plan' });
  await expect(input).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole('option').first()).toContainText(first);
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await noDialog(page);
}

/** Machado et al. (2009) at severity 1, as an SVG filter over the page: how a colour-blind eye sees it. */
const CVD: Record<string, string> = {
  protanopia: '0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0',
  deuteranopia: '0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0',
  tritanopia: '1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0',
};

test('the P18 editor by keyboard and assistive technology: shortcuts, the element list, handles, drawers and modes', async ({ page }) => {
  test.setTimeout(300_000);
  await firstRunSetup(page, { name: 'Keys', email: 'keys@example.test', password: password('keys') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await frame(page).focus();

  // ── ? opens the shortcut sheet: the registry's keys, by group, searchable; Esc gives the plan its focus back.
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  const search = sheet.getByRole('searchbox', { name: 'Search the shortcuts' }).or(sheet.getByRole('textbox', { name: 'Search the shortcuts' }));
  await expect(search).toBeFocused();
  for (const group of ['Tools', 'Editing', 'View and navigation', 'History', 'On the plan', 'A focused handle', 'Placing from the library']) await expect(sheet.getByRole('heading', { name: group, exact: true })).toBeVisible();
  await expect(sheet.locator('[data-command="edit.undo"]')).toContainText('⌘Z');
  await expect(sheet.locator('[data-command="mode.electrical"]')).toContainText('⌥3');
  await expect(sheet.locator('[data-command="help.shortcuts"]')).toContainText('?');
  await shoot(page, 'shortcut-sheet');
  await axe(page, '[role="dialog"]');
  await page.keyboard.type('history');
  await expect(sheet.locator('[data-command="history.toggle"]')).toContainText('⌥H');
  await expect(sheet.locator('[data-command="edit.undo"]')).toHaveCount(0);
  await expect(sheet.getByRole('status')).toContainText(/\d+ shortcuts?/);
  await shoot(page, 'shortcut-sheet-search');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await noDialog(page);
  await expect(frame(page)).toBeFocused();

  // Not while typing: ? in the library's search is a character.
  await page.keyboard.press('i');
  const librarySearch = page.getByRole('searchbox', { name: 'Search the library to add' }).or(page.getByRole('textbox', { name: 'Search the library to add' }));
  await expect(librarySearch).toBeFocused();
  await page.keyboard.type('?');
  await expect(librarySearch).toHaveValue('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await frame(page).focus();

  // The palette shows each command's keys.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('show the history');
  await expect(page.getByRole('option', { name: /Show the history/ })).toContainText('⌥H');
  await page.keyboard.press('Escape');
  await noDialog(page);
  await expect(frame(page)).toBeFocused();
  // The sheet from the palette too, listed with its own key.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('keyboard shortcuts');
  await expect(page.getByRole('option').first()).toContainText('Keyboard shortcuts');
  await expect(page.getByRole('option').first()).toContainText('?');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await noDialog(page);
  await expect(frame(page)).toBeFocused();

  // ── ⌥L: the element list, the plan's mirror. Tree | Elements | Library in the left drawer.
  await page.keyboard.press('Alt+KeyL');
  const list = page.getByRole('listbox', { name: /^Elements on / });
  await expect(list).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Elements' })).toHaveAttribute('aria-selected', 'true');
  const options = list.getByRole('option');
  expect(await options.count()).toBeGreaterThan(20);
  const active = async () => list.locator(`[id="${(await list.getAttribute('aria-activedescendant')) ?? ''}"]`);
  await expect(await active()).toContainText(/room · /);
  // ↓ and Space: the second element selected on the plan; ⇧↓ adds the third; ⌘Space takes it out again.
  await page.keyboard.press('ArrowDown');
  const second = await (await active()).getAttribute('data-element');
  await page.keyboard.press('Space');
  await expect(list.locator(`[data-element="${second!}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+Space');
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  // ⌘A: everything listed.
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(async () => list.locator('[aria-selected="true"]').count()).toBeGreaterThan(20);
  await shoot(page, 'element-list');
  await axe(page, '.fs-elements');
  // Esc: back to the plan, the selection kept; Esc again clears it.
  await page.keyboard.press('Escape');
  await expect(frame(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);

  // Chosen on the plan (the palette's Go to), found in the list.
  await palette(page, 'kitchen island', /Kitchen island/);
  await expect(list.locator('[data-element="KIT-ISLAND"]')).toHaveAttribute('aria-selected', 'true');
  // Framed (⇧2), as a person resizing it would have it: its handles apart, its dimensions readable.
  await frame(page).focus();
  await page.keyboard.press('Shift+Digit2');
  await page.waitForTimeout(700);
  await expect(await active()).toHaveAttribute('data-element', 'KIT-ISLAND');

  // ── Tab from the plan to the island's handles; → one 3″ module wider, ⇧← four narrower — each one op.
  await frame(page).focus();
  await page.keyboard.press('Tab');
  const focusedHandle = () => page.evaluate(() => document.activeElement?.getAttribute('data-key-handle') ?? null);
  await expect.poll(focusedHandle).toBe('front');
  for (let i = 0; i < 8 && (await focusedHandle()) !== 'left'; i++) await page.keyboard.press('Tab');
  expect(await focusedHandle()).toBe('left');
  const handle = page.locator('[data-key-handle="left"]');
  await expect(handle).toHaveAttribute('role', 'slider');
  await expect(handle).toHaveAccessibleName(/^Width, left side of Kitchen island/);
  const before = await docOf(page, project);
  const ops = (await historyOf(page, project)).length;
  expect(widthOf(before, 'KIT-ISLAND')).toBe(2_304_000);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => widthOf(await docOf(page, project), 'KIT-ISLAND')).toBe(72 * IN);
  expect((await historyOf(page, project)).length).toBe(ops + 1);
  await expect(page.locator('.fs-keyhandles__live')).toContainText('Kitchen island');
  await expect(page.locator('.fs-keyhandles__live')).toContainText('wide ×');
  await expect(handle).toBeFocused();
  await shoot(page, 'handle');
  await axe(page, '.fs-editor__canvas');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => widthOf(await docOf(page, project), 'KIT-ISLAND')).toBe(60 * IN);
  // Enter: the typed width in the inspector — the width the press made, even when the editor is still
  // reading it back as the field takes the focus (FLR-T-18.19) — and leaving it changes nothing.
  await page.keyboard.press('Enter');
  const typedWidth = page.getByRole('textbox', { name: 'Width', exact: true });
  await expect(typedWidth).toBeFocused();
  await expect(typedWidth).toHaveValue(`5'-0"`);
  await frame(page).focus();
  // ⇧Tab from the plan: the last handle, the rotate handle — → turns the island 15° clockwise.
  await page.keyboard.press('Shift+Tab');
  await expect.poll(focusedHandle).toBe('rotate');
  const turned = itemOf(await docOf(page, project), 'KIT-ISLAND').host!.rotation!;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => itemOf(await docOf(page, project), 'KIT-ISLAND').host!.rotation).toBe(turned - 15_000_000);
  await expect(page.locator('.fs-keyhandles__live')).toContainText('turned');
  expect(widthOf(await docOf(page, project), 'KIT-ISLAND')).toBe(60 * IN);
  // Esc from a handle: the plan.
  await page.keyboard.press('Escape');
  await expect(frame(page)).toBeFocused();
  await settled(page);

  // ── A room's side from the keyboard: the Pantry chosen in the list, Tab to its first handle, → pushes it out.
  await palette(page, 'pantry', /Pantry/);
  await frame(page).focus();
  const roomOps = (await historyOf(page, project)).length;
  await page.keyboard.press('Tab');
  await expect.poll(focusedHandle).not.toBeNull();
  for (let i = 0; i < 4 && (await focusedHandle()) !== 'west'; i++) await page.keyboard.press('Tab');
  expect(await focusedHandle()).toBe('west');
  await expect(page.locator(':focus')).toHaveAccessibleName('West side of Pantry');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await historyOf(page, project)).length).toBe(roomOps + 1);
  expect((await historyOf(page, project))[0]).toMatchObject({ kind: 'apply' });
  await expect(page.locator('.fs-keyhandles__live')).toContainText('Pantry:');
  await page.keyboard.press('Escape');
  await settled(page);

  // ── Modes by key, ⌥1–⌥7: Electrical ghosts the walls — listed, not pickable — and turns plumbing off.
  await frame(page).focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Digit3');
  await expect(page.getByRole('button', { name: 'Electrical mode' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+KeyL');
  await expect(list).toBeFocused();
  await expect(list.getByRole('group', { name: /^Walls, / }).getByRole('option').first()).toHaveAttribute('aria-disabled', 'true');
  await expect(list.getByRole('group', { name: /^Plumbing, / })).toHaveCount(0);
  await expect(list.getByRole('group', { name: /^Electrical, / })).toHaveCount(1);
  await axe(page, '.fs-elements');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Digit4');
  await expect(page.getByRole('button', { name: 'Plumbing mode' })).toHaveAttribute('aria-pressed', 'true');
  await palette(page, 'show every layer', /Show every layer/);

  // ── The mode menu, and how it looks with each kind of colour blindness (the colours: test/colourblind.test.ts).
  await page.getByRole('button', { name: 'Modes menu' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await shoot(page, 'modes');
  await page.evaluate((cvd) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = Object.entries(cvd).map(([k, m]) => `<filter id="cvd-${k}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${m}"/></filter>`).join('');
    svg.id = 'cvd-filters';
    document.body.appendChild(svg);
  }, CVD);
  for (const kind of Object.keys(CVD)) {
    await page.evaluate((k) => { document.documentElement.style.filter = `url(#cvd-${k})`; }, kind);
    await shoot(page, `modes-${kind}`);
  }
  await page.evaluate(() => { document.documentElement.style.filter = ''; document.getElementById('cvd-filters')?.remove(); });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  // ── The drawers in full screen: ⌘\ into the left one, Esc back to the plan, F6 round them, F out.
  await frame(page).focus();
  await page.keyboard.press('f');
  await expect(frame(page)).toHaveAttribute('data-chrome', 'full');
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-drawer]')?.getAttribute('data-drawer') ?? null)).toBe('left');
  // The first Esc closes the focused tool's tooltip (as in drawers.spec.ts), the second leaves the drawer.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(frame(page)).toBeFocused();
  await page.keyboard.press('F6');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-drawer]')?.getAttribute('data-drawer') ?? null)).not.toBeNull();
  if ((await page.getByRole('tooltip').count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  await expect(frame(page)).toBeFocused();
  await page.keyboard.press('f');
  await expect(frame(page)).not.toHaveAttribute('data-chrome', 'full');

  // The plan's own way to the list: a skip link that shows when it has the focus.
  const skip = page.getByRole('button', { name: /Go to the list of elements on the plan/ });
  await skip.focus();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(list).toBeFocused();
});
