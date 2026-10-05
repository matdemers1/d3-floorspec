import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventHubOf } from '../../src/app.js';
import { EventHub } from '../../src/events/hub.js';
import { ONE_ROOM_HOUSE } from '../support/fake-applier.js';
import {
  Browser,
  createProjectAs,
  inviteMember,
  isStream,
  OPERATOR,
  reset,
  setupOperator,
  start,
  testDb,
  TEST_ENV,
  tokenFor,
  type EventStream,
  type Running,
  type SseEvent,
} from './helpers.js';

/**
 * FLR-T-3.5, the server half: `GET /api/projects/:projectId/events`. A subscriber hears main move
 * and changesets change, from the transaction that made the change and only if it committed;
 * resumes with `Last-Event-ID`; and hears nothing from anybody else's project.
 */

const RENAME = (name: string) => [{ op: 'setProperty', id: 'R1', path: '/name', value: name }];

describe('the live event stream', () => {
  const db = testDb();
  let running: Running;
  let operator: Browser;
  let project: { id: string; head: string };
  const open: EventStream[] = [];

  const path = (suffix: string) => `/api/projects/${project.id}${suffix}`;
  const accountId = async () => (await db.account.findFirstOrThrow({ where: { role: 'operator' } })).id;

  /** Subscribe and wait until the stream says it is live. */
  async function subscribe(as: Browser = operator, headers: Record<string, string> = {}, suffix = ''): Promise<EventStream> {
    const opened = await as.events(path(`/events${suffix}`), headers);
    if (!isStream(opened)) throw new Error(`subscribe answered ${String(opened.status)}: ${opened.text}`);
    open.push(opened);
    return opened;
  }

  async function apply(batch: unknown[], as: Browser = operator) {
    const res = await as.post(path('/ops'), { batch });
    expect(res.status, res.text).toBe(201);
    return res.body as { hash: string; op: { seq: number }; changeset: { id: string } | null };
  }

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
    await apply(ONE_ROOM_HOUSE);
  });
  afterEach(() => {
    for (const stream of open.splice(0)) stream.close();
  });

  it('streams with headers nothing in between may buffer, and says when it is live', async () => {
    const stream = await subscribe();
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    const ready = await stream.next('ready');
    expect(ready.data).toEqual({ resumed: false, replayed: 0 });
    expect(ready.id).toMatch(/^[0-9a-z]+-\d+$/);
    expect(stream.retry).toBe(3000);
  });

  it('sends head when main moves: an apply, an undo, a redo', async () => {
    const stream = await subscribe();
    const ready = await stream.next('ready');
    const applied = await apply(RENAME('Galley'));
    const head = await stream.next('head');
    expect(head.data).toEqual({
      head: 'main',
      hash: applied.hash,
      seq: applied.op.seq,
      kind: 'apply',
      authorKind: 'account',
      author: await accountId(),
      changeset: null,
    });
    expect(idNumber(head)).toBeGreaterThan(idNumber(ready));

    const undone = (await operator.post(path('/undo'))).body as { hash: string; op: { seq: number } };
    expect((await stream.next('head')).data).toMatchObject({ kind: 'undo', hash: undone.hash, seq: undone.op.seq });
    const redone = (await operator.post(path('/redo'))).body as { hash: string };
    const third = await stream.next('head');
    expect(third.data).toMatchObject({ kind: 'redo', hash: redone.hash });
    // IDs only increase.
    const ids = stream.events.map(idNumber);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('sends changeset as an agent proposes, appends, and a person accepts — and head when main moves', async () => {
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
    const stream = await subscribe();
    await stream.next('ready');

    // An agent's apply goes into a changeset named after it (FLR-ADR-016): no head event.
    const first = await apply(RENAME('Galley'), agent);
    const opened = await stream.next();
    expect(opened.event).toBe('changeset');
    expect(opened.data).toMatchObject({
      id: first.changeset?.id,
      name: 'Claude',
      status: 'pending',
      change: 'opened',
      head: `cs/${String(first.changeset?.id)}`,
      hash: first.hash,
      ops: 1,
      createdBy: 'Claude',
      mergeMode: null,
    });
    const second = await apply([{ op: 'setProperty', id: 'R1', path: '/name', value: 'Scullery' }], agent);
    expect((await stream.next()).data).toMatchObject({ change: 'appended', hash: second.hash, ops: 2, status: 'pending' });

    const accepted = await operator.post(path(`/changesets/${String(first.changeset?.id)}/accept`));
    expect(accepted.status, accepted.text).toBe(200);
    const { hash, merged } = accepted.body as { hash: string; merged: number[] };
    expect((await stream.next()).data).toMatchObject({ change: 'accepted', status: 'accepted', hash, ops: 2, mergeMode: 'fast-forward' });
    expect((await stream.next()).data).toEqual({
      head: 'main',
      hash,
      seq: merged.at(-1),
      kind: 'merge',
      authorKind: 'agent',
      author: 'Claude',
      changeset: first.changeset?.id,
    });
  });

  it('sends changeset when one is proposed and when a person rejects it, and nothing for a no-op propose', async () => {
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
    const stream = await subscribe();
    await stream.next('ready');
    const proposed = (await agent.post(path('/changesets'), { name: 'Another idea' })).body as { changeset: { id: string; head: string } };
    expect((await stream.next()).data).toMatchObject({ id: proposed.changeset.id, change: 'opened', ops: 0, hash: proposed.changeset.head });
    // Naming it again without a batch changes nothing.
    expect((await agent.post(path('/changesets'), { name: 'Another idea' })).status).toBe(200);
    const rejected = await operator.post(path(`/changesets/${proposed.changeset.id}/reject`));
    expect(rejected.status, rejected.text).toBe(200);
    const next = await stream.next();
    expect(next.data).toMatchObject({ id: proposed.changeset.id, change: 'rejected', status: 'rejected', hash: null });
    expect(stream.pending()).toEqual([]);
  });

  it('says a changeset failed to replay, after the rollback, and moves nothing', async () => {
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
    const proposed = (await agent.post(path('/changesets'), { name: 'Rename', batch: RENAME('Galley') })).body as {
      changeset: { id: string };
      applied: { hash: string };
    };
    await apply([{ op: 'removeElement', id: 'R1' }]);
    const stream = await subscribe();
    await stream.next('ready');
    const accepted = await operator.post(path(`/changesets/${proposed.changeset.id}/accept`));
    expect(accepted.status).toBe(409);
    const failed = await stream.next();
    expect(failed.event).toBe('changeset');
    expect(failed.data).toMatchObject({ id: proposed.changeset.id, status: 'pending', change: 'replay-failed', hash: proposed.applied.hash, ops: 1 });
    // No head event: nothing merged.
    await settle();
    expect(stream.pending()).toEqual([]);
  });

  it('publishes nothing for a rejected batch — not even the changeset it would have opened', async () => {
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent', 'Claude'));
    const stream = await subscribe();
    await stream.next('ready');
    const bad = [{ op: 'removeElement', id: 'NOPE' }];
    expect((await operator.post(path('/ops'), { batch: bad })).status).toBe(422);
    expect((await agent.post(path('/ops'), { batch: bad })).status).toBe(422);
    expect((await agent.post(path('/changesets'), { name: 'Bad idea', batch: bad })).status).toBe(422);
    // A stale If-Match is refused before anything is written, too.
    expect((await operator.post(path('/ops'), { batch: RENAME('x') }, { 'if-match': `"${'0'.repeat(64)}"` })).status).toBe(412);
    // The next thing the stream carries is the next commit.
    const applied = await apply(RENAME('Galley'));
    const next = await stream.next();
    expect(next.event).toBe('head');
    expect(next.data).toMatchObject({ hash: applied.hash });
    expect(stream.events.filter((e) => e.event !== 'ready')).toHaveLength(1);
  });

  it('resumes from Last-Event-ID with exactly what was missed, then goes live', async () => {
    const first = await subscribe();
    const ready = await first.next('ready');
    first.close();
    // A second subscriber stays on, so the test knows when the hub has numbered both commits.
    const watcher = await subscribe();
    await watcher.next('ready');
    const a = await apply(RENAME('Galley'));
    const b = await apply(RENAME('Scullery'));
    await watcher.next('head');
    await watcher.next('head');

    const resumed = await subscribe(operator, { 'last-event-id': String(ready.id) });
    const replayed = [await resumed.next(), await resumed.next()];
    expect(replayed.map((e) => [e.event, (e.data as { hash: string }).hash])).toEqual([
      ['head', a.hash],
      ['head', b.hash],
    ]);
    expect((await resumed.next()).data).toEqual({ resumed: true, replayed: 2 });

    // `?lastEventId=` does the same, for a client that cannot set the header.
    const byQuery = await subscribe(operator, {}, `?lastEventId=${encodeURIComponent(String(replayed[0]?.id))}`);
    expect((await byQuery.next()).data).toMatchObject({ hash: b.hash });
    expect((await byQuery.next('ready')).data).toEqual({ resumed: true, replayed: 1 });

    const c = await apply(RENAME('Pantry'));
    expect((await resumed.next('head')).data).toMatchObject({ hash: c.hash });
  });

  it('tells a subscriber to resync when it cannot resume', async () => {
    for (const lastEventId of ['nonsense', 'zzzz-1', `${eventHubOf(running.app).epoch}-999999999`]) {
      const stream = await subscribe(operator, { 'last-event-id': lastEventId });
      const first = await stream.next();
      expect(first.event, lastEventId).toBe('resync');
      expect(first.data).toEqual({ reason: 'unknown-id' });
      // It stays live after the resync.
      const applied = await apply(RENAME(`Room ${lastEventId}`));
      expect((await stream.next('head')).data).toMatchObject({ hash: applied.hash });
      stream.close();
    }
  });

  it("hears nothing from another account's project, and gets 404 for it", async () => {
    const bob = await inviteMember(running, operator, 'bob@example.test');
    const bobsProject = await createProjectAs(bob, "Bob's house");
    const alices = await subscribe();
    await alices.next('ready');

    // Bob cannot open Alice's stream, with his session or with his own project's token.
    const refused = await bob.events(path('/events'));
    expect(isStream(refused)).toBe(false);
    expect(refused).toMatchObject({ status: 404, body: { error: 'project not found' } });
    const bobsToken = Browser.bearer(running.url, await tokenFor(bob, bobsProject.id, 'read'));
    expect(await bobsToken.events(path('/events'))).toMatchObject({ status: 404 });
    expect(await new Browser(running.url).events(path('/events'))).toMatchObject({ status: 401 });

    // Bob's stream on his own project hears his commits; Alice's hears none of them.
    const bobs = await bobsToken.events(`/api/projects/${bobsProject.id}/events`);
    if (!isStream(bobs)) throw new Error('bob could not subscribe to his own project');
    open.push(bobs);
    await bobs.next('ready');
    const bobApplied = await bob.post(`/api/projects/${bobsProject.id}/ops`, { batch: ONE_ROOM_HOUSE });
    expect(bobApplied.status).toBe(201);
    expect((await bobs.next('head')).data).toMatchObject({ hash: (bobApplied.body as { hash: string }).hash });
    // Alice's own commit is the next — and only — thing on her stream.
    const mine = await apply(RENAME('Galley'));
    expect((await alices.next()).data).toMatchObject({ hash: mine.hash });
    expect(alices.events.filter((e) => e.event === 'head')).toHaveLength(1);
  });

  it('accepts a read token for its own project', async () => {
    const reader = Browser.bearer(running.url, await tokenFor(operator, project.id, 'read'));
    const stream = await subscribe(reader);
    await stream.next('ready');
    const applied = await apply(RENAME('Galley'));
    expect((await stream.next('head')).data).toMatchObject({ hash: applied.hash });
  });

  it('lets go of a subscriber that disconnects', async () => {
    const hub = eventHubOf(running.app);
    const stream = await subscribe();
    await stream.next('ready');
    expect(hub.subscriberCount(project.id)).toBe(1);
    stream.close();
    await eventually(() => hub.subscriberCount(project.id) === 0);
  });
});

