import { createHash } from 'node:crypto';
import { contentHash, validate } from '@floorspec/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupOperator, start, testDb, type Running } from './helpers.js';

/**
 * FLR-T-0.8, the code side: a signed-in account creates a project and downloads a model.json that
 * is a valid Floorspec Core 0.2 document by the reference engine — canonical bytes, keyed by the hash of its JCS form.
 */
describe('create a project, download its model', () => {
  const db = testDb();
  let running: Running;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('stores version 0, points main at it, logs op 1, and serves canonical bytes that validate', async () => {
    const operator = await setupOperator(running);
    const created = await operator.post('/api/projects', { name: 'Lake house' });
    expect(created.status).toBe(201);
    const { id, head } = created.body as { id: string; head: string };

    const jcs = '{"floorspec":"0.2","project":{"name":"Lake house"}}';
    const expectedHash = createHash('sha256').update(jcs, 'utf8').digest('hex');
    expect(head).toBe(expectedHash);

    const version = await db.version.findUniqueOrThrow({ where: { hash: expectedHash } });
    expect(version.document).toEqual({ floorspec: '0.2', project: { name: 'Lake house' } });
    expect(await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: id, name: 'main' } } })).toMatchObject({
      versionHash: expectedHash,
    });
    const ops = await db.opLog.findMany({ where: { projectId: id } });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ seq: 1, authorKind: 'account', beforeHash: null, afterHash: expectedHash });
    expect(ops[0]?.ops).toEqual([{ op: 'createProject', name: 'Lake house', floorspec: '0.2' }]);

    const download = await operator.get(`/api/projects/${id}/model.json`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toMatch(/^application\/json/);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="model.json"');
    expect(download.headers.get('etag')).toBe(`"${expectedHash}"`);
    // The canonical file form, byte for byte: sorted keys, two spaces, LF, a final newline.
    expect(download.text).toBe('{\n  "floorspec": "0.2",\n  "project": {\n    "name": "Lake house"\n  }\n}\n');

    // Not a stub any more: the reference engine, all three tiers (FLR-T-1.10).
    const result = validate(download.text);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('shares one version row between projects that arrive at the same document', async () => {
    const operator = await setupOperator(running);
    await operator.post('/api/projects', { name: 'Same' });
    await operator.post('/api/projects', { name: 'Same' });
    expect(await db.project.count()).toBe(2);
    expect(await db.version.count()).toBe(1);
  });

  it('refuses a project without a name', async () => {
    const operator = await setupOperator(running);
    expect((await operator.post('/api/projects', { name: '   ' })).status).toBe(400);
    expect(await db.project.count()).toBe(0);
  });

  it('keeps a project stored as Core 0.1 at 0.1 through its edits, and upgrades it only by an op that says so', async () => {
    const operator = await setupOperator(running);
    const { id } = (await operator.post('/api/projects', { name: 'Old house' })).body as { id: string };
    // A project created before new projects started at Core 0.2: its head is a 0.1 document.
    const old = { floorspec: '0.1', project: { name: 'Old house' } };
    const oldHash = contentHash(old);
    await db.version.create({ data: { hash: oldHash, document: old } });
    await db.head.update({ where: { projectId_name: { projectId: id, name: 'main' } }, data: { versionHash: oldHash } });
    const model = async (): Promise<Record<string, unknown>> => JSON.parse((await operator.get(`/api/projects/${id}/model.json`)).text) as Record<string, unknown>;

    // An edit applies (Ops 0.2 applies to 0.1 documents) and does not change the declared version.
    const renamed = await operator.post(`/api/projects/${id}/ops`, { batch: [{ op: 'setProperty', id: '$project', path: '/name', value: 'Older house' }] });
    expect(renamed.status, renamed.text).toBe(201);
    expect(await model()).toEqual({ floorspec: '0.1', project: { name: 'Older house' } });

    // A program is not a Core 0.1 member: adding one without upgrading is rejected by validation.
    expect((await operator.post(`/api/projects/${id}/ops`, { batch: [{ op: 'addProgramItem', function: 'kitchen' }] })).status).toBe(422);

    // The upgrade is an op of its own, in the history like any other, and undo takes it back.
    const upgraded = await operator.post(`/api/projects/${id}/ops`, {
      batch: [
        { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' },
        { op: 'addProgramItem', function: 'kitchen', name: 'Kitchen', minArea: '8 m2' },
        { op: 'addProgramItem', function: 'dining', name: 'Dining' },
        { op: 'setAdjacency', a: 'Kitchen', b: 'Dining', kind: 'required', weight: 10 },
      ],
    });
    expect(upgraded.status, upgraded.text).toBe(201);
    expect((upgraded.body as { created: string[] }).created).toEqual(['P1', 'P2']);
    expect(await model()).toMatchObject({ floorspec: '0.2', program: { adjacency: [{ a: 'P1', b: 'P2', kind: 'required', weight: 10 }] } });
    expect((await operator.post(`/api/projects/${id}/undo`)).status).toBe(201);
    expect(await model()).toEqual({ floorspec: '0.1', project: { name: 'Older house' } });
  });

  it('agrees with the engine that a document of another version is not one it can read', () => {
    expect(validate(JSON.stringify({ floorspec: '0.3', project: { name: 'x' } })).diagnostics.map((d) => d.code)).toEqual(['FS-DOC-001']);
    expect(validate(JSON.stringify({ floorspec: '0.1' })).valid).toBe(false);
  });
});
