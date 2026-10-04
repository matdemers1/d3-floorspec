import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupOperator, start, testDb, type Running } from './helpers.js';

const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../src/model/stub-schema.json'), 'utf8'),
) as object;

/**
 * FLR-T-0.8, the code side: a signed-in account creates a project and downloads a model.json that
 * validates against the stub schema — canonical bytes, keyed by the hash of its JCS form.
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

    const jcs = '{"floorspec":"0.1","project":{"name":"Lake house"}}';
    const expectedHash = createHash('sha256').update(jcs, 'utf8').digest('hex');
    expect(head).toBe(expectedHash);

    const version = await db.version.findUniqueOrThrow({ where: { hash: expectedHash } });
    expect(version.document).toEqual({ floorspec: '0.1', project: { name: 'Lake house' } });
    expect(await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: id, name: 'main' } } })).toMatchObject({
      versionHash: expectedHash,
    });
    const ops = await db.opLog.findMany({ where: { projectId: id } });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ seq: 1, authorKind: 'account', beforeHash: null, afterHash: expectedHash });
    expect(ops[0]?.ops).toEqual([{ op: 'createProject', name: 'Lake house', floorspec: '0.1' }]);

    const download = await operator.get(`/api/projects/${id}/model.json`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toMatch(/^application\/json/);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="model.json"');
    expect(download.headers.get('etag')).toBe(`"${expectedHash}"`);
    // The canonical file form, byte for byte: sorted keys, two spaces, LF, a final newline.
    expect(download.text).toBe('{\n  "floorspec": "0.1",\n  "project": {\n    "name": "Lake house"\n  }\n}\n');

    const validate = new Ajv2020({ strict: true }).compile(schema);
    const valid = validate(JSON.parse(download.text));
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
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

  it('rejects a document the stub schema does not describe', () => {
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate({ floorspec: '0.2', project: { name: 'x' } })).toBe(false);
    expect(validate({ floorspec: '0.1' })).toBe(false);
  });
});
