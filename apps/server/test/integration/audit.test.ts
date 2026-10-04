import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import {
  Browser,
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
    await setupOperator(running);
    return {
      reply: await d3auth.signIn(new Browser(running.url), {
        iss: ISSUER,
        sub: 'operator-sub',
        email: OPERATOR.email,
        emailVerified: true,
      }),
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
      expect(row?.actor).toMatch(/^(account:[0-9a-f-]{36}|anonymous)$/);
      expect(row?.at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect((row?.detail as { route?: string } | null)?.route).toBe(route);
    });
  }
});
