import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = {
  PUBLIC_URL: 'https://floorspec.d3cloud.io',
  DATABASE_URL: 'postgresql://u:p@db:5432/floorspec',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('configuration', () => {
  it('accepts a complete environment and runs password-only without D3 Auth', () => {
    const config = loadConfig(base);
    expect(config.oidcConfigured).toBe(false);
    expect(config.PORT).toBe(3400);
  });

  it('names a missing secret', () => {
    const rest: Record<string, string> = { ...base };
    delete rest['KEK'];
    expect(problems(rest)).toContain('KEK is not set');
  });

  it('refuses a placeholder or a short key', () => {
    expect(problems({ ...base, PEPPER: 'change-me' }).join()).toMatch(/PEPPER/);
    expect(problems({ ...base, KEK: Buffer.alloc(8).toString('base64') }).join()).toMatch(/32 bytes/);
  });

  it('refuses a half-configured D3 Auth and accepts a whole one', () => {
    expect(problems({ ...base, D3AUTH_CLIENT_ID: 'floorspec' }).join()).toMatch(/together/);
    const config = loadConfig({
      ...base,
      D3AUTH_ISSUER: 'https://auth.d3cloud.io',
      D3AUTH_CLIENT_ID: 'floorspec',
      D3AUTH_CLIENT_SECRET: 's3cret',
    });
    expect(config.oidcConfigured).toBe(true);
  });

  it('treats empty D3 Auth values as unset, as a compose env file writes them', () => {
    const config = loadConfig({ ...base, D3AUTH_ISSUER: '', D3AUTH_CLIENT_ID: '', D3AUTH_CLIENT_SECRET: '' });
    expect(config.oidcConfigured).toBe(false);
  });
});
