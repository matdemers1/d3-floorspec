import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  createFloorspecMcpHandler,
  DESIGN_PARTNER_PROMPT,
  FloorspecApiError,
  formatFeetInches,
  OP_NAMES,
  TOOL_NAMES,
  type Committed,
  type FloorspecClient,
  type RenderOptions,
} from '../src/index.js';

/** The conformance suite's one room, 4 m × 3 m, named Kitchen. */
const HOUSE = {
  floorspec: '0.1',
  project: { name: 'Lake house' },
  buildings: { B1: {} },
  levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } },
  types: { WT: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
  junctions: {
    J1: { level: 'L1', position: [0, 0] },
    J2: { level: 'L1', position: [0, 3840000] },
    J3: { level: 'L1', position: [5120000, 3840000] },
    J4: { level: 'L1', position: [5120000, 0] },
  },
  walls: {
    W1: { level: 'L1', start: 'J1', end: 'J2', type: 'WT' },
    W2: { level: 'L1', start: 'J2', end: 'J3', type: 'WT' },
    W3: { level: 'L1', start: 'J3', end: 'J4', type: 'WT' },
    W4: { level: 'L1', start: 'J4', end: 'J1', type: 'WT' },
  },
  openings: { O1: { wall: 'W3', offset: 1280000, width: 1170432, height: 2709333 } },
  rooms: { R1: { level: 'L1', anchor: [2560000, 1920000], name: 'Kitchen', function: 'kitchen' } },
};

const PROJECT = { id: '01a10000-0000-7000-8000-000000000001', name: 'Lake house', head: 'a'.repeat(64) };

/** A client that answers from memory and records what the tools asked of it. */
class MemoryClient implements FloorspecClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  agent = false;
  renderable = false;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  listProjects() {
    this.record('listProjects');
    return Promise.resolve([PROJECT]);
  }
  model(projectId: string, changeset?: string) {
    this.record('model', projectId, changeset);
    return Promise.resolve({ hash: PROJECT.head, document: HOUSE, text: JSON.stringify(HOUSE) });
  }
  apply(projectId: string, input: { batch: readonly unknown[] }): Promise<Committed> {
    this.record('apply', projectId, input);
    if (JSON.stringify(input.batch).includes('W99')) {
      return Promise.reject(
        new FloorspecApiError(422, {
          type: '/problems/ops-rejected',
          error: 'the batch was rejected and nothing changed',
          diagnostics: [{ code: 'FS-OPS-003', severity: 'error', message: 'W99 does not exist.', elements: [] }],
        }),
      );
    }
    return Promise.resolve({
      status: 'committed',
      head: this.agent ? 'cs/x' : 'main',
      before: PROJECT.head,
      hash: 'b'.repeat(64),
      op: { id: 'op', seq: 2, kind: 'apply' },
      resolved: [],
      created: ['O2'],
      removed: [],
      changeset: this.agent ? { id: 'cs-1', name: 'Claude', status: 'pending', base: PROJECT.head, head: 'b'.repeat(64), ops: 1 } : null,
    });
  }
  propose(projectId: string, input: { name: string }) {
    this.record('propose', projectId, input);
    return Promise.resolve({ changeset: { id: 'cs-1', name: input.name, status: 'pending' as const, base: PROJECT.head, head: PROJECT.head, ops: 0 }, applied: null });
  }
  changesets() {
    return Promise.resolve([]);
  }
  accept(projectId: string, changesetId: string) {
    this.record('accept', projectId, changesetId);
    return Promise.reject(new FloorspecApiError(403, { error: 'an agent cannot accept or reject a changeset: a person does (FLR-ADR-016)' }));
  }
  reject(projectId: string, changesetId: string) {
    this.record('reject', projectId, changesetId);
    return Promise.resolve({ changeset: { id: changesetId, name: 'x', status: 'rejected' as const, base: '', head: null, ops: 0 } });
  }
  validate() {
    return Promise.resolve({ head: 'main', hash: PROJECT.head, valid: true, diagnostics: [] });
  }
  findings() {
    return Promise.resolve({ head: 'main', hash: PROJECT.head, findings: [], rulePacks: [], note: 'No rule packs are installed yet.' });
  }
  render(projectId: string, options: RenderOptions) {
    this.record('render', projectId, options);
    if (options.view === '3d') return Promise.reject(new FloorspecApiError(501, { error: '3D rendering is not available yet' }));
    if (!this.renderable) return Promise.reject(new FloorspecApiError(501, { error: 'rendering arrives with FLR-T-2.8' }));
    return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
}

