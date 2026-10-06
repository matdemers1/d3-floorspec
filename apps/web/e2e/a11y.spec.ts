// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Result } from 'axe-core';
import { asAgent, password, projectIn, settled, setupToken, totp } from './support.js';

/**
 * FLR-T-3.9: axe on every screen and every significant state, in both themes — zero violations of
 * WCAG 2.0, 2.1 and 2.2 A/AA is the bar. One walk through the app, from first-run setup to a
 * second account accepting an invite; at each stop the colour scheme is switched to light and to
 * dark, the page is checked to have actually re-themed (the `data-theme` @d3cloud/ui's
 * ThemeProvider sets on <html>, and a different page background), and axe runs.
 *
 * Nothing is excluded and no rule is disabled: a violation is fixed in the app.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THEMES = ['light', 'dark'] as const;

interface Finding {
  state: string;
  theme: string;
  violation: string;
}

const findings: Finding[] = [];
const audited = new Set<string>();
const backgrounds: Record<string, Set<string>> = { light: new Set(), dark: new Set() };

function describe(v: Result): string {
  const nodes = v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}${n.failureSummary === undefined ? '' : ` — ${n.failureSummary.split('\n').slice(1).join(' ').trim()}`}`);
  return `${v.id} (${v.impact ?? '?'}): ${v.help} [${String(v.nodes.length)} node(s)]\n        ${nodes.join('\n        ')}`;
}

/** Wait until nothing is animating, so axe reads settled colours rather than a transition's middle. */
async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
}

/**
 * Text drawn in SVG — the plan's room names, areas and dimensions, on the canvas and on the
 * dashboard's thumbnail — is text a sighted person reads, but axe cannot judge it: it reports
 * "background could not be determined" (an image node) and moves on. So it is checked here, by the
 * same WCAG 1.4.3 arithmetic, against every surface it can sit on: the well the plan is drawn in,
 * and each room's fill composited over it. Opacity on the text or its groups counts against it.
 * Text painted over a halo — a stroke at least 2 px wide under its fill (`paint-order: stroke`) —
 * sits on that halo wherever it is drawn: it is checked against the halo over each of those surfaces.
 */
async function svgTextContrast(page: Page): Promise<{ failures: string[]; checked: string[] }> {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (m === null) return null;
      const [r, g, b, a] = (m[1] ?? '').split(/[ ,/]+/).filter(Boolean).map(Number);
      return [r ?? 0, g ?? 0, b ?? 0, a ?? 1];
    };
    const over = (top: Rgba, under: Rgba): Rgba => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const lum = (c: Rgba) => {
      const ch = c.slice(0, 3).map((v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
    };
    const ratio = (a: Rgba, b: Rgba) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
    };
    const opacityOf = (el: Element, stop: Element) => {
      let o = 1;
      for (let e: Element | null = el; e !== null && e !== stop.parentElement; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const failures: string[] = [];
    const checked: string[] = [];
    for (const svg of document.querySelectorAll('svg')) {
      const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim() !== '' && t.getBoundingClientRect().width > 0);
      if (texts.length === 0) continue;
      let well: Rgba | null = null;
      for (let e: Element | null = svg; e !== null && well === null; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg !== null && bg[3] > 0) well = bg;
      }
      const base = well ?? ([255, 255, 255, 1] as Rgba);
      const surfaces: Rgba[] = [base];
      for (const face of svg.querySelectorAll('[class*="__rooms"] > *')) {
        const style = getComputedStyle(face);
        const fill = parse(style.fill);
        if (fill === null) continue;
        surfaces.push(over([fill[0], fill[1], fill[2], fill[3] * Number(style.fillOpacity) * opacityOf(face, svg)], base));
      }
      for (const text of texts) {
        const parts = text.querySelectorAll('tspan').length > 0 ? [...text.querySelectorAll('tspan')] : [text];
        for (const part of parts) {
          const style = getComputedStyle(part);
          const fill = parse(style.fill);
          if (fill === null) continue;
          const size = parseFloat(style.fontSize);
          const bold = Number(style.fontWeight) >= 700;
          const needed = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
          const alpha = fill[3] * Number(style.fillOpacity) * opacityOf(part, svg);
          const halo = parse(style.stroke);
          const haloed = halo !== null && style.paintOrder.trim().startsWith('stroke') && parseFloat(style.strokeWidth) >= 2;
          const grounds = haloed ? surfaces.map((bg) => over([halo[0], halo[1], halo[2], halo[3] * Number(style.strokeOpacity) * opacityOf(part, svg)], bg)) : surfaces;
          const worst = Math.min(...grounds.map((bg) => ratio(over([fill[0], fill[1], fill[2], alpha], bg), bg)));
          checked.push(`${part.textContent.trim()}=${worst.toFixed(2)}`);
          if (worst < needed) failures.push(`svg-text-contrast: "${part.textContent.trim()}" (${part.getAttribute('class') ?? 'text'}) is ${worst.toFixed(2)}:1, needs ${String(needed)}:1`);
        }
      }
    }
    return { failures, checked };
  });
}

