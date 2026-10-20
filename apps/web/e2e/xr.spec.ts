/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The named export: under NodeNext the default resolves to the module namespace, not the class.
import { AxeBuilder } from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';
import { firstRunSetup, password, settled } from './support.js';

/**
 * FLR-T-14.3: walk it in VR, and place it on the lot in AR — on the Courtyard House.
 *
 * WebXR cannot run in headless Chromium for real, so a page script stands in for a headset
 * (fixtures/webxr-mock.js): `navigator.xr` says immersive VR is supported, and a session draws its
 * two eyes into the page's canvas through three.js's own WebXR path. Without it "Enter VR"
 * never shows (no dead button). With it: Enter VR on the Experiences cluster, its panel (ready, start, eye height, comfort, the
 * gestures), Enter VR asking for a floor-level space, the walk starting at the entry on the main floor, a
 * look-and-pinch teleport onto the floor ahead, a level switch from the screen beside the headset, and
 * Exit VR — with no page errors. Then Export ▸ View in AR…: the USDZ made at table scale and at true
 * scale (stored, 64-byte aligned, the scale in its metadata), its QR code and link, the link opened on
 * a phone with no account (Quick Look's `<a rel="ar">` on iOS, a download elsewhere). axe in both
 * themes; screenshots of the VR entry, the headset's view and the AR dialog in test-results/xr-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const MOCK = fileURLToPath(new URL('./fixtures/webxr-mock.js', import.meta.url));
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface XrHook {
  frames: number;
  init: { optionalFeatures?: string[] } | null;
  ended: boolean | null;
  head(): [number, number, number] | null;
  pinch(dir: [number, number, number], ms?: number): Promise<void>;
}
interface Hook {
  __xr?: XrHook;
  __floorspec3d?: { ready: boolean };
  /** The editor's own, under automation (XrScene.tsx): the last aim, the rig, the menu as drawn. */
  __floorspecXr?: { aim: { ok: boolean; reason?: string; floor: number } | null; menu: string | null; menuShown: boolean };
}

/** The theme switched and settled: two frames after it, no CSS transition still running (as edit3d.spec.ts). */
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

