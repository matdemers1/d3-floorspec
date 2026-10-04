import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Browser,
  FakeD3Auth,
  ISSUER,
  OPERATOR,
  reset,
  setupOperator,
  start,
  testDb,
  type Running,
} from './helpers.js';

/**
 * FLR-T-0.5, the D3 Auth half: a sign-in links to an existing account and never creates one.
 * PKCE itself is the SDK's, asserted against a real discovery document in test/unit/oidc-pkce.
 */
describe('Sign in with D3 Auth', () => {
  const db = testDb();
  const d3auth = new FakeD3Auth();
  let running: Running;

  beforeAll(async () => {
    running = await start({ with: { oidc: d3auth } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  const location = (res: { headers: Headers }) => res.headers.get('location') ?? '';

  it('offers the button only when a client exists', async () => {
    const plain = await start();
    try {
      expect((await new Browser(plain.url).get('/auth/session')).body).toMatchObject({ oidcAvailable: false });
      expect((await new Browser(plain.url).get('/auth/oidc/start')).status).toBe(503);
    } finally {
      await plain.close();
    }
    expect((await new Browser(running.url).get('/auth/session')).body).toMatchObject({ oidcAvailable: true });
  });

  it('refuses an unknown identity and creates no account', async () => {
    await setupOperator(running);
    const browser = new Browser(running.url);
    const res = await d3auth.signIn(browser, { iss: ISSUER, sub: 'stranger', email: 'stranger@example.test', emailVerified: true });
    expect(res.status).toBe(302);
    expect(location(res)).toMatch(/^\/signin\?d3auth_error=/);
    expect(new URLSearchParams(location(res).split('?')[1]).get('d3auth_error')).toMatch(/invitation only/);
    expect((await browser.get('/auth/session')).status).toBe(401);
    expect(await db.account.count()).toBe(1);
    expect(await db.identity.count()).toBe(0);
  });

  it('never links by email, even one the issuer has verified', async () => {
    await setupOperator(running);
    const res = await d3auth.signIn(new Browser(running.url), { iss: ISSUER, sub: 'op-sub', email: OPERATOR.email, emailVerified: true });
    expect(location(res)).toMatch(/^\/signin\?d3auth_error=/);
    expect(await db.identity.count()).toBe(0);
    expect(await db.account.count()).toBe(1);
  });

  it('signs in by the stored link once linked, whatever email the issuer now reports', async () => {
    const operator = await setupOperator(running);
    await d3auth.signIn(operator, { iss: ISSUER, sub: 'op-sub', emailVerified: false }, true);
    const again = await d3auth.signIn(new Browser(running.url), { iss: ISSUER, sub: 'op-sub', email: 'renamed@example.test', emailVerified: true });
    expect(location(again)).toBe('/');
    expect(await db.account.count()).toBe(1);
  });

  it('does not take over an account already linked to another D3 Auth identity', async () => {
    const operator = await setupOperator(running);
    await d3auth.signIn(operator, { iss: ISSUER, sub: 'op-sub', emailVerified: false }, true);
    const res = await d3auth.signIn(new Browser(running.url), { iss: ISSUER, sub: 'someone-else', email: OPERATOR.email, emailVerified: true });
    expect(location(res)).toMatch(/^\/signin\?d3auth_error=/);
    expect(await db.identity.count()).toBe(1);
  });

  it('links from Account settings to the signed-in account, keeping its session', async () => {
    const operator = await setupOperator(running);
    // A different address at the issuer: linking from settings does not depend on email at all.
    const res = await d3auth.signIn(operator, { iss: ISSUER, sub: 'op-sub', email: 'elsewhere@example.test', emailVerified: false }, true);
    expect(location(res)).toBe('/account?d3auth=linked');
    expect((await operator.get('/auth/session')).body).toMatchObject({ d3auth: { iss: ISSUER } });

    const signedIn = await d3auth.signIn(new Browser(running.url), { iss: ISSUER, sub: 'op-sub', emailVerified: false });
    expect(location(signedIn)).toBe('/');

    // And unlinks, which is allowed because a password remains.
    expect((await operator.request('DELETE', '/api/account/d3auth')).status).toBe(204);
    expect(await db.identity.count()).toBe(0);
  });

  it('refuses a callback this browser did not start', async () => {
    await setupOperator(running);
    const res = await new Browser(running.url).get('/auth/oidc/callback?state=forged&code=x');
    expect(location(res)).toMatch(/^\/signin\?d3auth_error=/);
    const refused = await db.auditLog.findFirst({ where: { action: 'auth.oidc.refused' } });
    expect(refused?.detail).toMatchObject({ reason: 'no_transaction' });
  });
});
