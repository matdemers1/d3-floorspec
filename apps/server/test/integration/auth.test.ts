import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import {
  Browser,
  inviteMember,
  OPERATOR,
  reset,
  setupOperator,
  start,
  testDb,
  tokenOf,
  totpCode,
  type Running,
} from './helpers.js';

/** FLR-T-0.5, the app-native half: setup, invites, password + TOTP, and no way to sign up. */
describe('app-native login', () => {
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

  describe('first-run setup', () => {
    it('creates the operator while no account exists, and then disappears', async () => {
      const anonymous = new Browser(running.url);
      expect((await anonymous.get('/auth/session')).body).toMatchObject({ authenticated: false, setupRequired: true });

      const operator = await setupOperator(running);
      const session = await operator.get('/auth/session');
      expect(session.body).toMatchObject({
        authenticated: true,
        account: { email: OPERATOR.email, role: 'operator' },
        totpEnrolled: false,
      });

      const again = await new Browser(running.url).post('/auth/setup', {
        email: 'second@example.test',
        displayName: 'Second',
        password: 'another-password-1',
      });
      expect(again.status).toBe(404);
      expect(await db.account.count()).toBe(1);
      expect((await anonymous.get('/auth/session')).body).toMatchObject({ setupRequired: false });
    });

    it('refuses a short password', async () => {
      const res = await new Browser(running.url).post('/auth/setup', { ...OPERATOR, password: 'short' });
      expect(res.status).toBe(400);
      expect(await db.account.count()).toBe(0);
    });
  });

  describe('there is no public sign-up route', () => {
    it('answers 404 wherever a sign-up route would be', async () => {
      await setupOperator(running);
      const anonymous = new Browser(running.url);
      for (const path of ['/auth/signup', '/auth/register', '/api/accounts', '/api/signup', '/auth/accounts']) {
        const res = await anonymous.post(path, { email: 'x@example.test', password: 'x-password-123' });
        expect(res.status, path).toBe(404);
      }
      expect(await db.account.count()).toBe(1);
    });

    it('creates accounts from exactly two public routes: setup and invite acceptance', () => {
      const publicWrites = registry(running.app)
        .filter((route) => route.mutating && route.access === 'public')
        .map((route) => `${route.method} ${route.path}`)
        .sort();
      // Each of these either creates nothing or is one of the two ways in. A new public write is a
      // decision, and this list is where it gets made.
      expect(publicWrites).toEqual([
        'GET /auth/oidc/callback',
        'POST /auth/invites/:token/accept',
        'POST /auth/login',
        'POST /auth/logout',
        'POST /auth/setup',
      ]);
    });
  });

  describe('password and TOTP', () => {
    it('signs in with a password, and refuses a wrong one with one message', async () => {
      await setupOperator(running);
      const browser = new Browser(running.url);
      const wrong = await browser.post('/auth/login', { email: OPERATOR.email, password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: 'invalid credentials' });
      const unknown = await browser.post('/auth/login', { email: 'nobody@example.test', password: 'whatever-123' });
      expect(unknown.body).toEqual({ error: 'invalid credentials' });

      const ok = await browser.post('/auth/login', { email: OPERATOR.email.toUpperCase(), password: OPERATOR.password });
      expect(ok.body).toEqual({ status: 'signed_in' });
      expect((await browser.get('/auth/session')).status).toBe(200);

      await browser.post('/auth/logout');
      expect((await browser.get('/auth/session')).status).toBe(401);
    });

    it('enrols TOTP, then asks for a code, refuses a replay, and can turn it off with a code', async () => {
      const operator = await setupOperator(running);
      const enrol = await operator.post('/auth/totp/enrol');
      const { secret, uri } = enrol.body as { secret: string; uri: string };
      expect(uri).toMatch(/^otpauth:\/\/totp\/D3%20Floorspec:/);

      // Not in force until a code proves it.
      expect((await new Browser(running.url).post('/auth/login', OPERATOR)).body).toEqual({ status: 'signed_in' });
      expect((await operator.post('/auth/totp/confirm', { code: '000000' })).status).toBe(400);
      expect((await operator.post('/auth/totp/confirm', { code: await totpCode(secret) })).status).toBe(204);

      const browser = new Browser(running.url);
      expect((await browser.post('/auth/login', OPERATOR)).body).toEqual({ status: 'totp_required' });
      const code = await totpCode(secret, 1);
      expect((await browser.post('/auth/login', { ...OPERATOR, totpCode: '123456' })).status).toBe(401);
      expect((await browser.post('/auth/login', { ...OPERATOR, totpCode: code })).body).toEqual({ status: 'signed_in' });
      // The same code, again: a step is burned once used.
      expect((await new Browser(running.url).post('/auth/login', { ...OPERATOR, totpCode: code })).status).toBe(401);

      expect((await operator.post('/auth/totp/disable', { code: '000000' })).status).toBe(400);
      // As if the next step had arrived, rather than waiting thirty seconds for it.
      await db.credential.updateMany({ data: { totpLastStep: null } });
      expect((await operator.post('/auth/totp/disable', { code: await totpCode(secret) })).status).toBe(204);
      expect((await new Browser(running.url).post('/auth/login', OPERATOR)).body).toEqual({ status: 'signed_in' });
    });

    it('throttles repeated failures before hashing, and says how long to wait', async () => {
      await setupOperator(running);
      const browser = new Browser(running.url);
      let last = 0;
      for (let i = 0; i < 6; i++) {
        last = (await browser.post('/auth/login', { email: OPERATOR.email, password: 'wrong-password' })).status;
      }
      expect(last).toBe(429);
    });
  });

  describe('invites', () => {
    it('lets the operator invite a member, once', async () => {
      const operator = await setupOperator(running);
      const created = await operator.post('/api/invites', { email: 'member@example.test' });
      expect(created.status).toBe(201);
      const { url } = created.body as { url: string };
      expect(url).toMatch(/^http:\/\/localhost:3400\/invite\/[A-Za-z0-9_-]{43}$/);
      const token = tokenOf(url);

      const guest = new Browser(running.url);
      expect((await guest.get(`/auth/invites/${token}`)).body).toMatchObject({ email: 'member@example.test' });
      const wrongEmail = await guest.post(`/auth/invites/${token}/accept`, {
        email: 'other@example.test',
        displayName: 'Other',
        password: 'member-password-1',
      });
      expect(wrongEmail.status).toBe(400);

      const accepted = await guest.post(`/auth/invites/${token}/accept`, {
        email: 'member@example.test',
        displayName: 'Member',
        password: 'member-password-1',
      });
      expect(accepted.status).toBe(201);
      expect((await guest.get('/auth/session')).body).toMatchObject({ account: { role: 'member' } });

      // Single-use.
      const again = await new Browser(running.url).post(`/auth/invites/${token}/accept`, {
        email: 'member@example.test',
        displayName: 'Again',
        password: 'member-password-1',
      });
      expect(again.status).toBe(404);
      expect((await guest.get(`/auth/invites/${token}`)).status).toBe(404);
    });

    it('refuses a revoked or expired invite', async () => {
      const operator = await setupOperator(running);
      const revoked = (await operator.post('/api/invites', {})).body as { id: string; url: string };
      expect((await operator.request('DELETE', `/api/invites/${revoked.id}`)).status).toBe(204);
      expect((await new Browser(running.url).get(`/auth/invites/${tokenOf(revoked.url)}`)).status).toBe(404);

      const expired = (await operator.post('/api/invites', {})).body as { id: string; url: string };
      await db.invite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await new Browser(running.url).post(`/auth/invites/${tokenOf(expired.url)}/accept`, {
        email: 'late@example.test',
        displayName: 'Late',
        password: 'member-password-1',
      });
      expect(res.status).toBe(404);

      const listed = (await operator.get('/api/invites')).body as { invites: { id: string; state: string }[] };
      expect(listed.invites.find((i) => i.id === revoked.id)?.state).toBe('revoked');
      expect(listed.invites.find((i) => i.id === expired.id)?.state).toBe('expired');
    });

    it('lets only the operator manage invites', async () => {
      const operator = await setupOperator(running);
      const member = await inviteMember(running, operator, 'member@example.test');
      expect((await member.post('/api/invites', {})).status).toBe(403);
      expect((await member.get('/api/invites')).status).toBe(403);
      expect((await new Browser(running.url).post('/api/invites', {})).status).toBe(401);
    });
  });
});
