import { expect, test, type Locator, type Page } from '@playwright/test';
import { asAgent, count, firstRunSetup, FT, historyOf, modelOf, password, projectIn, settled, setupToken, type Doc } from './support.js';

/**
 * FLR-T-3.9: the main path, as the P3 exit demo runs it — with a pointer this time (the keyboard
 * suite is FLR-T-3.7's). From first-run setup behind the setup token: a blank project, its
 * dashboard, an agent token minted on the Tokens screen; then in the editor a level, four walls
 * drawn by clicking a closed room, a door and a window placed on them, a room anchor placed and
 * named. An agent then proposes a change through the API exactly as one does — a bearer token,
 * a named changeset, never main — and the proposal appears live, drawn over the plan. It is
 * accepted, undone (an appended inverse), and the two versions are compared in the history's diff
 * view. Every step is checked in the model the server holds, not only on screen.
 */

/** The plan canvas: where a world point (base units) is on the page. */
interface Camera {
  at: (x: number, y: number) => { x: number; y: number };
}

/**
 * An empty level is framed by viewport.ts's `fit(null, w, h)`: 40 ft × 28 ft around the origin,
 * with 72 px of padding. The camera is checked against the status bar's cursor readout before it
 * is trusted, so a change to the framing fails here and not as a mysterious misclick later.
 */
