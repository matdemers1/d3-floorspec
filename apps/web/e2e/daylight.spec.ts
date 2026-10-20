import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-14.7: daylight you can see — the board's frames "14.7 · Daylight in 3D" and "14.7 · Daylight
 * on the plan" on the Courtyard House (Atlanta), read on a clock in America/New_York.
 *
 * Daylight on the Experiences cluster; Jun 21 and then Dec 21 at 3 pm; the legend's four named bands
 * and the advisory alert; the study path-traced by the api's inline drain; glare flags at the den's
 * desk and, a level up, the primary bed; on the plan the overlay, its chip, the legend and the
 * June-against-December card with the den and the primary bedroom; the room inspector's daylight
 * rows; axe in both themes. Screenshots land in test-results/daylight-*.png.
 */

test.use({ timezoneId: 'America/New_York' });

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
type Hook = { __floorspec3d?: { ready: boolean } };

/** The theme switched and settled: no CSS transition still running (as edit3d.spec.ts waits). */
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

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(700);
    await themeSettled(page);
    await page.screenshot({ path: `test-results/daylight-${name}-${theme}.png` });
  }
}

/** The study for the clock shown has arrived: the panel says how it was made, or the plan's chip stops tracing. */
async function studied(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: /Path tracer · 64 spp/ })).toBeVisible({ timeout: 120_000 });
}

