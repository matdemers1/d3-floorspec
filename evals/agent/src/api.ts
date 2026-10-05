import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { EVAL_ROOT, type Doc } from './seeds.js';

/**
 * The D3 Floorspec API the eval runs against: the real server (`apps/server`, built), started as a
 * child process on a free loopback port against a throwaway database, and driven through its REST
 * API exactly as a person's browser would — first-run setup, a project per task, the seed applied
 * as Floorspec Ops, an **agent** token for Claude (FLR-ADR-016: its edits land in a changeset).
 */

export const REPO_ROOT = join(EVAL_ROOT, '../..');
export const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/dist/index.js');
export const SHIM = join(REPO_ROOT, 'packages/mcp-stdio/dist/floorspec-mcp.js');

/**
 * The harness's own test operator, for a database it creates and drops. Test values only: they
 * exist nowhere but in the throwaway `*_test` database of an eval run on this machine.
 */
export const EVAL_OPERATOR = { email: 'eval-operator@example.test', displayName: 'Eval operator', password: 'eval-operator-password-1' } as const;

/** The agent token's name; the server opens a changeset of this name for the agent's batches. */
export const AGENT_TOKEN_NAME = 'Claude (agent eval)';

export const DEFAULT_DATABASE_URL = 'postgresql://floorspec:floorspec@localhost:55433/floorspec_eval_test';

/** Drop and create the eval database. Refuses any name that does not end in `_test`. */
export async function freshDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to recreate "${name}": an eval database name must end in _test`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface RunningApi {
  readonly url: string;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

/** Start the built API against a fresh database; resolves when `/readyz` answers 200. */
export async function startApi(databaseUrl: string, logFile: string, fixedPort?: number): Promise<RunningApi> {
  await freshDatabase(databaseUrl);
  const port = fixedPort ?? (await freePort());
  const url = `http://127.0.0.1:${String(port)}`;
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: join(REPO_ROOT, 'apps/server'),
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      NODE_ENV: 'development',
      PORT: String(port),
      PUBLIC_URL: `http://localhost:${String(port)}`,
      DATABASE_URL: databaseUrl,
      // Throwaway keys for a throwaway database: generated per run, never stored.
      KEK: randomBytes(32).toString('base64'),
      PEPPER: randomBytes(32).toString('base64'),
      PREMIGRATION_DUMP: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const state: { exited: number | null } = { exited: null };
  child.on('exit', (code) => {
    state.exited = code ?? -1;
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (state.exited !== null) throw new Error(`the API exited with ${String(state.exited)} before it was ready; see ${logFile}`);
    try {
      const res = await fetch(`${url}/readyz`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`the API was not ready within 120 s; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (state.exited !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: ${String(status)} ${body.slice(0, 2000)}`);
  }
}

/** The operator's browser: a cookie jar and JSON. */
export class Operator {
  private cookie = '';

  constructor(readonly base: string) {}

  /** The operator's session cookie, to hand to a later process (the proxy eval's server.json). */
  get session(): string {
    return this.cookie;
  }

  /** An operator signed in with a session cookie an earlier process saved. */
  static resume(base: string, cookie: string): Operator {
    const op = new Operator(base);
    op.cookie = cookie;
    return op;
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie === '' ? {} : { cookie: this.cookie }),
      },
      redirect: 'manual',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie();
    if (set.length > 0) {
      const jar = new Map(this.cookie.split('; ').filter((c) => c.length > 0).map((c) => [c.split('=')[0] ?? '', c] as const));
      for (const line of set) {
        const pair = line.split(';')[0] ?? '';
        jar.set(pair.split('=')[0] ?? '', pair);
      }
      this.cookie = [...jar.values()].join('; ');
    }
    return res;
  }

  async json<T>(method: string, path: string, body: unknown, expect: number, what: string): Promise<T> {
    const res = await this.request(method, path, body);
    const text = await res.text();
    if (res.status !== expect) throw new ApiError(res.status, text, what);
    return JSON.parse(text) as T;
  }

  /** First-run setup: the eval operator becomes the instance's operator and is signed in. */
  async setup(): Promise<void> {
    await this.json('POST', '/auth/setup', EVAL_OPERATOR, 201, 'first-run setup');
  }

  async createProject(name: string): Promise<string> {
    const project = await this.json<{ id: string }>('POST', '/api/projects', { name }, 201, 'create project');
    return project.id;
  }

  /** Commit a batch to main as the operator. */
  async applyToMain(projectId: string, batch: readonly object[]): Promise<string> {
    const res = await this.json<{ hash: string }>('POST', `/api/projects/${projectId}/ops`, { batch }, 201, 'seed batch');
    return res.hash;
  }

  async agentToken(projectId: string): Promise<string> {
    const res = await this.json<{ token: string }>('POST', '/api/tokens', { projectId, name: AGENT_TOKEN_NAME, kind: 'agent' }, 201, 'agent token');
    return res.token;
  }

  async model(projectId: string, changeset?: string): Promise<{ hash: string; document: Doc }> {
    const path = changeset === undefined ? `/api/projects/${projectId}/model.json` : `/api/projects/${projectId}/changesets/${changeset}/model.json`;
    const res = await this.request('GET', path);
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text, 'read model');
    return { hash: (res.headers.get('etag') ?? '').replace(/"/g, ''), document: JSON.parse(text) as Doc };
  }

  async changesets(projectId: string): Promise<ChangesetDetail[]> {
    const list = await this.json<{ changesets: { id: string; name: string; status: string }[] }>('GET', `/api/projects/${projectId}/changesets?status=all`, undefined, 200, 'list changesets');
    const out: ChangesetDetail[] = [];
    for (const c of list.changesets) out.push(await this.json<ChangesetDetail>('GET', `/api/projects/${projectId}/changesets/${c.id}`, undefined, 200, 'read changeset'));
    return out;
  }
}

export interface ChangesetDetail {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly head: string | null;
  readonly log: readonly { readonly seq: number; readonly ops: readonly unknown[]; readonly resolved: readonly unknown[]; readonly createdAt: string }[];
}
