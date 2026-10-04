import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ONE_ROOM_HOUSE } from '../support/fake-applier.js';
import { Browser, createProjectAs, inviteMember, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-2.5: agent-scoped tokens write into named pending changesets on scratch heads; accept
 * fast-forwards or replays onto main; reject discards; a replay failure is surfaced as the
 * applier's diagnostics and never merged.
 */
describe('API tokens', () => {
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

  it('shows the secret once and stores only its hash', async () => {
    const created = await operator.post('/api/tokens', { projectId: project.id, name: 'Claude Code', kind: 'agent' });
    expect(created.status, created.text).toBe(201);
    const { token, id, scopes } = created.body as { token: string; id: string; scopes: string[] };
    expect(token).toMatch(/^fls_[A-Za-z0-9_-]{43}$/);
    expect(scopes).toEqual(['read', 'agent']);
    const row = await db.apiToken.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token);
    // Listed without the secret, and the audit row does not carry it either.
    const listed = await operator.get('/api/tokens');
    expect(listed.text).not.toContain(token);
    expect((listed.body as { tokens: { id: string; kind: string; state: string }[] }).tokens).toEqual([
      expect.objectContaining({ id, kind: 'agent', state: 'active' }),
    ]);
    expect(JSON.stringify(await db.auditLog.findMany({ where: { action: 'token.create' } }))).not.toContain(token);
  });

  it('stops working the moment it is revoked', async () => {
    const created = (await operator.post('/api/tokens', { projectId: project.id, name: 'x', kind: 'read' })).body as { token: string; id: string };
    const client = Browser.bearer(running.url, created.token);
    expect((await client.get(`/api/projects/${project.id}`)).status).toBe(200);
    expect((await operator.request('DELETE', `/api/tokens/${created.id}`)).status).toBe(204);
    expect((await client.get(`/api/projects/${project.id}`)).status).toBe(401);
  });

  it('expires', async () => {
    const created = (await operator.post('/api/tokens', { projectId: project.id, name: 'x', kind: 'read', expiresInDays: 1 })).body as { token: string; id: string };
    await db.apiToken.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await Browser.bearer(running.url, created.token).get(`/api/projects/${project.id}`)).status).toBe(401);
  });

  it('reaches its own project and nothing else', async () => {
    const other = await createProjectAs(operator, 'Other');
    const write = Browser.bearer(running.url, await tokenFor(operator, project.id, 'write'));
    expect((await write.get(`/api/projects/${other.id}`)).status).toBe(404);
    expect((await write.post(`/api/projects/${other.id}/ops`, { batch: ONE_ROOM_HOUSE })).status).toBe(404);
    const listed = (await write.get('/api/projects')).body as { projects: { id: string }[] };
    expect(listed.projects.map((p) => p.id)).toEqual([project.id]);
  });

  it('never acts as a person: no tokens, no account settings, no invites', async () => {
    const write = Browser.bearer(running.url, await tokenFor(operator, project.id, 'write'));
    expect((await write.post('/api/tokens', { projectId: project.id, name: 'y', kind: 'write' })).status).toBe(403);
    expect((await write.get('/api/tokens')).status).toBe(403);
    expect((await write.post('/auth/totp/enrol')).status).toBe(403);
    expect((await write.post('/api/invites', {})).status).toBe(403);
    expect((await write.request('DELETE', `/api/projects/${project.id}`)).status).toBe(403);
    // A bearer request is judged by its token alone; the session cookie beside it is ignored.
    const session = await write.get('/auth/session');
    expect(session.status).toBe(401);
  });

  it('holds each token to its scope', async () => {
    const read = Browser.bearer(running.url, await tokenFor(operator, project.id, 'read'));
    expect((await read.get(`/api/projects/${project.id}/model.json`)).status).toBe(200);
    expect((await read.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE })).status).toBe(403);
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent'));
    const undo = await agent.post(`/api/projects/${project.id}/undo`);
    expect(undo.status).toBe(403);
    expect((undo.body as { error: string }).error).toContain('FLR-ADR-016');
  });

  it('cannot be minted for somebody else\'s project', async () => {
    const bob = await inviteMember(running, operator, 'bob@example.test');
    const res = await bob.post('/api/tokens', { projectId: project.id, name: 'mine now', kind: 'write' });
    expect(res.status).toBe(404);
    expect(await db.apiToken.count()).toBe(0);
    // Nor revoked by somebody else.
    const created = (await operator.post('/api/tokens', { projectId: project.id, name: 'x', kind: 'read' })).body as { id: string };
    expect((await bob.request('DELETE', `/api/tokens/${created.id}`)).status).toBe(404);
    expect((await db.apiToken.findUniqueOrThrow({ where: { id: created.id } })).revokedAt).toBeNull();
  });

  it('refuses a token that is both a write token and an agent token, in the database', async () => {
    const account = await db.account.findFirstOrThrow();
    await expect(
      db.apiToken.create({ data: { accountId: account.id, projectId: project.id, name: 'both', tokenHash: 'x', prefix: 'fls_x', scopes: ['write', 'agent'] } }),
    ).rejects.toThrow();
  });
});

