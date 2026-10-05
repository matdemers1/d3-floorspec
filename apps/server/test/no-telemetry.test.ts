/**
 * FLR-T-12.3: the two guarantees the README makes, held by a test.
 *
 * **No telemetry** (FLR-REQ-152). The api is booted in this process under an interception layer
 * on every way Node reaches the network — `net.Socket#connect` (which TCP, TLS, `http(s)`, `pg`
 * and undici's `fetch` all go through), `dns.lookup`/`resolve*` and `dns.promises`, `dgram` sends,
 * and, to name the culprit, `fetch` and `http(s).request` — and then driven through every surface:
 * first-run setup, sessions and TOTP, projects, ops, undo and redo, versions, changesets, layouts,
 * the electrical assistant, validation, findings under installed rule packs, renders (the worker's
 * renderer, in-process), the live event stream, tokens, exports, and MCP tool calls. The only
 * connections allowed are the configured services: Postgres at DATABASE_URL, the api's own port
 * (the MCP endpoint loops back to it), and — only with Sign in with D3 Auth configured — the
 * D3 Auth issuer. Anything else is refused before it leaves the process and fails the test. A
 * positive control proves the layer sees a request.
 *
 * **Free export** (FLR-REQ-151). `model.json` — the project as a canonical Floorspec document — and
 * the MCP `floorspec_export` tool answer for every project whatever state it is in: empty, edited,
 * with a pending changeset, holding a document today's engine finds invalid or one of an older
 * draft, through a session or a token of any kind. Nothing in the app charges for anything.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, contentHash, validate } from '@floorspec/engine';
import type { Prisma } from '../src/db.js';
import { createOidcClient } from '../src/auth/oidc.js';
import { createVerifier } from '../src/auth/resource-server.js';
import { workerRenderer } from '../src/render.js';
import { loadRulePacks } from '../src/rules/packs.js';
import { ONE_ROOM_HOUSE } from './support/fake-applier.js';
import { Browser, createProjectAs, isStream, reset, setupOperator, start, testConfig, testDb, tokenFor, totpCode, type Running } from './integration/helpers.js';

// ── the interception layer ─────────────────────────────────────────────────────

interface Attempt {
  readonly via: string;
  readonly host: string;
  readonly port?: number;
}

const attempts: Attempt[] = [];
/** Ports on loopback that are ours: the api (and its MCP loopback) and Postgres. */
const allowedLoopbackPorts = new Set<number>();
const allowedHosts = new Map<string, Set<number>>(); // host → ports (Postgres when it is not on loopback)
let configuredHosts = new Set<string>(); // the D3 Auth issuer, when configured

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

type Verdict = 'ours' | 'configured' | 'refused';
function judge(a: Attempt): Verdict {
  if (a.via === 'ipc') return 'ours';
  if (LOOPBACK.has(a.host) && (a.port === undefined || allowedLoopbackPorts.has(a.port))) return 'ours';
  if (a.port !== undefined && allowedHosts.get(a.host)?.has(a.port)) return 'ours';
  if (configuredHosts.has(a.host)) return 'configured';
  return 'refused';
}

const blocked = (what: string): Error => Object.assign(new Error(`no-telemetry test: refused ${what}`), { code: 'ENOTFOUND' });

/** Everything the layer saw that was not one of ours or a configured service. */
const violations = (): Attempt[] => attempts.filter((a) => judge(a) === 'refused');

const originals: (() => void)[] = [];
function patch<T extends object, K extends keyof T>(target: T, key: K, make: (original: T[K]) => T[K]): void {
  const original = target[key];
  target[key] = make(original);
  originals.push(() => {
    target[key] = original;
  });
}

