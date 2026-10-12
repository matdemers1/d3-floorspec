import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, furniture, OFFICIAL_READER } from '@floorspec/engine';
import { Browser, createProjectAs, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-13.11: `POST /api/projects/:projectId/assistants/staging` runs the staging assistant on main
 * and opens what it proposes — decor from the FS_furniture starter library around the furniture
 * already there — as one pending changeset. Main does not move until a person accepts it; the
 * library files the decor names are copied into the project's asset store; asked again once it is
 * accepted, there is nothing to add.
 */

const FT = 390_144;
const SOFA = furniture.STARTER_LIBRARY_ITEMS['sofa-2100'] as furniture.StarterLibraryItem;

/** A 16' × 12' living room with a sofa in the middle of it, facing north. */
const ROOM = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
  { op: 'addLevel', id: 'L1', building: 'B1', elevation: 0, height: "9'", name: 'Level 1' },
  { op: 'addElement', collection: 'types', id: 'WT', element: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
  { op: 'drawWall', level: 'L1', from: [0, 0], to: [0, 12 * FT], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [0, 12 * FT], to: [16 * FT, 12 * FT], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [16 * FT, 12 * FT], to: [16 * FT, 0], type: 'WT' },
  { op: 'drawWall', level: 'L1', from: [16 * FT, 0], to: [0, 0], type: 'WT' },
  { op: 'addRoom', id: 'LIV', level: 'L1', at: [8 * FT, 6 * FT], name: 'Living', function: 'living' },
];
const FURNISH = [
  { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' },
  { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' },
  { op: 'addElement', collection: 'assets', id: 'M-sofa', element: { path: `assets/${SOFA.model.sha256}.glb`, sha256: SOFA.model.sha256, mediaType: SOFA.model.mediaType, byteLength: SOFA.model.byteLength } },
  { op: 'addElement', collection: 'assets', id: 'S-sofa', element: { path: `assets/${SOFA.symbol.sha256}.svg`, sha256: SOFA.symbol.sha256, mediaType: SOFA.symbol.mediaType, byteLength: SOFA.symbol.byteLength } },
  {
    op: 'placeElement',
    extension: 'FS_furniture',
    collection: 'pieces',
    id: 'SOFA',
    host: { mode: 'surface', room: 'LIV', surface: 'floor', at: [8 * FT, 3 * FT], rotation: 90_000_000 },
    element: { ...structuredClone(SOFA.element), fallback: { box: structuredClone(SOFA.element.fallback.box), asset: 'M-sofa', symbol: 'S-sofa' } },
  },
];

interface Staged {
  main: string;
  changeset: { id: string; name: string; status: string } | null;
  proposal: { name: string; explanation: string[]; added: { id: string; item: string; room: string; with?: string }[]; notes: string[]; ops: number };
}

describe('the staging assistant', () => {
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
    for (const batch of [ROOM, FURNISH]) {
      const res = await operator.post(`/api/projects/${project.id}/ops`, { batch });
      expect(res.status, res.text).toBe(201);
    }
  });

  const path = (rest = '') => `/api/projects/${project.id}${rest}`;
  const main = async () => (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;

  it('opens its proposal as a pending changeset, main unmoved, and copies the library files into the project', async () => {
    const before = await main();
    const res = await operator.post(path('/assistants/staging'), { rooms: ['Living'] });
    expect(res.status, res.text).toBe(201);
    const body = res.body as Staged;
    expect(body.main).toBe(before);
    expect(body.changeset).toMatchObject({ status: 'pending', name: 'Staging: Living' });
    const items = body.proposal.added.map((a) => a.item);
    expect(items).toContain('cushion-450');
    expect(items.some((i) => i.startsWith('rug-'))).toBe(true);
    expect(body.proposal.added.every((a) => a.room === 'LIV')).toBe(true);
    expect(body.proposal.explanation.join(' ')).not.toMatch(/complian/i);
    expect(await main()).toBe(before);

    const model = await operator.get(path(`/changesets/${body.changeset?.id ?? ''}/model.json`));
    expect(model.status).toBe(200);
    expect(check(model.text, OFFICIAL_READER).valid).toBe(true);
    // Every file a decor asset names is the project's to read.
    const assets = (await operator.get(path('/assets'))).body as { uploads: { sha256: string }[] };
    const uploaded = new Set(assets.uploads.map((u) => u.sha256));
    for (const item of new Set(items)) {
      const lib = furniture.STARTER_LIBRARY_ITEMS[item] as furniture.StarterLibraryItem;
      expect(uploaded.has(lib.model.sha256), `${item} model`).toBe(true);
      expect(uploaded.has(lib.symbol.sha256), `${item} symbol`).toBe(true);
    }

    // Accepted, asked again: nothing to add, and no changeset opened.
    const accepted = await operator.post(path(`/changesets/${body.changeset?.id ?? ''}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const again = await operator.post(path('/assistants/staging'), {});
    expect(again.status, again.text).toBe(200);
    expect(again.body).toMatchObject({ changeset: null, proposal: { ops: 0 } });
  });

  it('lets an agent token ask, and refuses rooms and levels the plan does not have', async () => {
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent'));
    const res = await agent.post(path('/assistants/staging'), {});
    expect(res.status, res.text).toBe(201);
    expect((await operator.post(path('/assistants/staging'), { rooms: ['Pantry'] })).status).toBe(400);
    const level = await operator.post(path('/assistants/staging'), { level: 'L9' });
    expect(level.status).toBe(422);
    expect(level.text).toContain('There is no level L9');
    expect((await operator.post(path('/assistants/staging'), { spacing: 3 })).status).toBe(400);
  });
});
