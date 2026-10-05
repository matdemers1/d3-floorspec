import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp, eventHubOf, type AppDeps } from '../../src/app.js';
import { OidcError, type CompletedSignIn, type OidcClient } from '../../src/auth/oidc.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { opsApplier } from '../../src/ops/applier.js';

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
  // The real applier, @floorspec/ops; no D3 Auth verifier unless a test brings one.
  const app = createApp({ config, db, applier: opsApplier, verifier: null, ...options.with });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => { resolve(); }));
  const { port } = server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${String(port)}`,
    config,
    db,
    // Open event streams would keep the server from closing: the hub ends them first.
    close: async () => {
      await eventHubOf(app).close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    },
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

  constructor(
    private readonly base: string,
    /** Sent with every request: a bearer token, for a program rather than a browser. */
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  /** A client that presents a bearer token and keeps no cookies. */
  static bearer(base: string, token: string): Browser {
    return new Browser(base, { authorization: `Bearer ${token}` });
  }

  get cookies(): ReadonlyMap<string, string> {
    return this.jar;
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...this.extraHeaders, ...extra };
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

  /**
   * Open a server-sent-events stream with this browser's cookies and headers. A non-200 answer is
   * read whole and returned as a Reply; a stream is returned open.
   */
  async events(path: string, extra: Record<string, string> = {}): Promise<EventStream | Reply> {
    const headers: Record<string, string> = { accept: 'text/event-stream', ...this.extraHeaders, ...extra };
    if (this.jar.size > 0) headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const abort = new AbortController();
    const res = await fetch(`${this.base}${path}`, { headers, redirect: 'manual', signal: abort.signal });
    if (res.status !== 200 || res.body === null) {
      const text = await res.text();
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      return { status: res.status, body, text, headers: res.headers };
    }
    return new EventStream(res, abort);
  }

  get(path: string): Promise<Reply> {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> {
    return this.request('POST', path, body ?? {}, headers);
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

// ─── Projects, edits and tokens ────────────────────────────────────────────

/** Create a project through the real route; returns its ID and first head. */
export async function createProjectAs(browser: Browser, name = 'Lake house'): Promise<{ id: string; head: string }> {
  const res = await browser.post('/api/projects', { name });
  if (res.status !== 201) throw new Error(`create project failed: ${String(res.status)} ${res.text}`);
  return res.body as { id: string; head: string };
}

/** Mint an API token through the account screen's route; returns the secret. */
export async function tokenFor(browser: Browser, projectId: string, kind: 'read' | 'write' | 'agent', name = `${kind} token`): Promise<string> {
  const res = await browser.post('/api/tokens', { projectId, name, kind });
  if (res.status !== 201) throw new Error(`token failed: ${String(res.status)} ${res.text}`);
  return (res.body as { token: string }).token;
}

// ─── Server-sent events ────────────────────────────────────────────────────

export interface SseEvent {
  readonly id: string | null;
  readonly event: string;
  readonly data: unknown;
}

/** A minimal EventSource for tests: parses frames as they arrive and keeps comments and events. */
export class EventStream {
  readonly status: number;
  readonly headers: Headers;
  readonly events: SseEvent[] = [];
  readonly comments: string[] = [];
  retry: number | null = null;
  ended = false;
  private cursor = 0;
  private buffer = '';
  private waiters: (() => void)[] = [];

  constructor(
    res: Response,
    private readonly abort: AbortController,
  ) {
    this.status = res.status;
    this.headers = res.headers;
    void this.pump(res);
  }

  private async pump(res: Response): Promise<void> {
    const body = res.body;
    if (body === null) return;
    const decoder = new TextDecoder();
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = this.buffer.indexOf('\n\n')) >= 0) {
          this.parse(this.buffer.slice(0, index));
          this.buffer = this.buffer.slice(index + 2);
        }
        this.wake();
      }
    } catch {
      // Aborted by close(), or the server went away: either way the stream has ended.
    }
    this.ended = true;
    this.wake();
  }

  private parse(block: string): void {
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry') this.retry = Number(value);
    }
    if (data.length === 0) return;
    this.events.push({ id, event, data: JSON.parse(data.join('\n')) as unknown });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Wait for a condition on the stream, or fail after `timeoutMs`. */
  async until(check: () => boolean, timeoutMs = 5_000, what = 'the stream'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (this.ended) throw new Error(`${what}: the stream ended first`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${what}: timed out; events so far: ${JSON.stringify(this.events)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The next event not yet taken, optionally of one type (others before it are skipped). */
  async next(type?: string, timeoutMs = 5_000): Promise<SseEvent> {
    const find = () => this.events.findIndex((e, i) => i >= this.cursor && (type === undefined || e.event === type));
    await this.until(() => find() >= 0, timeoutMs, `waiting for ${type ?? 'an event'}`);
    const index = find();
    this.cursor = index + 1;
    return this.events[index] as SseEvent;
  }

  /** Events not yet taken. */
  pending(): SseEvent[] {
    return this.events.slice(this.cursor);
  }

  /** Wait until the server ends the stream. */
  async closed(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const ended = () => this.ended;
    while (!ended()) {
      if (Date.now() > deadline) throw new Error('waiting for the stream to end: timed out');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.abort.abort();
  }
}

export function isStream(reply: EventStream | Reply): reply is EventStream {
  return reply instanceof EventStream;
}
