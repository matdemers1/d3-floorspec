/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { firstRunSetup, IN, modelOf, password, projectIn, settled } from './support.js';

/**
 * FLR-T-7.5, the P7 exit demo: "Toggle to 3D and walk through your house at eye height, up an
 * L-stair, under a hip roof; select a wall in 3D and see it selected in 2D."
 *
 * A two-level house (e2e/fixtures/l-stair-hip-roof.json: a front door into the kitchen, an L stair
 * in the living room rising to a loft, a 6:12 hip roof) is built through the API as one Ops batch.
 * The editor toggles to 3D from the top bar; a wall clicked in 3D is the plan's, the tree's and the
 * inspector's selection; a room picked in the tree is labelled in 3D; the walkthrough starts inside
 * the front door at eye height, walks with the keys, climbs the L stair with them — up the first
 * flight to the landing, a left turn, up the second to the loft — under the roof, and Escape ends
 * it. Touch: the stick walks. The walker is read through the view's test hook (navigator.webdriver
 * only): position, the floor under it and the room it is in.
 *
 * Then FLR-T-11.3 (Core 0.4, 17.7): the stair made a winder with a newel and a design headroom from
 * its inspector, then a spiral — each seen in the plan (winders, the spiral's column) and in 3D (the
 * mesh's flights, and the spiral's centre column).
 *
 * Chromium draws WebGL with SwiftShader here (playwright.config.ts). Screenshots of each state, in
 * both themes, land in test-results/three-*.png.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const M = 1_280_000;

function batchOf(doc: Record<string, unknown>): { op: string; collection: string; id: string; element: unknown }[] {
  const order = ['materials', 'types', 'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'stairs', 'roofs'];
  return order.flatMap((collection) =>
    Object.entries((doc[collection] ?? {}) as Record<string, unknown>).map(([id, element]) => ({ op: 'addElement', collection, id, element })),
  );
}

interface Walker {
  x: number;
  y: number;
  feet: number;
  eye: number;
  ground: number;
  yaw: number;
  room: string | null;
  blocked: string | null;
}

/** The 3D view's test hook (src/editor/three/ThreeView.tsx), present under automation only. */
declare global {
  interface Window {
    __floorspec3d?: {
      ready: boolean;
      parts: number;
      kinds: Record<string, number>;
      walking: boolean;
      walker: Walker | null;
      screenPoint(id: string): { x: number; y: number } | null;
      walk(from: { x: number; y: number; yaw: number | null; level: string | null } | null): void;
      face(yawDegrees: number): void;
    };
  }
}

