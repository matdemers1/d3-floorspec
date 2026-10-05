// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';
import type { Result } from 'axe-core';
import { firstRunSetup, password, projectIn } from './support.js';

/**
 * FLR-T-9.6, the P9 exit demo's second half: "your architect friend opens a share link, and pins a
 * comment on a wall". The owner makes an expiring link from the dashboard; a browser with no account
 * opens it and sees the plan, the 3D view and the findings with their notice; the architect — an
 * invited account — signs in from the link, comes straight back, and pins a comment on a wall. The
 * owner, with the editor open, sees it arrive live, pinned on the plan, and resolves it. Revoking the
 * link stops it at once, for the viewer already looking and for anyone who opens it after.
 *
 * axe runs on the viewer and on each comment state in both themes, as the a11y suite does: nothing
 * excluded, no rule disabled.
 */

const HOUSE = new URL('./fixtures/p6-demo-house.json', import.meta.url).pathname;
const HOUSE_NAME = (JSON.parse(readFileSync(HOUSE, 'utf8')) as { project: { name: string } }).project.name;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function describe(v: Result): string {
  const nodes = v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}${n.failureSummary === undefined ? '' : ` — ${n.failureSummary.split('\n').slice(1).join(' ').trim()}`}`);
  return `${v.id} (${v.impact ?? '?'}): ${v.help} [${String(v.nodes.length)} node(s)]\n        ${nodes.join('\n        ')}`;
}

async function audit(page: Page, state: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html'), `${state}: the ${theme} theme rendered`).toHaveAttribute('data-theme', theme);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().iterations ?? 1) === Infinity), undefined, { timeout: 5_000 }).catch(() => undefined);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect.soft(results.violations.map(describe), `${state} (${theme})`).toEqual([]);
  }
}

/** Where on the page an element of the level shown is (the viewer's automation hook). */
async function pointOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const handle = await page.waitForFunction((el) => (window as { __floorspecShare?: { screenPoint(id: string): { x: number; y: number } | null } }).__floorspecShare?.screenPoint(el) ?? null, id);
  return (await handle.jsonValue()) as { x: number; y: number };
}

test('an owner shares a house; an architect opens the link, signs in and pins a comment on a wall; the owner resolves it; a revoke ends it', async ({ page, baseURL, browser }) => {
  if (baseURL === undefined) throw new Error('no baseURL');
  test.setTimeout(240_000);

  // ── The owner: first-run setup, the Phase 6 demo house imported, and an invite for the architect.
  await firstRunSetup(page, { name: 'Matthew Demers', email: 'owner@example.test', password: password('owner') });
  await page.getByRole('button', { name: 'Check a Floorspec file' }).click();
  await page.locator('input[type="file"]').setInputFiles(HOUSE);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const invite = await page.request.post('/api/invites', { data: { email: 'dana@example.test' } });
  expect(invite.ok()).toBe(true);
  const inviteToken = new URL(((await invite.json()) as { url: string }).url).pathname.split('/').at(-1) ?? '';
  const danaPassword = password('dana');
  const accepting = await request.newContext({ baseURL });
  expect((await accepting.post(`/auth/invites/${inviteToken}/accept`, { data: { email: 'dana@example.test', displayName: 'Dana K.', password: danaPassword } })).ok()).toBe(true);
  await accepting.dispose();

  // ── 1. The owner makes a link from the dashboard's Share card.
  const card = page.locator('[data-region="share"]');
  await expect(card).toContainText('Not shared');
  await card.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share / });
  await expect(dialog).toContainText('Anyone with a link can view. Commenting needs an account.');
  await dialog.getByLabel('Label').fill('Architect review');
  await audit(page, 'share dialog');
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const url = await dialog.getByTestId('share-url').inputValue();
  expect(url).toMatch(new RegExp(`^${baseURL}/s/[A-Za-z0-9_-]{43}$`));
  await expect(dialog.locator('.fs-share-links__row')).toContainText('Architect review');
  await audit(page, 'share dialog, link made');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(card).toContainText('Architect review');

  // ── 2. Somebody with no account opens it: the plan, the 3D view and the findings, and nothing else.
  const stranger = await browser.newContext({ baseURL });
  const viewer = await stranger.newPage();
  await viewer.goto(url);
  await expect(viewer.getByRole('heading', { level: 1 })).toHaveText(HOUSE_NAME);
  await expect(viewer.locator('.fs-share__title p')).toContainText('Shared by Matthew Demers · view only');
  await expect(viewer.getByRole('application', { name: /^Plan of / })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Sign in to comment' })).toBeVisible();
  // No account's details, no history, no other project, no way into the editor.
  const text = (await viewer.locator('body').innerText()).toLowerCase();
  expect(text).not.toContain('owner@example.test');
  expect(text).not.toContain(project);
  await expect(viewer.getByRole('link', { name: /projects|history|editor/i })).toHaveCount(0);
  await audit(viewer, 'shared viewer, no account');

  await viewer.getByRole('tab', { name: 'Findings' }).click();
  await expect(viewer.getByTestId('findings-notice')).toContainText('not a plan review');
  await viewer.getByRole('button', { name: 'What the installed rule packs check, and what they do not' }).click();
  await expect(viewer.getByRole('region', { name: 'Coverage of the installed rule packs' })).toBeVisible();
  await audit(viewer, 'shared viewer, findings and coverage');

  await viewer.getByRole('radio', { name: '3D' }).click();
  await viewer.waitForFunction(() => (window as { __floorspec3d?: { ready: boolean } }).__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  await expect(viewer.getByRole('main', { name: '3D view' })).toBeVisible();
  await viewer.getByRole('radio', { name: 'Walk' }).click();
  await expect(viewer.getByRole('main', { name: 'Walkthrough' })).toBeVisible();
  await viewer.keyboard.press('Escape');
  await viewer.getByRole('radio', { name: 'Plan' }).click();
  await expect(viewer.getByRole('application', { name: /^Plan of / })).toBeVisible();

  // Comments are read-only without an account.
  await viewer.getByRole('tab', { name: 'Comments' }).click();
  await expect(viewer.getByText('No comments yet')).toBeVisible();
  await audit(viewer, 'shared viewer, comments, signed out');

  // ── 3. The owner opens the editor with the comments column, to watch them arrive.
  await page.goto(`/projects/${project}/editor`);
  await expect(page.locator('.fs-topbar__title p')).toContainText('saved');
  await page.getByRole('button', { name: 'Comments' }).click();
  await expect(page.getByRole('complementary', { name: 'Comments' })).toContainText('No comments yet');

  // ── 4. The architect signs in from the link, comes straight back, and pins a comment on a wall.
  await viewer.getByRole('button', { name: 'Sign in to comment' }).first().click();
  await expect(viewer).toHaveURL(/\/signin$/);
  await viewer.getByLabel('Email').fill('dana@example.test');
  await viewer.getByLabel('Password', { exact: true }).fill(danaPassword);
  await viewer.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(viewer).toHaveURL(url);
  await expect(viewer.locator('.fs-share__you')).toContainText('Dana K.');
  await audit(viewer, 'shared viewer, signed in');

  const wall = await pointOf(viewer, 'W2');
  await viewer.mouse.move(wall.x - 2, wall.y);
  await viewer.mouse.click(wall.x, wall.y);
  await expect(viewer.locator('.fs-comments__context')).toContainText('Pinned to');
  const box = viewer.getByRole('textbox', { name: /^Comment on / });
  await box.fill('Consider a **6"** wall here — you will want a vent stack for the island sink.');
  await audit(viewer, 'shared viewer, a comment pinned and written');
  await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
  const pin = viewer.getByRole('group', { name: 'Comment pins' }).getByRole('button', { name: /^Comment 1 by Dana K\. on Wall W2/ });
  await expect(pin).toBeVisible();
  await expect(viewer.locator('.fs-thread').first()).toContainText('Consider a 6" wall here');
  await expect(viewer.locator('.fs-thread strong').first()).toHaveText('6"');
  await audit(viewer, 'shared viewer, a thread');

  // The server holds it pinned to the wall, at the version the link shows.
  const threads = (await (await page.request.get(`/api/projects/${project}/comments`)).json()) as { threads: { pin: { element: string; level: string; point: [number, number] | null } }[] };
  expect(threads.threads).toHaveLength(1);
  expect(threads.threads[0]?.pin).toMatchObject({ element: 'W2' });
  expect(threads.threads[0]?.pin.point).not.toBeNull();

  // ── 5. The owner sees it arrive, live, in the column and on the plan, and resolves it.
  const column = page.getByRole('complementary', { name: 'Comments' });
  await expect(column).toContainText('Consider a 6" wall here', { timeout: 15_000 });
  await expect(page.getByRole('group', { name: 'Comment pins' }).getByRole('button', { name: /^Comment 1 by Dana K\. on Wall W2/ })).toBeVisible();
  await audit(page, 'editor, comments column');
  await column.getByRole('button', { name: 'Resolve comment 1' }).click();
  await expect(column.locator('.fs-thread').first()).toContainText('Resolved');
  // And the architect sees it resolved, without reloading.
  await expect(viewer.locator('.fs-thread').first()).toContainText('Resolved', { timeout: 15_000 });

  // ── 6. The owner revokes the link: the architect's page says so, and so does a fresh visit.
  await page.goto(`/projects/${project}`);
  await page.locator('[data-region="share"]').getByRole('button', { name: 'Share' }).click();
  const again = page.getByRole('dialog', { name: /^Share / });
  await again.getByRole('button', { name: 'Revoke Architect review' }).click();
  await again.getByRole('button', { name: 'Confirm: revoke Architect review' }).click();
  await expect(again).toContainText('Active links · 0');
  await expect(viewer.getByRole('heading', { name: 'This link was turned off', level: 1 })).toBeVisible({ timeout: 15_000 });
  await audit(viewer, 'shared viewer, revoked');
  const late = await browser.newContext({ baseURL });
  const latePage = await late.newPage();
  await latePage.goto(url);
  await expect(latePage.getByRole('heading', { name: 'This link was turned off', level: 1 })).toBeVisible();
  const api = await latePage.request.get(`${new URL(url).pathname.replace('/s/', '/api/share/')}/model.json`);
  expect(api.status()).toBe(410);
  await late.close();
  await stranger.close();
});
