import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { Browser, createProjectAs, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-4.3: `POST /api/projects/:projectId/layouts` runs the layout solver on main's program and
 * opens one pending changeset per candidate. Main does not move until a person accepts one; every
 * candidate replays cleanly onto main as it is; the accepted one leaves every brief item with a
 * room and no unmet-brief lint; and the others then no longer apply.
 */

/**
 * A small brief — two bedrooms, a bath, a kitchen and a living room, three adjacencies — and the
 * empty level they are laid out on.
 */
export const BRIEF = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
  { op: 'addLevel', id: 'L1', building: 'B1', elevation: 0, height: "9'", name: 'Level 1' },
  { op: 'addProgramItem', id: 'LIV', function: 'living', name: 'Living room', targetArea: '260 sq ft' },
  { op: 'addProgramItem', id: 'KIT', function: 'kitchen', name: 'Kitchen', targetArea: '140 sq ft' },
  { op: 'addProgramItem', id: 'BED', function: 'sleeping', name: 'Bedroom', count: 2, targetArea: '130 sq ft', minArea: '100 sq ft' },
  { op: 'addProgramItem', id: 'BTH', function: 'bath', name: 'Bath', targetArea: '50 sq ft' },
  { op: 'setAdjacency', a: 'KIT', b: 'LIV', kind: 'required' },
  { op: 'setAdjacency', a: 'BED', b: 'BTH', kind: 'preferred' },
  { op: 'setAdjacency', a: 'KIT', b: 'BED', kind: 'forbidden' },
];

const PROGRAM_LINTS = ['FS-LINT-008', 'FS-LINT-009', 'FS-LINT-010', 'FS-LINT-011'];

interface Solved {
  solved: { main: string; items: number; adjacencies: number };
  candidates: {
    rank: number;
    label: string;
    level: string;
    score: { total: number; briefFit: number; circulation: number; findings: number };
    explanation: string[];
    changeset: { id: string; name: string; status: string; base: string; head: string };
    reused: boolean;
  }[];
}

