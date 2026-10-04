import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app.js';
import { OidcError, type CompletedSignIn, type OidcClient } from '../../src/auth/oidc.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/** A fixed, valid environment. The secrets are test-only values, 32 bytes each. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3400',
  DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  KEK: Buffer.alloc(32, 7).toString('base64'),
  PEPPER: Buffer.alloc(32, 9).toString('base64'),
} as const;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

let shared: Db | null = null;
export function testDb(): Db {
  shared ??= createDb(TEST_ENV.DATABASE_URL);
  return shared;
}

/** Empty every table. TRUNCATE fires no row triggers, so the append-only tables empty too. */
export async function reset(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  await db.$executeRawUnsafe(
    `truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`,
  );
}

export interface Running {
  readonly app: Express;
  readonly url: string;
  readonly config: Config;
  readonly db: Db;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly env?: Record<string, string>;
  /** Anything else the app takes — an OIDC client double, for instance. */
  readonly with?: Partial<AppDeps>;
}

export async function start(options: StartOptions = {}): Promise<Running> {
  const config = testConfig(options.env);
  const db = testDb();
  const app = createApp({ config, db, ...options.with });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => { resolve(); }));
  const { port } = server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${String(port)}`,
    config,
    db,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      }),
  };
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly headers: Headers;
}

/** A browser, as far as these tests need one: it keeps cookies and never follows a redirect. */
export class Browser {
  private readonly jar = new Map<string, string>();

  constructor(private readonly base: string) {}

  get cookies(): ReadonlyMap<string, string> {
    return this.jar;
  }

  async request(method: string, path: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.jar.size > 0) {
      headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      if (index <= 0 || pair === undefined) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  get(path: string): Promise<Reply> {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown): Promise<Reply> {
    return this.request('POST', path, body ?? {});
  }
}

// ─── Accounts ──────────────────────────────────────────────────────────────

export const OPERATOR = { email: 'operator@example.test', displayName: 'Operator', password: 'operator-password-1' };

/** First-run setup through the real route: a browser signed in as the operator. */
export async function setupOperator(running: Running): Promise<Browser> {
  const browser = new Browser(running.url);
  const res = await browser.post('/auth/setup', OPERATOR);
  if (res.status !== 201) throw new Error(`setup failed: ${String(res.status)} ${res.text}`);
  return browser;
}

/** An invited member, signed in, created through the real invite routes. */
export async function inviteMember(
  running: Running,
  operator: Browser,
  email: string,
  password = 'member-password-1',
): Promise<Browser> {
  const invite = await operator.post('/api/invites', { email });
  if (invite.status !== 201) throw new Error(`invite failed: ${String(invite.status)} ${invite.text}`);
  const token = tokenOf((invite.body as { url: string }).url);
  const member = new Browser(running.url);
  const res = await member.post(`/auth/invites/${token}/accept`, { email, displayName: email, password });
  if (res.status !== 201) throw new Error(`accept failed: ${String(res.status)} ${res.text}`);
  return member;
}

export function tokenOf(url: string): string {
  return new URL(url).pathname.split('/').at(-1) ?? '';
}

/** A TOTP code for a base32 secret, at an offset in 30-second steps from now. */
export async function totpCode(secret: string, stepsFromNow = 0): Promise<string> {
  const { TOTP, Secret } = await import('otpauth');
  const totp = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
  return totp.generate({ timestamp: Date.now() + stepsFromNow * 30_000 });
}

// ─── A D3 Auth double ──────────────────────────────────────────────────────


export const ISSUER = 'https://auth.example.test';

/**
 * Stands in for the SDK-backed client: it keeps the same per-browser transaction rule (the
 * callback must carry the cookie `start` set), and returns whichever identity the test queues.
 */
export class FakeD3Auth implements OidcClient {
  readonly issuer = ISSUER;
  next: Omit<CompletedSignIn, 'linkToAccountId'> | null = null;
  private readonly pending = new Map<string, { link?: string }>();
  private counter = 0;

  beginSignIn(linkToAccountId?: string): Promise<{ url: string; tx: string }> {
    const tx = `tx-${String(++this.counter)}-${String(Date.now())}`;
    this.pending.set(tx, linkToAccountId === undefined ? {} : { link: linkToAccountId });
    return Promise.resolve({ url: `${ISSUER}/authorize?state=${tx}`, tx });
  }

  completeSignIn(_url: URL, tx: string, state: string): Promise<CompletedSignIn> {
    const started = this.pending.get(tx);
    this.pending.delete(tx);
    if (started === undefined || state !== tx) return Promise.reject(new OidcError('No sign-in is in progress for this browser.'));
    if (this.next === null) return Promise.reject(new OidcError('D3 Auth could not complete the sign-in. Try again.'));
    return Promise.resolve({ ...this.next, ...(started.link === undefined ? {} : { linkToAccountId: started.link }) });
  }

  /** As a browser would: start, then come back to the callback with the state. */
  async signIn(browser: Browser, identity: Omit<CompletedSignIn, 'linkToAccountId'>, link = false): Promise<Reply> {
    this.next = identity;
    const start = await browser.get(`/auth/oidc/start${link ? '?link=1' : ''}`);
    if (start.status !== 302) throw new Error(`start answered ${String(start.status)}`);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return browser.get(`/auth/oidc/callback?state=${encodeURIComponent(state)}&code=abc`);
  }
}
