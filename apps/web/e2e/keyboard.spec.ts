import { expect, test, type Page } from '@playwright/test';

/**
 * FLR-T-3.7's doneWhen, end to end and keyboard only: no click, no hover, no drag — every step is
 * a key press, typed text, or moving focus to a control the way a screen reader's "jump to" does
 * (`locator.focus()`), then keys. From first-run setup it creates a blank project, adds a level,
 * draws four walls by a typed start point and typed lengths aimed with the arrows, adds a door to
 * a wall chosen in the tree, names a room from the command palette, nudges a wall with an arrow
 * key, and undoes the nudge — and checks each step in the model the server holds.
 */

const IN = 32_512;
const FT = 12 * IN;

interface Doc {
  levels?: Record<string, unknown>;
  junctions?: Record<string, { position: [number, number] }>;
  walls?: Record<string, { start: string; end: string; name?: string }>;
  openings?: Record<string, unknown>;
  rooms?: Record<string, { name?: string }>;
}

async function modelOf(page: Page, project: string): Promise<Doc> {
  const res = await page.request.get(`/api/projects/${project}/model.json`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Doc;
}

const count = (c: Record<string, unknown> | undefined) => Object.keys(c ?? {}).length;

async function palette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search commands and the plan' });
  await expect(input).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
}

/** Wait until the editor is not in the middle of an edit. */
async function settled(page: Page) {
  await expect(page.locator('.fs-topbar__title p')).toContainText('saved');
}

test('a house drawn, furnished with a door and a room, nudged and undone — without a pointer', async ({ page }) => {
  // ── First-run setup: the operator account, for this run only.
  await page.goto('/');
  await page.getByLabel('Your name').focus();
  await page.keyboard.type('Keyboard Tester');
  await page.keyboard.press('Tab');
  await page.keyboard.type('keyboard@example.test');
  const password = `kbd-${String(Date.now())}-e2e-only`;
  await page.getByLabel('Password', { exact: true }).focus();
  await page.keyboard.type(password);
  await page.getByLabel('Password again').focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');

  // ── A blank project.
  const newProject = page.getByRole('button', { name: 'New project' }).first();
  await expect(newProject).toBeVisible();
  await newProject.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await page.keyboard.type('Keyboard house');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = /\/projects\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  const open = page.getByRole('button', { name: 'Open editor' }).first();
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor$`));
  await expect(page.getByText('This project has no levels yet')).toBeVisible();
  await expect(page.locator('.fs-statusbar')).toContainText('Live');

  // ── A level, from the command palette.
  await palette(page, 'add a level');
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');
  await settled(page);
  expect(count((await modelOf(page, project)).levels)).toBe(1);

  // ── Four walls: W for the tool, a typed start point, then the arrows aim and lengths are typed.
  await page.keyboard.press('w');
  await page.keyboard.type('0,0');
  await page.keyboard.press('Enter');
  for (const [arrow, length] of [['ArrowRight', `20'`], ['ArrowUp', `12'`], ['ArrowLeft', `20'`], ['ArrowDown', `12'`]] as const) {
    await page.keyboard.press(arrow);
    await page.keyboard.type(length);
    await page.keyboard.press('Enter');
  }
  // Closing the loop commits it: one batch of four drawWall ops.
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);
  let doc = await modelOf(page, project);
  const xs = Object.values(doc.junctions ?? {}).map((j) => j.position[0]);
  const ys = Object.values(doc.junctions ?? {}).map((j) => j.position[1]);
  expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 20 * FT, 0, 12 * FT]);
  await page.keyboard.press('Escape');

  // ── A door: choose a wall in the tree with the arrows, D for the door tool on it, Enter centres it.
  const walls = page.getByRole('treeitem', { name: /^Walls/ });
  await walls.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fs-tree__row.is-selected')).toContainText('Wall');
  // Esc leaves the tree for the plan, keeping the selection.
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await page.keyboard.press('Enter');
  await expect.poll(async () => count((await modelOf(page, project)).openings)).toBe(1);
  await settled(page);
  await page.keyboard.press('Escape');

  // ── A room, named in the closed space from the palette; its name typed into the inspector.
  await palette(page, 'name a room in');
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  const roomName = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(roomName).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Great room');
  await page.keyboard.press('Enter');
  await expect.poll(async () => Object.values((await modelOf(page, project)).rooms ?? {})[0]?.name).toBe('Great room');
  await settled(page);

  // ── Nudge: pick a horizontal wall in the tree, Esc back to the plan, ↑ moves it 1" north.
  doc = await modelOf(page, project);
  const junctions = doc.junctions ?? {};
  const [wallId, wall] = Object.entries(doc.walls ?? {}).find(([, w]) => junctions[w.start]?.position[1] === 0 && junctions[w.end]?.position[1] === 0) ?? [];
  if (wallId === undefined || wall === undefined) throw new Error('no south wall');
  const row = page.getByRole('treeitem', { name: new RegExp(`Wall ${wallId}\\b`) });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await modelOf(page, project)).junctions?.[wall.start]?.position[1]).toBe(IN);
  await settled(page);

  // ── Undo: the nudge is taken back by an appended inverse, not by rewriting the log.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await modelOf(page, project)).junctions?.[wall.start]?.position[1]).toBe(0);
  await settled(page);
  const history = (await (await page.request.get(`/api/projects/${project}/history`)).json()) as { ops: { kind: string }[] };
  expect(history.ops[0]?.kind).toBe('undo');
  expect(history.ops.map((o) => o.kind)).toContain('apply');
  // The door and the room are still there.
  doc = await modelOf(page, project);
  expect([count(doc.walls), count(doc.openings), count(doc.rooms)]).toEqual([4, 1, 1]);
});
