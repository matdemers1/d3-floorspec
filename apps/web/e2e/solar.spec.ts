/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FT, IN, firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-16.1: solar on the Courtyard House on its street, in Electrical mode — the P16 board's "16.1 · Solar
 * on the roof", "16.1 · Solar assistant" and "16.1 · Solar in 3D" frames.
 *
 * The Solar tool (⇧P) opens the Solar panel: the roof's faces ranked by what a kW makes on them in a year
 * after shade, and what the assistant would add; "Review as changeset" opens it as a pending changeset while
 * main has no array. A click on the guest wing's shed roof picks the face; "Place an array here" lays the
 * largest grid that keeps its setbacks, as ops on main; the array's inspector says its year as a range with
 * its method and an advisory note, never "compliant". Show: Ghost, Off, On. The Solar arrays schedule lists it.
 * In 3D the array lies on its roof, every program within 16 texture units; the Solar layer hides it there too.
 * axe passes in both themes. Screenshots: test-results/solar-*.png (and FLR161_SHOTS, when set).
 */

const ON_ITS_STREET = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// The guest wing's shed roof (RF2, on L1, facing north at 3:12): a point in the middle of its face.
const GUEST_WING: [number, number] = [5_800_000, 2_700_000];

type Arr = { roof: string; face?: number; rows: number; columns: number; module: { watts: number } };
interface Doc {
  extensionsUsed?: Record<string, string>;
  extensions?: { FS_energy?: { collections?: { pvArrays?: Record<string, Arr>; inverters?: Record<string, { arrays?: string[] }> } } };
}
type Hook = { __floorspec3d?: { ready: boolean; arrays: number; programs: { list: { name: string; linked: boolean; samplers: number }[] } } };

const docOf = async (page: Page, project: string): Promise<Doc> => (await (await page.request.get(`/api/projects/${project}/model.json`)).json()) as Doc;
const arrays = (d: Doc): [string, Arr][] => Object.entries(d.extensions?.FS_energy?.collections?.pvArrays ?? {});

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
    await page.waitForTimeout(600);
    await themeSettled(page);
    const path = `test-results/solar-${name}-${theme}.png`;
    await page.screenshot({ path });
    const out = process.env['FLR161_SHOTS'];
    if (out !== undefined && out !== '') {
      mkdirSync(out, { recursive: true });
      copyFileSync(path, `${out}/solar-${name}-${theme}.png`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
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
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Where the pointer is on the plan, as the status bar reads it out. */
async function readout(page: Page, x: number, y: number): Promise<[number, number]> {
  await page.mouse.move(x, y);
  let at: [number, number] | null = null;
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [wx, wy] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map((m) => (m[1] === '-' ? -1 : 1) * (Number(m[2]) * FT + Number(m[3]) * IN + (m[4] === undefined ? 0 : (Number(m[4]) / Number(m[5])) * IN)));
      at = wx === undefined || wy === undefined ? null : [wx, wy];
      return at !== null;
    })
    .toBe(true);
  return at as unknown as [number, number];
}

/** The plan's camera, from two readouts: where a world point (base units) is on the page. */
async function cameraOf(page: Page): Promise<{ at: (p: readonly [number, number]) => { x: number; y: number }; s: number }> {
  const box = (await page.getByRole('application', { name: /^Plan of / }).boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
  const wa = await readout(page, a.x, a.y);
  const wb = await readout(page, b.x, b.y);
  const s = (b.x - a.x) / (wb[0] - wa[0]);
  return { at: (p) => ({ x: a.x + (p[0] - wa[0]) * s, y: a.y - (p[1] - wa[1]) * s }), s };
}

/** The Solar tool on — ⇧P toggles it, so it is pressed only when the Solar panel is not showing. */
async function solarTool(page: Page): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Inspector' }).getByRole('region', { name: 'Solar', exact: true });
  // the pending proposal reopens in the right drawer with the page: close it to see the inspector
  const proposal = page.getByRole('complementary', { name: 'Proposal' });
  if (await proposal.isVisible()) await proposal.getByRole('button', { name: 'Close the proposal' }).click();
  if (await panel.isVisible()) return;
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+KeyP');
}

