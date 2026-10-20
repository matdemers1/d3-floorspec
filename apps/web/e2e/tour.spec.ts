/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync } from 'node:fs';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';
import { firstRunSetup, settled } from './support.js';

/**
 * FLR-T-14.2: a virtual tour (the board's "14.2 · Make a virtual tour" and the tour viewer on a
 * phone). The Courtyard House with a saved view in its kitchen: Share ▸ Virtual tour… lists its rooms
 * — garages, closets and the outdoors left out, the entry first, the kitchen seen from its saved view —
 * three are toured as a small draft, and Render makes the job and its link at once; the job card
 * counts the panoramas and shows the link. Opened on a phone with no account, the tour starts in the
 * entry: dragged to look round, a hotspot walks to the great room still facing the way you went, the
 * map shows the level and the way you face, the plan sheet's room list walks to the kitchen, the
 * arrow keys turn the view. axe passes on the dialog, the job card, the viewer and the plan sheet in
 * both themes; screenshots land in test-results/tour-*.png and the panoramas in test-results/tour-pano-*.jpg.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const M = 1_280_000;
const p = (x: number, y: number, z: number) => [Math.round(x * M), Math.round(y * M), Math.round(z * M)];

function withKitchenView(): Record<string, unknown> {
  const doc = structuredClone(HOUSE) as { extensionsUsed: Record<string, string>; extensions: Record<string, unknown> };
  doc.extensionsUsed['FS_views'] = '0.1.0';
  doc.extensions['FS_views'] = { views: { SV4: { name: 'Kitchen', eye: p(12.8, 16.2, 1.6), target: p(17, 17.5, 0.9), focalLength: 24, aspect: '4:5' } } };
  return doc;
}

const OWNER = { name: 'Agent of the house', email: 'tour@example.test', password: 'tour-owner-e2e-only' };

async function themed(page: Page, each: (theme: 'light' | 'dark') => Promise<void>): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The theme's colours ease in: wait them out before a screenshot or a contrast check.
    await page.waitForTimeout(800);
    await each(theme);
  }
}

async function axe(page: Page, state: string): Promise<void> {
  await themed(page, async (theme) => {
    // The panorama's canvas is aria-hidden; the plan's pins repeat the room list, which is the way in.
    const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('.fs-tour__canvas').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
  });
}

const yawOf = async (page: Page) => Number(await page.locator('.fs-tour').getAttribute('data-yaw'));

test('a virtual tour: made in the editor, shared as one link, walked on a phone', async ({ page, browser, baseURL }) => {
  test.setTimeout(420_000);
  await firstRunSetup(page, OWNER);
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(withKitchenView())),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);

  // ── Share ▸ Virtual tour…
  await page.locator('.fs-topbar__share').click();
  const share = page.getByRole('dialog', { name: /^Share / });
  await share.getByRole('button', { name: 'Virtual tour…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a virtual tour' });
  const rooms = dialog.getByRole('list', { name: /^Rooms · / });
  await expect(rooms).toBeVisible();
  // Garages, closets, the pantry and the roof deck are left out; the entry opens the tour.
  await expect(rooms).toHaveAccessibleName('Rooms · 16 of 20');
  for (const out of ['Garage', 'Pantry', 'Primary closet', 'Roof deck']) await expect(dialog.getByRole('checkbox', { name: out })).not.toBeChecked();
  await expect(rooms.getByRole('listitem').first()).toContainText('Entry');
  await expect(rooms.getByRole('listitem').first()).toContainText('Starts here');
  // The kitchen is seen from the saved view standing in it.
  await expect(dialog.getByRole('combobox', { name: 'Where Kitchen is seen from' })).toContainText('Saved view · Kitchen');
  await axe(page, 'make a virtual tour');
  await page.screenshot({ path: 'test-results/tour-dialog.png' });

  // Three rooms, as a small draft.
  const keep = new Set(['Entry', 'Great room', 'Kitchen']);
  for (const item of await rooms.getByRole('listitem').all()) {
    const box = item.getByRole('checkbox');
    const label = (await item.locator('label').first().textContent())?.trim() ?? '';
    const on = (await box.getAttribute('aria-checked')) === 'true' || (await box.getAttribute('data-state')) === 'checked';
    if (on !== keep.has(label)) await box.click();
  }
  await expect(rooms).toHaveAccessibleName('Rooms · 3 of 20');
  await expect(dialog).toContainText('3 panoramas · 2 doorways linked');
  await dialog.getByRole('combobox', { name: 'Panorama' }).click();
  await page.getByRole('option', { name: '1024 × 512 · draft' }).click();
  await dialog.getByRole('button', { name: 'Render 3 panoramas and share' }).click();

  // ── The job card: the panoramas counted, the link at once.
  const card = dialog.getByRole('region', { name: 'Tour job' });
  await expect(card).toBeVisible();
  const url = await dialog.getByTestId('tour-url').inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}\/tour$/);
  await expect(card.getByRole('heading', { name: 'Tour ready' })).toBeVisible({ timeout: 240_000 });
  await expect(card).toContainText('3 panoramas · 2 doorways linked');
  await card.getByRole('button', { name: 'QR code' }).click();
  await expect(card.getByRole('img', { name: 'QR code of the tour’s link' })).toBeVisible();
  await axe(page, 'tour ready');
  await page.screenshot({ path: 'test-results/tour-job.png' });

  // The panoramas themselves, kept beside the screenshots.
  const path = new URL(url).pathname;
  const answer = (await (await page.request.get(`/api${path.replace(/^\/s\//, '/share/')}`)).json()) as { manifest: { rooms: { id: string; pano: string }[] } };
  for (const room of answer.manifest.rooms) {
    const pano = await page.request.get(`/api${path.replace(/^\/s\//, '/share/')}/${room.pano}`);
    expect(pano.headers()['content-type']).toBe('image/jpeg');
    writeFileSync(`test-results/tour-${room.pano}`, await pano.body());
  }

  // ── On a phone, with no account.
  const phone = await browser.newContext({ ...devices['iPhone 15'], baseURL: baseURL! });
  const viewer = await phone.newPage();
  await viewer.goto(path);
  const tour = viewer.locator('.fs-tour');
  await expect(tour).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(tour).toHaveAttribute('data-room', 'R5');
  await expect(viewer.getByRole('heading', { name: 'Entry', level: 1 })).toBeVisible();
  await expect(viewer.getByText('Courtyard House · Main floor · 1 of 3')).toBeVisible();
  await expect(viewer.getByText('Drag or turn your phone to look · tap a doorway')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Map of the Main floor: you are in the Entry/ })).toBeVisible();
  await themed(viewer, async (theme) => { await viewer.screenshot({ path: `test-results/tour-phone-entry-${theme}.png` }); });

  // Dragged: the view turns, and the hint goes.
  const surface = viewer.getByRole('application', { name: /^Panorama of the / });
  await expect(surface).toHaveAccessibleName(/^Panorama of the Entry/);
  const box = (await surface.boundingBox())!;
  const before = await yawOf(viewer);
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await viewer.mouse.down();
  for (let i = 1; i <= 8; i++) await viewer.mouse.move(box.x + box.width / 2 - i * 15, box.y + box.height / 2);
  await viewer.mouse.up();
  const after = await yawOf(viewer);
  expect(Math.abs(after - before)).toBeGreaterThan(10);
  await expect(viewer.getByText('Drag or turn your phone to look · tap a doorway')).toBeHidden();

  // A hotspot at the doorway: turned to face it, then tapped — into the great room, facing the way we walked.
  const hotspot = viewer.getByRole('button', { name: 'Go to the Great room' });
  for (let tries = 0; tries < 12 && !(await hotspot.isVisible()); tries++) {
    await surface.focus();
    await viewer.keyboard.press('Shift+ArrowRight');
  }
  await expect(hotspot).toBeVisible();
  await hotspot.click();
  await expect(tour).toHaveAttribute('data-room', 'R7');
  await expect(tour).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(viewer.getByRole('heading', { name: 'Great room', level: 1 })).toBeVisible();
  await expect(viewer.getByText('Courtyard House · Main floor · 2 of 3')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Map of the Main floor: you are in the Great room/ })).toBeVisible();
  const facing = await yawOf(viewer);
  await expect(viewer.locator('.fs-tour-map__you')).toHaveAttribute('data-heading', facing.toFixed(0));
  await themed(viewer, async (theme) => { await viewer.screenshot({ path: `test-results/tour-phone-great-room-${theme}.png` }); });
  await axe(viewer, 'tour viewer');

  // The arrow keys turn it on a computer, five degrees a press.
  await surface.focus();
  await viewer.keyboard.press('ArrowRight');
  expect(((await yawOf(viewer)) - facing + 540) % 360 - 180).toBeCloseTo(5, 0);

  // ── The plan sheet: the room list walks to the kitchen.
  await viewer.getByRole('button', { name: 'Open the plan', exact: true }).click();
  const sheet = viewer.getByRole('dialog', { name: 'Courtyard House' });
  await expect(sheet).toBeVisible();
  const list = sheet.getByRole('navigation', { name: 'Rooms on the Main floor' });
  await expect(list.getByRole('button', { name: 'Great room' })).toHaveAttribute('aria-current', 'true');
  await expect(sheet).toContainText('Panoramas are 1024 × 512, path-traced on Jun 21 at 3:00 pm.');
  await themed(viewer, async (theme) => { await viewer.screenshot({ path: `test-results/tour-phone-plan-${theme}.png` }); });
  await axe(viewer, 'tour plan sheet');
  await list.getByRole('button', { name: 'Kitchen' }).click();
  await expect(sheet).toBeHidden();
  await expect(tour).toHaveAttribute('data-room', 'R8');
  await expect(tour).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(viewer.getByRole('heading', { name: 'Kitchen', level: 1 })).toBeVisible();
  await themed(viewer, async (theme) => { await viewer.screenshot({ path: `test-results/tour-phone-kitchen-${theme}.png` }); });

  // A reload stays in the room.
  await viewer.reload();
  await expect(tour).toHaveAttribute('data-room', 'R8');
  await phone.close();
});
