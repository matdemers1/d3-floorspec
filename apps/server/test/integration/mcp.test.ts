import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@floorspec/mcp';
import { TokenRejected, type Verifier } from '../../src/auth/resource-server.js';
import { workerRenderer } from '../../src/render.js';
import { ONE_ROOM_HOUSE } from '../support/fake-applier.js';
import { Browser, createProjectAs, ISSUER, reset, setupOperator, start, testDb, tokenFor, type Running } from './helpers.js';

/**
 * FLR-T-2.6 and FLR-T-2.10, end to end: MCP 2026-07-28 at /mcp, authorised by a per-project token
 * or by a D3 Auth access token (Claude's connector, a public client), every tool call going back
 * through the REST API's own guards — and the stdio shim proxying Claude Code to it.
 */

/** Stands in for D3 Auth's JWKS: `jwt.<sub>.<client>` verifies, anything else does not. */
const fakeVerifier: Verifier = {
  verify(token: string) {
    const [kind, sub, client] = token.split('.');
    if (kind !== 'jwt' || sub === undefined) return Promise.reject(new TokenRejected('bad signature'));
    return Promise.resolve({ iss: ISSUER, sub, client });
  },
};

type Content = { type: string; text?: string; data?: string; mimeType?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const images = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'image');

describe('the MCP endpoint', () => {
  const db = testDb();
  let running: Running;
  let operator: Browser;
  let project: { id: string; head: string };
  const clients: Client[] = [];

  async function connect(authorization: string, era: 'legacy' | 'modern' = 'modern'): Promise<Client> {
    const client = new Client({ name: 'test', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), { requestInit: { headers: { authorization } } }));
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    running = await start({ with: { verifier: fakeVerifier, renderer: workerRenderer() } });
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    operator = await setupOperator(running);
    project = await createProjectAs(operator);
    await operator.post(`/api/projects/${project.id}/ops`, { batch: ONE_ROOM_HOUSE });
  });

  it('answers a request without a credential with the RFC 9728 challenge', async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${running.config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="openid profile email"`,
    );
    // A session cookie is not a credential here.
    const cookie = [...operator.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const withCookie = await fetch(`${running.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    expect(withCookie.status).toBe(401);
    // A forged access token is refused the same way, with the error named.
    const forged = await fetch(`${running.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x.y.z' }, body: '{}' });
    expect(forged.status).toBe(401);
    expect(forged.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('publishes protected-resource metadata pointing at D3 Auth', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${running.url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: `${running.config.PUBLIC_URL}/mcp`, bearer_methods_supported: ['header'] });
    }
    expect((await fetch(`${running.url}/mcp`)).status).toBe(405);
  });

  for (const era of ['legacy', 'modern'] as const) {
    it(`serves the eleven tools to a ${era} client with a project token`, async () => {
      const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'read')}`, era);
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const described = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
      expect(described.isError, texts(described)).toBeFalsy();
      expect(texts(described)).toContain('Kitchen');
    });
  }

  it('commits a write token\'s batch to main and draws it', async () => {
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'write')}`);
    const result = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }], render: true },
    });
    expect(result.isError, texts(result)).toBeFalsy();
    expect(texts(result)).toContain('Committed to main');
    const [png] = images(result);
    expect(png?.mimeType).toBe('image/png');
    expect(Buffer.from(png?.data ?? '', 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
    const row = await db.opLog.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { seq: 'desc' } });
    expect(row).toMatchObject({ head: 'main', authorKind: 'token' });
    // Audited through the ordinary REST route the tool called.
    expect(await db.auditLog.count({ where: { action: 'ops.apply', actor: { startsWith: 'token:' } } })).toBe(1);
  });

  it('lays out main\'s brief for an agent as candidate changesets, leaving main as it was', async () => {
    const brief = [
      { op: 'addProgramItem', id: 'LIV', function: 'living', name: 'Living room', targetArea: '240 sq ft' },
      { op: 'addProgramItem', id: 'KIT', function: 'kitchen', name: 'Kitchen', targetArea: '130 sq ft' },
      { op: 'addProgramItem', id: 'BED', function: 'sleeping', name: 'Bedroom', targetArea: '130 sq ft' },
      { op: 'setAdjacency', a: 'KIT', b: 'LIV', kind: 'required' },
    ];
    expect((await operator.post(`/api/projects/${project.id}/ops`, { batch: brief })).status).toBe(201);
    const before = (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'agent', 'Claude Code')}`);
    const result = await mcp.callTool({ name: 'floorspec_propose_layouts', arguments: {} });
    expect(result.isError, texts(result)).toBeFalsy();
    const { candidates } = result.structuredContent as { candidates: { changeset: { id: string; name: string } }[] };
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const [first] = candidates;
    expect(texts(result)).toContain(`1. "${first?.changeset.name ?? ''}" (${first?.changeset.id ?? ''})`);
    const rows = await db.changeset.findMany({ where: { projectId: project.id, status: 'pending' } });
    expect(rows.map((r) => r.id).sort()).toEqual(candidates.map((c) => c.changeset.id).sort());
    expect(rows.every((r) => r.createdByAgent === 'Claude Code')).toBe(true);
    expect((await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash).toBe(before);
    expect(await db.auditLog.count({ where: { action: 'layouts.propose', actor: { startsWith: 'agent:' } } })).toBe(1);
  });

  it('puts an agent token\'s batch in a changeset, draws it ghosted, and refuses to let the agent accept it', async () => {
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'agent', 'Claude Code')}`);
    const before = (await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash;
    const proposed = await mcp.callTool({
      name: 'floorspec_propose',
      arguments: { name: 'Rename the kitchen', batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }], render: true },
    });
    expect(proposed.isError, texts(proposed)).toBeFalsy();
    const changeset = (proposed.structuredContent as { changeset: { id: string } }).changeset.id;
    expect(images(proposed)).toHaveLength(1);
    expect((await db.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: 'main' } } })).versionHash).toBe(before);

    const applied = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'moveJunction', id: 'J3', to: [5120000, 4000000] }] } });
    expect(texts(applied)).toContain('It is pending');

    const describedChangeset = await mcp.callTool({ name: 'floorspec_describe', arguments: { changeset } });
    expect(texts(describedChangeset)).toContain('Galley');
    const validated = await mcp.callTool({ name: 'floorspec_validate', arguments: { changeset } });
    expect(validated.structuredContent).toMatchObject({ head: `cs/${changeset}` });

    const accept = await mcp.callTool({ name: 'floorspec_accept', arguments: { changeset } });
    expect(accept.isError).toBe(true);
    expect(texts(accept)).toContain('FLR-ADR-016');
    // The person accepts it.
    expect((await operator.post(`/api/projects/${project.id}/changesets/${changeset}/accept`)).status).toBe(200);
  });

  it('takes a pending changeset by its name on every tool, as apply does', async () => {
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'agent', 'Claude Code')}`);
    const name = 'Rename the kitchen';
    const proposed = await mcp.callTool({ name: 'floorspec_propose', arguments: { name, batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }] } });
    const id = (proposed.structuredContent as { changeset: { id: string } }).changeset.id;
    // apply by name appends to it…
    const applied = await mcp.callTool({ name: 'floorspec_apply', arguments: { changeset: name, batch: [{ op: 'setProperty', id: 'R1', path: '/function', value: 'kitchen' }] } });
    expect(applied.structuredContent).toMatchObject({ changeset: { id } });
    // …and every other tool reads it by name too.
    const described = await mcp.callTool({ name: 'floorspec_describe', arguments: { changeset: name } });
    expect(described.isError, texts(described)).toBeFalsy();
    expect(texts(described)).toContain('Galley');
    expect(texts(described)).toContain(`(changeset "${name}" ${id}, pending)`);
    const queried = await mcp.callTool({ name: 'floorspec_query', arguments: { changeset: name, ids: ['R1'] } });
    expect(JSON.stringify(queried.structuredContent)).toContain('Galley');
    const validated = await mcp.callTool({ name: 'floorspec_validate', arguments: { changeset: name } });
    expect(validated.structuredContent).toMatchObject({ head: `cs/${id}` });
    const findings = await mcp.callTool({ name: 'floorspec_findings', arguments: { changeset: name } });
    expect(findings.structuredContent).toMatchObject({ head: `cs/${id}` });
    expect(images(await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: name, width: 512 } }))).toHaveLength(1);
    const exported = await mcp.callTool({ name: 'floorspec_export', arguments: { changeset: name } });
    expect(JSON.stringify(exported.content)).toContain('Galley');
    const accept = await mcp.callTool({ name: 'floorspec_accept', arguments: { changeset: name } });
    expect(texts(accept)).toContain('FLR-ADR-016');
    const unknown = await mcp.callTool({ name: 'floorspec_validate', arguments: { changeset: 'Widen the bath' } });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)).toContain(`Pending: "${name}" (${id})`);
  });

  it('adds a hint to the rejections agents are known to hit, leaving the diagnostics as they were', async () => {
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'write')}`);
    const cased = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addOpening', wall: 'W3', at: 'centered', width: '36"' }] } });
    expect(cased.isError).toBe(true);
    expect(texts(cased)).toMatch(/FS-INV-301 error: .*height does not resolve/);
    expect(texts(cased)).toContain("Hint: An opening without a fill type needs `height` — door height is usually 6' 8\"");
    expect(JSON.stringify(cased.structuredContent)).not.toContain('Hint');

    const study = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'setProperty', id: 'R1', path: '/function', value: 'study' }] } });
    expect(texts(study)).toContain('FS-SCH-001 error: /rooms/R1/function');
    expect(texts(study)).toContain('Hint: Room functions (Core 4.1): unspecified, sleeping');
    expect(texts(study)).toContain('study → office');

    const midBatch = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'drawWall', level: 'L1', from: [2560000, -390144], to: [2560000, 4230144] }, { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "1'" }] },
    });
    expect(texts(midBatch)).toContain('FS-OPS-007');
    expect(texts(midBatch)).toContain('Hint: Walls drawn in this batch join the plan when the batch ends; apply this operation in a second batch.');
  });

  it('reports findings honestly, and 3D as not available yet', async () => {
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'read')}`);
    const findings = await mcp.callTool({ name: 'floorspec_findings', arguments: {} });
    expect(findings.structuredContent).toMatchObject({ findings: [] });
    expect(texts(findings)).toContain('Nothing was checked: no rule pack is installed on this server yet.');
    // The notice and the pack coverage link, as on every findings surface (FLR-REQ-105, FLR-REQ-096).
    expect(texts(findings)).toContain('They are not a plan review, and the authority having jurisdiction decides.');
    expect(texts(findings)).toMatch(/What the installed packs check, and do not: https?:\/\/\S+\/rule-packs/);
    expect(texts(findings)).not.toMatch(/is compliant/i);
    const threeD = await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d' } });
    expect(threeD.isError).toBe(true);
    expect(texts(threeD)).toContain('not available yet');
    const plan = await mcp.callTool({ name: 'floorspec_render', arguments: { width: 512 } });
    expect(images(plan)).toHaveLength(1);
    const exported = await mcp.callTool({ name: 'floorspec_export', arguments: {} });
    expect((exported.content as { type: string; resource?: { text: string } }[]).find((c) => c.type === 'resource')?.resource?.text).toBe(
      (await operator.get(`/api/projects/${project.id}/model.json`)).text,
    );
  });

  it('keeps a token to its own project', async () => {
    const other = await createProjectAs(operator, 'Other house');
    const mcp = await connect(`Bearer ${await tokenFor(operator, project.id, 'write')}`);
    const result = await mcp.callTool({ name: 'floorspec_describe', arguments: { project: other.id } });
    expect(result.isError).toBe(true);
  });

  describe('signed in through D3 Auth', () => {
    it('acts for the linked account as an agent: it reads every project and proposes, never commits', async () => {
      const account = await db.account.findFirstOrThrow({ where: { email: 'operator@example.test' } });
      await db.identity.create({ data: { accountId: account.id, iss: ISSUER, sub: 'operator-sub' } });
      await createProjectAs(operator, 'Second house');
      const mcp = await connect('Bearer jwt.operator-sub.claude');

      // Two projects: the tool asks which.
      const ambiguous = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
      expect(ambiguous.isError).toBe(true);
      expect(texts(ambiguous)).toContain('Name a project');

      const applied = await mcp.callTool({
        name: 'floorspec_apply',
        arguments: { project: project.id, batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }] },
      });
      expect(applied.isError, texts(applied)).toBeFalsy();
      expect(applied.structuredContent).toMatchObject({ changeset: { name: 'd3auth:claude', status: 'pending' } });
      const row = await db.opLog.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { seq: 'desc' } });
      expect(row).toMatchObject({ authorKind: 'agent', authorAgent: 'd3auth:claude', authorAccountId: account.id });
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'changeset.apply' } });
      expect(audit.actor).toBe('agent:d3auth:claude');
    });

    it('refuses a token whose subject is not linked to an account', async () => {
      const res = await fetch(`${running.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer jwt.stranger.claude' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    });

    it('cannot use a D3 Auth token on the REST API to act as a person', async () => {
      const account = await db.account.findFirstOrThrow({ where: { email: 'operator@example.test' } });
      await db.identity.create({ data: { accountId: account.id, iss: ISSUER, sub: 'operator-sub' } });
      const bearer = Browser.bearer(running.url, 'jwt.operator-sub.claude');
      expect((await bearer.get('/api/tokens')).status).toBe(403);
      expect((await bearer.request('DELETE', `/api/projects/${project.id}`)).status).toBe(403);
    });
  });

  it('is reachable from Claude Code through the stdio shim', async () => {
    const token = await tokenFor(operator, project.id, 'agent', 'Claude Code');
    // The built bin, resolved through the workspace dependency so turbo builds it before this suite.
    const shim = join(dirname(createRequire(import.meta.url).resolve('@floorspec/mcp-stdio')), 'floorspec-mcp.js');
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [shim], env: { FLOORSPEC_URL: running.url, FLOORSPEC_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    );
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const described = await client.callTool({ name: 'floorspec_describe', arguments: {} });
    expect(texts(described)).toContain('Kitchen');
    const proposed = await client.callTool({ name: 'floorspec_propose', arguments: { name: 'Via the shim', batch: [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }] } });
    expect(proposed.isError, texts(proposed)).toBeFalsy();
    expect(await db.changeset.count({ where: { name: 'Via the shim' } })).toBe(1);
  });
});