const walker = (page: Page): Promise<Walker | null> => page.evaluate(() => window.__floorspec3d?.walker ?? null);

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__floorspec3d?.ready === true, undefined, { timeout: 30_000 });
  // A frame or two drawn after the first mesh.
  await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/three-${name}-${theme}.png` });
  }
}

/** Hold a key until the walker satisfies `until` (checked every animation frame), then let go. */
async function holdUntil(page: Page, key: string, until: string): Promise<Walker> {
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(`(() => { const w = window.__floorspec3d?.walker; return w !== null && w !== undefined && (${until}); })()`, undefined, { polling: 'raf', timeout: 20_000 });
  } finally {
    await page.keyboard.up(key);
  }
  return (await walker(page))!;
}

test('the P7 exit demo: 3D, split with synced selection, and a walk up the L stair under the hip roof', async ({ page }) => {
  test.setTimeout(180_000);
  await firstRunSetup(page, { name: 'Walker', email: 'walker@example.test', password: password('three') });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const created = page.getByRole('dialog', { name: 'New project' });
  await created.getByLabel('Name').fill('Stair and hip roof house');
  await created.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  const applied = await page.request.post(`/api/projects/${project}/ops`, { data: { batch: batchOf(HOUSE) } });
  expect(applied.status(), await applied.text()).toBe(201);

  await page.goto(`/projects/${project}/editor`);
  await settled(page);
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');

  // ── Toggle to 3D from the top bar: the view is in the URL, the canvas has a name and a description.
  const views = page.getByRole('radiogroup', { name: 'View' });
  await views.getByRole('radio', { name: '3D' }).click();
  await expect(page).toHaveURL(/[?&]view=3d\b/);
  const canvas = page.getByRole('application', { name: 'Walkthrough of Stair and hip roof house' }).or(page.getByRole('application', { name: '3D view of Stair and hip roof house' }));
  await expect(canvas).toBeVisible();
  await ready(page);
  await expect(page.getByRole('application', { name: /^Plan of / })).toBeHidden();
  const description = page.locator(`[id="${(await canvas.getAttribute('aria-describedby'))!}"]`);
  await expect(description).toContainText('Level 1: 7 walls, 2 doors, 4 windows, 2 rooms, 1 stair, no roof showing.');
  await expect(description).toContainText('Use the plan view for full keyboard editing.');
  await expect(page.getByRole('button', { name: /Cutaway · Level 1 and below/ })).toHaveAttribute('aria-pressed', 'true');
  await shoot(page, '3d-cutaway');

  // The whole house, roof on; then back to the cutaway.
  await page.getByRole('button', { name: /Cutaway · Level 1 and below/ }).click();
  await expect(page.getByRole('button', { name: 'Whole house' })).toHaveAttribute('aria-pressed', 'false');
  await expect(description).toContainText('1 roof');
  await page.getByRole('button', { name: /View: SW iso/ }).click();
  await expect(page.getByRole('button', { name: /View: SE iso/ })).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, '3d-whole-house');
  await page.getByRole('button', { name: /View: SE iso/ }).click(); // → NE
  await page.getByRole('button', { name: /View: NE iso/ }).click(); // → NW
  await page.getByRole('button', { name: /View: NW iso/ }).click(); // → Top
  await page.getByRole('button', { name: /View: Top/ }).click(); // → SW
  await page.getByRole('button', { name: 'Whole house' }).click();

  // The keyboard orbits the canvas, and the plan's own arrow keys do not move underneath it.
  await canvas.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: /View: free orbit/ })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.getByRole('button', { name: /View: SW iso/ })).toBeVisible();

  // ── Split: a wall clicked in 3D is the selection in the plan, the tree and the inspector.
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/[?&]view=split\b/);
  await expect(page.getByRole('application', { name: /^Plan of Level 1/ })).toBeVisible();
  await expect(page.getByText('Selection synced · click in either view')).toBeVisible();
  await ready(page);
  await page.waitForTimeout(400);
  const point = await page.evaluate(() => window.__floorspec3d?.screenPoint('GAB') ?? null);
  expect(point, 'the west wall can be clicked in 3D').not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Wall GAB' })).toBeVisible();
  await expect(page.locator('.fs-tree__row.is-selected')).toContainText('Wall GAB');
  await expect(page.locator('.fs-canvas__svg .fs-hl--selected')).toHaveCount(1);
  await expect(page.locator('.fs-three__label')).toHaveText('Wall GAB');
  await shoot(page, 'split-wall-selected');

  // …and a room picked on the plan's side is the one labelled in 3D.
  await page.getByRole('treeitem', { name: /^Kitchen/ }).first().click();
  await expect(inspector.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await expect(page.locator('.fs-three__label')).toHaveText('Kitchen');
  await expect(inspector.getByRole('region', { name: '3D' })).toContainText('Level 1 and below, cut away');

  // ── Live: an edit made elsewhere (an API batch, as an agent's accepted change arrives) is re-meshed
  //    in place, and the camera stays where it was.
  const parts = await page.evaluate(() => window.__floorspec3d?.parts ?? 0);
  const added = await page.request.post(`/api/projects/${project}/ops`, {
    data: { batch: [{ op: 'addElement', collection: 'openings', id: 'GW5', element: { wall: 'GCD', offset: Math.round(3.4 * M), fill: 'WN' } }] },
  });
  expect(added.status(), await added.text()).toBe(201);
  await expect.poll(() => page.evaluate(() => window.__floorspec3d?.parts ?? 0)).toBe(parts + 1);
  await expect(page.getByText('3D · SW iso')).toBeVisible();

  // ── Walk through, from the entry: inside the front door, in the kitchen, at eye height.
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/[?&]view=3d\b/);
  await page.locator('body').focus();
  await page.keyboard.press('4');
  await expect(page.getByRole('button', { name: 'Exit walkthrough' })).toBeVisible();
  await page.waitForFunction(() => window.__floorspec3d?.walking === true);
  await expect(page.getByRole('navigation', { name: 'Tools' })).toBeHidden();
  let w = (await walker(page))!;
  expect(w.room).toBe('KIT');
  expect(w.eye - w.ground).toBeCloseTo(1.6, 6);
  expect(w.feet).toBeCloseTo(0, 6);
  await expect(page.getByRole('status').filter({ hasText: 'eye height' })).toContainText('Kitchen · Level 1 · eye height 5\'-3"');
  await expect(page.getByRole('img', { name: /^Map of Level 1: you are in Kitchen, facing north/ })).toBeVisible();
  await shoot(page, 'walk-entry');

  // W walks forward (north, into the kitchen); the walls keep the walker in.
  const before = w;
  w = await holdUntil(page, 'w', 'w.y > ' + String(before.y + 1.0));
  expect(w.room).toBe('KIT');
  expect(w.blocked).toBeNull();
  expect(w.eye - w.ground).toBeCloseTo(1.6, 6);

  // ── The L stair: from its foot, facing east up the first flight, with the arrow keys.
  await page.evaluate((M) => { window.__floorspec3d?.walk({ x: 0.6 * M, y: 0.6 * M, yaw: 0, level: 'L1' }); }, M);
  await expect.poll(async () => (await walker(page))?.x ?? 0).toBeCloseTo(0.6, 6);
  w = (await walker(page))!;
  expect(w.room).toBe('LIV');
  expect(w.feet).toBe(0);
  // Up the first flight to the landing (x 2.5–3.4, its top 1.35 m)…
  await holdUntil(page, 'ArrowUp', 'w.x >= 2.8');
  await page.waitForTimeout(200);
  w = (await walker(page))!;
  expect(w.feet).toBeCloseTo(1.35, 6);
  expect(w.eye - w.ground).toBeCloseTo(1.6, 6);
  await expect(page.getByRole('status').filter({ hasText: 'eye height' })).toContainText('Stair · Level 1');
  await shoot(page, 'walk-landing');
  // …turn left with the arrow key, as the stair turns…
  w = await holdUntil(page, 'ArrowLeft', 'w.yaw >= 88');
  expect(w.yaw).toBeLessThan(100);
  // …and up the second flight onto the loft's floor, 2.7 m up, under the hip roof.
  await holdUntil(page, 'ArrowUp', 'w.y >= 3.0');
  await page.waitForTimeout(200);
  w = (await walker(page))!;
  expect(w.feet).toBeCloseTo(2.7, 6);
  expect(w.room).toBe('LOFT');
  expect(w.eye - w.ground).toBeCloseTo(1.6, 6);
  await expect(page.getByRole('status').filter({ hasText: 'eye height' })).toContainText('Loft · Level 2');
  await expect(description).toContainText('1 roof');
  await expect(page.getByRole('img', { name: /^Map of Level 2/ })).toBeVisible();
  await shoot(page, 'walk-loft');
  // Turn round and look down the stairwell, the way just climbed.
  await holdUntil(page, 'ArrowRight', 'w.yaw <= -60');
  const look = (await canvas.boundingBox())!;
  await page.mouse.move(look.x + look.width / 2, look.y + look.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(look.x + look.width / 2, look.y + look.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await shoot(page, 'walk-stairwell');

  // Shift walks faster; a wall still stops it.
  await holdUntil(page, 'ArrowLeft', 'w.yaw >= 0');
  // A slow frame can turn past 0°; face east exactly, so the wall ahead is the one this checks.
  await page.evaluate(() => { window.__floorspec3d!.face(0); });
  await page.keyboard.down('Shift');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Shift');
  w = (await walker(page))!;
  expect(w.blocked).toBeNull();
  expect(w.x).toBeLessThan(4.8);
  expect(w.room).toBe('LOFT');

  // ── Escape ends the walk: the panels are back, and so is the orbit view.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Exit walkthrough' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('application', { name: '3D view of Stair and hip roof house' })).toBeVisible();

  // ── Touch: with a touch screen, the stick walks and a drag looks around.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.waitForFunction(() => window.matchMedia('(pointer: coarse)').matches).catch(() => undefined);
  await page.getByRole('toolbar', { name: '3D view' }).getByRole('button', { name: 'Walk through' }).click();
  await page.waitForFunction(() => window.__floorspec3d?.walking === true);
  const stick = page.locator('.fs-three__stick');
  if (await stick.isVisible()) {
    w = (await walker(page))!;
    const box = (await stick.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 4 });
    await page.waitForFunction((y) => (window.__floorspec3d?.walker?.y ?? 0) > y + 0.5, w.y, { polling: 'raf', timeout: 10_000 });
    await page.mouse.up();
    await expect(page.getByText('Stick walks')).toBeVisible();
    await shoot(page, 'walk-touch');
  } else {
    test.info().annotations.push({ type: 'note', description: 'touch emulation did not report a coarse pointer; the stick was not shown' });
  }
  const yaw = (await walker(page))!.yaw;
  const gl = (await canvas.boundingBox())!;
  await page.mouse.move(gl.x + gl.width * 0.6, gl.y + gl.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(gl.x + gl.width * 0.4, gl.y + gl.height * 0.5, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await walker(page))!.yaw - yaw)).toBeGreaterThan(20);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.getByRole('button', { name: 'Exit walkthrough' }).click();

  // ── Back to the plan: the URL forgets the view.
  await page.keyboard.press('1');
  await expect(page).not.toHaveURL(/view=/);
  const plan = page.getByRole('application', { name: /^Plan of / });
  await expect(plan).toBeVisible();

  // ── FLR-T-11.3: the stair, from its inspector, made a quarter-turn winder (Core 0.4, 17.7)…
  // The tree opened down to the level's stairs: the project, its building and level, then the group.
  const tree = page.getByRole('tree');
  for (let depth = 1; depth <= 3; depth++) {
    const closed = tree.locator(`[role="treeitem"][aria-level="${String(depth)}"][aria-expanded="false"]`);
    while ((await closed.count()) > 0) await closed.first().click();
  }
  const stairsRow = tree.getByRole('treeitem', { name: /^Stairs/ });
  if ((await stairsRow.getAttribute('aria-expanded')) === 'false') await stairsRow.click();
  await tree.getByRole('treeitem').filter({ hasText: 'ST1' }).first().click();
  const form = inspector.getByRole('combobox', { name: 'Form' });
  await expect(form).toBeVisible();
  await form.click();
  await page.getByRole('option', { name: 'Winder', exact: true }).click();
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.form?.kind).toBe('winder');
  await settled(page);
  // …its three winders drawn in the plan, tapered between the two flights…
  await expect(plan.locator('[data-stair="ST1"] [data-step="winder"]')).toHaveCount(3);
  await expect(plan.locator('[data-stair="ST1"] [data-step="landing"]')).toHaveCount(0);
  // …a 4" newel at the turn, and the headroom it is designed for, 6'-8".
  await inspector.getByRole('textbox', { name: 'Newel' }).fill('4"');
  await inspector.getByRole('textbox', { name: 'Newel' }).press('Enter');
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.form?.newel).toBe(4 * IN);
  await settled(page);
  await inspector.getByRole('textbox', { name: 'Design headroom' }).fill('6\' 8"');
  await inspector.getByRole('textbox', { name: 'Design headroom' }).press('Enter');
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.minHeadroom).toBe(80 * IN);
  await settled(page);
  await expect(inspector.getByText('Least going, narrow end')).toBeVisible();
  await expect(inspector.getByText('Floor above open from')).toBeVisible();
  // FLR-T-12.9: the winders tinted, the newel drawn, where the floor above opens marked, and the
  // stair outlined only when selected — its treads not painted over.
  const stairG = plan.locator('[data-stair="ST1"]');
  await expect(stairG.locator('.fs-stair__step--winder')).toHaveCount(3);
  expect(await stairG.locator('.fs-stair__step--winder').first().evaluate((el) => getComputedStyle(el).fillOpacity)).toBe('0.18');
  await expect(stairG.locator('[data-newel="ST1"]')).toHaveCount(1);
  await expect(stairG.locator('[data-opening="ST1"]')).toHaveCount(1);
  expect(await plan.locator('.fs-hl--selected').evaluate((el) => getComputedStyle(el).fill)).toBe('none');
  const sections = await inspector.locator('section.fs-section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(sections.slice(0, 2)).toEqual(['Identity', 'Stair']);
  // The tree says the stair's ID once: beside its name ("Stair"), or in its label when it has none.
  expect(((await tree.getByRole('treeitem').filter({ hasText: 'ST1' }).first().textContent()) ?? '').match(/ST1/g)).toHaveLength(1);
  await shoot(page, 'plan-winder');
  // A half turn: its second flight runs back past the foot, and UP is written clear of the stair's box.
  await inspector.getByRole('radiogroup', { name: 'Turns through' }).getByRole('radio', { name: 'A half' }).click();
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.form?.angle).toBe('half');
  await settled(page);
  await expect(stairG.locator('.fs-stair__step--winder')).toHaveCount(6);
  const upBox = (await stairG.locator('[data-up="ST1"]').boundingBox())!;
  const box = (await plan.locator('.fs-hl--selected').boundingBox())!;
  expect(upBox.x < box.x + box.width && upBox.x + upBox.width > box.x && upBox.y < box.y + box.height && upBox.y + upBox.height > box.y).toBe(false);
  await shoot(page, 'plan-winder-half');
  await inspector.getByRole('radiogroup', { name: 'Turns through' }).getByRole('radio', { name: 'A quarter' }).click();
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.form?.angle).toBe('quarter');
  await settled(page);
  // In 3D: the winders are part of the stair's flight.
  // The 3D view is mounted afresh: its description is found again from the canvas.
  const described = async () => page.locator(`[id="${(await canvas.getAttribute('aria-describedby'))!}"]`);
  await views.getByRole('radio', { name: '3D' }).click();
  await ready(page);
  await expect(await described()).toContainText('1 stair');
  await expect.poll(() => page.evaluate(() => window.__floorspec3d?.kinds['stairFlight'] ?? 0)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__floorspec3d?.kinds['stairLanding'] ?? 0)).toBe(0);
  await shoot(page, '3d-winder');

  // ── …and then a spiral: its circle and centre column in the plan, its column in 3D.
  await views.getByRole('radio', { name: '2D plan' }).click();
  await expect(plan).toBeVisible();
  await form.click();
  await page.getByRole('option', { name: 'Spiral', exact: true }).click();
  await expect.poll(async () => (await modelOf(page, project)).stairs?.['ST1']?.form?.kind).toBe('spiral');
  await settled(page);
  await expect(plan.locator('[data-column="ST1"]')).toBeVisible();
  await expect(inspector.getByRole('textbox', { name: 'Diameter' })).toBeVisible();
  await expect(inspector.getByRole('textbox', { name: 'Sweep' })).toHaveValue('270');
  // A spiral's tread does not claim to be its going: its diameter and sweep set that.
  await expect(inspector).not.toContainText('nosing to nosing');
  await expect(inspector).toContainText("a spiral's diameter and sweep set it");
  await shoot(page, 'plan-spiral');
  await views.getByRole('radio', { name: '3D' }).click();
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__floorspec3d?.kinds['stairColumn'] ?? 0)).toBe(1);
  await expect(await described()).toContainText('1 stair');
  await shoot(page, '3d-spiral');
});