test('solar: the assistant ranks the faces and opens a changeset, an array placed on the guest wing with its estimate and note, Ghost/Off/On, the schedule, the arrays in 3D — axe in both themes', async ({ page }) => {
  test.setTimeout(480_000);
  await firstRunSetup(page, { name: 'Electrician', email: 'solar@example.test', password: password('solar') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House with solar') },
    data: Buffer.from(JSON.stringify(ON_ITS_STREET)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  // ── Electrical mode: the Solar tool (⇧P) on its rail opens the Solar panel.
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Electrical mode' }).click();
  await expect(page.getByRole('button', { name: 'Solar (⇧P)' })).toBeVisible();
  await page.locator('.fs-editor').focus();
  await page.keyboard.press('Shift+KeyP');
  const panel = inspector.getByRole('region', { name: 'Solar', exact: true });
  await expect(panel).toBeVisible();
  // the faces, ranked by a kW's year: the east wing, the garage's flat roof, the guest wing
  const faces = panel.getByTestId('solar-faces').getByRole('listitem');
  await expect(faces).toHaveCount(3);
  await expect(faces.nth(0)).toContainText('East wing shed roof · faces E');
  await expect(faces.nth(2)).toContainText('Guest wing shed roof · faces N');
  await expect(panel.getByTestId('solar-adds')).toContainText('East wing shed roof');
  await expect(panel.getByTestId('solar-adds')).toContainText('inverter');
  await expect(panel).toContainText('±20%');
  await expect(panel).toContainText('No code is checked or cited');
  await expect(panel).not.toContainText(/compliant/i);
  await axe(page, 'the Solar panel');
  await shoot(page, 'assistant');

  // ── Review as changeset: a pending changeset; main has no array until a person accepts it.
  await panel.getByRole('button', { name: 'Review as changeset' }).click();
  const proposal = page.getByRole('complementary', { name: 'Proposal' });
  await expect(proposal.getByRole('heading', { name: /^Solar on the roof/ })).toBeVisible();
  const { changesets } = (await (await page.request.get(`/api/projects/${project}/changesets`)).json()) as { changesets: { name: string; status?: string }[] };
  expect(changesets.some((c) => c.name.startsWith('Solar on the roof') && (c.status ?? 'pending') === 'pending')).toBe(true);
  expect(arrays(await docOf(page, project))).toEqual([]);
  await proposal.getByRole('button', { name: 'Close the proposal' }).click();
  await expect(inspector).toBeVisible();

  // ── By hand, on main: pick the guest wing's shed roof, and lay an array on it.
  await solarTool(page);
  await expect(inspector.getByRole('region', { name: 'Solar', exact: true })).toBeVisible();
  const cam = await cameraOf(page);
  const at = cam.at(GUEST_WING);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('solar-picked-face')).toBeAttached();
  const solar = inspector.getByRole('region', { name: 'Solar', exact: true });
  await expect(solar.getByTestId('solar-face-fit')).toContainText('kWh a year');
  await solar.getByRole('button', { name: 'Place an array here' }).click();
  await expect.poll(async () => arrays(await docOf(page, project)).length).toBe(1);
  const doc = await docOf(page, project);
  expect(doc.extensionsUsed?.['FS_energy']).toBe('0.1.0');
  const [[pvId, pv]] = arrays(doc) as [[string, Arr]];
  expect([pv.roof, pv.face]).toEqual(['RF2', 2]);
  expect(Object.values(doc.extensions!.FS_energy!.collections!.inverters ?? {})[0]?.arrays).toEqual([pvId]);
  // its inspector: panels, face and shade, a year as a range with its method, and the advisory note
  const body = inspector.getByTestId('solar-array');
  await expect(body).toBeVisible();
  await expect(body.getByTestId('solar-production')).toHaveText(/^\d{1,3}(,\d{3})*–\d{1,3}(,\d{3})* kWh$/);
  await expect(body).toContainText('A year · estimate ±20%');
  await expect(body.getByTestId('solar-method')).toContainText('not a production guarantee');
  await expect(body).toContainText('An estimate to compare layouts');
  await expect(body).not.toContainText(/compliant/i);
  await expect(page.getByTestId('solar-layer').locator(`[data-array="${pvId}"]`)).toBeAttached();
  await expect(page.getByTestId('solar-layer')).toContainText(`${pvId} · `);
  await shoot(page, 'array');
  await axe(page, 'an array selected in the Solar panel');

  // ── Show: Ghost greys it, Off hides it, On brings it back.
  const show = inspector.getByRole('region', { name: 'Solar', exact: true }).getByRole('radiogroup', { name: 'Show solar' });
  await show.getByRole('radio', { name: 'Ghost' }).click();
  await expect(page.locator('.fs-canvas')).toHaveAttribute('data-ghost', /\bsolar\b/);
  await show.getByRole('radio', { name: 'Off' }).click();
  await expect(page.getByTestId('solar-layer')).toHaveCount(0);
  await show.getByRole('radio', { name: 'On' }).click();
  await expect(page.getByTestId('solar-layer')).toBeAttached();
  await page.keyboard.press('Escape');

  // ── The Solar arrays schedule.
  await page.goto(`/projects/${project}/schedules`);
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Solar arrays' }).click();
  await expect(page.getByRole('tabpanel')).toContainText(pvId);
  await expect(page.getByRole('tabpanel')).toContainText('Guest wing shed roof');
  await expect(page.getByRole('tabpanel')).toContainText('not a production guarantee');

  // ── In 3D: the array on its roof, within the texture budget; the Solar layer hides it there too.
  await page.goto(`/projects/${project}/editor?view=3d`);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 120_000 });
  const shownArrays = () => page.evaluate(() => (window as unknown as Hook).__floorspec3d!.arrays);
  // An array lies on its roof, which a cutaway at its level leaves off: the whole house shows it.
  await page.getByRole('combobox', { name: 'Levels in 3D' }).click();
  await page.getByRole('option', { name: /^Whole house/ }).click();
  await expect(page.getByRole('combobox', { name: 'Levels in 3D' })).toContainText('Whole house');
  await expect.poll(shownArrays).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  const programs = await page.evaluate(() => (window as unknown as Hook).__floorspec3d!.programs.list);
  expect(programs.every((p) => p.linked && p.samplers <= 16), JSON.stringify(programs)).toBe(true);
  await shoot(page, '3d');
  await axe(page, 'the 3D view with an array');
  await solarTool(page);
  const panel3d = inspector.getByRole('region', { name: 'Solar', exact: true });
  await expect(panel3d).toBeVisible();
  await panel3d.getByRole('radiogroup', { name: 'Show solar' }).getByRole('radio', { name: 'Off' }).click();
  await expect.poll(shownArrays).toBe(0);
  await panel3d.getByRole('radiogroup', { name: 'Show solar' }).getByRole('radio', { name: 'On' }).click();
  await expect.poll(shownArrays).toBeGreaterThan(0);
});
