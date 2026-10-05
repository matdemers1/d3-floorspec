import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from '@floorspec/engine';
import { unavailableApplier } from '../../src/ops/applier.js';
import { FakeApplier, ONE_ROOM_HOUSE } from '../support/fake-applier.js';
import { Browser, createProjectAs, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-2.4: applying ops stores a new canonical version, appends the op with its author (user,
 * token or agent) and inverse patches, and moves the head; undo appends the inverse.
 */
describe('versions and the op log', () => {
  const db = testDb();
  const applier = new FakeApplier();
  let running: Running;
  let operator: Browser;
  let project: { id: string; head: string };

  beforeAll(async () => {
    running = await start({ with: { applier } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    operator = await setupOperator(running);
    project = await createProjectAs(operator);
  });

  const ops = (id = project.id) => `/api/projects/${id}/ops`;
  const mainOf = async () => (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;

  it('stores the new canonical version, appends the op with author, batch, resolved and inverse, and moves main', async () => {
    const res = await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    expect(res.status, res.text).toBe(201);
    const body = res.body as { hash: string; before: string; head: string; op: { seq: number; kind: string }; created: string[] };
    expect(body).toMatchObject({ status: 'committed', head: 'main', before: project.head, op: { seq: 2, kind: 'apply' } });
    expect(body.created).toEqual(['B1', 'J1', 'J2', 'J3', 'J4', 'L1', 'R1', 'W1', 'W2', 'W3', 'W4', 'WT']);
    expect(res.headers.get('etag')).toBe(`"${body.hash}"`);

    // The version is keyed by the SHA-256 of its JCS form, and stored as that document.
    const version = await db.version.findUniqueOrThrow({ where: { hash: body.hash } });
    const jcs = JSON.stringify(sortKeys(version.document));
    expect(createHash('sha256').update(jcs, 'utf8').digest('hex')).toBe(body.hash);
    expect(await mainOf()).toBe(body.hash);

    const row = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, seq: 2 } });
    expect(row).toMatchObject({
      kind: 'apply',
      head: 'main',
      authorKind: 'account',
      beforeHash: project.head,
      afterHash: body.hash,
      authorTokenId: null,
      authorAgent: null,
    });
    expect(row.ops).toEqual(ONE_ROOM_HOUSE);
    expect(row.resolved).toEqual(ONE_ROOM_HOUSE);
    // The inverse removes everything the batch added, in the order Ops 1.6 gives.
    expect((row.inverse as { op: string; id: string }[]).map((o) => `${o.op} ${o.id}`)).toEqual([
      'removeElement R1', 'removeElement W1', 'removeElement W2', 'removeElement W3', 'removeElement W4',
      'removeElement J1', 'removeElement J2', 'removeElement J3', 'removeElement J4', 'removeElement L1', 'removeElement B1', 'removeElement WT',
    ]);

    // The version is readable as canonical bytes, and the history shows the op.
    const version2 = await operator.get(`/api/projects/${project.id}/versions/${body.hash}`);
    expect(version2.status).toBe(200);
    expect(version2.text).toBe(canonicalize(version.document));
    const history = (await operator.get(`/api/projects/${project.id}/history`)).body as { head: string; undo: number; ops: { seq: number; kind: string }[] };
    expect(history.head).toBe(body.hash);
    expect(history.undo).toBe(2);
    expect(history.ops.map((o) => `${String(o.seq)} ${o.kind}`)).toEqual(['2 apply', '1 create']);
    // Audited in the same transaction.
    expect(await db.auditLog.count({ where: { action: 'ops.apply', targetId: project.id } })).toBe(1);
  });

  it('records a write token as a token author and an agent token as an agent writing a changeset, never main', async () => {
    const write = Browser.bearer(running.url, await tokenFor(operator, project.id, 'write', 'my laptop'));
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));

    const byToken = await write.post(ops(), { batch: ONE_ROOM_HOUSE });
    expect(byToken.status, byToken.text).toBe(201);
    const tokenRow = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, seq: 2 } });
    expect(tokenRow).toMatchObject({ authorKind: 'token', head: 'main', authorAgent: null });
    expect(tokenRow.authorTokenId).not.toBeNull();
    const main = await mainOf();

    const byAgent = await agent.post(ops(), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }] });
    expect(byAgent.status, byAgent.text).toBe(201);
    const agentBody = byAgent.body as { head: string; changeset: { id: string; name: string; status: string } };
    expect(agentBody.changeset).toMatchObject({ name: 'Claude', status: 'pending' });
    expect(agentBody.head).toBe(`cs/${agentBody.changeset.id}`);
    const agentRow = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, seq: 3 } });
    expect(agentRow).toMatchObject({ authorKind: 'agent', authorAgent: 'Claude', head: `cs/${agentBody.changeset.id}`, changesetId: agentBody.changeset.id });
    // Main did not move.
    expect(await mainOf()).toBe(main);
    // The audit trail names the credential, and the account it acts for.
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'changeset.apply' } });
    expect(audit.actor).toMatch(/^agent:[0-9a-f-]{36}$/);
  });

  it('shares a version row between ops that arrive at the same document', async () => {
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    const before = await db.version.count();
    const renamed = await operator.post(ops(), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }] });
    expect(await db.version.count()).toBe(before + 1);
    const back = await operator.post(ops(), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Kitchen' }] });
    expect(back.status).toBe(201);
    expect(await db.version.count()).toBe(before + 1);
    expect((renamed.body as { before: string }).before).toBe((back.body as { hash: string }).hash);
  });

  it('refuses a stale If-Match with 412 and changes nothing; a current one commits', async () => {
    const stale = project.head;
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    const opsBefore = await db.opLog.count();
    const refused = await operator.post(ops(), { batch: [{ op: 'removeElement', id: 'R1' }] }, { 'if-match': `"${stale}"` });
    expect(refused.status).toBe(412);
    expect(refused.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(refused.body).toMatchObject({ status: 412, type: '/problems/stale-head', hash: await mainOf() });
    expect(await db.opLog.count()).toBe(opsBefore);

    const current = await operator.post(ops(), { batch: [{ op: 'removeElement', id: 'R1' }] }, { 'if-match': `"${await mainOf()}"` });
    expect(current.status, current.text).toBe(201);
  });

  it('answers a rejected batch with 422 problem+json carrying the diagnostics, and changes nothing', async () => {
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    const counts = async () => [await db.opLog.count(), await db.version.count(), await db.auditLog.count(), await db.changeset.count()];
    const before = await counts();
    const main = await mainOf();
    const res = await operator.post(ops(), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'x' }, { op: 'removeElement', id: 'W99' }] });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: '/problems/ops-rejected',
      status: 422,
      diagnostics: [{ code: 'FS-OPS-003', severity: 'error', location: { pointer: '/batch/1/id' } }],
    });
    expect(await counts()).toEqual(before);
    expect(await mainOf()).toBe(main);

    // An agent's rejected first batch does not leave an empty changeset behind.
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent'));
    const agentBefore = await counts();
    expect((await agent.post(ops(), { batch: [{ op: 'removeElement', id: 'W99' }] })).status).toBe(422);
    const after = await counts();
    expect(after[0]).toBe(agentBefore[0]);
    expect(after[3]).toBe(0);
  });

  it('refuses a malformed request with 400 before the applier sees it', async () => {
    expect((await operator.post(ops(), { batch: [] })).status).toBe(400);
    expect((await operator.post(ops(), { batch: [{ notAnOp: true }] })).status).toBe(400);
    expect((await operator.post(ops(), { batch: [{ op: 'removeElement', id: 'W1' }], context: { retired: ['W1'] } })).status).toBe(400);
  });

  it('undo appends the stored inverse as a new op; undoing an undo is a redo; history never rewinds', async () => {
    const built = (await operator.post(ops(), { batch: ONE_ROOM_HOUSE })).body as { hash: string };
    const renamed = (await operator.post(ops(), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }] })).body as { hash: string };

    const undo = await operator.post(`/api/projects/${project.id}/undo`);
    expect(undo.status, undo.text).toBe(201);
    expect(undo.body).toMatchObject({ hash: built.hash, undid: 3, op: { seq: 4, kind: 'undo' } });
    expect(await mainOf()).toBe(built.hash);
    const undoRow = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, seq: 4 }, include: { undoOf: true } });
    expect(undoRow.undoOf?.seq).toBe(3);
    expect(undoRow.ops).toEqual([{ op: 'setProperty', id: 'R1', path: '/name', value: 'Kitchen' }]);

    // Undo again: the next edit back, the room's creation.
    const second = await operator.post(`/api/projects/${project.id}/undo`);
    expect(second.body).toMatchObject({ hash: project.head, undid: 2, op: { seq: 5, kind: 'undo' } });

    // Redo is the undo of the newest undo, appended too.
    const redo = await operator.post(`/api/projects/${project.id}/redo`);
    expect(redo.status, redo.text).toBe(201);
    expect(redo.body).toMatchObject({ hash: built.hash, redid: 5, op: { seq: 6, kind: 'redo' } });
    const redo2 = await operator.post(`/api/projects/${project.id}/redo`);
    expect(redo2.body).toMatchObject({ hash: renamed.hash, redid: 4, op: { seq: 7, kind: 'redo' } });
    expect((await operator.post(`/api/projects/${project.id}/redo`)).status).toBe(409);

    // Seven ops, none rewritten: the log only grew.
    expect(await db.opLog.count({ where: { projectId: project.id } })).toBe(7);
    const history = (await operator.get(`/api/projects/${project.id}/history`)).body as { undo: number | null; redo: number | null };
    // What undo would invert next is the rename, op 3, whose effect is back in the document.
    expect(history).toMatchObject({ undo: 3, redo: null });
  });

  it('has nothing to undo on a new project, and a new edit ends the redo trail', async () => {
    expect((await operator.post(`/api/projects/${project.id}/undo`)).status).toBe(409);
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    await operator.post(`/api/projects/${project.id}/undo`);
    await operator.post(ops(), { batch: [{ op: 'addElement', collection: 'buildings', element: {} }] });
    expect((await operator.post(`/api/projects/${project.id}/redo`)).status).toBe(409);
  });

  it('hands the applier every ID the project ever held as context.retired, and undo can bring one back', async () => {
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    await operator.post(ops(), { batch: [{ op: 'removeElement', id: 'R1' }] });
    applier.requests.length = 0;

    // A new room is minted R2, not R1: R1 is retired, though it is no longer in the document.
    const added = await operator.post(ops(), { batch: [{ op: 'addElement', collection: 'rooms', element: { level: 'L1', anchor: [1, 1] } }] });
    expect((added.body as { created: string[] }).created).toEqual(['R2']);
    expect(applier.requests[0]?.context?.retired).toContain('R1');
    // Naming a retired ID is refused (FS-OPS-005).
    const reuse = await operator.post(ops(), { batch: [{ op: 'addElement', collection: 'rooms', id: 'R1', element: { level: 'L1', anchor: [1, 1] } }] });
    expect(reuse.body).toMatchObject({ diagnostics: [{ code: 'FS-OPS-005' }] });

    // Undo the R2 add, then undo the removal: R1 comes back under its own ID.
    await operator.post(`/api/projects/${project.id}/undo`);
    const restored = await operator.post(`/api/projects/${project.id}/undo`);
    expect(restored.status, restored.text).toBe(201);
    expect((restored.body as { created: string[] }).created).toEqual(['R1']);
    expect(await db.retiredId.count({ where: { projectId: project.id } })).toBe(13);
  });

  it('hands the applier context.option, keeps it in the op log and shows it in the history (Ops 0.3, 2.8)', async () => {
    await operator.post(ops(), { batch: ONE_ROOM_HOUSE });
    applier.requests.length = 0;
    const res = await operator.post(ops(), { batch: [{ op: 'addElement', collection: 'rooms', element: { level: 'L1', anchor: [1, 1] } }], context: { option: 'KB' } });
    expect(res.status, res.text).toBe(201);
    expect(applier.requests[0]?.context?.option).toBe('KB');
    const seq = (res.body as { op: { seq: number } }).op.seq;
    expect((await db.opLog.findFirstOrThrow({ where: { projectId: project.id, seq } })).editOption).toBe('KB');
    const history = (await operator.get(`/api/projects/${project.id}/history`)).body as { ops: { seq: number; option: string | null }[] };
    expect(history.ops.find((o) => o.seq === seq)?.option).toBe('KB');
    expect(history.ops.find((o) => o.seq === seq - 1)?.option).toBeNull();
    // Not an ID: refused before the applier sees it.
    expect((await operator.post(ops(), { batch: ONE_ROOM_HOUSE, context: { option: 7 } })).status).toBe(400);
  });

  it('serves only versions this project reached', async () => {
    const other = await createProjectAs(operator, 'Other');
    await operator.post(`/api/projects/${other.id}/ops`, { batch: ONE_ROOM_HOUSE });
    const otherHead = (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: other.id, name: 'main' } } })).versionHash;
    expect((await operator.get(`/api/projects/${project.id}/versions/${otherHead}`)).status).toBe(404);
    expect((await operator.get(`/api/projects/${other.id}/versions/${otherHead}`)).status).toBe(200);
    expect((await operator.get(`/api/projects/${project.id}/versions/not-a-hash`)).status).toBe(404);
  });
});

describe('without an applier', () => {
  const db = testDb();
  let running: Running;

  beforeAll(async () => {
    running = await start({ with: { applier: unavailableApplier } });
  });
  afterAll(async () => {
    await running.close();
  });

  it('answers 503 problem+json and changes nothing', async () => {
    await reset(db);
    const operator = await setupOperator(running);
    const project = await createProjectAs(operator);
    const res = await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ type: '/problems/applier-unavailable' });
    expect(await db.opLog.count()).toBe(1);
  });
});

/** RFC 8785 for these documents: integers and strings only, so sorting keys is the whole job. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
