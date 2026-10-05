import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it } from 'vitest';
import { ROOM_FUNCTIONS } from '../src/vocabulary.js';
import {
  createFloorspecMcpHandler,
  DESIGN_PARTNER_PROMPT,
  FloorspecApiError,
  formatFeetInches,
  OP_NAMES,
  TOOL_NAMES,
  type Committed,
  type FloorspecClient,
  type LayoutsInput,
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
const CHANGESET = { id: '01a10000-0000-7000-8000-0000000000c5', name: 'Widen the kitchen', status: 'pending' as const, base: PROJECT.head, head: 'c'.repeat(64), ops: 1 };

/** A client that answers from memory and records what the tools asked of it. */
class MemoryClient implements FloorspecClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  agent = false;
  renderable = false;
  /** The next apply is refused with these diagnostics. */
  rejectNext: { code: string; severity: 'error'; message: string; elements: string[] }[] | null = null;

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
    if (this.rejectNext !== null) {
      const diagnostics = this.rejectNext;
      this.rejectNext = null;
      return Promise.reject(new FloorspecApiError(422, { type: '/problems/ops-rejected', error: 'the batch was rejected and nothing changed', diagnostics }));
    }
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
  changesets(projectId: string) {
    this.record('changesets', projectId);
    return Promise.resolve([CHANGESET]);
  }
  accept(projectId: string, changesetId: string) {
    this.record('accept', projectId, changesetId);
    return Promise.reject(new FloorspecApiError(403, { error: 'an agent cannot accept or reject a changeset: a person does (FLR-ADR-016)' }));
  }
  /** The next layouts call is answered as a project with no brief is. */
  noBrief = false;
  proposeLayouts(projectId: string, input: LayoutsInput) {
    this.record('proposeLayouts', projectId, input);
    if (this.noBrief) {
      return Promise.reject(
        new FloorspecApiError(422, { type: '/problems/layout-unsolvable', error: 'no layout could be made from this brief', detail: 'There is no program to lay out.' }),
      );
    }
    const candidate = (rank: number, total: number, label: string) => ({
      rank,
      label,
      level: 'L1',
      footprint: { width: 13_655_040, depth: 10_924_032 },
      score: { total, briefFit: 0.951, circulation: 1, findings: 1 },
      explanation: ['required Kitchen – Living room: adjacent', 'engine findings: none'],
      unplaced: rank === 3 ? [{ item: 'GAR', count: 1, reason: 'exterior spaces are not laid out' }] : [],
      changeset: { id: `cs-${String(rank)}`, name: `Layout ${String(rank)} of 3 (${total.toFixed(1)}): ${label}`, status: 'pending' as const, base: PROJECT.head, head: 'd'.repeat(64), ops: 1 },
      reused: rank === 2,
    });
    return Promise.resolve({
      solved: { main: PROJECT.head, items: 4, adjacencies: 3 },
      candidates: [candidate(1, 97.56, 'Bedroom wing along a hall'), candidate(2, 97.23, 'Compact, no hall'), candidate(3, 96.88, 'Split bedrooms')],
    });
  }
  proposeElectrical(projectId: string, input: { rooms?: readonly string[] }) {
    this.record('proposeElectrical', projectId, input);
    return Promise.resolve({
      main: PROJECT.head,
      changeset: { id: 'cs-e', name: 'Electrical layout: Kitchen', status: 'pending' as const, base: PROJECT.head, head: 'e'.repeat(64), ops: 1 },
      proposal: {
        name: 'Electrical layout: Kitchen',
        explanation: ['Proposes 6 receptacles, 1 switch, 1 light for Kitchen.', 'These are layout defaults, not a code check: advisory code findings, with their citations, arrive with the Floorspec Rules packs.'],
        added: { receptacles: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'], switches: ['X8'], lights: ['X7'] },
        circuits: [],
        notes: ['There is no panel, so no circuits are proposed: place one and ask again.'],
        ops: 9,
      },
    });
  }
  reject(projectId: string, changesetId: string) {
    this.record('reject', projectId, changesetId);
    return Promise.resolve({ changeset: { id: changesetId, name: 'x', status: 'rejected' as const, base: '', head: null, ops: 0 } });
  }
  validate(projectId: string, changeset?: string) {
    this.record('validate', projectId, changeset);
    return Promise.resolve({ head: 'main', hash: PROJECT.head, valid: true, diagnostics: [] });
  }
  findings(projectId: string, changeset?: string) {
    this.record('findings', projectId, changeset);
    return Promise.resolve({
      head: 'main',
      hash: PROJECT.head,
      findings: [],
      rulePacks: [],
      note: 'Nothing was checked: no rule pack is installed on this server yet.',
      notice: 'Floorspec findings are advisory. They are not a plan review, and the authority having jurisdiction decides.',
      profile: 'Model Codes (latest)',
      profileId: null,
      coverageUrl: 'https://floorspec.example.test/rule-packs',
    });
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
    it(`lists exactly the eleven verbs to a ${era} client`, async () => {
      const mcp = await connect(new MemoryClient(), era);
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });
  }

  it('advertises the Floorspec Ops union once, under apply\'s $defs, with exactly each op\'s members', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    type Variant = { properties: { op: { const: string } }; additionalProperties: boolean };
    type Schema = { properties: { batch: { items: { $ref: string } } }; $defs: Record<string, { type?: string; oneOf?: Variant[]; properties?: { op: { enum: string[] } } }> };
    const apply = tools.find((t) => t.name === 'floorspec_apply')?.inputSchema as unknown as Schema;
    expect(apply.properties.batch.items.$ref).toBe('#/$defs/Op');
    const variants = apply.$defs['Op']?.oneOf ?? [];
    expect(apply.$defs['Op']?.type).toBe('object');
    expect(variants.map((v) => v.properties.op.const).sort()).toEqual([...OP_NAMES].sort());
    expect(variants.every((v) => !v.additionalProperties && 'additionalProperties' in v)).toBe(true);
    expect(OP_NAMES).toEqual(expect.arrayContaining(['resizeRoom', 'addOpening', 'drawWall', 'moveWall', 'removeWall', 'setProperty', 'moveOpening', 'addLevel']));
    // Propose names the same operations and leaves their members to apply's schema.
    const propose = tools.find((t) => t.name === 'floorspec_propose')?.inputSchema as unknown as Schema;
    expect(propose.properties.batch.items.$ref).toBe('#/$defs/Op');
    expect(propose.$defs['Op']?.properties?.op.enum).toEqual([...OP_NAMES]);
    expect(JSON.stringify(propose)).not.toContain('"Length"');
  });

  it('says, with every findings answer, that findings are not a plan review, and where the pack coverage is (FLR-REQ-105, 096)', async () => {
    const mcp = await connect(new MemoryClient());
    const said = texts(await mcp.callTool({ name: 'floorspec_findings', arguments: {} }));
    expect(said).toContain('0 finding(s). Nothing was checked');
    expect(said).toContain('Profile: Model Codes (latest).');
    expect(said).toContain('They are not a plan review, and the authority having jurisdiction decides.');
    expect(said).toContain('What the installed packs check, and do not: https://floorspec.example.test/rule-packs');
    expect(said).not.toMatch(/\bcomplian|\bcomplies\b|passes code/i);
  });

  it('lays out the brief as candidate changesets, through the API, and reports each one', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_propose_layouts', arguments: { count: 3, footprint: { width: "44'", depth: 9_000_000 } } });
    expect(result.isError ?? false, texts(result)).toBe(false);
    expect(client.calls.at(-1)).toEqual({ method: 'proposeLayouts', args: [PROJECT.id, { count: 3, footprint: { width: "44'", depth: 9_000_000 } }] });
    const said = texts(result);
    expect(said).toContain('3 layout candidates from 4 brief items and 3 adjacencies, each a pending changeset');
    expect(said).toContain('1. "Layout 1 of 3 (97.6): Bedroom wing along a hall" (cs-1): score 97.6 — brief fit 95%, circulation 100%, findings 100%.');
    expect(said).toContain('(cs-2), already open');
    expect(said).toContain('   - required Kitchen – Living room: adjacent');
    expect(said).toContain('not placed here: GAR x1 (exterior spaces are not laid out)');
    expect(result.structuredContent).toMatchObject({ project: PROJECT.id, solved: { items: 4 }, candidates: [{ rank: 1 }, { rank: 2 }, { rank: 3 }] });

    // Nothing to lay out: the API's reason, as a tool error.
    client.noBrief = true;
    const refused = await mcp.callTool({ name: 'floorspec_propose_layouts', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(texts(refused)).toContain('no layout could be made from this brief: There is no program to lay out.');
    // The schema holds the count to what the API takes.
    const { tools } = await mcp.listTools();
    const check = new AjvJsonSchemaValidator().getValidator(tools.find((t) => t.name === 'floorspec_propose_layouts')?.inputSchema as never);
    expect(check({ count: 3 }).valid).toBe(true);
    expect(check({ count: 40 }).valid).toBe(false);
    expect(check({ code: 'x' }).valid).toBe(false);
  });

  it('lets the electrical assistant propose a changeset, and says it is advice', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_propose', arguments: { assistant: 'electrical', rooms: ['Kitchen'] } });
    expect(result.isError, texts(result)).toBeFalsy();
    expect(client.calls.at(-1)).toEqual({ method: 'proposeElectrical', args: [PROJECT.id, { rooms: ['Kitchen'] }] });
    const said = texts(result);
    expect(said).toContain('Changeset "Electrical layout: Kitchen" (cs-e) is pending: 9 operations from the electrical assistant. Main has not changed until a person accepts it.');
    expect(said).toContain('- These are layout defaults, not a code check');
    // A batch and an assistant together, or neither a name nor an assistant, is refused before the API.
    const both = await mcp.callTool({ name: 'floorspec_propose', arguments: { assistant: 'electrical', batch: [] } });
    expect(both.isError).toBe(true);
    const unnamed = await mcp.callTool({ name: 'floorspec_propose', arguments: {} });
    expect(texts(unnamed)).toContain('Name the changeset');
  });

  it('keeps tools/list within its budget', async () => {
    const mcp = await connect(new MemoryClient());
    const listing = await mcp.listTools();
    const size = JSON.stringify(listing).length;
    process.stderr.write(`tools/list: ${String(size)} bytes (${String(JSON.stringify(listing, null, 2).length)} pretty-printed)\n`);
    // Was ~57 KB (130 KB pretty) with the operation union inlined at every member, twice over.
    expect(size).toBeLessThan(25_000);
  });

  it('advertises a schema that accepts and refuses what the tool does', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    const ajv = new AjvJsonSchemaValidator();
    const cases: { batch: unknown[]; ok: boolean }[] = [
      { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" }], ok: true },
      { batch: [{ op: 'addOpening', wall: 'east wall of Kitchen', at: 'centered', width: 1170432, height: '6\' 8"' }], ok: true },
      { batch: [{ op: 'setProperty', id: '$project', path: '/name', value: { any: ['json', 1, null] } }], ok: true },
      { batch: [{ op: 'moveOpening', opening: 'O1', by: "1'", toward: 'east' }], ok: true },
      { batch: [{ op: 'addLevel', building: 'B1', below: 'L1', height: "8'" }], ok: true },
      { batch: [{ op: 'drawWall', level: 'L1', from: [0, 0], to: "12' east of J4", justification: 'center' }], ok: true },
      { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'up', by: "2'" }], ok: false },
      { batch: [{ op: 'removeElement', id: 'W1', also: 1 }], ok: false },
      { batch: [{ op: 'runScript', code: 'rm -rf /' }], ok: false },
      { batch: [{ op: 'drawWall', level: 'L1', from: [0], to: 'J2' }], ok: false },
      { batch: [{ op: 'setProperty', id: 'R1', path: 'name', value: 1 }], ok: false },
      { batch: ['resizeRoom'], ok: false },
      { batch: [], ok: false },
    ];
    const check = ajv.getValidator(tools.find((t) => t.name === 'floorspec_apply')?.inputSchema as never);
    for (const { batch, ok } of cases) {
      expect(check({ batch }).valid, JSON.stringify(batch)).toBe(ok);
      const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch } });
      expect(result.isError ?? false, JSON.stringify(batch)).toBe(!ok);
    }
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
    const result = await mcp.callTool({ name: 'floorspec_accept', arguments: { changeset: CHANGESET.id } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain('FLR-ADR-016');
  });

  it('takes a pending changeset by name or ID on every tool that reads or decides one', async () => {
    const client = new MemoryClient();
    client.renderable = true;
    const mcp = await connect(client);
    const { tools } = await mcp.listTools();
    const reads = ['floorspec_describe', 'floorspec_query', 'floorspec_validate', 'floorspec_findings', 'floorspec_render', 'floorspec_export'];
    for (const name of [...reads, 'floorspec_accept', 'floorspec_reject', 'floorspec_apply']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as unknown as { properties: { changeset: { description: string } } };
      expect(schema.properties.changeset.description, name).toMatch(/name or ID/);
    }
    // What each tool hands the API for the changeset it was given.
    const sent = (tool: string): unknown => {
      const call = client.calls.filter((c) => c.method !== 'listProjects' && c.method !== 'changesets').at(-1);
      return tool === 'floorspec_render' ? (call?.args[1] as RenderOptions).changeset : call?.args[1];
    };
    for (const handle of [CHANGESET.name, CHANGESET.id, CHANGESET.name.toUpperCase()]) {
      for (const tool of reads) {
        const result = await mcp.callTool({ name: tool, arguments: { changeset: handle } });
        expect(result.isError ?? false, `${tool} ${handle}: ${texts(result)}`).toBe(false);
        expect(sent(tool), `${tool} ${handle}`).toBe(CHANGESET.id);
      }
      await mcp.callTool({ name: 'floorspec_reject', arguments: { changeset: handle } });
      expect(sent('floorspec_reject')).toBe(CHANGESET.id);
      const accept = await mcp.callTool({ name: 'floorspec_accept', arguments: { changeset: handle } });
      expect(texts(accept)).toContain('FLR-ADR-016');
      expect(sent('floorspec_accept')).toBe(CHANGESET.id);
    }
    const described = await mcp.callTool({ name: 'floorspec_describe', arguments: { changeset: CHANGESET.name } });
    expect(texts(described)).toContain(`(changeset "${CHANGESET.name}" ${CHANGESET.id}, pending)`);
    expect(described.structuredContent).toMatchObject({ changeset: CHANGESET.id });

    // A name no pending changeset has is refused before anything else is read, naming the ones there are.
    const before = client.calls.length;
    const missing = await mcp.callTool({ name: 'floorspec_validate', arguments: { changeset: 'Widen the bath' } });
    expect(missing.isError).toBe(true);
    expect(texts(missing)).toContain('No pending changeset is named "Widen the bath". Pending: "Widen the kitchen"');
    expect(client.calls.slice(before).map((c) => c.method)).toEqual(['listProjects', 'changesets']);
  });

  describe('a rejection that teaches', () => {
    const reject = async (diagnostics: { code: string; message: string; elements?: string[] }[], batch: unknown[]) => {
      const client = new MemoryClient();
      client.rejectNext = diagnostics.map((d) => ({ severity: 'error' as const, elements: [], ...d }));
      const mcp = await connect(client);
      return mcp.callTool({ name: 'floorspec_apply', arguments: { batch } });
    };
    const hints = (result: { content?: unknown }) => texts(result).split('\n').filter((l) => l.startsWith('Hint: '));

    it('says a cased opening needs a height, and keeps the coded diagnostic as it was', async () => {
      const diagnostic = { code: 'FS-INV-301', message: "O1's height does not resolve: neither the opening nor its fill gives it.", elements: ['O1'] };
      const result = await reject([diagnostic], [{ op: 'addOpening', wall: 'W1', at: 'centered', width: '36"' }]);
      expect(result.isError).toBe(true);
      expect(texts(result)).toContain("- FS-INV-301 error: O1's height does not resolve");
      expect(hints(result)).toEqual([`Hint: An opening without a fill type needs \`height\` — door height is usually 6' 8" (a cased opening 6' 8" to 7' 0").`]);
      expect(result.structuredContent).toMatchObject({ status: 422, diagnostics: [{ ...diagnostic, severity: 'error' }] });
      expect(JSON.stringify(result.structuredContent)).not.toContain('Hint');
    });

    it('lists the room functions when one is not a Core term', async () => {
      const result = await reject(
        [
          { code: 'FS-SCH-001', message: '/rooms/R1/function: must be equal to one of the allowed values' },
          { code: 'FS-SCH-001', message: '/rooms/R1/function: must match pattern "^(FS|EXT|[A-Z0-9]{2,8})_[A-Za-z0-9]+:[a-z][A-Za-z0-9]*$"' },
        ],
        [{ op: 'addRoom', level: 'L1', at: 'J1', function: 'study' }],
      );
      const [hint] = hints(result);
      expect(hints(result)).toHaveLength(1);
      for (const term of ROOM_FUNCTIONS) expect(hint).toContain(term);
      expect(hint).toContain('study → office');
    });

    it('says a selector after a drawWall must wait for the next batch', async () => {
      const result = await reject(
        [{ code: 'FS-OPS-007', message: 'level L1 has no faces to read: junction J9 lies inside W3 (Core 5.3.2)', elements: ['L1'] }],
        [
          { op: 'drawWall', level: 'L1', from: 'J1', to: 'J3' },
          { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" },
        ],
      );
      expect(hints(result)).toEqual(['Hint: Walls drawn in this batch join the plan when the batch ends; apply this operation in a second batch.']);
    });

    it('gives no hint for a rejection it has nothing to add to', async () => {
      const result = await reject([{ code: 'FS-OPS-003', message: 'W99 does not exist.' }], [{ op: 'removeElement', id: 'W99' }]);
      expect(hints(result)).toEqual([]);
      const noLevel = await reject([{ code: 'FS-OPS-007', message: 'level L9 has no faces to read: there is no level L9' }], [{ op: 'drawWall', level: 'L9', from: 'J1', to: 'J2' }]);
      expect(hints(noLevel)).toEqual([]);
    });
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
