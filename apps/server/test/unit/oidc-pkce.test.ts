import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOidcClient, OIDC_SCOPE } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config.js';

/**
 * The real SDK-backed client against a real discovery document: the authorization request it
 * builds carries PKCE (S256), state, nonce, the registered redirect URI and the scopes.
 */
describe('Sign in with D3 Auth — the authorization request', () => {
  let server: Server;
  let issuer = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            end_session_endpoint: `${issuer}/session/end`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['ES256'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { resolve(); }));
    issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(() => {
    server.close();
  });

  const config = () =>
    loadConfig({
      PUBLIC_URL: 'https://floorspec.d3cloud.io',
      DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      D3AUTH_ISSUER: issuer,
      D3AUTH_CLIENT_ID: 'floorspec',
      D3AUTH_CLIENT_SECRET: 'test-secret',
    });

  it('asks for a code with an S256 challenge, state and nonce, at the registered redirect URI', async () => {
    const client = await createOidcClient(config());
    expect(client).not.toBeNull();
    const { url, tx } = await (client ?? { beginSignIn: () => Promise.reject(new Error('no client')) }).beginSignIn();
    const params = new URL(url).searchParams;
    expect(url.startsWith(`${issuer}/auth?`)).toBe(true);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('floorspec');
    expect(params.get('redirect_uri')).toBe('https://floorspec.d3cloud.io/auth/oidc/callback');
    expect(params.get('scope')).toBe(OIDC_SCOPE);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(tx).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is null — one button, not a broken one — when the issuer is unreachable', async () => {
    const unreachable = { ...config(), D3AUTH_ISSUER: 'http://127.0.0.1:1' };
    expect(await createOidcClient(unreachable)).toBeNull();
  });
});