function install(): void {
  // TCP and TLS: every client socket connects through here — pg, undici (fetch), http(s), tls.
  patch(net.Socket.prototype, 'connect', (original) =>
    function (this: net.Socket, ...args: unknown[]) {
      const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
      let attempt: Attempt;
      if (typeof first === 'object' && first !== null) {
        const o = first as { path?: string; host?: string; port?: number | string };
        attempt = o.path !== undefined ? { via: 'ipc', host: o.path } : { via: 'tcp', host: o.host ?? 'localhost', port: Number(o.port) };
      } else if (typeof first === 'string' && !/^[0-9]+$/.test(first)) attempt = { via: 'ipc', host: first };
      else attempt = { via: 'tcp', host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
      attempts.push(attempt);
      if (judge(attempt) === 'ours') return (original as (...a: unknown[]) => net.Socket).apply(this, args);
      // Refused (or a configured service this offline test stands in for): fail like an unreachable host.
      process.nextTick(() => this.destroy(blocked(`${attempt.host}:${String(attempt.port)}`)));
      return this;
    },
  );
  // DNS: a lookup is how a hostname leaves the process before any socket does.
  const lookups = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveTxt', 'resolveSrv', 'resolveNs', 'resolveMx'] as const;
  for (const name of lookups) {
    patch(dns, name, (original) =>
      function (hostname: string, ...rest: unknown[]) {
        const attempt: Attempt = { via: `dns.${name}`, host: hostname };
        attempts.push(attempt);
        if (name === 'lookup' && LOOPBACK.has(hostname)) return (original as (...a: unknown[]) => unknown)(hostname, ...rest);
        const callback = rest.at(-1);
        if (typeof callback === 'function') process.nextTick(() => { (callback as (e: Error) => void)(blocked(`a DNS ${name} of ${hostname}`)); });
        return undefined;
      } as never,
    );
    patch(dns.promises, name, (original) =>
      function (hostname: string, ...rest: unknown[]) {
        attempts.push({ via: `dns.promises.${name}`, host: hostname });
        if (name === 'lookup' && LOOPBACK.has(hostname)) return (original as (...a: unknown[]) => unknown)(hostname, ...rest);
        return Promise.reject(blocked(`a DNS ${name} of ${hostname}`));
      } as never,
    );
  }
  // UDP: statsd-style metrics would go out this way.
  patch(dgram.Socket.prototype, 'send', () =>
    function (this: dgram.Socket, ...args: unknown[]) {
      const port = args.find((a) => typeof a === 'number' && a > 0) as number | undefined;
      const host = args.find((a, i) => typeof a === 'string' && i > 0) as string | undefined;
      attempts.push({ via: 'udp', host: host ?? 'localhost', ...(port === undefined ? {} : { port }) });
      const callback = args.at(-1);
      if (typeof callback === 'function') process.nextTick(() => { (callback as (e: Error) => void)(blocked('a UDP datagram')); });
    } as never,
  );
  // Named for the report: who asked. The socket layer above is what refuses.
  for (const [mod, name] of [
    [http, 'http'],
    [https, 'https'],
  ] as const) {
    for (const fn of ['request', 'get'] as const) {
      patch(mod, fn, (original) =>
        function (...args: unknown[]) {
          const first = args[0];
          const url = first instanceof URL ? first : typeof first === 'string' ? new URL(first) : undefined;
          const o = (url === undefined ? first : undefined) as { hostname?: string; host?: string; port?: number | string } | undefined;
          attempts.push({ via: `${name}.${fn}`, host: url?.hostname ?? o?.hostname ?? o?.host ?? 'localhost', ...(url?.port ? { port: Number(url.port) } : o?.port ? { port: Number(o.port) } : {}) });
          return (original as (...a: unknown[]) => unknown)(...args);
        } as never,
      );
    }
  }
  patch(globalThis, 'fetch', (original) =>
    function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const attempt: Attempt = { via: 'fetch', host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
      attempts.push(attempt);
      if (judge(attempt) !== 'ours') return Promise.reject(new TypeError('fetch failed', { cause: blocked(url.host) }));
      return original(input, init);
    },
  );
  syncBuiltinESMExports();
}

function uninstall(): void {
  for (const restore of originals.reverse()) restore();
  originals.length = 0;
  syncBuiltinESMExports();
}

// ── the app, driven ────────────────────────────────────────────────────────────

const ISSUER = 'https://auth.d3-floorspec-test.invalid';
const PACKS = new URL('./fixtures/rule-packs/', import.meta.url).pathname;
const PROFILE = new URL('./fixtures/profiles/synthetic.json', import.meta.url).pathname;
const OIDC_ENV = { D3AUTH_ISSUER: ISSUER, D3AUTH_CLIENT_ID: 'floorspec', D3AUTH_CLIENT_SECRET: 'a-client-secret-for-tests-only', RULE_PACKS_DIR: PACKS, RULE_PROFILE: PROFILE };

const BRIEF = [
  { op: 'addProgramItem', id: 'LIV', function: 'living', name: 'Living room', targetArea: '240 sq ft' },
  { op: 'addProgramItem', id: 'BED', function: 'sleeping', name: 'Bedroom', targetArea: '130 sq ft' },
  { op: 'setAdjacency', a: 'BED', b: 'LIV', kind: 'preferred' },
];

type Content = { type: string; text?: string; resource?: { text?: string } };

describe('no telemetry: no outbound connection beyond the configured services', () => {
  const db = testDb();
  let running: Running;
  const clients: Client[] = [];

  beforeAll(async () => {
    const pg = new URL(process.env['DATABASE_URL'] ?? '');
    const pgPort = Number(pg.port || 5432);
    if (LOOPBACK.has(pg.hostname)) allowedLoopbackPorts.add(pgPort);
    else allowedHosts.set(pg.hostname, new Set([pgPort]));
    configuredHosts = new Set([new URL(ISSUER).hostname]);
    install();

    // Boot as index.ts boots: rule packs from a local directory, D3 Auth discovery against the
    // configured issuer (which this offline test refuses, so the client is null and the password
    // path carries on), the real resource-server verifier, and the worker's renderer.
    const config = testConfig(OIDC_ENV);
    const rulePacks = loadRulePacks(config.RULE_PACKS_DIR, config.RULE_PROFILE);
    const oidc = await createOidcClient(config);
    expect(oidc).toBeNull();
    running = await start({ env: OIDC_ENV, with: { oidc, verifier: createVerifier(config), renderer: workerRenderer(), rulePacks, eventStream: { heartbeatMs: 50 } } });
    allowedLoopbackPorts.add(Number(new URL(running.url).port));
    await reset(db);
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await running.close();
    uninstall();
  });

  it('the interception layer sees an outbound request (positive control)', async () => {
    const before = attempts.length;
    await expect(fetch('https://telemetry.example.com/collect', { method: 'POST', body: '{}' })).rejects.toThrow();
    const lookup = new Promise((resolve, reject) => {
      dns.lookup('telemetry.example.com', (e) => {
        if (e) reject(e);
        else resolve(null);
      });
    });
    await expect(lookup).rejects.toThrow();
    const seen = attempts.splice(before);
    expect(seen.map((a) => [a.via, a.host])).toEqual([
      ['fetch', 'telemetry.example.com'],
      ['dns.lookup', 'telemetry.example.com'],
    ]);
  });

  it('booting reached only the configured D3 Auth issuer, and Postgres', () => {
    expect(violations()).toEqual([]);
    const hosts = new Set(attempts.filter((a) => judge(a) === 'configured').map((a) => a.host));
    // Discovery was attempted — against the issuer and nothing else.
    expect([...hosts]).toEqual([new URL(ISSUER).hostname]);
  });

  it('every surface of the api, the worker\'s renderer and MCP, driven end to end', async () => {
    // First-run setup, a session, TOTP.
    const operator = await setupOperator(running);
    expect((await operator.get('/auth/session')).status).toBe(200);
    const enrol = await operator.post('/auth/totp/enrol');
    expect(enrol.status, enrol.text).toBeLessThan(300);
    const secret = (enrol.body as { secret?: string }).secret;
    if (secret !== undefined) expect((await operator.post('/auth/totp/confirm', { code: await totpCode(secret) })).status).toBeLessThan(300);

    // Projects and ops; history, undo, redo, versions.
    const project = await createProjectAs(operator, 'Offline house');
    const path = (rest = ''): string => `/api/projects/${project.id}${rest}`;
    const live = await operator.events(path('/events'));
    const applied = await operator.post(path('/ops'), { batch: ONE_ROOM_HOUSE });
    expect(applied.status, applied.text).toBe(201);
    if (isStream(live)) {
      await live.next(undefined, 5_000);
      live.close();
    }
    const hash = (applied.body as { hash: string }).hash;
    expect((await operator.get(path(`/versions/${hash}`))).status).toBe(200);
    expect((await operator.get(path('/history'))).status).toBe(200);
    expect((await operator.post(path('/undo'))).status).toBe(201);
    expect((await operator.post(path('/redo'))).status).toBe(201);
    expect((await operator.post(path('/ops'), { batch: BRIEF })).status).toBe(201);

    // Checks: validation, findings under the installed packs, a render by the worker's renderer.
    expect((await operator.get(path('/validate'))).status).toBe(200);
    expect((await operator.get(path('/findings'))).status).toBe(200);
    const png = await operator.get(path('/render'));
    expect(png.status, png.text.slice(0, 200)).toBe(200);
    expect((await operator.get('/api/rule-packs')).status).toBe(200);
    expect((await operator.get('/api/profiles')).status).toBe(200);

    // Changesets: an agent proposes, a person accepts; the layout solver; the electrical assistant.
    const agentToken = await tokenFor(operator, project.id, 'agent', 'Claude Code');
    const agent = Browser.bearer(running.url, agentToken);
    const proposed = await agent.post(path('/changesets'), { name: 'Rename the kitchen', batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }] });
    expect(proposed.status, proposed.text).toBe(201);
    const changesetId = (proposed.body as { changeset: { id: string } }).changeset.id;
    expect((await agent.get(path(`/changesets/${changesetId}/model.json`))).status).toBe(200);
    expect((await operator.post(path(`/changesets/${changesetId}/accept`))).status).toBe(200);
    const layouts = await operator.post(path('/layouts'), {});
    expect(layouts.status, layouts.text).toBeLessThan(300);
    const electrical = await operator.post(path('/assistants/electrical'), {});
    expect(electrical.status, electrical.text).toBeLessThan(300);

    // Export.
    expect((await operator.get(path('/model.json'))).status).toBe(200);

    // MCP over HTTP with an API token: the server loops back to its own port, and nowhere else.
    const mcp = new Client({ name: 'no-telemetry', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agentToken}` } } }));
    clients.push(mcp);
    expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);
    for (const [name, args] of [
      ['floorspec_describe', {}],
      ['floorspec_validate', {}],
      ['floorspec_findings', {}],
      ['floorspec_render', {}],
      ['floorspec_export', {}],
      ['floorspec_propose', { name: 'Widen nothing', batch: [{ op: 'setProperty', id: '$project', path: '/name', value: 'Offline house 2' }] }],
    ] as const) {
      const result = await mcp.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 300)}`).toBeFalsy();
    }

    // A D3 Auth access token at /mcp: the real verifier fetches the issuer's key set — the
    // configured service — and nothing else. This one is unsigned, so it is refused either way.
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'someone', aud: `${running.config.PUBLIC_URL}/mcp` })).toString('base64url');
    const configuredBefore = attempts.filter((a) => judge(a) === 'configured').length;
    const jwt = await fetch(`${running.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${header}.${payload}.c2ln` }, body: '{}' });
    expect(jwt.status).toBe(401);
    expect(attempts.filter((a) => judge(a) === 'configured').length, 'the verifier asked the issuer for its keys').toBeGreaterThan(configuredBefore);

    // Tokens and invites, then deleting the project.
    expect((await operator.get('/api/tokens')).status).toBe(200);
    expect((await operator.post('/api/invites', { email: 'member@example.test' })).status).toBe(201);
    expect((await operator.request('DELETE', path())).status).toBe(204);

    expect(violations()).toEqual([]);
    const configured = new Set(attempts.filter((a) => judge(a) === 'configured').map((a) => a.host));
    expect([...configured]).toEqual([new URL(ISSUER).hostname]);
    // The layer saw the traffic it allowed, too: Postgres and the api's own port.
    const tcp = attempts.filter((a) => a.via === 'tcp');
    const pgPort = Number(new URL(process.env['DATABASE_URL'] ?? '').port || 5432);
    expect(tcp.some((a) => a.port === pgPort)).toBe(true);
    expect(tcp.some((a) => a.port === Number(new URL(running.url).port))).toBe(true);
    // And everything that was ours went to the api's port or Postgres.
    for (const a of attempts.filter((x) => x.via === 'tcp' && judge(x) === 'ours')) {
      const port = a.port ?? -1;
      expect(allowedLoopbackPorts.has(port) || allowedHosts.get(a.host)?.has(port), `${a.host}:${String(port)}`).toBe(true);
    }
  });

  it('without D3 Auth configured, nothing but Postgres and the api is contacted at all', async () => {
    const before = attempts.length;
    const config = testConfig();
    expect(await createOidcClient(config)).toBeNull();
    expect(createVerifier(config)).toBeNull();
    const plain = await start({ with: { renderer: workerRenderer() } });
    allowedLoopbackPorts.add(Number(new URL(plain.url).port));
    try {
      const browser = new Browser(plain.url);
      expect((await browser.post('/auth/session', { email: 'operator@example.test', password: 'operator-password-1' })).status).toBeLessThan(500);
      expect((await browser.get('/healthz')).status).toBe(200);
    } finally {
      await plain.close();
    }
    const seen = attempts.slice(before);
    expect(seen.filter((a) => judge(a) !== 'ours')).toEqual([]);
  });
});

