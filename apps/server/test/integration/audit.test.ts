import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import {
  Browser,
  createProjectAs,
  tokenFor,
  FakeD3Auth,
  ISSUER,
  OPERATOR,
  reset,
  setupOperator,
  start,
  testDb,
  tokenOf,
  totpCode,
  type Reply,
  type Running,
} from './helpers.js';
import { projectWithDocument } from './drawings-support.js';

/**
 * The audit walk (FLR-T-0.4): every mutating route, called successfully, writes an audit row with
 * an actor, a time and the operation.
 *
 * The routes come from the app's own registry, not from this file. A mutating route this table
 * does not know how to call fails the first test — so a new route is covered the day it lands, or
 * the suite says it is not.
 */

interface Ctx {
  readonly running: Running;
  readonly d3auth: FakeD3Auth;
}

interface Exercised {
  readonly reply: Reply;
  /** The audit action the call must have written. */
  readonly action: string;
}

type Exercise = (ctx: Ctx) => Promise<Exercised>;

/** Enrol and confirm TOTP for a browser; returns the secret. */
async function withTotp(browser: Browser): Promise<string> {
  const { secret } = (await browser.post('/auth/totp/enrol')).body as { secret: string };
  await browser.post('/auth/totp/confirm', { code: await totpCode(secret) });
  return secret;
}

const ROOM = [{ op: 'addElement', collection: 'buildings', id: 'B1', element: {} }];

/** A brief the layout solver can lay out: a living room, a kitchen and a bedroom. */
const BRIEF = [
  { op: 'addProgramItem', function: 'living', targetArea: '240 sq ft' },
  { op: 'addProgramItem', function: 'kitchen', targetArea: '120 sq ft' },
  { op: 'addProgramItem', function: 'sleeping', targetArea: '120 sq ft' },
];