test('daylight: Jun 21 and Dec 21 at 3 pm — bands, the advisory, glare at the den desk and the primary bed, on the plan and in 3D, axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Daylight', email: 'daylight@example.test', password: password('daylight') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });

  // ── Daylight, from the Experiences cluster.
  const cluster = page.getByRole('toolbar', { name: 'Experiences' });
  const button = cluster.getByRole('button', { name: 'Daylight' });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'Daylight', exact: true });
  await expect(panel).toBeVisible();
  // Advisory, first and always — and never the word FLR-ADR-011 forbids.
  await expect(panel.getByText('Advisory, not a compliance check.')).toBeVisible();
  await expect(panel).not.toContainText(/\bcompliant\b/i);
  // Four named bands, not a rainbow, on the work plane 2′-6″ up.
  const legend = panel.getByRole('list', { name: /On the work plane/ });
  await expect(legend.getByRole('listitem')).toHaveText([/Bright — glare likely\s*over 3,000 lx/, /Useful daylight\s*300–3,000 lx/, /Needs a lamp for tasks\s*100–300 lx/, /Dim\s*under 100 lx/]);

  // ── June 21, 3 pm.
  await panel.getByRole('button', { name: 'Jun 21', exact: true }).click();
  await panel.getByLabel('Time of day').fill('900');
  await expect(panel.getByLabel('Date at the site')).toHaveValue(/-06-21$/);
  await expect(panel.locator('.fs-daylight__clock')).toHaveText('3:00 pm');
  await studied(page);
  // The study is laid on the main floor, and the den's desk flagged with the hours the sun is on it.
  const marks = page.getByRole('list', { name: 'Glare at desks and beds' });
  await expect(marks.locator('[data-mark="DEN-DESK"]')).toContainText(/Den desk · (low )?sun \d/);
  const june = await page.evaluate(async (id) => (await (await fetch(`/api/projects/${id}/daylight?at=2026-06-21T15:00-04:00`)).json()) as { glare: { id: string }[]; rooms: { id: string; median: number }[] }, project);
  expect(june.glare.map((g) => g.id)).toEqual(expect.arrayContaining(['DEN-DESK', 'PB-BED']));
  await shoot(page, '3d-june-l1');
  await axe(page, 'daylight panel, June, in 3D');

  // A level up: the primary bedroom, its bed flagged.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('PageUp');
  await expect(marks.locator('[data-mark="PB-BED"]')).toContainText(/Primary bed · (low )?sun \d/);
  await shoot(page, '3d-june-l2');

  // ── December 21, 3 pm.
  await panel.getByRole('button', { name: 'Dec 21', exact: true }).click();
  await expect(panel.getByLabel('Date at the site')).toHaveValue(/-12-21$/);
  await studied(page);
  await expect(marks.locator('[data-mark="PB-BED"]')).toContainText(/Primary bed · (low )?sun \d/);
  await shoot(page, '3d-december-l2');

  // ── Compare with June, then the plan.
  await panel.getByRole('button', { name: /Compare with Jun 21/ }).click();
  await page.getByRole('radio', { name: '2D plan' }).click();
  await expect(page.locator('[data-daylight="L2"]')).toBeAttached();
  const chip = page.getByRole('group', { name: 'Daylight' });
  await expect(chip).toContainText('Daylight · Dec 21 · 3:00 pm · clear');
  const card = page.locator('.fs-daylight__compare');
  await expect(card.getByRole('heading')).toHaveText(/Jun 21 vs Dec 21 · 3:00 pm/, { timeout: 120_000 });
  await expect(card.locator('tr[data-room="R17"]')).toContainText('Primary bedroom');
  await expect(card.locator('tr[data-room="R6"]')).toContainText('Den');
  await expect(card.locator('tr[data-room="R6"] [role="img"]').first()).toHaveAttribute('aria-label', /% useful daylight/);
  // The legend stays on screen on the plan, with the advisory.
  await expect(page.getByRole('list', { name: /Work plane 2′-6″ · advisory/ }).getByRole('listitem')).toHaveCount(4);
  await expect(page.locator('.fs-daylight__flags [data-glare="PB-BED"]')).toBeVisible();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+Digit1');
  await shoot(page, 'plan-l2-december');

  // The primary bedroom and the den, each on a December and a June afternoon.
  const chipDone = async (day: string) => {
    await expect(chip).toContainText(`Daylight · ${day} · 3:00 pm · clear`);
    await expect(chip.getByRole('status')).toHaveCount(0, { timeout: 120_000 });
  };
  // A close-up of a room, the comparison put aside so the room and its flag are in view, then back.
  const comparing = page.locator('.fs-daylight__plan-legend').getByRole('button');
  const closeUp = async (room: RegExp, name: string) => {
    await page.getByRole('treeitem', { name: room }).first().click();
    await page.locator('.fs-editor').focus();
    await page.keyboard.press('Shift+Digit2');
    await comparing.click();
    await expect(card).toHaveCount(0);
    await page.waitForTimeout(800);
    await shoot(page, name);
    await comparing.click();
    await expect(card.getByRole('heading')).toHaveText(/Jun 21 vs Dec 21 · 3:00 pm/);
  };
  await closeUp(/^Primary bedroom/, 'primary-bedroom-december');
  await card.getByRole('button', { name: 'Swap' }).click();
  await chipDone('Jun 21');
  await expect(page.locator('.fs-daylight__flags [data-glare="PB-BED"]')).toContainText(/Primary bed · (low )?sun \d/);
  await closeUp(/^Primary bedroom/, 'primary-bedroom-june');

  await closeUp(/^Den/, 'den-june');
  await expect(page.locator('[data-daylight="L1"]')).toBeAttached();
  await expect(page.locator('.fs-daylight__flags [data-glare="DEN-DESK"]')).toContainText(/Den desk · (low )?sun \d/);
  await card.getByRole('button', { name: 'Swap' }).click();
  await chipDone('Dec 21');
  await expect(page.locator('.fs-daylight__flags [data-glare="DEN-DESK"]')).toContainText(/Den desk/);
  await closeUp(/^Den/, 'den-december');
  await axe(page, 'daylight on the plan, December against June, the den selected');

  // The den in the inspector: its bands, median, sun-hours and glare.
  const room = page.getByRole('region', { name: /Daylight at Dec 21, 3:00 pm · clear sky/ });
  await expect(room).toContainText('Useful daylight');
  await expect(room).toContainText(/Median\s*[\d,]+ lx/);
  await expect(room).toContainText(/Sun-hours a year\s*[\d,]+ h on the floor/);
  await expect(room).not.toContainText(/\bcompliant\b/i);

  // Sun-hours over a year, the panel's other choice, drawn in the same four colours with their own names.
  // Back in 3D, the panel is where it was left.
  await page.getByRole('radio', { name: '3D' }).click();
  await expect(page.getByRole('region', { name: 'Daylight', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Daylight', exact: true }).getByRole('radio', { name: 'Sun-hours · year' }).click();
  await expect(page.getByRole('list', { name: /Direct sun on the work plane · a year/ }).getByRole('listitem')).toHaveText([/Sun most days/, /Some sun/, /A little sun/, /No direct sun/]);
  await shoot(page, '3d-sun-hours');

  // ⌥D hides it, and nothing of it is left — in 3D or on the plan.
  await page.locator('.fs-three__gl').focus();
  await page.keyboard.press('Alt+KeyD');
  await expect(page.getByRole('region', { name: 'Daylight', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: '2D plan' }).click();
  await expect(page.locator('[data-daylight]')).toHaveCount(0);
  await expect(chip).toHaveCount(0);
});