describe('layout candidates', () => {
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
  });

  const path = (rest = '') => `/api/projects/${project.id}${rest}`;
  const main = async () => (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;
  const model = async (rest = '/model.json') => {
    const res = await operator.get(path(rest));
    expect(res.status, res.text).toBe(200);
    return JSON.parse(res.text) as Record<string, unknown>;
  };
  async function brief(): Promise<string> {
    const res = await operator.post(path('/ops'), { batch: BRIEF });
    expect(res.status, res.text).toBe(201);
    return (res.body as { hash: string }).hash;
  }

  it('opens one pending changeset per ranked candidate, each of which replays cleanly onto main, and writes one audit row', async () => {
    const before = await brief();
    const res = await operator.post(path('/layouts'), {});
    expect(res.status, res.text).toBe(201);
    const body = res.body as Solved;
    expect(body.solved).toMatchObject({ main: before, items: 4, adjacencies: 3 });
    expect(body.candidates.every((c) => c.level === 'L1')).toBe(true);
    expect(body.candidates.length).toBeGreaterThanOrEqual(3);
    expect(body.candidates.map((c) => c.rank)).toEqual(body.candidates.map((_, i) => i + 1));
    const totals = body.candidates.map((c) => c.score.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    // Main has not moved: a candidate is a proposal.
    expect(await main()).toBe(before);

    const document = await model();
    for (const c of body.candidates) {
      expect(c.changeset).toMatchObject({ status: 'pending', base: before });
      // The name carries the rank and the score, since a changeset has no other place for them.
      expect(c.changeset.name).toMatch(new RegExp(`^Layout ${String(c.rank)} of ${String(body.candidates.length)} \\(${c.score.total.toFixed(1)}\\): `));
      const detail = (await operator.get(path(`/changesets/${c.changeset.id}`))).body as { log: { ops: unknown[] }[] };
      expect(detail.log).toHaveLength(1);
      // The batch replays onto main as the server's accept would, and the result checks.
      const replayed = apply(document, { batch: detail.log[0]?.ops as never });
      expect(replayed.status).toBe('committed');
      if (replayed.status === 'committed') expect(check(replayed.document).valid).toBe(true);
      expect(JSON.parse((await operator.get(path(`/changesets/${c.changeset.id}/model.json`))).text)).toBeDefined();
    }
    const audit = await db.auditLog.findMany({ where: { action: 'layouts.propose' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetType: 'project', targetId: project.id });
    expect((audit[0]?.detail as { candidates: unknown[] }).candidates).toHaveLength(body.candidates.length);
  });

  it('accepting the top candidate meets the brief — every item has a room, no FS-LINT-008…011 — and the others stop applying', async () => {
    await brief();
    const body = (await operator.post(path('/layouts'), {})).body as Solved;
    const [top, ...rest] = body.candidates;
    if (top === undefined) throw new Error('no candidates');
    const accepted = await operator.post(path(`/changesets/${top.changeset.id}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toMatchObject({ mode: 'fast-forward' });

    const result = check(await model());
    expect(result.valid).toBe(true);
    expect(Object.keys(result.derived?.program?.items ?? {}).sort()).toEqual(['BED', 'BTH', 'KIT', 'LIV']);
    for (const [id, item] of Object.entries(result.derived?.program?.items ?? {})) {
      expect(item.rooms.length, id).toBeGreaterThan(0);
      expect(item.countMet, id).toBe(true);
    }
    expect(result.diagnostics.filter((d) => PROGRAM_LINTS.includes(d.code))).toEqual([]);

    for (const other of rest) {
      const res = await operator.post(path(`/changesets/${other.changeset.id}/accept`));
      expect(res.status, res.text).toBe(409);
      expect(res.body).toMatchObject({ type: '/problems/replay-failed' });
    }
  });

  it('names the same candidates again when solved twice on the same main, and new ones once main moves', async () => {
    await brief();
    const first = (await operator.post(path('/layouts'), {})).body as Solved;
    const again = await operator.post(path('/layouts'), {});
    expect(again.status, again.text).toBe(200);
    const second = again.body as Solved;
    expect(second.candidates.every((c) => c.reused)).toBe(true);
    expect(second.candidates.map((c) => c.changeset.id)).toEqual(first.candidates.map((c) => c.changeset.id));
    expect(await db.changeset.count({ where: { projectId: project.id } })).toBe(first.candidates.length);

    // Main moves (the brief grows): a new solve opens new changesets, and no name is used twice.
    expect((await operator.post(path('/ops'), { batch: [{ op: 'addProgramItem', id: 'OFF', function: 'office', name: 'Office', targetArea: '100 sq ft' }] })).status).toBe(201);
    const third = (await operator.post(path('/layouts'), {})).body as Solved;
    expect(third.candidates.every((c) => !c.reused)).toBe(true);
    const names = (await db.changeset.findMany({ where: { projectId: project.id, status: 'pending' } })).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is open to an agent token, whose candidates are its own changesets and never main', async () => {
    const before = await brief();
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
    const res = await agent.post(path('/layouts'), { count: 3, footprint: { width: "44'", depth: "30'" } });
    expect(res.status, res.text).toBe(201);
    const body = res.body as Solved;
    expect(body.candidates.length).toBeGreaterThanOrEqual(3);
    const rows = await db.changeset.findMany({ where: { id: { in: body.candidates.map((c) => c.changeset.id) } } });
    expect(rows.every((r) => r.createdByAgent === 'Claude')).toBe(true);
    expect(await main()).toBe(before);
    // A read token cannot.
    const read = Browser.bearer(running.url, await tokenFor(operator, project.id, 'read'));
    expect((await read.post(path('/layouts'), {})).status).toBe(403);
  });

  it('says why when there is nothing to lay out, and refuses a body it does not understand', async () => {
    const res = await operator.post(path('/layouts'), {});
    expect(res.status, res.text).toBe(422);
    expect(res.body).toMatchObject({ type: '/problems/layout-unsolvable' });
    expect((res.body as { detail: string }).detail).toMatch(/no program/);
    expect((await operator.post(path('/layouts'), { count: 40 })).status).toBe(400);
    expect((await operator.post(path('/layouts'), { footprint: { width: 'wide', depth: "30'" } })).status).toBe(400);
    expect(await db.changeset.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'layouts.propose' } })).toBe(0);
  });
});