/** axe on what is showing, and a screenshot of it, in each theme. */
async function axeAndShoot(page: Page, state: string, shot: string | null): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(800);
    await themeSettled(page);
    // The canvas is drawn, not read: it is aria-hidden, and the view's summary is its text.
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${state} (${theme})`).toEqual([]);
    if (shot !== null) await page.screenshot({ path: `test-results/xr-${shot}-${theme}.png` });
  }
}

/** A stored ZIP's entries and where each one's data starts. */
function entries(zip: Buffer): { name: string; offset: number; method: number; bytes: Buffer }[] {
  const out: { name: string; offset: number; method: number; bytes: Buffer }[] = [];
  let at = 0;
  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const n = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const offset = at + 30 + n + extra;
    out.push({ name: zip.subarray(at + 30, at + 30 + n).toString('utf8'), offset, method, bytes: zip.subarray(offset, offset + size) });
    at = offset + size;
  }
  return out;
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await d.path();
  return { name: d.suggestedFilename(), bytes: readFileSync(path) };
}

test('walk it in VR and place it on the lot in AR: Enter VR only with a headset, a walk with teleport and levels, the USDZ at two scales sent to a phone', async ({ page, browser, baseURL }) => {
  test.setTimeout(600_000);
  // What went wrong on the page: its errors, and console errors other than a missing texture's 404.
  const errors: string[] = [];
  await firstRunSetup(page, { name: 'Walker in VR', email: 'xr@example.test', password: password('xr') });
  const imported = await page.request.post('/api/projects/import/floorspec', {
    headers: { 'content-type': 'application/octet-stream', 'x-project-name': encodeURIComponent('Courtyard House') },
    data: Buffer.from(JSON.stringify(HOUSE)),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const project = ((await imported.json()) as { id: string }).id;
  const editor = `/projects/${project}/editor?view=3d`;

  // ── No headset: no Enter VR. Headless Chromium has no immersive VR to offer.
  await page.goto(editor);
  await settled(page);
  await page.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  const offered = await page.evaluate(async () => {
    const xr = (navigator as unknown as { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
    return xr === undefined ? false : await xr.isSessionSupported('immersive-vr').catch(() => false);
  });
  expect(offered).toBe(false);
  await page.waitForTimeout(500);
  await expect(page.getByRole('toolbar', { name: 'Experiences' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter VR' })).toHaveCount(0);

  // ── A browser that says no (the stand-in told to): still no Enter VR.
  const cookies = await page.context().cookies();
  const refusing = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await refusing.addCookies(cookies);
  await refusing.addInitScript(() => { (window as unknown as { __xrSupported: boolean }).__xrSupported = false; });
  await refusing.addInitScript({ path: MOCK });
  const no = await refusing.newPage();
  await no.goto(`${baseURL ?? ''}${editor}`);
  await settled(no);
  await no.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  await no.waitForTimeout(500);
  await expect(no.getByRole('button', { name: 'Enter VR' })).toHaveCount(0);
  await refusing.close();

  // ── A headset: Enter VR, at the end of the Experiences cluster.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(cookies);
  await context.addInitScript({ path: MOCK });
  const vr = await context.newPage();
  vr.on('pageerror', (e) => { errors.push(e.message); });
  vr.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await vr.goto(`${baseURL ?? ''}${editor}`);
  await settled(vr);
  await vr.waitForFunction(() => (window as unknown as Hook).__floorspec3d?.ready === true, undefined, { timeout: 90_000 });
  const pill = vr.getByRole('toolbar', { name: 'Experiences' }).getByRole('button', { name: 'Enter VR' });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('aria-pressed', 'false');

  // ── Its panel: ready, where to start, the eye height, comfort, what each gesture does.
  await pill.click();
  const panel = vr.getByRole('region', { name: 'Walk it in VR' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Headset ready · Chrome · immersive-vr');
  await expect(panel.getByRole('combobox', { name: 'Start in' })).toContainText('(the walkthrough start)');
  await expect(panel.getByRole('combobox', { name: 'Eye height' })).toContainText('From the headset (standing)');
  await expect(panel.getByRole('switch', { name: 'Snap turn · 30°' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: 'Vignette while moving' })).toBeChecked();
  for (const gesture of ['Teleport', 'Turn', 'Level', 'Exit']) await expect(panel.getByText(gesture, { exact: true })).toBeVisible();
  await expect(panel).toContainText('Read-only in VR — edit in 2D or 3D.');
  await axeAndShoot(vr, 'Walk it in VR panel', 'vr-entry');

  // ── Enter VR: a floor-level space asked for; the walk starts at the entry, on the main floor, at 1:1.
  await panel.getByRole('button', { name: 'Enter VR' }).click();
  const status = vr.getByRole('status').filter({ hasText: /^In VR/ });
  await expect(status).toBeVisible({ timeout: 30_000 });
  await vr.waitForFunction(() => ((window as unknown as Hook).__xr?.frames ?? 0) > 3, undefined, { timeout: 60_000 });
  const init = await vr.evaluate(() => (window as unknown as Hook).__xr!.init);
  expect(init?.optionalFeatures).toEqual(expect.arrayContaining(['local-floor', 'hand-tracking']));
  await expect(status).toContainText('Main floor');
  await expect(pill).toHaveCount(0);
  const start = (await vr.evaluate(() => (window as unknown as Hook).__xr!.head()))!;
  // Standing on the main floor: the eye 1.6 m up.
  expect(start[2]).toBeCloseTo(1.6, 1);
  await vr.screenshot({ path: 'test-results/xr-headset.png' });

  // The menu at your side, as the headset draws it: the house, where you are, the levels, the roofs, Exit VR.
  const menu = await vr.evaluate(() => (window as unknown as Hook).__floorspecXr?.menu ?? null);
  expect(menu).toMatch(/^data:image\/png;base64,/);
  writeFileSync('test-results/xr-menu.png', Buffer.from(menu!.split(',')[1]!, 'base64'));
  const head = () => vr.evaluate(() => (window as unknown as Hook).__xr!.head());
  const aimed = () => vr.evaluate(() => (window as unknown as Hook).__floorspecXr?.aim ?? null);

  // ── Look and pinch at the far wall, low: it is in the way, and nobody moves.
  await vr.evaluate(() => (window as unknown as Hook).__xr!.pinch([0, -0.45, -1], 800));
  await vr.waitForTimeout(800);
  expect(await aimed()).toMatchObject({ ok: false, reason: 'a-wall' });
  expect(Math.hypot((await head())![0] - start[0], (await head())![1] - start[1])).toBeLessThan(0.01);

  // ── At the floor ahead: a ray (a pointer's) and a fade, and you stand there.
  const before = await status.textContent();
  await vr.evaluate(() => (window as unknown as Hook).__xr!.pinch([0, -1, -1], 800));
  await expect.poll(async () => {
    const h = await head();
    return h === null ? 0 : Math.hypot(h[0] - start[0], h[1] - start[1]);
  }, { timeout: 30_000 }).toBeGreaterThan(1.2);
  expect(await aimed()).toMatchObject({ ok: true, floor: 0 });
  const landed = (await head())!;
  // Still on a floor of the main floor, at the same eye height.
  expect(landed[2]).toBeCloseTo(1.6, 1);
  await expect(status).toContainText('Main floor');
  // Straight up, through the ceiling: no floor to land on, and nobody moves.
  await vr.evaluate(() => (window as unknown as Hook).__xr!.pinch([0, 1, -0.05], 500));
  await vr.waitForTimeout(800);
  const up = await aimed();
  expect(up?.ok).toBe(false);
  // A floor above from below, or — under a roof with no storey over it — nothing at all.
  expect(['a-ceiling', 'nothing']).toContain(up?.reason);
  const stayed = (await head())!;
  expect(Math.hypot(stayed[0] - landed[0], stayed[1] - landed[1])).toBeLessThan(0.01);
  expect(before).toBeTruthy();

  // ── The upper floor, from the screen beside the headset: up a storey, on a floor of the upper floor.
  await status.getByRole('button', { name: 'Upper floor' }).click();
  await expect(status).toContainText('Upper floor', { timeout: 30_000 });
  await expect(status.getByRole('button', { name: 'Upper floor' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await vr.evaluate(() => (window as unknown as Hook).__xr!.head()))![2], { timeout: 30_000 }).toBeGreaterThan(3.5);
  await vr.screenshot({ path: 'test-results/xr-headset-level2.png' });

  // ── Exit VR: the session ends, the orbit and Enter VR come back.
  await status.getByRole('button', { name: 'Exit VR' }).click();
  await expect(status).toHaveCount(0);
  expect(await vr.evaluate(() => (window as unknown as Hook).__xr!.ended)).toBe(true);
  await expect(pill).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();

  // ── Export ▸ View in AR…
  await page.locator('.fs-topbar__export').click();
  const exporting = page.getByRole('dialog', { name: /^Export / });
  await exporting.getByRole('button', { name: 'View in AR…' }).click();
  const dialog = page.getByRole('dialog', { name: 'View in AR' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /True scale — on the lot/ })).toHaveAttribute('aria-checked', 'true');
  for (const on of ['Main floor', 'Upper floor', 'Roofs', 'Furniture', 'Fixtures and lights']) await expect(dialog.getByRole('checkbox', { name: on })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'The lawn and site' })).not.toBeChecked();
  await expect(dialog).toContainText('Main floor on the ground');

  // Table scale, made: its QR code, its link, its file at 1:50.
  await dialog.getByRole('radio', { name: /Table scale — 1:50/ }).click();
  await dialog.getByRole('button', { name: 'Make the AR model' }).click();
  await expect(dialog.getByText('Ready · send it to a phone')).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByRole('img', { name: 'QR code of the AR model’s link' })).toBeVisible();
  const tableLink = await dialog.getByTestId('ar-url').inputValue();
  expect(tableLink).toMatch(/\/s\/[A-Za-z0-9_-]{43}\/ar$/);
  await expect(dialog).toContainText(/\d+\.\d MB/);
  const table = await downloaded(page, () => dialog.getByTestId('ar-download').click());
  expect(table.name).toMatch(/^courtyard-house-v\d+-table\.usdz$/);
  const tableFiles = entries(table.bytes);
  expect(tableFiles[0]!.name).toBe('model.usda');
  for (const e of tableFiles) {
    expect(e.method, e.name).toBe(0);
    expect(e.offset % 64, e.name).toBe(0);
  }
  const tableUsda = tableFiles[0]!.bytes.toString('utf8');
  expect(tableUsda).toContain('string scale = "1:50"');
  expect(tableUsda).toContain('float3 xformOp:scale = (0.02, 0.02, 0.02)');
  expect(tableUsda).toContain('uniform token preliminary:anchoring:type = "plane"');

  // True scale, made again: a different scale in the same metadata, its own link.
  await dialog.getByRole('radio', { name: /True scale — on the lot/ }).click();
  await expect(dialog.getByText('The choices changed: make it again.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Make it again' }).click();
  await expect(dialog.getByText('Ready · send it to a phone')).toBeVisible({ timeout: 120_000 });
  const trueLink = await dialog.getByTestId('ar-url').inputValue();
  expect(trueLink).not.toBe(tableLink);
  const trueScale = await downloaded(page, () => dialog.getByTestId('ar-download').click());
  expect(trueScale.name).toMatch(/^courtyard-house-v\d+\.usdz$/);
  const trueUsda = entries(trueScale.bytes)[0]!.bytes.toString('utf8');
  expect(trueUsda).toContain('string scale = "1:1"');
  expect(trueUsda).not.toContain('xformOp:scale');
  for (const e of entries(trueScale.bytes)) expect(e.offset % 64, e.name).toBe(0);
  await axeAndShoot(page, 'View in AR dialog', 'ar-dialog');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // ── On a phone, with no account: an iPhone's Safari opens it in AR Quick Look; anything else downloads it.
  const path = new URL(trueLink).pathname;
  const phone = await browser.newContext({ ...devices['iPhone 15'] });
  // Chromium has no AR Quick Look: stand in for iOS Safari's answer to Apple's own test.
  await phone.addInitScript(() => {
    const supports = Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'supports')?.value as (this: DOMTokenList, token: string) => boolean;
    DOMTokenList.prototype.supports = function (this: DOMTokenList, token: string) { return token === 'ar' ? true : supports.call(this, token); };
  });
  const ios = await phone.newPage();
  await ios.goto(`${baseURL ?? ''}${path}`);
  await expect(ios.getByRole('heading', { name: 'Courtyard House' })).toBeVisible();
  await expect(ios.getByText('True scale · stand on the lot and walk round it')).toBeVisible();
  const quickLook = ios.locator('a[rel="ar"]');
  await expect(quickLook).toHaveAttribute('href', /\/api\/share\/[A-Za-z0-9_-]{43}\/ar\.usdz#allowsContentScaling=0$/);
  // AR Quick Look takes a link whose one child is an image.
  expect(await quickLook.evaluate((a) => [a.children.length, a.firstElementChild?.tagName])).toEqual([1, 'IMG']);
  await expect(quickLook.getByRole('img', { name: 'View Courtyard House in AR' })).toBeVisible();
  const usdz = await ios.request.get(new URL((await quickLook.getAttribute('href'))!.split('#')[0]!, baseURL).toString());
  expect(usdz.status()).toBe(200);
  expect(usdz.headers()['content-type']).toBe('model/vnd.usdz+zip');
  expect(usdz.headers()['content-disposition']).toMatch(/^inline; /);
  await axeAndShoot(ios, 'AR page on a phone', 'ar-phone');
  await phone.close();
  const android = await browser.newContext({ ...devices['Pixel 7'] });
  const other = await android.newPage();
  await other.goto(`${baseURL ?? ''}${new URL(tableLink).pathname}`);
  await expect(other.getByText('Table scale · 1:50 · pinch to turn')).toBeVisible();
  await expect(other.getByRole('link', { name: /Download courtyard-house-v\d+-table\.usdz · \d+\.\d MB/ })).toBeVisible();
  await android.close();
});
