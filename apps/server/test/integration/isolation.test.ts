import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import { Browser, inviteMember, reset, setupOperator, start, testDb, type Running } from './helpers.js';

/**
 * Per-account isolation (FLR-T-0.6): account B receives 404 — not 403, not an empty 200 — for every
 * read and every write on account A's project.
 *
 * The project-scoped routes come from the app's registry. A `:projectId` route this table does not
 * list fails the first test, so a new route is in this suite the day it is added or the suite says
 * so. Each call is also made as A, so a 404 for B is never the 404 of a route that does not work.
 */

interface Call {
  readonly body?: unknown;
  /** What A, the owner, gets. */
  readonly ownerStatus: number;
}

const CALLS: Record<string, Call> = {
  'GET /api/projects/:projectId': { ownerStatus: 200 },
  'GET /api/projects/:projectId/ops': { ownerStatus: 200 },
  'GET /api/projects/:projectId/model.json': { ownerStatus: 200 },
  // Last: it is the one that changes the project, so the owner's call to it goes at the end.
  'DELETE /api/projects/:projectId': { ownerStatus: 204 },
};

describe('per-account isolation', () => {
  const db = testDb();
  let running: Running;
  let alice: Browser;
  let bob: Browser;
  let projectId: string;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    alice = await setupOperator(running);
    bob = await inviteMember(running, alice, 'bob@example.test');
    projectId = ((await alice.post('/api/projects', { name: "Alice's house" })).body as { id: string }).id;
  });

  it('covers every project-scoped route the app declares', () => {
    const declared = registry(running.app)
      .filter((route) => route.projectScoped)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(CALLS).sort()).toEqual(declared);
  });

  it("answers B with 404 for every read and write on A's project, and changes nothing", async () => {
    const auditBefore = await db.auditLog.count();
    for (const [route, call] of Object.entries(CALLS)) {
      const [method = 'GET', path = ''] = route.split(' ');
      const res = await bob.request(method, path.replace(':projectId', projectId), call.body);
      expect(res.status, `${route} as B`).toBe(404);
      expect(res.body, `${route} as B`).toEqual({ error: 'project not found' });
    }
    // Nothing B did was a change, so nothing was audited and the project is untouched.
    expect(await db.auditLog.count()).toBe(auditBefore);
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ deletedAt: null, name: "Alice's house" });
  });

  it('gives the same 404 for a project that does not exist, so an ID leaks nothing', async () => {
    const missing = '01a10000-0000-7000-8000-000000000000';
    for (const [route, call] of Object.entries(CALLS)) {
      const [method = 'GET', path = ''] = route.split(' ');
      const res = await bob.request(method, path.replace(':projectId', missing), call.body);
      expect(res.status, route).toBe(404);
      expect(res.body, route).toEqual({ error: 'project not found' });
    }
  });

  it('answers A, the owner, on every one of the same routes', async () => {
    for (const [route, call] of Object.entries(CALLS)) {
      const [method = 'GET', path = ''] = route.split(' ');
      const res = await alice.request(method, path.replace(':projectId', projectId), call.body);
      expect(res.status, `${route} as A`).toBe(call.ownerStatus);
    }
  });

  it("does not list A's projects to B", async () => {
    const listed = (await bob.get('/api/projects')).body as { projects: unknown[] };
    expect(listed.projects).toEqual([]);
  });

  it('asks an anonymous caller to sign in rather than saying whether the project exists', async () => {
    const res = await new Browser(running.url).get(`/api/projects/${projectId}`);
    expect(res.status).toBe(401);
  });
});