describe('the live event stream, tuned', () => {
  const db = testDb();
  const extra: Running[] = [];

  beforeEach(async () => {
    await reset(db);
  });
  afterEach(async () => {
    for (const running of extra.splice(0)) await running.close();
  });

  async function startWith(options: Parameters<typeof start>[0]) {
    const running = await start(options);
    extra.push(running);
    return { running, operator: await setupOperator(running) };
  }

  async function streamOf(browser: Browser, projectId: string, headers: Record<string, string> = {}): Promise<EventStream> {
    const opened = await browser.events(`/api/projects/${projectId}/events`, headers);
    if (!isStream(opened)) throw new Error(`subscribe answered ${String(opened.status)}`);
    return opened;
  }

  it('sends a heartbeat comment while nothing happens', async () => {
    const { operator } = await startWith({ with: { eventStream: { heartbeatMs: 30 } } });
    const project = await createProjectAs(operator);
    const stream = await streamOf(operator, project.id);
    await stream.until(() => stream.comments.filter((c) => c === 'heartbeat').length >= 2);
    stream.close();
  });

  it('ends a stream after its maximum age, so the client reconnects and is authorised again', async () => {
    const { operator } = await startWith({ with: { eventStream: { maxAgeMs: 150 } } });
    const project = await createProjectAs(operator);
    const stream = await streamOf(operator, project.id);
    await stream.next('ready');
    await stream.closed();
    expect(stream.ended).toBe(true);
  });

  it('answers resync when what was missed has fallen out of the ring', async () => {
    const { operator } = await startWith({ with: { events: new EventHub(TEST_ENV.DATABASE_URL, { ringSize: 1 }) } });
    const project = await createProjectAs(operator);
    const first = await streamOf(operator, project.id);
    const ready = await first.next('ready');
    first.close();
    const watcher = await streamOf(operator, project.id);
    await watcher.next('ready');
    for (const batch of [ONE_ROOM_HOUSE, RENAME('B')]) {
      expect((await operator.post(`/api/projects/${project.id}/ops`, { batch })).status).toBe(201);
    }
    // Once the hub has numbered both, the ring holds only the second.
    await watcher.next('head');
    await watcher.next('head');
    watcher.close();
    const resumed = await streamOf(operator, project.id, { 'last-event-id': String(ready.id) });
    expect(await resumed.next()).toMatchObject({ event: 'resync', data: { reason: 'expired' } });
    resumed.close();
  });

  it('fans out through Postgres: a commit on one api process reaches a subscriber on another', async () => {
    const { running: one, operator } = await startWith({});
    const two = await start();
    extra.push(two);
    const project = await createProjectAs(operator);
    // The same person, signed in on the other process: they share the database.
    const viaTwo = new Browser(two.url);
    expect((await viaTwo.post('/auth/login', OPERATOR)).status).toBe(200);
    const stream = await streamOf(viaTwo, project.id);
    await stream.next('ready');
    const applied = await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
    expect(applied.status).toBe(201);
    expect(new URL(one.url).port).not.toBe(new URL(two.url).port);
    expect((await stream.next('head')).data).toMatchObject({ hash: (applied.body as { hash: string }).hash });
    stream.close();
  });

  it('reconnects a listener that lost its connection, and tells subscribers to resync', async () => {
    const hub = new EventHub(TEST_ENV.DATABASE_URL, { backoffMs: 20 });
    const { operator } = await startWith({ with: { events: hub } });
    const project = await createProjectAs(operator);
    const stream = await streamOf(operator, project.id);
    const ready = await stream.next('ready');
    await db.$executeRaw`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'd3-floorspec events' and datname = current_database() and pid <> pg_backend_pid()`;
    const resync = await stream.next('resync');
    expect(resync.data).toEqual({ reason: 'listener-reconnected' });
    expect(idNumber(resync)).toBeGreaterThan(idNumber(ready));
    const applied = await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
    expect((await stream.next('head')).data).toMatchObject({ hash: (applied.body as { hash: string }).hash });
    // An ID from before the loss cannot be resumed from: what was sent while nobody listened is gone.
    stream.close();
    const resumed = await streamOf(operator, project.id, { 'last-event-id': String(ready.id) });
    expect(await resumed.next()).toMatchObject({ event: 'resync', data: { reason: 'expired' } });
    resumed.close();
  });
});

function idNumber(event: SseEvent): number {
  return Number(String(event.id).split('-').at(-1));
}

/** Give a stray event time to arrive, if one were coming. */
async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await settle(20);
  }
}
