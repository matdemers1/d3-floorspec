import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { canonicalMcpUri, protectedResourceMetadata, TokenRejected, verifierFor, wwwAuthenticate } from '../../src/auth/resource-server.js';

const ISSUER = 'https://auth.example.test/oidc';
const config = loadConfig({
  PUBLIC_URL: 'https://floorspec.example.test',
  DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  D3AUTH_ISSUER: ISSUER,
  D3AUTH_CLIENT_ID: 'floorspec',
  D3AUTH_CLIENT_SECRET: 'secret-value',
});

/**
 * FLR-T-2.6: the MCP endpoint accepts a D3 Auth access token only when it was minted for this
 * server's `/mcp` resource, by the configured issuer, and is in date.
 */
describe('the resource server', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
  const verifier = verifierFor(ISSUER, canonicalMcpUri(config), createLocalJWKSet({ keys: [jwk] }));

  const mint = (claims: { aud?: string; iss?: string; sub?: string; exp?: string; azp?: string }) => {
    let jwt = new SignJWT({ azp: claims.azp ?? 'claude-connector', scope: 'openid profile email' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? 'https://floorspec.example.test/mcp')
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? '5m');
    if (claims.sub !== '') jwt = jwt.setSubject(claims.sub ?? 'user-1');
    return jwt.sign(privateKey);
  };

  it('accepts a token for its own /mcp resource', async () => {
    expect(await verifier.verify(await mint({}))).toEqual({ iss: ISSUER, sub: 'user-1', client: 'claude-connector' });
  });

  it('refuses a token minted for another resource — Foreman, Bindery, anything else D3 Auth serves', async () => {
    await expect(verifier.verify(await mint({ aud: 'https://foreman.d3cloud.io/mcp' }))).rejects.toBeInstanceOf(TokenRejected);
    await expect(verifier.verify(await mint({ aud: 'https://floorspec.example.test/' }))).rejects.toBeInstanceOf(TokenRejected);
  });

  it('refuses another issuer, an expired token, a token without a subject, and garbage', async () => {
    await expect(verifier.verify(await mint({ iss: 'https://evil.example.test' }))).rejects.toBeInstanceOf(TokenRejected);
    await expect(verifier.verify(await mint({ exp: '-1m' }))).rejects.toBeInstanceOf(TokenRejected);
    await expect(verifier.verify(await mint({ sub: '' }))).rejects.toBeInstanceOf(TokenRejected);
    await expect(verifier.verify('a.b.c')).rejects.toBeInstanceOf(TokenRejected);
  });

  it('refuses a token signed by a key D3 Auth does not publish', async () => {
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setAudience(canonicalMcpUri(config)).setSubject('user-1').setExpirationTime('5m').sign(other.privateKey);
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(TokenRejected);
  });

  it('publishes metadata naming the resource and D3 Auth, and challenges with it', () => {
    expect(protectedResourceMetadata(config)).toMatchObject({ resource: 'https://floorspec.example.test/mcp', authorization_servers: [ISSUER] });
    expect(wwwAuthenticate(config)).toBe('Bearer resource_metadata="https://floorspec.example.test/.well-known/oauth-protected-resource/mcp", scope="openid profile email"');
  });
});