async function connect(client: FloorspecClient, era: 'legacy' | 'modern' = 'modern') {
  const handler = createFloorspecMcpHandler(() => client);
  const fetchLike = (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init));
  const mcp = new Client({ name: 'test', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://floorspec.test/mcp'), { fetch: fetchLike }));
  return mcp;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string; uri?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

describe('the MCP server', () => {
  for (const era of ['legacy', 'modern'] as const) {
    it(`lists exactly the ten verbs to a ${era} client`, async () => {
      const mcp = await connect(new MemoryClient(), era);
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });
  }

  it('advertises the Floorspec Ops union as the batch item schema, with exactly each op\'s members', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    for (const name of ['floorspec_apply', 'floorspec_propose']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as unknown as { properties: { batch: { items: { oneOf: { properties: { op: { const: string } }; additionalProperties: boolean }[] } } } };
      const variants = schema.properties.batch.items.oneOf;
      expect(variants.map((v) => v.properties.op.const).sort()).toEqual([...OP_NAMES].sort());
      expect(variants.every((v) => !v.additionalProperties)).toBe(true);
    }
    expect(OP_NAMES).toEqual(expect.arrayContaining(['resizeRoom', 'addOpening', 'drawWall', 'moveWall', 'removeWall', 'setProperty']));
  });

  /**
   * FLR-REQ-058: no tool runs code. Every input property, at every depth, is checked: none is named
   * like a place for code, and no tool's name or description offers to run, evaluate or execute
   * anything. Op values (`setProperty.value`) are data, and are named as such.
   */
  it('has no code-execution tool', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    const CODE = /^(code|script|source|program|eval|exec|execute|expression|function_body|javascript|js|python|sql|shell|command|cmd|lambda|snippet)$/i;
    const offers = /\b(run|execute|evaluate|eval)\b[^.]*\b(code|script|javascript|python|program|command)\b/i;
    const names: string[] = [];
    const walk = (schema: unknown, path: string) => {
      if (Array.isArray(schema)) schema.forEach((s, i) => { walk(s, `${path}[${String(i)}]`); });
      else if (schema !== null && typeof schema === 'object') {
        const record = schema as Record<string, unknown>;
        if (record['properties'] !== undefined && typeof record['properties'] === 'object') {
          for (const [key, inner] of Object.entries(record['properties'] as Record<string, unknown>)) {
            names.push(`${path}.${key}`);
            expect(key, `${path}.${key}`).not.toMatch(CODE);
            walk(inner, `${path}.${key}`);
          }
        }
        for (const [key, inner] of Object.entries(record)) if (key !== 'properties') walk(inner, path);
      }
    };
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/exec|eval|run|script|code|shell/i);
      expect(`${tool.title ?? ''} ${tool.description ?? ''}`, tool.name).not.toMatch(offers);
      walk(tool.inputSchema, tool.name);
    }
    expect(names.length).toBeGreaterThan(50);
  });

  it('describes with the room-centric summary, and says which head it read', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = texts(result);
    expect(text).toContain('Lake house');
    expect(text).toContain('(main)');
    expect(text).toContain('Kitchen');
    expect(result.structuredContent).toMatchObject({ project: PROJECT.id, hash: PROJECT.head, summary: { valid: true } });
  });

  it('describes one room by its name as well as its ID, and refuses an unknown room or level with a hint', async () => {
    const mcp = await connect(new MemoryClient());
    const byName = await mcp.callTool({ name: 'floorspec_describe', arguments: { room: 'kitchen' } });
    expect(byName.isError, texts(byName)).toBeFalsy();
    expect(texts(byName)).toContain('Kitchen');
    const byId = await mcp.callTool({ name: 'floorspec_describe', arguments: { room: 'R1' } });
    expect(texts(byId)).toBe(texts(byName));
    const missing = await mcp.callTool({ name: 'floorspec_describe', arguments: { room: 'Ballroom' } });
    expect(missing.isError).toBe(true);
    expect(texts(missing)).toContain('No room is called "Ballroom"');
    const level = await mcp.callTool({ name: 'floorspec_describe', arguments: { level: 'L9' } });
    expect(level.isError).toBe(true);
    expect(texts(level)).toContain('There is no level "L9"');
  });

  it('queries the walls bounding a room, with lengths in feet-inches and base units', async () => {
    const mcp = await connect(new MemoryClient());
    const result = await mcp.callTool({ name: 'floorspec_query', arguments: { room: 'kitchen', kind: 'walls' } });
    const structured = result.structuredContent as { count: number; elements: { id: string; length: { units: number; ftIn: string }; direction: string; rooms: string[] }[] };
    expect(structured.elements.map((e) => e.id)).toEqual(['W1', 'W2', 'W3', 'W4']);
    const north = structured.elements.find((e) => e.id === 'W2');
    expect(north).toMatchObject({ direction: 'east', rooms: ['R1'], length: { units: 5120000, ftIn: formatFeetInches(5120000) } });
    const openings = await mcp.callTool({ name: 'floorspec_query', arguments: { wall: 'W3' } });
    const hosted = (openings.structuredContent as { elements: { id: string; width: { ftIn: string } }[] }).elements;
    expect(hosted.map((e) => e.id)).toEqual(['O1']);
    expect(hosted[0]?.width.ftIn).toBe(`3' 0"`);
  });

  it('applies a typed batch, says where it landed, and refuses an op the standard does not define before calling the API', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const ok = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'addOpening', wall: 'east wall of Kitchen', at: 'centered', width: '36"' }] },
    });
    expect(ok.isError).toBeFalsy();
    expect(texts(ok)).toContain('Committed to main');

    client.agent = true;
    const proposed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" }] } });
    expect(texts(proposed)).toContain('It is pending: main has not changed until a person accepts it');

    const before = client.calls.filter((c) => c.method === 'apply').length;
    const bad = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'runScript', code: 'rm -rf /' }] } });
    expect(bad.isError).toBe(true);
    const extra = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'removeElement', id: 'W1', also: 1 }] } });
    expect(extra.isError).toBe(true);
    expect(client.calls.filter((c) => c.method === 'apply').length).toBe(before);
  });

  it('returns a rejection as an error carrying the diagnostics', async () => {
    const mcp = await connect(new MemoryClient());
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'removeElement', id: 'W99' }] } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain('Rejected: nothing changed.');
    expect(texts(result)).toContain('FS-OPS-003');
  });

  it('renders with the created elements highlighted, and says so when it could not look', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const without = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'removeElement', id: 'W1' }], render: true } });
    expect(texts(without)).toContain('You have not seen the result');
    client.renderable = true;
    const withPng = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'removeElement', id: 'W1' }], render: true } });
    expect((withPng.content as Content[]).some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toMatchObject({ view: 'plan', highlight: ['O2'] });
    const threeD = await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d' } });
    expect(threeD.isError).toBe(true);
    expect(texts(threeD)).toContain('not available yet');
  });

  it('relays a refused accept as an error', async () => {
    const mcp = await connect(new MemoryClient());
    const result = await mcp.callTool({ name: 'floorspec_accept', arguments: { changeset: 'cs-1' } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain('FLR-ADR-016');
  });

  it('exports canonical JSON as a resource, and reads it as one', async () => {
    const mcp = await connect(new MemoryClient());
    const result = await mcp.callTool({ name: 'floorspec_export', arguments: {} });
    const content = result.content as Content[];
    expect(content.find((c) => c.type === 'resource_link')?.uri).toBe(`floorspec://${PROJECT.id}/model`);
    const read = await mcp.readResource({ uri: `floorspec://${PROJECT.id}/model` });
    expect(read.contents[0]).toMatchObject({ mimeType: 'application/json' });
  });

  it('offers the design partner prompt, the same text the plugin skill carries', async () => {
    const mcp = await connect(new MemoryClient());
    const prompt = await mcp.getPrompt({ name: 'design-partner' });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text', text: DESIGN_PARTNER_PROMPT });
    const skill = readFileSync(join(import.meta.dirname, '../../../plugin/skills/floorspec-design-partner/SKILL.md'), 'utf8');
    expect(skill.replace(/\r\n/g, '\n')).toContain(DESIGN_PARTNER_PROMPT);
  });
});

describe('feet and inches', () => {
  it('prints exact sixteenths and rounds the rest once', () => {
    expect(formatFeetInches(390144)).toBe(`1' 0"`);
    expect(formatFeetInches(390144 * 12 + 32512 * 6 + 16256)).toBe(`12' 6 1/2"`);
    expect(formatFeetInches(32512 * 3 / 4)).toBe(`3/4"`);
    expect(formatFeetInches(-390144 * 2)).toBe(`-2' 0"`);
    expect(formatFeetInches(0)).toBe(`0"`);
  });
});