describe('changesets', () => {
  const db = testDb();
  let running: Running;
  let operator: Browser;
  let agent: Browser;
  let project: { id: string; head: string };
  let base: string;

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
    base = ((await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE })).body as { hash: string }).hash;
    agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
  });

  const path = (rest = '') => `/api/projects/${project.id}${rest}`;
  const mainOf = async () => (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;

  async function propose(name: string, batch: unknown[]) {
    const res = await agent.post(path('/changesets'), { name, batch });
    expect(res.status, res.text).toBeLessThan(300);
    return res.body as { changeset: { id: string; name: string; status: string; head: string }; applied: { hash: string } };
  }

  it('puts an agent\'s ops on a named scratch head and leaves main alone', async () => {
    const first = await propose('Widen the kitchen', [{ op: 'setProperty', id: 'J3', path: '/position', value: [6000000, 3840000] }]);
    expect(first.changeset).toMatchObject({ name: 'Widen the kitchen', status: 'pending' });
    const id = first.changeset.id;
    const scratch = await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: `cs/${id}` } } });
    expect(scratch.versionHash).toBe(first.applied.hash);
    expect(await mainOf()).toBe(base);

    // The same name appends to the same pending changeset, through either route.
    const second = await agent.post(path('/ops'), { batch: [{ op: 'moveJunction', id: 'J4', to: [6000000, 0] }], changeset: 'Widen the kitchen' });
    expect(second.status, second.text).toBe(201);
    expect((second.body as { changeset: { id: string } }).changeset.id).toBe(id);
    const byHandle = await agent.post(path('/ops'), { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Big kitchen' }], changeset: id });
    expect(byHandle.status).toBe(201);

    const listed = (await operator.get(path('/changesets'))).body as { changesets: { id: string; ops: number; fastForward: boolean }[] };
    expect(listed.changesets).toEqual([expect.objectContaining({ id, ops: 3, fastForward: true })]);
    const read = (await agent.get(path(`/changesets/${id}`))).body as { log: { seq: number }[]; head: string };
    expect(read.log.map((o) => o.seq)).toEqual([3, 4, 5]);
    const model = await agent.get(path(`/changesets/${id}/model.json`));
    expect(model.headers.get('etag')).toBe(`"${read.head}"`);
    expect(await mainOf()).toBe(base);
  });

  it('accepts by fast-forward when main has not moved: the ops arrive on main as merges, by their author', async () => {
    const proposed = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    const accepted = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toMatchObject({ mode: 'fast-forward', hash: proposed.applied.hash, changeset: { status: 'accepted', mergeMode: 'fast-forward' } });
    expect(await mainOf()).toBe(proposed.applied.hash);

    const merged = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, head: 'main', kind: 'merge' } });
    expect(merged).toMatchObject({ authorKind: 'agent', authorAgent: 'Claude', changesetId: proposed.changeset.id, beforeHash: base, afterHash: proposed.applied.hash });
    // The scratch head is gone; the changeset and its own ops stay in the log.
    expect(await db.head.count({ where: { projectId: project.id, name: { startsWith: 'cs/' } } })).toBe(0);
    expect(await db.opLog.count({ where: { changesetId: proposed.changeset.id } })).toBe(2);
    // A merged op is undoable like any other.
    const undo = await operator.post(path('/undo'));
    expect(undo.body).toMatchObject({ hash: base });
  });

  it('replays the batches onto main when main has moved, re-resolving them against the plan as it is now', async () => {
    const proposed = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    const moved = (await operator.post(path('/ops'), { batch: [{ op: 'moveJunction', id: 'J3', to: [5120000, 4000000] }] })).body as { hash: string };

    const listed = (await operator.get(path('/changesets'))).body as { changesets: { fastForward: boolean }[] };
    expect(listed.changesets[0]?.fastForward).toBe(false);

    const accepted = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const body = accepted.body as { mode: string; hash: string };
    expect(body.mode).toBe('replay');
    // Both edits are in main: the person's move and the agent's rename.
    expect(body.hash).not.toBe(proposed.applied.hash);
    expect(body.hash).not.toBe(moved.hash);
    const doc = (await operator.get(path('/model.json'))).body as { rooms: { R1: { name: string } }; junctions: { J3: { position: number[] } } };
    expect(doc.rooms.R1.name).toBe('Galley');
    expect(doc.junctions.J3.position).toEqual([5120000, 4000000]);
    const merged = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, head: 'main', kind: 'merge' } });
    expect(merged).toMatchObject({ beforeHash: moved.hash, afterHash: body.hash, authorKind: 'agent' });
  });

  it('surfaces a replay failure as the applier\'s diagnostics, merges nothing, and leaves the changeset pending', async () => {
    const proposed = await propose('Rename the north wall', [{ op: 'setProperty', id: 'W2', path: '/name', value: 'North' }]);
    // Meanwhile the person removes that wall on main.
    const removed = (await operator.post(path('/ops'), { batch: [{ op: 'removeElement', id: 'W2' }] })).body as { hash: string };
    const opsBefore = await db.opLog.count();

    const accepted = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status).toBe(409);
    expect(accepted.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(accepted.body).toMatchObject({
      type: '/problems/replay-failed',
      changeset: proposed.changeset.id,
      failedIndex: 0,
      diagnostics: [{ code: 'FS-OPS-003', severity: 'error' }],
    });
    expect(await mainOf()).toBe(removed.hash);
    expect(await db.opLog.count()).toBe(opsBefore);
    expect(await db.changeset.findUniqueOrThrow({ where: { id: proposed.changeset.id } })).toMatchObject({ status: 'pending', closedAt: null });
    expect(await db.head.count({ where: { name: `cs/${proposed.changeset.id}` } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'changeset.accept' } })).toBe(0);
  });

  it('reserves the IDs a changeset minted, and gives them back to it on replay', async () => {
    const proposed = await propose('Add a room', [{ op: 'addElement', collection: 'rooms', element: { level: 'L1', anchor: [10, 10], name: 'Den' } }]);
    // The changeset minted R2. Main, meanwhile, adds a room of its own: R3, not R2.
    const mainAdd = (await operator.post(path('/ops'), { batch: [{ op: 'addElement', collection: 'rooms', element: { level: 'L1', anchor: [20, 20] } }] })).body as { created: string[] };
    expect(mainAdd.created).toEqual(['R3']);
    const accepted = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const merged = await db.opLog.findFirstOrThrow({ where: { projectId: project.id, head: 'main', kind: 'merge' } });
    // Re-minted on replay as one more than the largest in use, R4; R2 stays reserved but unused.
    expect(merged.created).toEqual(['R4']);
  });

  it('rejects by discarding the scratch head; main is untouched', async () => {
    const proposed = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    const rejected = await operator.post(path(`/changesets/${proposed.changeset.id}/reject`));
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body).toMatchObject({ changeset: { status: 'rejected' } });
    expect(await mainOf()).toBe(base);
    expect(await db.head.count({ where: { name: `cs/${proposed.changeset.id}` } })).toBe(0);
    // A closed changeset takes no more ops and cannot be decided twice.
    expect((await agent.post(path('/ops'), { batch: [{ op: 'removeElement', id: 'R1' }], changeset: proposed.changeset.id })).status).toBe(409);
    expect((await operator.post(path(`/changesets/${proposed.changeset.id}/accept`))).status).toBe(409);
    // A new proposal under the same name opens a new changeset.
    const again = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    expect(again.changeset.id).not.toBe(proposed.changeset.id);
  });

  it('lets a person decide — a session or their write token — and never an agent', async () => {
    const proposed = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    for (const verb of ['accept', 'reject']) {
      const res = await agent.post(path(`/changesets/${proposed.changeset.id}/${verb}`));
      expect(res.status, verb).toBe(403);
    }
    const read = Browser.bearer(running.url, await tokenFor(operator, project.id, 'read'));
    expect((await read.post(path(`/changesets/${proposed.changeset.id}/accept`))).status).toBe(403);
    const write = Browser.bearer(running.url, await tokenFor(operator, project.id, 'write'));
    const accepted = await write.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const account = await db.account.findFirstOrThrow({ where: { email: 'operator@example.test' } });
    expect(await db.changeset.findUniqueOrThrow({ where: { id: proposed.changeset.id } })).toMatchObject({ closedByAccountId: account.id });
  });

  it('honours If-Match on accept', async () => {
    const proposed = await propose('Rename', [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }]);
    const stale = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`), {}, { 'if-match': `"${project.head}"` });
    expect(stale.status).toBe(412);
    expect((await operator.post(path(`/changesets/${proposed.changeset.id}/accept`), {}, { 'if-match': `"${base}"` })).status).toBe(200);
  });
});
