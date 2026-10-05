import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportIfc } from '@d3-floorspec/worker/ifc';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';
import { projectWithDocument } from './drawings-support.js';
import { editIfc, REAL, realWorker, reconciliation, stepCarrying, stubWorker, uploadIfc, type Worker } from './imports-support.js';

/**
 * FLR-T-9.5 end to end: an IFC file exported from a project, edited in another tool, uploaded back —
 * and reconciled by Floorspec ID into a proposed changeset (never main) with a report of what did not
 * come across, which then accepts, by fast-forward or by replay onto a main that moved meanwhile.
 */

interface ImportReply {
  changeset: { id: string; name: string; status: string; base: string; head: string | null } | null;
  report: {
    source: 'ifc';
    file: { name: string };
    base: string;
    edits: { element: string; kind: string; changes: string[] }[];
    entries: { severity: string; globalId: string | null; entity: string | null; element: string | null; change: string; reason: string }[];
    counts: Record<string, number>;
  };
}

type Doc = Record<string, Record<string, Record<string, unknown>>>;

const db = testDb();
const HOUSE = JSON.parse(readFileSync(new URL('../../../../packages/mcp/test/fixtures/three-room-house.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;
const AT = new Date('2026-10-05T12:00:00Z');

describe('IFC round trip', () => {
  let running: Running;
  const before = process.env['IFC_WORKER_URL'];
  let worker: Worker | null = null;
  const use = (w: Worker) => {
    worker = w;
    process.env['IFC_WORKER_URL'] = w.url;
  };

  beforeAll(async () => {
    running = await start();
  }, 30_000);
  afterAll(async () => {
    if (before === undefined) delete process.env['IFC_WORKER_URL'];
    else process.env['IFC_WORKER_URL'] = before;
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });
  afterEach(async () => {
    await worker?.stop();
    worker = null;
  });

  describe.skipIf(!REAL)('with the real IFC worker', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'flr-ifcimport-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** Export the project's head as the person downloads it, and make the architect's edits. */
    async function exported(hash: string, scenarios: readonly string[]): Promise<Uint8Array> {
      const file = await exportIfc(HOUSE, { version: { hash, at: AT }, workerUrl: (worker as Worker).url });
      const source = join(dir, `${hash.slice(0, 8)}.ifc`);
      writeFileSync(source, file.bytes);
      if (scenarios.length === 0) return file.bytes;
      const target = join(dir, `edited-${scenarios.join('-')}.ifc`);
      await editIfc(source, target, scenarios);
      return new Uint8Array(readFileSync(target));
    }

    it('reconciles an edited export into a pending changeset with its report, which accepts', async () => {
      use(await realWorker());
      const operator = await setupOperator(running);
      const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
      const bytes = await exported(hash, ['move-wall', 'door-width', 'rename-space', 'delete-window', 'new-wall', 'brep-wall']);

      const reply = await uploadIfc(running.url, operator, id, bytes, { name: 'three-room-house-architect.ifc' });
      expect(reply.status, reply.text).toBe(201);
      const { changeset, report } = reply.body as ImportReply;
      expect(changeset).toMatchObject({ name: 'IFC round-trip: three-room-house-architect.ifc', status: 'pending', base: hash });
      expect(report.edits.map((e) => [e.kind, e.element])).toEqual([
        ['opening', 'FD'],
        ['room', 'KIT'],
        ['wall', 'WW'],
        ['opening', 'KW'],
        ['wall', 'Closet wall'],
      ]);
      expect(report.entries.map((e) => [e.severity, e.entity, e.element])).toEqual([['unmapped', 'IfcWall', 'WI2']]);
      expect(report.entries[0]?.change).toContain('replaced by Brep');
      expect(report.entries[0]?.globalId).toMatch(/^[0-9A-Za-z_$]{22}$/);

      // Main has not moved: nothing of it is in the plan until a person accepts it.
      expect((await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: id, name: 'main' } } })).versionHash).toBe(hash);
      expect(await db.opLog.count({ where: { projectId: id, head: 'main', changesetId: { not: null } } })).toBe(0);

      // The review reads the report with the changeset.
      const detail = (await operator.get(`/api/projects/${id}/changesets/${changeset?.id ?? ''}`)).body as { report: ImportReply['report']; log: { ops: { op: string }[] }[] };
      expect(detail.report).toEqual(report);
      expect(detail.log[0]?.ops.map((o) => o.op)).toEqual(['setProperty', 'setProperty', 'moveWall', 'removeElement', 'drawWall']);

      const accepted = await operator.post(`/api/projects/${id}/changesets/${changeset?.id ?? ''}/accept`);
      expect(accepted.status, accepted.text).toBe(200);
      expect(accepted.body).toMatchObject({ mode: 'fast-forward' });
      const model = (await operator.get(`/api/projects/${id}/model.json`)).body as Doc;
      expect(model['junctions']?.['C1']?.['position']).toEqual([-384000, 0]);
      expect(model['junctions']?.['C2']?.['position']).toEqual([-384000, 9363456]);
      expect(model['openings']?.['FD']?.['width']).toBe(1170432 + 128000);
      expect(model['openings']?.['KW']).toBeUndefined();
      expect(model['rooms']?.['KIT']?.['name']).toBe('Kitchen and pantry');
      expect(Object.values(model['walls'] ?? {}).filter((w) => w['name'] === 'Closet wall')).toHaveLength(1);
      expect(await db.auditLog.count({ where: { action: 'import.ifc', targetId: changeset?.id ?? '' } })).toBe(1);
    }, 120_000);

    it('replays cleanly onto a main that moved after the export', async () => {
      use(await realWorker());
      const operator = await setupOperator(running);
      const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
      const bytes = await exported(hash, ['move-wall', 'rename-space']);
      // Meanwhile, in Floorspec: the bedroom is renamed on main.
      const edited = await operator.post(`/api/projects/${id}/ops`, { batch: [{ op: 'setProperty', id: 'BED', path: '/name', value: 'Primary bedroom' }] });
      expect(edited.status, edited.text).toBe(201);

      const reply = await uploadIfc(running.url, operator, id, bytes);
      expect(reply.status, reply.text).toBe(201);
      const { changeset } = reply.body as ImportReply;
      // The changeset starts at the version the file came from, not at main.
      expect(changeset?.base).toBe(hash);
      const accepted = await operator.post(`/api/projects/${id}/changesets/${changeset?.id ?? ''}/accept`);
      expect(accepted.status, accepted.text).toBe(200);
      expect(accepted.body).toMatchObject({ mode: 'replay' });
      const model = (await operator.get(`/api/projects/${id}/model.json`)).body as Doc;
      expect(model['rooms']?.['BED']?.['name']).toBe('Primary bedroom');
      expect(model['rooms']?.['KIT']?.['name']).toBe('Kitchen and pantry');
      expect(model['junctions']?.['C1']?.['position']).toEqual([-384000, 0]);
    }, 120_000);

    it('makes no changeset from an unedited export: an empty batch and an empty report', async () => {
      use(await realWorker());
      const operator = await setupOperator(running);
      const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
      const reply = await uploadIfc(running.url, operator, id, await exported(hash, []));
      expect(reply.status, reply.text).toBe(200);
      const body = reply.body as ImportReply;
      expect(body.changeset).toBeNull();
      expect(body.report.edits).toEqual([]);
      expect(body.report.entries).toEqual([]);
      expect(await db.changeset.count({ where: { projectId: id } })).toBe(0);
      expect(await db.auditLog.count({ where: { action: 'import.ifc', targetId: id } })).toBe(1);
    }, 120_000);
  });

  it('applies the edits that apply, and reports the one the applier refuses', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
    use(
      await stubWorker((req) => ({
        status: 200,
        body: reconciliation(req.payload.hash, [
          { element: 'KIT', kind: 'room', changes: ["name 'Kitchen' → 'Galley'"], ops: [{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' }], sources: [{ globalId: '1abcdefghijklmnopqrstu', entity: 'IfcSpace' }] },
          { element: 'NOPE', kind: 'wall', changes: ['wall NOPE deleted'], ops: [{ op: 'removeElement', id: 'NOPE' }], sources: [{ globalId: '2abcdefghijklmnopqrstu', entity: 'IfcWall' }] },
        ]),
      })),
    );
    const reply = await uploadIfc(running.url, operator, id, stepCarrying(hash));
    expect(reply.status, reply.text).toBe(201);
    const { changeset, report } = reply.body as ImportReply;
    expect(report.edits.map((e) => e.element)).toEqual(['KIT']);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ severity: 'rejected', globalId: '2abcdefghijklmnopqrstu', entity: 'IfcWall', element: 'NOPE', change: 'wall NOPE deleted' });
    expect(report.entries[0]?.reason).toContain('FS-OPS-003');
    expect(report.counts).toMatchObject({ edits: 1, rejected: 1 });
    const stored = await db.changeset.findUniqueOrThrow({ where: { id: changeset?.id ?? '' } });
    expect(stored.report).toEqual(report);
  });

  it('refuses a file this project did not export, unless a base version is named', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
    use(await stubWorker((req) => ({ status: 200, body: reconciliation(req.payload.hash, [{ element: 'KIT', kind: 'room', changes: ['renamed'], ops: [{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' }], sources: [] }]) })));

    const foreign = await uploadIfc(running.url, operator, id, stepCarrying('f'.repeat(64)));
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ type: expect.stringContaining('not-from-this-project') as unknown, title: 'this IFC file was not exported from this project' });

    const none = await uploadIfc(running.url, operator, id, stepCarrying(null));
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ title: 'this IFC file was not exported from Floorspec' });

    const chosen = await uploadIfc(running.url, operator, id, stepCarrying('f'.repeat(64)), { base: hash });
    expect(chosen.status, chosen.text).toBe(201);
    expect((chosen.body as ImportReply).changeset?.base).toBe(hash);

    const bad = await uploadIfc(running.url, operator, id, stepCarrying(null), { base: 'f'.repeat(64) });
    expect(bad.status).toBe(422);
    expect(await db.changeset.count({ where: { projectId: id } })).toBe(1);
  });

  it('lands an agent’s import in a changeset, never on main', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
    use(await stubWorker((req) => ({ status: 200, body: reconciliation(req.payload.hash, [{ element: 'KIT', kind: 'room', changes: ['renamed'], ops: [{ op: 'setProperty', id: 'KIT', path: '/name', value: 'Galley' }], sources: [] }]) })));
    const agent = { bearer: await tokenFor(operator, id, 'agent') };
    const reply = await uploadIfc(running.url, agent, id, stepCarrying(hash));
    expect(reply.status, reply.text).toBe(201);
    expect((reply.body as ImportReply).changeset?.status).toBe('pending');
    const head = await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: id, name: 'main' } } });
    expect(head.versionHash).toBe(hash);
    // A read token may look, not propose.
    expect((await uploadIfc(running.url, { bearer: await tokenFor(operator, id, 'read') }, id, stepCarrying(hash))).status).toBe(403);
  });

  it('says so when the IFC worker cannot be reached, and when it cannot read the file', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Three-room house');
    process.env['IFC_WORKER_URL'] = 'http://127.0.0.1:9';
    const down = await uploadIfc(running.url, operator, id, stepCarrying(hash));
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ title: 'the IFC worker is not answering' });
    use(await stubWorker(() => ({ status: 422, body: { error: 'the IFC file could not be read (Error: bad entity)' } })));
    const unread = await uploadIfc(running.url, operator, id, stepCarrying(hash));
    expect(unread.status).toBe(422);
    expect(unread.body).toMatchObject({ title: 'the IFC file could not be read', detail: 'the IFC file could not be read (Error: bad entity)' });
    expect(await db.changeset.count({ where: { projectId: id } })).toBe(0);
  });
});