async function cameraOf(page: Page, svg: Locator): Promise<Camera> {
  const box = await svg.boundingBox();
  if (box === null) throw new Error('the plan canvas has no box');
  const s = Math.min((box.width - 144) / (40 * FT), (box.height - 144) / (28 * FT));
  const camera: Camera = { at: (x, y) => ({ x: box.x + box.width / 2 + x * s, y: box.y + box.height / 2 - y * s }) };
  const probe = camera.at(-10 * FT, -6 * FT);
  await page.mouse.move(probe.x, probe.y);
  // The readout is the raw pointer, a pixel's worth from the point: within an inch is the same spot.
  await expect
    .poll(async () => {
      const text = (await page.locator('.fs-statusbar__cursor').textContent()) ?? '';
      const [x, y] = [...text.matchAll(/(-?)(\d+)'-(\d+)(?: (\d+)\/(\d+))?"/g)].map(feetOf);
      return x !== undefined && y !== undefined && Math.abs(x + 10 * FT) <= FT / 12 && Math.abs(y + 6 * FT) <= FT / 12;
    })
    .toBe(true);
  return camera;
}

/** A `-10'-0 1/16"` match as base units. */
function feetOf(m: RegExpMatchArray): number {
  const [, sign, feet, inches, num, den] = m;
  const value = Number(feet) * FT + Number(inches) * (FT / 12) + (num === undefined ? 0 : (Number(num) / Number(den)) * (FT / 12));
  return sign === '-' ? -value : value;
}

async function click(page: Page, camera: Camera, x: number, y: number): Promise<void> {
  const p = camera.at(x, y);
  // A move first: the tools aim on hover (an opening finds its wall, a wall its snap).
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

const junctionsOf = (doc: Doc) => Object.values(doc.junctions ?? {}).map((j) => j.position);

test('setup to a compared undo: draw a room by hand, accept an agent’s proposal, undo it, compare', async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error('no baseURL');

  // ── First-run setup is gated by SETUP_TOKEN: a wrong token is refused, the right one creates
  //    the operator account.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up D3 Floorspec' })).toBeVisible();
  await page.getByLabel('Setup token').fill(`not-${setupToken()}`);
  await page.getByLabel('Your name').fill('Main Path');
  await page.getByLabel('Email').fill('main@example.test');
  const secret = password('main');
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByLabel('Password again').fill(secret);
  await page.getByRole('button', { name: 'Create the operator account' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Setup failed' })).toContainText('setup token is missing or wrong');
  await firstRunSetup(page, { name: 'Main Path', email: 'main@example.test', password: secret });

  // ── The projects list starts empty; a blank project is made from the dialog.
  await expect(page.getByRole('heading', { name: 'Design your first house' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Main path house');
  await dialog.getByRole('button', { name: 'Create project' }).click();

  // ── Its dashboard.
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const project = projectIn(page.url());
  await expect(page.getByRole('heading', { name: 'Main path house', level: 1 })).toBeVisible();
  let doc = await modelOf(page, project);
  expect(count(doc.levels)).toBe(0);

  // ── An agent token for this project, minted on the Tokens screen (Account › API tokens). The
  //    secret is shown once.
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible();
  await page.getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByRole('status').filter({ hasText: 'Copy this token now' });
  await expect(shown).toBeVisible();
  const token = (await shown.locator('.fs-mono').textContent())?.trim() ?? '';
  expect(token).toMatch(/^fls_[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText('Main path house · agent · created')).toBeVisible();

  // ── The editor.
  await page.goto(`/projects/${project}`);
  await page.getByRole('button', { name: 'Open editor' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/editor$`));
  await expect(page.getByText('This project has no levels yet')).toBeVisible();
  await expect(page.locator('.fs-statusbar')).toContainText('Live');

  // A level.
  await page.getByRole('button', { name: 'Add Level 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Level 1');
  await settled(page);
  doc = await modelOf(page, project);
  expect(count(doc.levels)).toBe(1);
  const level = Object.keys(doc.levels ?? {})[0] as string;

  // Four walls, clicked corner to corner, the last click on the first corner closing the room: a
  // 20 ft × 12 ft room around the origin.
  const svg = page.getByRole('application', { name: /^Plan of / });
  const camera = await cameraOf(page, svg);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Draw walls' }).click();
  for (const [x, y] of [[-10, -6], [10, -6], [10, 6], [-10, 6], [-10, -6]] as const) await click(page, camera, x * FT, y * FT);
  await expect.poll(async () => count((await modelOf(page, project)).walls)).toBe(4);
  await settled(page);
  doc = await modelOf(page, project);
  const xs = junctionsOf(doc).map((p) => p[0]);
  const ys = junctionsOf(doc).map((p) => p[1]);
  expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-10 * FT, 10 * FT, -6 * FT, 6 * FT]);
  await page.keyboard.press('Escape');

  // A door in the south wall, west of centre; a window in the north wall, east of centre.
  await rail.getByRole('button', { name: 'Place a door' }).click();
  await click(page, camera, -5 * FT, -6 * FT);
  await expect.poll(async () => count((await modelOf(page, project)).openings)).toBe(1);
  await settled(page);
  await rail.getByRole('button', { name: 'Place a window' }).click();
  await click(page, camera, 5 * FT, 6 * FT);
  await expect.poll(async () => count((await modelOf(page, project)).openings)).toBe(2);
  await settled(page);
  doc = await modelOf(page, project);
  const kinds = Object.values(doc.openings ?? {}).map((o) => doc.types?.[o.fill ?? '']?.kind).sort();
  expect(kinds).toEqual(['doorType', 'windowType']);

  // A room anchor in the closed space; its name typed into the inspector, which takes focus.
  await rail.getByRole('button', { name: 'Name a room' }).click();
  await click(page, camera, -5 * FT, 0);
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  const roomName = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(roomName).toBeFocused();
  await roomName.fill('Great room');
  await roomName.press('Enter');
  await expect.poll(async () => Object.values((await modelOf(page, project)).rooms ?? {})[0]?.name).toBe('Great room');
  await settled(page);
  await page.keyboard.press('Escape');
  const drawn = await modelOf(page, project);
  const drawnHead = (await historyOf(page, project))[0];

  // ── An agent proposes: a partition across the room, and a study in the new space — posted as a
  //    named changeset with only the bearer token, the way the MCP server's propose tool does.
  const agent = await asAgent(baseURL, token);
  const wallType = Object.values(drawn.walls ?? {})[0] as { type?: string } | undefined;
  const proposal = await agent.post(`/api/projects/${project}/changesets`, {
    data: {
      name: 'Add a study',
      batch: [
        { op: 'drawWall', level, from: [0, -6 * FT], to: [0, 6 * FT], ...(wallType?.type === undefined ? {} : { type: wallType.type }) },
        { op: 'addRoom', level, at: [5 * FT, 0], name: 'Study' },
      ],
    },
  });
  expect(proposal.status(), await proposal.text()).toBe(201);
  const changeset = ((await proposal.json()) as { changeset: { id: string } }).changeset.id;
  // An agent writes changesets, never main (FLR-ADR-016), and cannot accept its own proposal.
  expect(await modelOf(page, project)).toEqual(drawn);
  expect((await agent.post(`/api/projects/${project}/changesets/${changeset}/accept`, { data: {} })).status()).toBe(403);

  // ── It appears live, without a reload: the proposal panel opens and the plan draws it over main.
  const panel = page.getByRole('complementary', { name: 'Proposal' });
  await expect(panel.getByRole('heading', { name: 'Add a study' })).toBeVisible();
  await expect(panel).toContainText('Pending');
  await expect(page.locator('.fs-statusbar__proposals')).toHaveText('1 proposal');
  await expect(svg.locator('.fs-diffs .fs-diff--proposed').first()).toBeVisible();
  await expect(page.getByRole('note', { name: 'Legend' })).toContainText('Proposed');

  // ── Accept: it merges onto main.
  await panel.getByRole('button', { name: 'Accept changeset' }).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(2);
  await settled(page);
  const accepted = await modelOf(page, project);
  expect(Object.values(accepted.rooms ?? {}).map((r) => r.name).sort()).toEqual(['Great room', 'Study']);
  expect(count(accepted.walls)).toBeGreaterThan(count(drawn.walls));
  let log = await historyOf(page, project);
  const merge = log[0];
  expect(merge?.changeset?.name).toBe('Add a study');
  expect(merge?.before).toBe(drawnHead?.after);

  // ── Undo, from the top bar: an inverse appended to the log, not the log rewound.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => count((await modelOf(page, project)).rooms)).toBe(1);
  await settled(page);
  expect(await modelOf(page, project)).toEqual(drawn);
  log = await historyOf(page, project);
  const undo = log[0];
  expect(undo?.kind).toBe('undo');
  expect(undo?.undoOf).toBe(merge?.seq);
  expect(undo?.seq).toBe((merge?.seq ?? 0) + 1);
  expect(undo?.before).toBe(merge?.after);
  // The same document again, so the same content hash: the version before the merge.
  expect(undo?.after).toBe(merge?.before);
  expect(log.map((o) => o.seq)).toContain(merge?.seq);

  // ── The history shows the inverse as the newest version; selecting it compares the accepted
  //    version with the undone one in the diff view.
  await page.getByRole('button', { name: 'Show the history' }).click();
  const versions = page.getByRole('listbox', { name: 'Versions, newest first' });
  const newest = versions.getByRole('option').first();
  await expect(newest).toContainText(`v${String(undo?.seq)}`);
  await expect(newest).toContainText(`Undid v${String(merge?.seq)}`);
  await expect(versions.getByRole('option').nth(1)).toContainText('Accepted “Add a study”');
  await newest.click();
  const comparison = page.getByRole('complementary', { name: 'Comparison' });
  await expect(comparison.getByRole('heading', { name: `Compare v${String(merge?.seq)} → v${String(undo?.seq)}` })).toBeVisible();
  await expect(comparison).toContainText('Removed');
  await expect(comparison).toContainText('Study');
  await expect(page.getByRole('note', { name: 'Legend' })).toContainText('Removed');
  await expect(svg.locator('.fs-diffs .fs-diff--removed').first()).toBeVisible();
  // The two versions the view compares are the server's, byte for byte.
  const before = await page.request.get(`/api/projects/${project}/versions/${merge?.after ?? ''}`);
  const after = await page.request.get(`/api/projects/${project}/versions/${undo?.after ?? ''}`);
  expect(Object.values(((await before.json()) as Doc).rooms ?? {}).map((r) => r.name).sort()).toEqual(['Great room', 'Study']);
  expect((await after.json()) as Doc).toEqual(drawn);

  // ── Revoke the token: the agent is locked out at once.
  await page.goto('/account');
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Claude is revoked.')).toBeVisible();
  expect((await agent.get(`/api/projects/${project}/changesets`)).status()).toBe(401);
  await agent.dispose();
});
