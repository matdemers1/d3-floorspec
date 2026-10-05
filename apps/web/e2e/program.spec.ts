import { expect, test, type Locator, type Page } from '@playwright/test';
import { check } from '@floorspec/engine';
import { firstRunSetup, password, projectIn, settled } from './support.js';

/**
 * FLR-T-4.2 and FLR-T-4.3, as the P4 exit demo runs them: enter a brief, draw its bubble diagram,
 * get at least three ranked layout candidates, pick one, and see every brief item linked to a room
 * with no unmet-brief findings. Items are added through the dialog; the three lines are drawn the
 * three ways the canvas offers — by keyboard (R, then the other bubble), by dragging one bubble onto
 * another, and from the inspector's "Relate to" — and typed in the inspector. Every step is checked
 * in the model the server holds, and the last one by the engine itself.
 */

interface Program {
  floorspec: string;
  program?: { items: Record<string, { name?: string; function: string; count?: number }>; adjacency?: { a: string; b: string; kind: string }[] };
  rooms?: Record<string, { brief?: string }>;
}

async function modelOf(page: Page, project: string): Promise<Program> {
  const res = await page.request.get(`/api/projects/${project}/model.json`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Program;
}

const bubble = (page: Page, name: string): Locator => page.getByRole('group', { name: /^Bubble diagram/ }).getByRole('button', { name: new RegExp(`(^|to )${name}, `) });

async function addItem(page: Page, o: { name: string; fn?: string; area: string; count?: number }): Promise<void> {
  const brief = page.getByRole('complementary', { name: 'Brief table' });
  const first = brief.getByRole('button', { name: 'Add the first item' });
  await ((await first.isVisible()) ? first : brief.getByRole('button', { name: 'Add item' })).click();
  const dialog = page.getByRole('dialog', { name: 'Add a brief item' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill(o.name);
  if (o.fn !== undefined) {
    await dialog.getByRole('combobox', { name: 'Function' }).click();
    await page.getByRole('option', { name: o.fn, exact: true }).click();
  }
  await dialog.getByLabel('Target area').fill(o.area);
  if (o.count !== undefined) await dialog.getByLabel('How many').fill(String(o.count));
  await dialog.getByRole('button', { name: 'Add item' }).click();
  await expect(dialog).toBeHidden();
  await expect(brief.getByRole('button', { name: o.name, exact: true })).toBeVisible();
  await settled(page);
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.locator('circle').first().boundingBox();
  if (box === null) throw new Error('no bubble');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('the P4 exit demo: a brief, its bubble diagram, three layouts, one accepted, the brief met', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Brief Writer', email: 'brief@example.test', password: password('brief') });

  // ── A blank project, and its brief from the dashboard.
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('Exit demo');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Exit demo', level: 1 })).toBeVisible();
  const project = projectIn(page.url());
  await page.locator('[data-region="brief"]').getByRole('button', { name: 'Write the brief' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/program$`));
  await expect(page.getByRole('heading', { name: 'No brief yet' })).toBeVisible();

  // ── The brief: two bedrooms, a bath, a kitchen and a living room.
  await addItem(page, { name: 'Living room', fn: 'Living', area: '260 sq ft' });
  await addItem(page, { name: 'Kitchen', fn: 'Kitchen', area: '140' });
  await addItem(page, { name: 'Bedroom', area: '130 sq ft', count: 2 });
  await addItem(page, { name: 'Bath', fn: 'Bath', area: '50 sq ft' });
  let doc = await modelOf(page, project);
  expect(doc.floorspec).toBe('0.3');
  const ids: Record<string, string> = Object.fromEntries(Object.entries(doc.program?.items ?? {}).map(([id, item]): [string, string] => [item.name ?? id, id]));
  expect(Object.keys(ids).sort()).toEqual(['Bath', 'Bedroom', 'Kitchen', 'Living room']);
  expect(doc.program?.items[ids['Bedroom'] ?? '']).toMatchObject({ function: 'sleeping', count: 2 });
  await expect(page.getByRole('complementary', { name: 'Brief table' })).toContainText('4 items');

  // ── Kitchen–Living room by keyboard: R on one bubble, Enter on the other; then typed Required.
  await bubble(page, 'Kitchen').focus();
  await page.keyboard.press('r');
  await expect(page.getByRole('status').filter({ hasText: 'Choose the bubble to relate' })).toBeVisible();
  await bubble(page, 'Living room').focus();
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Brief inspector' });
  await expect(inspector.getByRole('heading', { name: 'Kitchen ↔ Living room' })).toBeVisible();
  await settled(page);
  await inspector.getByRole('radio', { name: 'Required' }).click();
  await expect(inspector.getByText('Adjacency · required')).toBeVisible();
  await settled(page);

  // Undo takes the kind back, Redo restores it: the brief's edits are the plan's history.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect.poll(async () => (await modelOf(page, project)).program?.adjacency?.map((a) => a.kind)).toEqual(['preferred']);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await expect.poll(async () => (await modelOf(page, project)).program?.adjacency?.map((a) => a.kind)).toEqual(['required']);

  // ── Bedroom–Bath by dragging one bubble onto the other: a preferred line.
  const from = await center(bubble(page, 'Bedroom'));
  const to = await center(bubble(page, 'Bath'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect(inspector.getByRole('heading', { name: 'Bedroom ↔ Bath' })).toBeVisible();
  await settled(page);

  // ── Kitchen–Bedroom from the inspector's "Relate to", typed Forbidden.
  await bubble(page, 'Kitchen').focus();
  await page.keyboard.press('Enter');
  await expect(inspector.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await inspector.getByRole('combobox', { name: 'Relate Kitchen to' }).click();
  await page.getByRole('option', { name: 'Bedroom', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Kitchen ↔ Bedroom' })).toBeVisible();
  await settled(page);
  await inspector.getByRole('radio', { name: 'Forbidden' }).click();
  await expect(inspector.getByText('Adjacency · forbidden')).toBeVisible();
  await settled(page);

  doc = await modelOf(page, project);
  const pair = (a: string, b: string) => [ids[a], ids[b]].sort().join('|');
  expect((doc.program?.adjacency ?? []).map((x) => `${[x.a, x.b].sort().join('|')} ${x.kind}`).sort()).toEqual(
    [`${pair('Kitchen', 'Living room')} required`, `${pair('Bedroom', 'Bath')} preferred`, `${pair('Kitchen', 'Bedroom')} forbidden`].sort(),
  );

  // ── Solve: at least three ranked candidates, each a changeset.
  await inspector.getByRole('button', { name: 'Solve 3 layouts' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/layouts$`), { timeout: 30_000 });
  const cards = page.getByRole('list', { name: 'Candidates, best first' }).getByRole('listitem');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('heading', { name: /^\d+ layouts from your brief$/ })).toBeVisible();
  await expect(cards.first()).toContainText('Best fit');
  const pending = ((await (await page.request.get(`/api/projects/${project}/changesets`)).json()) as { changesets: { name: string }[] }).changesets;
  expect(pending.filter((c) => /^Layout \d+ of \d+ \(/.test(c.name)).length).toBe(await cards.count());

  // ── Pick the best: open it as a changeset in the plan, and accept it.
  await cards.first().getByRole('button', { name: 'Open as changeset' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor`));
  const panel = page.getByRole('complementary', { name: 'Proposal' });
  await expect(panel.getByRole('heading', { name: /^Layout 1 of/ })).toBeVisible();
  await panel.getByRole('button', { name: 'Accept changeset' }).click();
  await expect(panel.getByRole('heading', { name: /^Layout 1 of/ })).toBeHidden();
  await settled(page);

  // ── The brief is met: every item has a room, and the engine finds nothing unmet.
  doc = await modelOf(page, project);
  const result = check(doc);
  expect(result.valid).toBe(true);
  const items = result.derived?.program?.items ?? {};
  expect(Object.keys(items).sort()).toEqual(Object.values(ids).sort());
  for (const [id, item] of Object.entries(items)) {
    expect(item.rooms.length, id).toBeGreaterThan(0);
    expect(item.countMet, id).toBe(true);
  }
  expect(result.diagnostics.filter((d) => ['FS-LINT-008', 'FS-LINT-009', 'FS-LINT-010', 'FS-LINT-011'].includes(d.code))).toEqual([]);
  for (const room of Object.values(doc.rooms ?? {})) if (room.brief !== undefined) expect(Object.values(ids)).toContain(room.brief);

  // The brief says so too, and the other candidates are offered for discarding.
  await page.getByRole('button', { name: 'Brief', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/program$`));
  const table = page.getByRole('table');
  await expect(table.getByText('Needs a room')).toHaveCount(0);
  await expect(table.getByText(/ of \d$/)).toHaveCount(0);
  await page.getByRole('radio', { name: 'Layouts' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/layouts$`));
  await expect(page.getByText(/^“Layout 1 of .*” is in the plan$/)).toBeVisible();
  await page.getByRole('button', { name: /^Discard the other/ }).click();
  await expect(page.getByText(/^“Layout 1 of .*” is in the plan$/)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'A candidate is in the plan' })).toBeVisible();
  await expect.poll(async () => ((await (await page.request.get(`/api/projects/${project}/changesets`)).json()) as { changesets: unknown[] }).changesets).toEqual([]);
});
