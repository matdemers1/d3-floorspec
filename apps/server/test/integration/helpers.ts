import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app.js';
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
