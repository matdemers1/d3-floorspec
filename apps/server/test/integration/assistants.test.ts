import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER } from '@floorspec/engine';
import { Browser, createProjectAs, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-5.8: `POST /api/projects/:projectId/assistants/electrical` runs the electrical layout
 * assistant on main and opens its proposal as one pending changeset. Main does not move until a
 * person accepts it; the proposal says it is advice from Floorspec's defaults, not a code check;
 * accepted, the plan holds what it proposed, and asking again finds nothing to add.
 */

const FT = 390_144;

/** A 16' × 12' kitchen, drawn clockwise so its walls' exterior faces are outside, with a panel in it. */
const KITCHEN = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
  { op: 'addLevel', id: 'L1', building: 'B1', elevation: 0, height: "9'", name: 'Level 1' },
  { op: 'addElement', collection: 'types', id: 'WT', element: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
  { op: 'drawWall', level: 'L1', from: [0, 0], to: [0, 12 * FT], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [0, 12 * FT], to: [16 * FT, 12 * FT], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [16 * FT, 12 * FT], to: [16 * FT, 0], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [16 * FT, 0], to: [0, 0], type: 'WT' },
];
const NAME = [{ op: 'addRoom', level: 'L1', at: [8 * FT, 6 * FT], name: 'Kitchen', function: 'kitchen' }];

interface Proposed {
  main: string;
  changeset: { id: string; name: string; status: string; head: string } | null;
  proposal: { name: string; explanation: string[]; added: { receptacles: string[]; switches: string[]; lights: string[] }; circuits: { id: string }[]; notes: string[]; ops: number };
}

describe('the electrical assistant', () => {
  const db = testDb();
  let running: Running;
  let operator: Browser;
  let project: { id: string; head: string };

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    operator = await setupOperator(running);
    project = await createProjectAs(operator);
    for (const batch of [KITCHEN, NAME]) {
      const res = await operator.post(`/api/projects/${project.id}/ops`, { batch });
      expect(res.status, res.text).toBe(201);
    }
  });

  const path = (rest = '') => `/api/projects/${project.id}${rest}`;
  const main = async () => (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;

  it('opens its proposal as a pending changeset, main unmoved, and says it is advice', async () => {
    const before = await main();
    const res = await operator.post(path('/assistants/electrical'), {});
    expect(res.status, res.text).toBe(201);
    const body = res.body as Proposed;
    expect(body.main).toBe(before);
    expect(body.changeset).toMatchObject({ status: 'pending', name: 'Electrical layout: Kitchen' });
    expect(body.proposal.added.receptacles.length).toBeGreaterThan(3);
    expect(body.proposal.added.lights).toHaveLength(1);
    expect(body.proposal.notes).toContain('There is no panel, so no circuits are proposed: place one and ask again.');
    expect(body.proposal.explanation.join(' ')).toContain('These are layout defaults, not a code check');
    expect(body.proposal.explanation.join(' ')).not.toMatch(/complian/i);
    expect(await main()).toBe(before);

    // The proposal, as the changeset holds it: valid under FS_electrical, GFCI at every kitchen receptacle.
    const model = await operator.get(path(`/changesets/${body.changeset?.id ?? ''}/model.json`));
    expect(model.status).toBe(200);
    const proposed = check(model.text, OFFICIAL_READER);
    expect(proposed.valid).toBe(true);
    const receptacles = (JSON.parse(model.text) as { extensions: { FS_electrical: { collections: { receptacles: Record<string, { features?: string[] }> } } } }).extensions.FS_electrical.collections.receptacles;
    for (const id of body.proposal.added.receptacles) expect(receptacles[id]?.features).toEqual(['gfci']);

    // Accepted, the plan holds it; asked again, there is nothing to add — and no changeset is opened.
    const accepted = await operator.post(path(`/changesets/${body.changeset?.id ?? ''}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const again = await operator.post(path('/assistants/electrical'), {});
    expect(again.status, again.text).toBe(200);
    expect(again.body).toMatchObject({ changeset: null, proposal: { ops: 0 } });
  });

  it('groups the loads into circuits once there is a panel, and an agent token may ask', async () => {
    const panel = await operator.post(path('/ops'), {
      batch: [
        // The circuits are checked against what FS_electrical derives, and FS_electrical 0.1.0 is
        // evaluated only for Core 0.2 plans: this one declares 0.2 (a new project is 0.3). When the
        // extension takes Core 0.3, drop this op.
        { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' },
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
        { op: 'placeElement', extension: 'FS_electrical', collection: 'panels', id: 'P1', host: { mode: 'wallFace', wall: 'west wall of Kitchen', toward: 'Kitchen', at: "4'", height: "5'" }, element: { fallback: { box: { min: [0, -256000, -512000], max: [128000, 256000, 512000] } }, volts: [120, 240], rating: 100, spaces: 20 } },
      ],
    });
    expect(panel.status, panel.text).toBe(201);
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent'));
    const res = await agent.post(path('/assistants/electrical'), { rooms: ['kitchen'] });
    expect(res.status, res.text).toBe(201);
    const body = res.body as Proposed;
    // A kitchen's receptacles share at least two circuits; its light has one of its own.
    expect(body.proposal.circuits.length).toBeGreaterThanOrEqual(3);
    const model = await agent.get(path(`/changesets/${body.changeset?.id ?? ''}/model.json`));
    const derived = check(model.text, OFFICIAL_READER).derived?.extensions?.FS_electrical;
    expect(new Set(derived?.panels['P1']?.circuits)).toEqual(new Set(body.proposal.circuits.map((c) => c.id)));
  });

  it('takes a spacing, and refuses what it cannot use', async () => {
    const tight = (await operator.post(path('/assistants/electrical'), {})).body as Proposed;
    const loose = (await operator.post(path('/assistants/electrical'), { spacing: "20'" })).body as Proposed;
    // Kitchens keep their own spacing; with it overridden only the general one changes — here none.
    expect(loose.proposal.added.receptacles.length).toBe(tight.proposal.added.receptacles.length);
    expect(loose.changeset?.name).toBe('Electrical layout: Kitchen (2)');
    expect((await operator.post(path('/assistants/electrical'), { spacing: 'wide' })).status).toBe(400);
    expect((await operator.post(path('/assistants/electrical'), { rooms: ['Pantry'] })).status).toBe(400);
    const level = await operator.post(path('/assistants/electrical'), { level: 'L9' });
    expect(level.status).toBe(422);
    expect(level.text).toContain('There is no level L9');
  });
});