// ── free export ────────────────────────────────────────────────────────────────

describe('free export: model.json for every project, whatever its state', () => {
  const db = testDb();
  let running: Running;
  let operator: Browser;
  const clients: Client[] = [];

  beforeAll(async () => {
    running = await start({ with: { renderer: null } });
    await reset(db);
    operator = await setupOperator(running);
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await running.close();
  });

  /** model.json through REST, and floorspec_export through MCP with a read-only token: the same bytes. */
  async function exported(projectId: string, as: Browser = operator): Promise<string> {
    const res = await as.get(`/api/projects/${projectId}/model.json`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="model.json"');
    const mcp = new Client({ name: 'export', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokenFor(operator, projectId, 'read')}` } } }));
    clients.push(mcp);
    const result = await mcp.callTool({ name: 'floorspec_export', arguments: {} });
    expect(result.isError).toBeFalsy();
    const resource = (result.content as Content[]).find((c) => c.type === 'resource');
    expect(resource?.resource?.text).toBe(res.text);
    return res.text;
  }

  it('an empty project exports a valid Floorspec document', async () => {
    const project = await createProjectAs(operator, 'Empty');
    const text = await exported(project.id);
    expect(validate(text).valid).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ floorspec: '0.3', project: { name: 'Empty' } });
  });

  it('an edited project exports its canonical document, its ETag the content hash', async () => {
    const project = await createProjectAs(operator, 'Edited');
    const applied = await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
    expect(applied.status).toBe(201);
    const text = await exported(project.id);
    expect(validate(text).valid).toBe(true);
    const res = await operator.get(`/api/projects/${project.id}/model.json`);
    expect(res.headers.get('etag')).toBe(`"${(applied.body as { hash: string }).hash}"`);
  });

  it('with a pending changeset: main exports as it is, and so does the changeset', async () => {
    const project = await createProjectAs(operator, 'Pending');
    await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
    const before = await exported(project.id);
    const agent = Browser.bearer(running.url, await tokenFor(operator, project.id, 'agent'));
    const proposed = await agent.post(`/api/projects/${project.id}/changesets`, { name: 'Rename', batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }] });
    expect(proposed.status).toBe(201);
    expect(await exported(project.id)).toBe(before);
    const id = (proposed.body as { changeset: { id: string } }).changeset.id;
    const changeset = await agent.get(`/api/projects/${project.id}/changesets/${id}/model.json`);
    expect(changeset.status).toBe(200);
    expect(changeset.text).toContain('Galley');
  });

  it('through every kind of credential: a session, and read, write and agent tokens', async () => {
    const project = await createProjectAs(operator, 'Credentials');
    const want = await exported(project.id);
    for (const kind of ['read', 'write', 'agent'] as const) {
      const as = Browser.bearer(running.url, await tokenFor(operator, project.id, kind));
      expect(await exported(project.id, as), kind).toBe(want);
    }
  });

  it('a project whose stored document the engine now finds invalid still exports, byte for byte', async () => {
    const project = await createProjectAs(operator, 'Broken');
    // A wall that names a junction that is not there: a document no op could produce, as a project
    // might hold one written under an older engine. Export does not judge it; it hands it over.
    const broken = { floorspec: '0.3', project: { name: 'Broken' }, buildings: { B1: {} }, levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } }, walls: { W1: { level: 'L1', start: 'J1', end: 'J9' } } };
    expect(validate(broken).valid).toBe(false);
    await storeAsMain(project.id, broken);
    expect(await exported(project.id)).toBe(canonicalize(broken));
  });

  it('a project still on an older Core draft exports as that draft', async () => {
    const project = await createProjectAs(operator, 'Old');
    const old = { floorspec: '0.1', project: { name: 'Old' } };
    await storeAsMain(project.id, old);
    const text = await exported(project.id);
    expect(JSON.parse(text)).toMatchObject({ floorspec: '0.1' });
    expect(validate(text).valid).toBe(true);
  });

  /** Point main at a version holding `document` — what an older release might have stored. */
  async function storeAsMain(projectId: string, document: Prisma.InputJsonObject): Promise<void> {
    const hash = contentHash(document);
    await db.version.upsert({ where: { hash }, create: { hash, document }, update: {} });
    await db.head.update({ where: { projectId_name: { projectId, name: 'main' } }, data: { versionHash: hash } });
  }
});