const EXERCISES: Record<string, Exercise> = {
  'POST /auth/setup': async ({ running }) => ({
    reply: await new Browser(running.url).post('/auth/setup', OPERATOR),
    action: 'account.setup',
  }),
  'POST /auth/login': async ({ running }) => {
    await setupOperator(running);
    return { reply: await new Browser(running.url).post('/auth/login', OPERATOR), action: 'auth.login' };
  },
  'POST /auth/logout': async ({ running }) => {
    const operator = await setupOperator(running);
    return { reply: await operator.post('/auth/logout'), action: 'auth.logout' };
  },
  'POST /auth/totp/enrol': async ({ running }) => {
    const operator = await setupOperator(running);
    return { reply: await operator.post('/auth/totp/enrol'), action: 'auth.totp.enrol' };
  },
  'POST /auth/totp/confirm': async ({ running }) => {
    const operator = await setupOperator(running);
    const { secret } = (await operator.post('/auth/totp/enrol')).body as { secret: string };
    return {
      reply: await operator.post('/auth/totp/confirm', { code: await totpCode(secret) }),
      action: 'auth.totp.enable',
    };
  },
  'POST /auth/totp/disable': async ({ running }) => {
    const operator = await setupOperator(running);
    const secret = await withTotp(operator);
    return {
      reply: await operator.post('/auth/totp/disable', { code: await totpCode(secret, 1) }),
      action: 'auth.totp.disable',
    };
  },
  'POST /auth/invites/:token/accept': async ({ running }) => {
    const operator = await setupOperator(running);
    const { url } = (await operator.post('/api/invites', {})).body as { url: string };
    return {
      reply: await new Browser(running.url).post(`/auth/invites/${tokenOf(url)}/accept`, {
        email: 'member@example.test',
        displayName: 'Member',
        password: 'member-password-1',
      }),
      action: 'invite.accept',
    };
  },
  'GET /auth/oidc/callback': async ({ running, d3auth }) => {
    // Linking from Account settings: the only way a D3 Auth identity becomes attached to an account.
    const operator = await setupOperator(running);
    return {
      reply: await d3auth.signIn(operator, { iss: ISSUER, sub: 'operator-sub', emailVerified: false }, true),
      action: 'identity.link',
    };
  },
  'POST /api/invites': async ({ running }) => {
    const operator = await setupOperator(running);
    return { reply: await operator.post('/api/invites', { email: 'x@example.test' }), action: 'invite.create' };
  },
  'DELETE /api/invites/:inviteId': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = (await operator.post('/api/invites', {})).body as { id: string };
    return { reply: await operator.request('DELETE', `/api/invites/${id}`), action: 'invite.revoke' };
  },
  'POST /api/projects': async ({ running }) => {
    const operator = await setupOperator(running);
    return { reply: await operator.post('/api/projects', { name: 'Lake house' }), action: 'project.create' };
  },
  'DELETE /api/projects/:projectId': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = (await operator.post('/api/projects', { name: 'Lake house' })).body as { id: string };
    return { reply: await operator.request('DELETE', `/api/projects/${id}`), action: 'project.delete' };
  },
  'POST /api/projects/:projectId/ops': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    return { reply: await operator.post(`/api/projects/${id}/ops`, { batch: ROOM }), action: 'ops.apply' };
  },
  'POST /api/projects/:projectId/undo': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    await operator.post(`/api/projects/${id}/ops`, { batch: ROOM });
    return { reply: await operator.post(`/api/projects/${id}/undo`), action: 'ops.undo' };
  },
  'POST /api/projects/:projectId/redo': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    await operator.post(`/api/projects/${id}/ops`, { batch: ROOM });
    await operator.post(`/api/projects/${id}/undo`);
    return { reply: await operator.post(`/api/projects/${id}/redo`), action: 'ops.redo' };
  },
  'POST /api/projects/:projectId/changesets': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    const agent = Browser.bearer(running.url, await tokenFor(operator, id, 'agent'));
    return { reply: await agent.post(`/api/projects/${id}/changesets`, { name: 'Idea', batch: ROOM }), action: 'changeset.propose' };
  },
  'POST /api/projects/:projectId/layouts': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    await operator.post(`/api/projects/${id}/ops`, { batch: BRIEF });
    return { reply: await operator.post(`/api/projects/${id}/layouts`, {}), action: 'layouts.propose' };
  },
  'POST /api/projects/:projectId/assistants/electrical': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    // A plan with no rooms: nothing to propose, and the request is still audited.
    return { reply: await operator.post(`/api/projects/${id}/assistants/electrical`, {}), action: 'assistants.electrical.propose' };
  },
  'POST /api/projects/:projectId/changesets/:changesetId/accept': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    const proposed = (await operator.post(`/api/projects/${id}/changesets`, { name: 'Idea', batch: ROOM })).body as { changeset: { id: string } };
    return { reply: await operator.post(`/api/projects/${id}/changesets/${proposed.changeset.id}/accept`), action: 'changeset.accept' };
  },
  'POST /api/projects/:projectId/changesets/:changesetId/reject': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    const proposed = (await operator.post(`/api/projects/${id}/changesets`, { name: 'Idea', batch: ROOM })).body as { changeset: { id: string } };
    return { reply: await operator.post(`/api/projects/${id}/changesets/${proposed.changeset.id}/reject`), action: 'changeset.reject' };
  },
  'POST /api/projects/:projectId/exports': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(running.db, operator);
    return { reply: await operator.post(`/api/projects/${id}/exports`, { kind: 'pdf' }), action: 'export.request' };
  },
  'POST /api/tokens': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    return { reply: await operator.post('/api/tokens', { projectId: id, name: 'Claude', kind: 'agent' }), action: 'token.create' };
  },
  'DELETE /api/tokens/:tokenId': async ({ running }) => {
    const operator = await setupOperator(running);
    const { id } = await createProjectAs(operator);
    const created = (await operator.post('/api/tokens', { projectId: id, name: 'Claude', kind: 'agent' })).body as { id: string };
    return { reply: await operator.request('DELETE', `/api/tokens/${created.id}`), action: 'token.revoke' };
  },
  'DELETE /api/account/d3auth': async ({ running, d3auth }) => {
    const operator = await setupOperator(running);
    await d3auth.signIn(operator, { iss: ISSUER, sub: 'operator-sub', emailVerified: false }, true);
    return { reply: await operator.request('DELETE', '/api/account/d3auth'), action: 'identity.unlink' };
  },
};


describe('the audit walk', () => {
  const db = testDb();
  const d3auth = new FakeD3Auth();
  let running: Running;

  beforeAll(async () => {
    running = await start({ with: { oidc: d3auth } });
  });
  afterAll(async () => {
    await running.close();
  });

  it('knows how to call every mutating route the app declares, and no others', () => {
    const declared = registry(running.app)
      .filter((route) => route.mutating)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(Object.keys(EXERCISES).sort()).toEqual(declared);
  });

  for (const [route, exercise] of Object.entries(EXERCISES)) {
    it(`${route} writes an audit row with actor, time and operation`, async () => {
      await reset(db);
      const startedAt = new Date(Date.now() - 1000);
      const { reply, action } = await exercise({ running, d3auth });
      expect(reply.status, reply.text).toBeLessThan(400);

      const rows = await db.auditLog.findMany({ where: { action } });
      expect(rows.length, `no "${action}" row for ${route}`).toBeGreaterThan(0);
      const row = rows.at(-1);
      expect(row?.actor).toMatch(/^((account|token|agent):[0-9a-f-]{36}|anonymous)$/);
      expect(row?.at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect((row?.detail as { route?: string } | null)?.route).toBe(route);
    });
  }
});