/** A11Y_DEBUG=1 prints, per state and theme, what axe passed and what it could not decide. */
const DEBUG = process.env['A11Y_DEBUG'] !== undefined;
/** A11Y_SHOTS=<dir> keeps a screenshot of every state in each theme, for a person to look at. */
const SHOTS = process.env['A11Y_SHOTS'];

/** axe, in both themes, on what the page shows now. */
async function audit(page: Page, state: string): Promise<void> {
  if (audited.has(state)) throw new Error(`state "${state}" audited twice`);
  audited.add(state);
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html'), `${state}: the ${theme} theme rendered`).toHaveAttribute('data-theme', theme);
    await still(page);
    backgrounds[theme]?.add(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${state.replace(/[^a-z0-9]+/gi, '-')}-${theme}.png` });

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const drawn = await svgTextContrast(page);
    if (DEBUG) {
      const incomplete = results.incomplete.map((r) => `${r.id}×${String(r.nodes.length)}`).join(' ');
      console.log(`${state} · ${theme}: ${String(results.passes.length)} rules pass, ${String(results.violations.length)} fail, needs review: ${incomplete || 'none'}; svg text ${drawn.checked.join(', ') || 'none'}`);
    }
    for (const v of results.violations) findings.push({ state, theme, violation: describe(v) });
    for (const d of drawn.failures) findings.push({ state, theme, violation: d });
    expect.soft([...results.violations.map(describe), ...drawn.failures], `${state} (${theme})`).toEqual([]);
  }
}

test('every screen and state has no axe violations, in light and in dark', async ({ page, baseURL, browser }) => {
  if (baseURL === undefined) throw new Error('no baseURL');
  test.setTimeout(300_000);

  // ── Anonymous: first-run setup, gated by the setup token, and its failure.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up D3 Floorspec' })).toBeVisible();
  await audit(page, 'first-run setup');
  const secret = password('a11y');
  await page.getByLabel('Setup token').fill('wrong-wrong-wrong-wrong-wrong');
  await page.getByLabel('Your name').fill('Axe Tester');
  await page.getByLabel('Email').fill('axe@example.test');
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByLabel('Password again').fill(secret);
  await page.getByRole('button', { name: 'Create the operator account' }).click();
  await expect(page.getByText('Setup failed')).toBeVisible();
  await audit(page, 'first-run setup, refused');
  await page.getByLabel('Setup token').fill(setupToken());
  await page.getByRole('button', { name: 'Create the operator account' }).click();

  // ── Projects: empty, the new-project dialog, the list, the import dialog.
  await expect(page.getByRole('heading', { name: 'Design your first house' })).toBeVisible();
  await audit(page, 'projects, empty');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await audit(page, 'new-project dialog');
  await page.getByRole('dialog').getByLabel('Name').fill('Blank house');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Blank house', level: 1 })).toBeVisible();
  const blank = projectIn(page.url());
  await page.waitForLoadState('networkidle');
  await audit(page, 'dashboard, blank project');

  await page.getByRole('link', { name: 'Projects' }).first().click();
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();
  await page.getByText('Three-room house').first().click();
  await expect(page.getByRole('dialog', { name: /New project from/ })).toBeVisible();
  await audit(page, 'new-project dialog, from a template');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const house = projectIn(page.url());
  await expect(page.getByRole('heading', { name: 'Three-room house', level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'dashboard, a house');
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit(page, 'dashboard, actions menu');
  await page.getByRole('menuitem', { name: 'Delete project…' }).click();
  await expect(page.getByRole('dialog', { name: /Delete/ })).toBeVisible();
  await audit(page, 'dashboard, delete confirmation');
  await page.getByRole('button', { name: 'Keep it' }).click();

  // FLR-T-12.6: the advisory energy estimate and its climate dialog.
  await page.locator('[data-region="energy"]').getByRole('button', { name: 'Open estimate' }).click();
  await expect(page.getByRole('heading', { name: 'Energy & comfort', level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'energy estimate');
  await page.getByRole('button', { name: 'Climate & assumptions' }).click();
  await expect(page.getByRole('dialog', { name: 'Climate & assumptions' })).toBeVisible();
  await audit(page, 'energy, climate and assumptions');
  await page.getByRole('dialog', { name: 'Climate & assumptions' }).getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'Projects' }).first().click();
  await expect(page.getByRole('list', { name: 'Projects' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'projects, list');
  await page.getByRole('searchbox').fill('no such thing');
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await audit(page, 'projects, no search results');
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Import Floorspec file' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page, 'import dialog');
  await page.keyboard.press('Escape');

  // ── Account: tokens (one minted, its secret shown once), two-factor enrolment, the menu.
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'account');
  await page.getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByRole('status').filter({ hasText: 'Copy this token now' });
  await expect(shown).toBeVisible();
  await expect(shown.locator('.fs-mono')).toHaveText(/^fls_/);
  await audit(page, 'account, token created');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByLabel('Code from the app')).toBeVisible();
  const totpSecret = (await page.locator('p.fs-mono').last().textContent())?.trim() ?? '';
  await audit(page, 'account, two-factor enrolment');
  await page.getByLabel('Code from the app').fill(totp(totpSecret));
  await page.getByRole('button', { name: 'Confirm and turn on' }).click();
  await expect(page.getByRole('button', { name: 'Turn off two-factor' })).toBeVisible();
  await audit(page, 'account, two-factor on');
  await page.getByRole('button', { name: /Axe Tester/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit(page, 'account menu');
  await page.keyboard.press('Escape');

  // ── Invites (the operator's), with one created.
  await page.getByRole('link', { name: 'Invites' }).click();
  await expect(page.getByRole('heading', { name: 'Invites', level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'invites');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const inviteAlert = page.getByRole('status').filter({ hasText: 'Send this link' });
  await expect(inviteAlert).toBeVisible();
  const inviteLink = (await inviteAlert.locator('.fs-mono').textContent())?.trim() ?? '';
  expect(inviteLink).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  // The "created" toast dismisses itself, fading out partway through the two themes' audits: this
  // state is the invite link, so audit it once the toast has gone.
  await expect(page.locator('.d3-toast')).toHaveCount(0, { timeout: 15_000 });
  await audit(page, 'invites, link created');

  // ── Not found, and not yours.
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: 'That page does not exist' })).toBeVisible();
  await audit(page, 'page not found');
  await page.goto('/projects/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('heading', { name: 'That project does not exist' })).toBeVisible();
  await audit(page, 'project not found');
  await page.goto('/projects/00000000-0000-4000-8000-000000000000/editor');
  await expect(page.getByRole('heading', { name: 'No such project' })).toBeVisible();
  await audit(page, 'editor, no such project');

  // ── The editor, on a project with no levels.
  await page.goto(`/projects/${blank}/editor`);
  await expect(page.getByText('This project has no levels yet')).toBeVisible();
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await audit(page, 'editor, no levels');

  // ── The editor, on the house: the tree, the inspector for each kind of element, the tools.
  await page.goto(`/projects/${house}/editor`);
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await settled(page);
  await audit(page, 'editor, tree and idle inspector');
  const tree = page.getByRole('tree');
  const rows = tree.getByRole('treeitem');
  /** Select a row; a group's first element when `first` (the tree is flat, depth in aria-level). */
  const pick = async (name: RegExp, state: string, first = false) => {
    const row = tree.getByRole('treeitem', { name });
    let target = row;
    if (first) {
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      const names = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent));
      target = rows.nth(names.findIndex((n) => name.test(n)) + 1);
    }
    await target.click();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await audit(page, state);
  };
  await pick(/^Walls/, 'editor, a wall selected', true);
  await pick(/^Openings/, 'editor, an opening selected', true);
  await pick(/^Junctions/, 'editor, a junction selected', true);
  await pick(/^Living room/, 'editor, a room selected');
  await pick(/^Main floor/, 'editor, a level selected');
  await pick(/^House/, 'editor, a building selected');
  await pick(/^Types/, 'editor, a type selected', true);
  await tree.getByRole('treeitem', { name: /32 in interior door/ }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('combobox', { name: 'Operation' })).toBeVisible();
  await audit(page, 'editor, a door type selected: its operation and clear opening (Core 0.3)');
  await pick(/^Materials/, 'editor, a material selected', true);
  await page.keyboard.press('Escape');
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Draw a slab' }).click();
  await audit(page, 'editor, slab tool (Core 0.3)');
  await rail.getByRole('button', { name: 'Draw a roof' }).click();
  await audit(page, 'editor, roof tool (Core 0.3)');
  await rail.getByRole('button', { name: 'Place a stair' }).click();
  await audit(page, 'editor, stair tool (Core 0.3)');
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  await audit(page, 'editor, wall tool');
  await page.keyboard.type('0,0');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('4');
  await audit(page, 'editor, drawing a wall with a typed length');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Core 0.4, chapter 21 (FLR-T-11.1): the arc-wall tool, an arc being drawn, and an arc wall selected.
  await rail.getByRole('button', { name: 'Draw arc walls' }).click();
  await audit(page, 'editor, arc wall tool (Core 0.4)');
  await page.keyboard.type('0,0');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('arc-entry')).toContainText('Sagitta');
  await audit(page, 'editor, drawing an arc wall: its bulge (Core 0.4)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const arcHouse = await page.request.post('/api/projects', { data: { name: 'Bay house' } });
  expect(arcHouse.status(), await arcHouse.text()).toBe(201);
  const bay = ((await arcHouse.json()) as { id: string }).id;
  const bayDoc = JSON.parse(readFileSync(new URL('./fixtures/bay-house.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
  const bayBatch = ['types', 'buildings', 'levels', 'junctions', 'walls', 'openings', 'rooms'].flatMap((collection) =>
    Object.entries(bayDoc[collection] ?? {}).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
  expect((await page.request.post(`/api/projects/${bay}/ops`, { data: { batch: bayBatch } })).status()).toBe(201);
  await page.goto(`/projects/${bay}/editor`);
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await settled(page);
  const wallsGroup = tree.getByRole('treeitem', { name: /^Walls/ });
  if ((await wallsGroup.getAttribute('aria-expanded')) === 'false') await wallsGroup.click();
  await tree.getByRole('treeitem', { name: /Wall W2\b/ }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Flip bulge' })).toBeVisible();
  await audit(page, 'editor, an arc wall selected (Core 0.4)');
  // FLR-T-12.9: a roof selected — its edges numbered on the plan and listed one row each — and a
  // stair selected, outlined only, its winders tinted. The house is loaded whole, its rooms' floor
  // finishes with it (FLR-T-12.10): room names, areas and dimensions on a finish-tinted floor read at 4.5:1.
  const p7 = await page.request.post('/api/projects', { data: { name: 'P7 house' } });
  expect(p7.status(), await p7.text()).toBe(201);
  const p7id = ((await p7.json()) as { id: string }).id;
  const p7Doc = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
  const p7Batch = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'].flatMap((collection) =>
    Object.entries(p7Doc[collection] ?? {}).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
  expect((await page.request.post(`/api/projects/${p7id}/ops`, { data: { batch: p7Batch } })).status()).toBe(201);
  await page.goto(`/projects/${p7id}/editor`);
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await settled(page);
  const p7Inspector = page.getByRole('complementary', { name: 'Inspector' });
  for (let depth = 1; depth <= 3; depth++) {
    const closed = tree.locator(`[role="treeitem"][aria-level="${String(depth)}"][aria-expanded="false"]`);
    while ((await closed.count()) > 0) await closed.first().click();
  }
  for (const [group, item] of [[/^Roofs/, /^Hip roof\b/], [/^Stairs/, /^Stair\b/]] as const) {
    const g = tree.getByRole('treeitem', { name: group });
    if ((await g.getAttribute('aria-expanded')) === 'false') await g.click();
    await tree.getByRole('treeitem', { name: item }).first().click();
    if (group.source === '^Roofs') {
      await expect(p7Inspector.getByRole('group', { name: 'Edges, numbered as on the plan' })).toBeVisible();
      await expect(page.locator('[data-roof-edges] [data-edge="1"]')).toBeVisible();
      await audit(page, 'editor, a roof selected: its edges numbered (Core 0.3)');
    } else {
      await expect(p7Inspector.getByRole('combobox', { name: 'Form' })).toContainText('L-shaped');
      await audit(page, 'editor, a stair selected (Core 0.4)');
      await p7Inspector.getByRole('combobox', { name: 'Form' }).click();
      await page.getByRole('option', { name: 'Winder', exact: true }).click();
      await expect(page.locator('[data-stair="ST1"] .fs-stair__step--winder')).toHaveCount(3);
      await audit(page, 'editor, a winder stair selected: its tinted winders (Core 0.4)');
    }
  }
  await page.goto(`/projects/${house}/editor`);
  await expect(page.locator('.fs-statusbar')).toContainText('Live');
  await settled(page);
  // Back on the house, its walls listed again in the tree, as the tour left them.
  const houseWalls = tree.getByRole('treeitem', { name: /^Walls/ });
  if ((await houseWalls.getAttribute('aria-expanded')) === 'false') await houseWalls.click();

  // The command palette.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('combobox', { name: 'Search commands and the plan' })).toBeFocused();
  await page.keyboard.type('room');
  await audit(page, 'editor, command palette');
  await page.keyboard.press('Escape');

  // A rejected edit: the diagnostics banner. A room anchor outside every closed space is refused.
  const svg = page.getByRole('application', { name: /^Plan of / });
  const box = await svg.boundingBox();
  if (box === null) throw new Error('the plan canvas has no box');
  await rail.getByRole('button', { name: 'Name a room' }).click();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.fs-reject')).toBeVisible();
  await audit(page, 'editor, a rejected edit');
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Select' }).click();

  // The prompt removing a wall between two rooms asks which room keeps the space.
  await page.getByRole('treeitem', { name: /^Wall WI2\b/ }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: /^Remove / })).toBeVisible();
  await audit(page, 'editor, remove-wall prompt');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');

  // An agent's proposal, live: drawn over the plan, the proposal panel open.
  const minted = await page.request.post('/api/tokens', { data: { projectId: house, name: 'Axe agent', kind: 'agent' } });
  expect(minted.status()).toBe(201);
  const agent = await asAgent(baseURL, ((await minted.json()) as { token: string }).token);
  const propose = async (name: string, batch: unknown[]) => {
    const res = await agent.post(`/api/projects/${house}/changesets`, { data: { name, batch } });
    expect(res.status(), await res.text()).toBe(201);
  };
  const panel = page.getByRole('complementary', { name: 'Proposal' });
  await propose('Bigger bedroom', [
    { op: 'moveWall', wall: 'WI2', by: 12 * 32_512 },
    { op: 'setProperty', id: 'LIV', path: '/name', value: 'Great room' },
  ]);
  await expect(panel.getByRole('heading', { name: 'Bigger bedroom' })).toBeVisible();
  await expect(panel).toContainText('Pending');
  await audit(page, 'editor, a proposal under review');

  // Main moves underneath it: the proposal is rebased, and accepting asks twice.
  const commit = async (batch: unknown[]) => {
    const res = await page.request.post(`/api/projects/${house}/ops`, { data: { batch } });
    expect(res.status(), await res.text()).toBe(201);
  };
  await commit([{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' }]);
  await expect(panel).toContainText('Rebased');
  await audit(page, 'editor, a rebased proposal');
  await panel.getByRole('button', { name: 'Accept rebased' }).click();
  const confirm = page.getByRole('dialog', { name: /rebased\?$/ });
  await expect(confirm).toBeVisible();
  await audit(page, 'editor, accepting a rebased proposal');
  await confirm.getByRole('button', { name: 'Accept rebased' }).click();
  await expect(panel).toBeHidden();
  await settled(page);

  // A proposal that no longer applies: it names an opening main then removes.
  await propose('Name the bedroom door', [{ op: 'setProperty', id: 'BD', path: '/name', value: 'Bedroom door' }]);
  await expect(panel.getByRole('heading', { name: 'Name the bedroom door' })).toBeVisible();
  await commit([{ op: 'removeElement', id: 'BD' }]);
  await expect(panel).toContainText('Does not apply');
  await audit(page, 'editor, a proposal that no longer applies');
  await panel.getByRole('button', { name: 'Reject' }).click();
  await expect(panel).toBeHidden();

  // One left pending, for the dashboard.
  await propose('Rename the kitchen', [{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Kitchen' }]);
  await expect(panel.getByRole('heading', { name: 'Rename the kitchen' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close the proposal' }).click();
  await expect(panel).toBeHidden();
  await agent.dispose();

  // The history, and two versions compared in the diff view.
  await page.getByRole('button', { name: 'Show the history' }).click();
  const versions = page.getByRole('listbox', { name: 'Versions, newest first' });
  await expect(versions.getByRole('option').first()).toBeVisible();
  await audit(page, 'editor, history');
  await versions.getByRole('option').filter({ hasText: 'Accepted “Bigger bedroom”' }).click();
  const comparison = page.getByRole('complementary', { name: 'Comparison' });
  await expect(comparison.getByRole('heading', { name: /^Compare v\d+ → v\d+$/ })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Legend' })).toBeVisible();
  await audit(page, 'editor, two versions compared');
  await comparison.getByRole('button', { name: 'Back to the plan' }).click();
  await page.getByRole('button', { name: 'Hide the history' }).click();

  // A narrower window: the tree folds away and the inspector floats.
  await page.setViewportSize({ width: 1024, height: 768 });
  const treeToggle = page.getByRole('button', { name: /the project tree$/ });
  await expect(treeToggle).toBeVisible();
  const treeWas = await treeToggle.getAttribute('aria-pressed');
  await audit(page, `editor, tablet width, tree ${treeWas === 'true' ? 'open' : 'folded'}`);
  await treeToggle.click();
  await expect(treeToggle).not.toHaveAttribute('aria-pressed', treeWas ?? '');
  await audit(page, `editor, tablet width, tree ${treeWas === 'true' ? 'folded' : 'open'}`);
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Building systems (FLR-T-5.7): devices on the plan, the device tool, a device, a panel, a
  //    circuit, a switch picking what it controls, clearances and the core-only view.
  const plate = { min: [0, -51200, -76800], max: [32000, 51200, 76800] };
  await commit([
    { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
    { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_plumbing', value: '0.1.0' },
    { op: 'placeElement', id: 'X1', extension: 'FS_electrical', collection: 'panels', host: { mode: 'wallFace', wall: 'WW', side: 'right', at: "4'", height: "5'" }, element: { name: 'P1', fallback: { box: { min: [0, -256000, -512000], max: [128000, 256000, 512000] } }, volts: [120, 240], rating: 200, spaces: 40, clearances: { working: { purpose: 'workingSpace', shape: 'box', min: [0, -512000, -1950720], max: [1280000, 512000, 609280] } } } },
    { op: 'placeElement', id: 'X2', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'WN2', toward: 'Galley', at: "3' from start", height: '42"' }, element: { fallback: { box: plate }, features: ['gfci'] } },
    { op: 'placeElement', id: 'X3', extension: 'FS_electrical', collection: 'switches', host: { mode: 'wallFace', wall: 'WW', side: 'right', at: "8'", height: "4'" }, element: { fallback: { box: plate }, control: 'threeWay', controls: ['X4'] } },
    { op: 'placeElement', id: 'X4', extension: 'FS_electrical', collection: 'lights', host: { mode: 'surface', room: 'Great room', surface: 'ceiling', at: [3 * 390144, 15 * 390144] }, element: { fallback: { box: { min: [-128000, -128000, -192000], max: [128000, 128000, 0] } } } },
    { op: 'placeElement', id: 'X5', extension: 'FS_plumbing', collection: 'waterHeaters', host: { mode: 'surface', room: 'Great room', surface: 'floor', at: [2 * 390144, 2 * 390144] }, element: { fallback: { box: { min: [-358400, -358400, 0], max: [358400, 358400, 1920000] } }, heater: 'storage', energy: 'electric' } },
    { op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C5', value: { panel: 'X1', breaker: 20, volts: 120, space: 1, loads: ['X2'], name: 'Kitchen counter 1' } },
    { op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C6', value: { panel: 'X1', breaker: 15, volts: 120, space: 2, loads: ['X4'], name: 'Lights', protection: ['afci'] } },
  ]);
  await expect(tree.getByRole('treeitem', { name: /^Electrical/ })).toBeVisible();
  await settled(page);
  await audit(page, 'editor, building systems on the plan');
  await page.keyboard.press('e');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'Electrical', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Electrical assistant' })).toBeVisible();
  await audit(page, 'editor, electrical device tool');
  await page.keyboard.press('Escape');
  await pick(/^Electrical/, 'editor, a panel selected', true);
  await page.getByRole('button', { name: /^C5 · Kitchen counter 1/ }).click();
  await expect(page.getByRole('heading', { name: 'C5 · Kitchen counter 1' })).toBeVisible();
  await audit(page, 'editor, a circuit selected');
  await tree.getByRole('treeitem', { name: /^Receptacle X2/ }).click();
  await expect(page.getByRole('heading', { name: 'Receptacle X2' })).toBeVisible();
  await audit(page, 'editor, a receptacle selected');
  await tree.getByRole('treeitem', { name: /^Switch X3/ }).click();
  await page.getByRole('button', { name: 'Pick on the plan' }).click();
  await expect(page.getByRole('button', { name: 'Done picking' })).toBeVisible();
  await audit(page, 'editor, a switch picking what it controls');
  await page.getByRole('button', { name: 'Done picking' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clearances' }).click();
  await page.getByRole('switch', { name: 'Show as core-only' }).click();
  await expect(page.locator('.fs-core-note')).toBeVisible();
  await audit(page, 'editor, clearances and the core-only view');
  await page.getByRole('switch', { name: 'Show as core-only' }).click();
  await page.getByRole('button', { name: 'Clearances' }).click();

  // ── The 3D view (FLR-T-7.5): 3D with its toolbar, the split view with a room selected, a walkthrough.
  await page.goto(`/projects/${house}/editor?view=3d`);
  await page.waitForFunction(() => window.__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await expect(page.getByRole('toolbar', { name: '3D view' })).toBeVisible();
  await audit(page, 'editor, 3D view');
  // FLR-T-12.6: the path-traced still's options.
  await page.getByRole('button', { name: 'Render still' }).click();
  await expect(page.getByRole('dialog', { name: 'Render a still' })).toBeVisible();
  await audit(page, 'editor, render a still');
  await page.getByRole('dialog', { name: 'Render a still' }).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Split' }).click();
  await expect(page.getByText('Selection synced · click in either view')).toBeVisible();
  await page.getByRole('tree').getByRole('treeitem', { name: /^Great room/ }).first().click();
  await expect(page.getByRole('button', { name: 'Walk through from here' })).toBeVisible();
  await audit(page, 'editor, split view with a room selected');
  await page.getByRole('button', { name: 'Walk through from here' }).click();
  await expect(page.getByRole('button', { name: 'Exit walkthrough' })).toBeVisible();
  await audit(page, 'editor, walkthrough');
  await page.getByRole('button', { name: 'Exit walkthrough' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await expect(page.getByRole('application', { name: /^Plan of / })).toBeVisible();

  // ── The schedules (FLR-T-5.8): rooms, and receptacles with their circuits.
  await page.goto(`/projects/${house}/schedules`);
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  await expect(page.getByRole('tabpanel').locator('tbody tr').first()).toBeVisible();
  await audit(page, 'schedules, rooms');
  await page.getByRole('tab', { name: /^Receptacles/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('C5');
  await audit(page, 'schedules, receptacles');

  // ── Code findings with no rule pack installed (FLR-T-6.9): the report, the editor's panel and the
  //    coverage page say nothing was checked; jurisdiction profiles and the builder (FLR-T-6.8).
  //    The states with findings are audited in findings.spec.ts, whose server has packs installed.
  await page.goto(`/projects/${house}/findings`);
  await expect(page.getByRole('heading', { name: 'No rule pack is installed' })).toBeVisible();
  await expect(page.getByTestId('findings-notice')).toBeVisible();
  await audit(page, 'findings report, no pack installed');
  await page.goto(`/projects/${house}/editor?findings=open`);
  await expect(page.getByTestId('findings-panel')).toContainText('No rule pack is installed');
  await audit(page, 'editor, findings panel, no pack installed');
  await page.goto('/rule-packs');
  await expect(page.getByRole('heading', { name: 'No rule pack is installed on this server' })).toBeVisible();
  await audit(page, 'rule packs, none installed');
  await page.goto(`/jurisdictions?project=${house}`);
  await expect(page.getByRole('heading', { name: 'Model Codes (latest)', level: 2 })).toBeVisible();
  await audit(page, 'jurisdiction profiles, the default');
  await page.getByRole('button', { name: 'New profile' }).click();
  await expect(page.getByRole('form', { name: 'New profile' })).toBeVisible();
  await audit(page, 'jurisdiction profiles, the builder');
  await page.getByLabel('Name').fill('');
  await page.getByRole('button', { name: 'Add an amendment' }).click();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await audit(page, 'jurisdiction profiles, the builder with problems');

  // ── The dashboard with a pending proposal and a history.
  await page.goto(`/projects/${house}`);
  await expect(page.getByText('Rename the kitchen')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'dashboard, a pending proposal');

  // ── The brief (FLR-T-4.2) on the blank house: empty, the add-item dialog, items and lines, an
  //    item and a line selected, relating by keyboard; then its layouts (FLR-T-4.3).
  await page.goto(`/projects/${blank}/program`);
  await expect(page.getByRole('heading', { name: 'No brief yet' })).toBeVisible();
  await expect(page.locator('.fs-program__live')).toContainText('Live');
  await audit(page, 'brief, empty');
  await page.getByRole('button', { name: 'Add the first item' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add a brief item' });
  await expect(addDialog).toBeVisible();
  await audit(page, 'brief, add-item dialog');
  await addDialog.getByLabel('Name').fill('Living room');
  await addDialog.getByLabel('Target area').fill('260 sq ft');
  await addDialog.getByRole('button', { name: 'Add item' }).click();
  await expect(addDialog).toBeHidden();
  // The rest of the brief as one batch, the way Claude sends one.
  const briefed = await page.request.post(`/api/projects/${blank}/ops`, {
    data: {
      batch: [
        { op: 'addProgramItem', function: 'kitchen', name: 'Kitchen', targetArea: '140 sq ft' },
        { op: 'addProgramItem', function: 'sleeping', name: 'Bedroom', count: 2, targetArea: '130 sq ft' },
        { op: 'addProgramItem', function: 'bath', name: 'Bath', targetArea: '50 sq ft' },
        { op: 'setAdjacency', a: 'item Kitchen', b: 'item Living room', kind: 'required' },
        { op: 'setAdjacency', a: 'item Bedroom', b: 'item Bath', kind: 'preferred' },
        { op: 'setAdjacency', a: 'item Kitchen', b: 'item Bedroom', kind: 'forbidden' },
      ],
    },
  });
  expect(briefed.status(), await briefed.text()).toBe(201);
  const diagram = page.getByRole('group', { name: 'Bubble diagram: 4 items, 3 lines' });
  await expect(diagram).toBeVisible();
  await audit(page, 'brief and bubble diagram');
  await diagram.getByRole('button', { name: /^Kitchen, / }).focus();
  await page.keyboard.press('Enter');
  const briefInspector = page.getByRole('complementary', { name: 'Brief inspector' });
  await expect(briefInspector.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await audit(page, 'brief, an item selected');
  await page.keyboard.press('r');
  await expect(page.getByRole('status').filter({ hasText: 'Choose the bubble to relate' })).toBeVisible();
  await audit(page, 'brief, relating by keyboard');
  await page.keyboard.press('Escape');
  await diagram.getByRole('button', { name: /^Kitchen ↔ Bedroom, forbidden/ }).focus();
  await page.keyboard.press('Enter');
  await expect(briefInspector.getByRole('heading', { name: 'Kitchen ↔ Bedroom' })).toBeVisible();
  await audit(page, 'brief, a line selected');
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(diagram).toBeVisible();
  await audit(page, 'brief, tablet width');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('radio', { name: 'Layouts' }).click();
  await expect(page.getByRole('heading', { name: 'No layouts for this version of the plan' })).toBeVisible();
  await audit(page, 'layouts, none yet');
  await page.getByRole('button', { name: 'Solve 3 layouts' }).click();
  const candidates = page.getByRole('list', { name: 'Candidates, best first' }).getByRole('listitem');
  await expect(candidates.first()).toBeVisible({ timeout: 30_000 });
  await expect(candidates.first().getByRole('img')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'layouts, candidates');
  await page.goto(`/projects/${blank}`);
  await expect(page.locator('[data-region="brief"]').getByRole('button', { name: 'Open the brief' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'dashboard, a brief and layout candidates');

  // ── Signed out: sign in, refused, and the two-factor step.
  await page.getByRole('button', { name: /Axe Tester/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to D3 Floorspec' })).toBeVisible();
  await audit(page, 'sign in');
  await page.getByLabel('Email').fill('axe@example.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Sign-in failed')).toBeVisible();
  await audit(page, 'sign in, refused');
  await page.getByRole('textbox', { name: 'Password' }).fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Authentication code')).toBeVisible();
  await audit(page, 'sign in, two-factor code');

  // ── An invite, followed by somebody with no account.
  const stranger = await browser.newContext({ baseURL });
  const invited = await stranger.newPage();
  await invited.goto(new URL(inviteLink).pathname);
  await expect(invited.getByRole('heading', { name: 'Join D3 Floorspec' })).toBeVisible();
  await invited.waitForLoadState('networkidle');
  await audit(invited, 'accept an invite');
  await invited.goto('/invite/not-a-real-invite');
  await expect(invited.getByRole('heading', { name: 'This invite cannot be used' })).toBeVisible();
  await audit(invited, 'an invite that cannot be used');
  await stranger.close();

  // Each theme really was a theme: no page background the light theme drew is one the dark drew.
  const light = [...(backgrounds['light'] ?? [])];
  const dark = [...(backgrounds['dark'] ?? [])];
  expect(light.length * dark.length).toBeGreaterThan(0);
  expect(light.filter((c) => dark.includes(c)), `light ${light.join(', ')} vs dark ${dark.join(', ')}`).toEqual([]);
});

test.afterAll(() => {
  if (findings.length > 0) {
    console.log(`\n${String(findings.length)} violation(s):\n${findings.map((f) => `  [${f.state} · ${f.theme}] ${f.violation}`).join('\n')}`);
  }
  console.log(`audited ${String(audited.size)} states × ${String(THEMES.length)} themes`);
});
