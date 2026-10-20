import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it } from 'vitest';
import type { DaylightStudy } from '@floorspec/analysis';
import { ROOM_FUNCTIONS } from '../src/vocabulary.js';
import {
  createFloorspecMcpHandler,
  CRITIQUE_CATEGORIES,
  critiquePrompt,
  daylightUri,
  DESIGN_PARTNER_PROMPT,
  FloorspecApiError,
  GUIDE_URI,
  parseFocus,
  formatFeetInches,
  OP_NAMES,
  TOOL_NAMES,
  type Committed,
  type AssetUpload,
  type FilmJob,
  type FilmRequest,
  type FloorspecClient,
  type StoredAsset,
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
  createProject(name: string) {
    this.record('createProject', name);
    return Promise.resolve({ id: '01a10000-0000-7000-8000-000000000002', name, head: 'b'.repeat(64) });
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
  proposeStaging(projectId: string, input: { rooms?: readonly string[] }) {
    this.record('proposeStaging', projectId, input);
    return Promise.resolve({
      main: PROJECT.head,
      changeset: { id: 'cs-s', name: 'Staging: Great room', status: 'pending' as const, base: PROJECT.head, head: 's'.repeat(64), ops: 1 },
      proposal: {
        name: 'Staging: Great room',
        explanation: ['Stages Great room with 2 pieces of decor from the FS_furniture starter library (CC0).', 'Great room: a 3000 × 2000 mm rug under the seating group and a floor lamp beside the sofa.'],
        added: [
          { id: 'R7-RUG1', item: 'rug-3000x2000', room: 'R7', rule: 'under the seating group', with: 'GR-SOFA' },
          { id: 'R7-LAMP1', item: 'lamp-floor-1600', room: 'R7', rule: 'beside the sofa', with: 'GR-SOFA' },
        ],
        rooms: ['R7'],
        notes: [],
        ops: 6,
      },
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
    if (options.view === '3d' && options.room === 'Attic') return Promise.reject(new FloorspecApiError(422, { title: 'this 3D view cannot be drawn', detail: 'the model has no room Attic' }));
    if (!this.renderable) return Promise.reject(new FloorspecApiError(501, { error: 'rendering arrives with FLR-T-2.8' }));
    return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
  requestFilm(projectId: string, options: FilmRequest): Promise<FilmJob> {
    this.record('requestFilm', projectId, options);
    if (options.film === 'Garden') return Promise.reject(new FloorspecApiError(400, { error: 'the model has no film "Garden"; its films are "Courtyard walk-in"' }));
    const dusk = options.light === 'day-to-night';
    return Promise.resolve({ id: 'job-1', status: 'queued', film: { id: 'F1', name: 'Courtyard walk-in', frames: 900, fps: 30, size: '1080p', format: 'mp4', quality: options.quality ?? 'draft', light: options.light ?? 'timeline', timelapse: dusk ? { date: '2026-06-21', from: '16:30', to: '20:00' } : null } });
  }
  uploadAsset(projectId: string, upload: AssetUpload): Promise<StoredAsset> {
    this.record('uploadAsset', projectId, upload.name, upload.as);
    return Promise.reject(new FloorspecApiError(503, { title: 'this instance has no asset store' }));
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
    it(`lists exactly the twelve verbs to a ${era} client`, async () => {
      const mcp = await connect(new MemoryClient(), era);
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });
  }

  it('advertises the Floorspec Ops union once, under apply\'s $defs, with exactly each op\'s members', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    type Variant = { properties: { op: { const: string } }; additionalProperties?: boolean };
    type Union = { type?: string; oneOf?: Variant[]; properties?: { op: { enum: string[] } }; required?: string[]; unevaluatedProperties?: boolean };
    type Schema = { properties: { batch: { items: { $ref: string } } }; $defs: Record<string, Union> };
    const apply = tools.find((t) => t.name === 'floorspec_apply')?.inputSchema as unknown as Schema;
    expect(apply.properties.batch.items.$ref).toBe('#/$defs/Op');
    const variants = apply.$defs['Op']?.oneOf ?? [];
    expect(apply.$defs['Op']?.type).toBe('object');
    expect(variants.map((v) => v.properties.op.const).sort()).toEqual([...OP_NAMES].sort());
    // Each operation is closed: said once, on the union, which the matching operation's members alone satisfy.
    expect(apply.$defs['Op']).toMatchObject({ required: ['op'], unevaluatedProperties: false });
    expect(variants.every((v) => !('additionalProperties' in v))).toBe(true);
    expect(OP_NAMES).toEqual(expect.arrayContaining(['resizeRoom', 'addOpening', 'drawWall', 'moveWall', 'removeWall', 'setProperty', 'moveOpening', 'addLevel']));
    // Propose names the same operations and leaves their members to apply's schema.
    const propose = tools.find((t) => t.name === 'floorspec_propose')?.inputSchema as unknown as Schema;
    expect(propose.properties.batch.items.$ref).toBe('#/$defs/Op');
    expect(propose.$defs['Op']?.properties?.op.enum).toEqual([...OP_NAMES]);
    expect(JSON.stringify(propose)).not.toContain('"Length"');
  });

  it('creates a project through the API, and refuses a second of the same name', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const created = await mcp.callTool({ name: 'floorspec_create_project', arguments: { name: 'West house' } });
    expect(created.isError, texts(created)).toBeFalsy();
    expect(client.calls.find((c) => c.method === 'createProject')?.args).toEqual(['West house']);
    expect(created.structuredContent).toMatchObject({ name: 'West house' });
    const again = await mcp.callTool({ name: 'floorspec_create_project', arguments: { name: 'lake HOUSE' } });
    expect(again.isError).toBe(true);
    expect(texts(again)).toContain('already called "lake HOUSE"');
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

  it('lets the staging assistant dress a room as a changeset', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_propose', arguments: { assistant: 'staging', rooms: ['Great room'] } });
    expect(result.isError, texts(result)).toBeFalsy();
    expect(client.calls.at(-1)).toEqual({ method: 'proposeStaging', args: [PROJECT.id, { rooms: ['Great room'] }] });
    const said = texts(result);
    expect(said).toContain('Changeset "Staging: Great room" (cs-s) is pending: 2 pieces of decor from the staging assistant. Main has not changed until a person accepts it.');
    expect(said).toContain('- Great room: a 3000 × 2000 mm rug under the seating group');
    const both = await mcp.callTool({ name: 'floorspec_propose', arguments: { assistant: 'staging', batch: [] } });
    expect(both.isError).toBe(true);
  });

  it('keeps tools/list within its budget', async () => {
    const mcp = await connect(new MemoryClient());
    const listing = await mcp.listTools();
    const size = JSON.stringify(listing).length;
    process.stderr.write(`tools/list: ${String(size)} bytes (${String(JSON.stringify(listing, null, 2).length)} pretty-printed)\n`);
    // Was ~57 KB (130 KB pretty) with the operation union inlined at every member, twice over.
    // 25 KB → 26 KB for the twelfth verb, floorspec_create_project (~400 bytes). FLR-T-12.25 paid
    // for the furniture catalogue and an opening's `at` (its near edge) by trimming other text, and
    // FLR-T-12.22 for floorspec_render's `lights` the same way (FLR-T-13.12 folded it into `scene`), and FLR-T-13.8 for its `doors`, and
    // FLR-T-13.4 and 13.9 for its `sky` and `at` (the shared project and changeset handles shortened),
    // and FLR-T-13.11 for floorspec_propose's assistant "staging" (descriptions said shorter); FLR-T-18.3's `mode`, FLR-T-18.5's `style` and FLR-T-18.13's `renovation` are enums alone.
    // FLR-T-12.41 gave it room to grow, 25,992 → ~21,900, without moving the ceiling: the long
    // guidance moved to the design-partner prompt (and floorspec://guide), the project handle is said
    // once in the server's instructions, propose names apply's locks rather than repeating them, and
    // closed unions are said once (tool-schema.ts). The ~4 KB under the ceiling is for new params;
    // FLR-T-14.1's film, preset and quality on floorspec_render took ~250 bytes of it (~23,300);
    // FLR-T-14.4's `compare` ~130 more (~23,450); FLR-T-15.4's `season` and `weather` ~400 more.
    expect(size).toBeLessThan(26_000);
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
      { batch: [{ op: 'drawWall', level: 'L1', from: [0, 0], to: 'J2', name: 'Spine', extras: {} }], ok: true },
      { batch: [{ op: 'placeElement', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'W1', toward: 'Kitchen', at: 'centered', height: '12"' }, element: {} }], ok: true },
      { batch: [{ op: 'placeElement', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'W1', at: 'centered', height: '12"', level: 'L1' }, element: {} }], ok: false },
      { batch: [{ op: 'placeElement', extension: 'FS_electrical', collection: 'receptacles', host: { wall: 'W1', at: 'centered', height: '12"' }, element: {} }], ok: false },
      { batch: [{ op: 'moveRoom', room: 'Kitchen', by: [0, 0], side: 'east' }], ok: false },
      { batch: [{ room: 'Kitchen', side: 'east', by: "2'" }], ok: false },
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
    // A lock is exactly one of an element, a length or a distance, as the tool takes it.
    const batch = [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" }];
    for (const [locks, ok] of [
      [[{ element: 'W1' }, { length: 'W2' }, { distance: ['W1', 'W3'] }], true],
      [[{ element: 'W1', length: 'W2' }], false],
      [[{}], false],
      [[{ wall: 'W1' }], false],
      [[{ distance: ['W1'] }], false],
    ] as const) {
      expect(check({ batch, locks }).valid, JSON.stringify(locks)).toBe(ok);
      const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch, locks } });
      expect(result.isError ?? false, JSON.stringify(locks)).toBe(!ok);
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
    // FLR-T-8.5: 3D from a named view, or from inside a room — one property, a view's name or a room's.
    const threeD = await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'ne', level: 'L1' } });
    expect((threeD.content as Content[]).some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', camera: 'ne', level: 'L1' });
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'Kitchen' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', room: 'Kitchen' });
    // FLR-T-13.12: a lighting scene by name ("All on" and "Off" are FLR-T-12.22's lights on and off),
    // passed through for the api to resolve; `lights` is folded into it, and refused by the schema.
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'Kitchen', scene: 'Evening' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', room: 'Kitchen', scene: 'Evening' });
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', lights: 'on' } })).isError).toBe(true);
    // FLR-T-13.8: the doors closed or open, passed through.
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'sw', doors: 'open' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', camera: 'sw', doors: 'open' });
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', doors: 'ajar' } })).isError).toBe(true);
    // FLR-T-13.4, 13.9: a sky and a date and time at the site, passed through; a sky that is not a preset refused.
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'R17', sky: 'clear', at: '2026-06-21T19:30-04:00', scene: 'Off' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', room: 'R17', sky: 'clear', at: '2026-06-21T19:30-04:00', scene: 'Off' });
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', sky: 'sunny' } })).isError).toBe(true);
    // FLR-T-18.3: a plan in a trade's view.
    await mcp.callTool({ name: 'floorspec_render', arguments: { level: 'L1', mode: 'electrical' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: 'plan', level: 'L1', mode: 'electrical' });
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { mode: 'kitchen' } })).isError).toBe(true);
    // FLR-T-18.5: a plan style.
    await mcp.callTool({ name: 'floorspec_render', arguments: { style: 'presentation' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: 'plan', style: 'presentation' });
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { style: 'sepia' } })).isError).toBe(true);
    // FLR-T-13.10: a saved view by name in `view`, passed through for the api to resolve; it sets its own camera and sky.
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: 'Hero exterior', width: 640 } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', savedView: 'Hero exterior', width: 640 });
    const both = await mcp.callTool({ name: 'floorspec_render', arguments: { view: 'Hero exterior', camera: 'sw' } });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toMatch(/sets its own camera/);
    const missing = await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'Attic' } });
    expect(missing.isError).toBe(true);
    expect(texts(missing)).toContain('this 3D view cannot be drawn');
  });

  it('takes a season and a weather for the 3D model and a saved view, never for a plan (FLR-T-15.4)', async () => {
    const client = new MemoryClient();
    client.renderable = true;
    const mcp = await connect(client);
    const last = () => client.calls.filter((c) => c.method === 'render').at(-1)?.args[1];
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', camera: 'sw', season: 'autumn', weather: 'overcast' } });
    expect(last()).toEqual({ view: '3d', camera: 'sw', season: 'autumn', weather: 'overcast' });
    // The board's own example: a saved view in autumn under an overcast sky — the view's camera kept.
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: 'hero', season: 'autumn', weather: 'overcast' } });
    expect(last()).toEqual({ view: '3d', savedView: 'hero', season: 'autumn', weather: 'overcast' });
    await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', season: 'winter', weather: 'snow', at: '2026-01-15T13:00' } });
    expect(last()).toEqual({ view: '3d', season: 'winter', weather: 'snow', at: '2026-01-15T13:00' });
    const calls = client.calls.length;
    const plan = await mcp.callTool({ name: 'floorspec_render', arguments: { level: 'L1', season: 'winter' } });
    expect(plan.isError).toBe(true);
    expect(texts(plan)).toContain('how the house is seen in 3D');
    expect(client.calls.filter((c) => c.method === 'render').length).toBe(client.calls.slice(0, calls).filter((c) => c.method === 'render').length);
    for (const bad of [{ view: '3d', season: 'fall' }, { view: '3d', weather: 'hail' }]) expect((await mcp.callTool({ name: 'floorspec_render', arguments: bad })).isError).toBe(true);
    // A film takes them too.
    await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'F1', season: 'winter', weather: 'snow' } });
    expect(client.calls.filter((c) => c.method === 'requestFilm').at(-1)?.args[1]).toEqual({ film: 'F1', season: 'winter', weather: 'snow' });
  });

  it('queues a film by name — draft or final, day to night — and says where it lands without waiting (FLR-T-14.1)', async () => {
    const client = new MemoryClient();
    const mcp = await connect(client);
    const queued = await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'Courtyard walk-in', preset: 'day-to-night' } });
    expect(queued.isError).toBeFalsy();
    expect(client.calls.filter((c) => c.method === 'requestFilm').at(-1)?.args[1]).toEqual({ film: 'Courtyard walk-in', light: 'day-to-night' });
    expect(texts(queued)).toContain('Queued the film "Courtyard walk-in": 900 frames, 1080p at 30 fps, draft, MP4, day to night 16:30–20:00 on 2026-06-21.');
    expect(texts(queued)).toContain('/exports/job-1/file');
    expect(client.calls.some((c) => c.method === 'render')).toBe(false);
    await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'F1', quality: 'final' } });
    expect(client.calls.filter((c) => c.method === 'requestFilm').at(-1)?.args[1]).toEqual({ film: 'F1', quality: 'final' });
    // A film is its keyframes' views, from main: nothing else goes with it; and its preset needs a film.
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'F1', camera: 'sw' } })).isError).toBe(true);
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { view: '3d', preset: 'day-to-night' } })).isError).toBe(true);
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'F1', preset: 'sunrise' } })).isError).toBe(true);
    const unknown = await mcp.callTool({ name: 'floorspec_render', arguments: { film: 'Garden' } });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)).toContain('no film "Garden"');
  });

  it('compares a changeset with main in 3D, side by side from one camera (FLR-T-14.4)', async () => {
    const client = new MemoryClient();
    client.renderable = true;
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'main', camera: 'ne' } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Content[];
    expect(content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(texts(result)).toContain('Left: main as it is now. Right: the changeset');
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', compare: 'main', camera: 'ne', changeset: CHANGESET.id });
    // A room to stand in, and a cutaway, go with it.
    await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'main', camera: 'Kitchen', level: 'L1' } });
    expect(client.calls.filter((c) => c.method === 'render').at(-1)?.args[1]).toEqual({ view: '3d', compare: 'main', room: 'Kitchen', level: 'L1', changeset: CHANGESET.id });
    // Main against itself is nothing: a changeset is named. A saved view, a plan or a scene is not a comparison's.
    const none = await mcp.callTool({ name: 'floorspec_render', arguments: { compare: 'main' } });
    expect(none.isError).toBe(true);
    expect(texts(none)).toContain('name the changeset');
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'main', view: 'Hero exterior' } })).isError).toBe(true);
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'main', view: 'plan' } })).isError).toBe(true);
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'main', scene: 'Evening' } })).isError).toBe(true);
    expect((await mcp.callTool({ name: 'floorspec_render', arguments: { changeset: CHANGESET.id, compare: 'version' } })).isError).toBe(true);
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

  it('offers the advisory energy estimate as a resource, never as a verdict (FLR-REQ-153)', async () => {
    const mcp = await connect(new MemoryClient());
    const listed = await mcp.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain(`floorspec://${PROJECT.id}/energy`);
    const read = await mcp.readResource({ uri: `floorspec://${PROJECT.id}/energy` });
    const body = (read.contents[0] as { text: string }).text;
    expect(body).toContain('An estimate to compare options — not an energy-code calculation.');
    expect(body).toMatch(/Design loads: heating [\d.,]+–[\d.,]+ kBtu\/h/);
    expect(body).not.toMatch(/complian/i);
  });

  it('offers daylight at a date and time as a resource: rooms in four bands, glare at desks and beds, advisory (FLR-T-14.7)', async () => {
    const client = new MemoryClient();
    const asked: { project: string; at: string }[] = [];
    const study: DaylightStudy = {
      at: '2026-12-21T15:00',
      offset: -300,
      sky: 'clear',
      sun: { azimuth: 216, altitude: 23 },
      site: { latitude: 33.7, longitude: -84.4, assumed: false },
      outside: { sky: 12_000, sun: 27_000 },
      workPlane: 0.762,
      spacing: 0.3048,
      samples: 64,
      levels: [],
      rooms: [{ id: 'R6', name: 'Den', level: 'L1', cells: 90, median: 441, mean: 800, shares: { bright: 0.06, useful: 0.6, lamp: 0.29, dim: 0.05 }, sunToday: 9.8, sunYear: 3403 }],
      glare: [{ id: 'DEN-DESK', name: 'Desk', kind: 'desk', room: 'R6', roomName: 'Den', level: 'L1', at: [1, 1], z: 0.75, hours: [{ from: 960, to: 980 }], now: false, low: true }],
      advisory: 'Advisory, not a compliance check.',
      ms: 1,
    };
    Object.assign(client, { daylight: (project: string, options: { at: string }) => { asked.push({ project, at: options.at }); return Promise.resolve(study); } });
    const mcp = await connect(client);
    const { resourceTemplates } = await mcp.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('floorspec://{project}/daylight{?at}');
    const read = await mcp.readResource({ uri: daylightUri(PROJECT.id, '2026-12-21T15:00-05:00') });
    const body = (read.contents[0] as { text: string }).text;
    expect(asked).toEqual([{ project: PROJECT.id, at: '2026-12-21T15:00-05:00' }]);
    expect(body).toContain('Advisory, not a compliance check.');
    expect(body).toContain('Den (R6, L1): median 441 lx');
    expect(body).toContain('Glare: Desk (DEN-DESK, Den) — low sun 4:00–4:20 pm');
    expect(body).not.toMatch(/\bcompliant\b/i);
  });

  it('advertises every parameter the tools take, so a client that caches the listing can send them', async () => {
    const mcp = await connect(new MemoryClient());
    const { tools } = await mcp.listTools();
    const params = (name: string) => tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
    // floorspec_render: every RenderOptions member but view's default, a room (camera) and lights (scene) — and a film (FLR-T-14.1).
    expect(Object.keys(params('floorspec_render')).sort()).toEqual(['at', 'camera', 'changeset', 'compare', 'doors', 'film', 'highlight', 'level', 'mode', 'preset', 'project', 'quality', 'renovation', 'scene', 'season', 'sky', 'style', 'view', 'weather', 'width']);
    expect(params('floorspec_render')['season']).toMatchObject({ enum: ['spring', 'summer', 'autumn', 'winter'] });
    expect(params('floorspec_render')['weather']).toMatchObject({ enum: ['clear', 'overcast', 'rain', 'snow'] });
    expect(params('floorspec_render')['compare']).toMatchObject({ enum: ['main'] });
    expect(params('floorspec_render')['preset']).toMatchObject({ enum: ['day-to-night'] });
    expect(params('floorspec_render')['quality']).toMatchObject({ enum: ['draft', 'final'] });
    expect(params('floorspec_render')['style']).toMatchObject({ enum: ['colour', 'presentation', 'technical', 'blueprint'] });
    expect(params('floorspec_render')['mode']).toMatchObject({ enum: ['construction', 'decorator', 'electrical', 'plumbing', 'mechanical', 'lowvoltage', 'landscape'] });
    expect(params('floorspec_render')['sky']).toMatchObject({ enum: ['clear', 'overcast', 'dusk', 'night', 'studio'] });
    expect(params('floorspec_render')['doors']).toMatchObject({ enum: ['closed', 'open'] });
    expect(params('floorspec_propose')['assistant']).toMatchObject({ enum: ['electrical', 'staging'] });
    expect(Object.keys(params('floorspec_propose')).sort()).toEqual(['assistant', 'batch', 'changeset', 'locks', 'name', 'project', 'render', 'rooms']);
    expect(Object.keys(params('floorspec_apply')).sort()).toEqual(['batch', 'changeset', 'ifMatch', 'locks', 'option', 'project', 'render']);
  });

  it('offers the design partner guidance as the resource floorspec://guide too', async () => {
    const mcp = await connect(new MemoryClient());
    expect((await mcp.listResources()).resources.map((r) => r.uri)).toContain(GUIDE_URI);
    const read = await mcp.readResource({ uri: GUIDE_URI });
    expect(read.contents[0]).toMatchObject({ uri: GUIDE_URI, mimeType: 'text/markdown', text: DESIGN_PARTNER_PROMPT });
    // What left the tool listing for it (FLR-T-12.41) is said there.
    for (const moved of ['needed only while your credential reaches more than one project', 'never resolved', '/clearOpening', 'door-interior-swing-30x80', 'refused with the list'])
      expect(DESIGN_PARTNER_PROMPT).toContain(moved);
  });

  it('offers the design partner prompt, the same text the plugin skill carries', async () => {
    const mcp = await connect(new MemoryClient());
    const prompt = await mcp.getPrompt({ name: 'design-partner' });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text', text: DESIGN_PARTNER_PROMPT });
    const skill = readFileSync(join(import.meta.dirname, '../../../plugin/skills/floorspec-design-partner/SKILL.md'), 'utf8');
    expect(skill.replace(/\r\n/g, '\n')).toContain(DESIGN_PARTNER_PROMPT);
  });
});

/** FLR-REQ-079: the design critique prompt, kept apart from code findings. */
describe('the design critique prompt', () => {
  it('is listed beside the design partner, with optional project, changeset and focus arguments', async () => {
    const mcp = await connect(new MemoryClient());
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['design-critique', 'design-partner']);
    const critique = prompts.find((p) => p.name === 'design-critique');
    if (critique === undefined) throw new Error('design-critique is not listed');
    expect(critique.title).toBe('Design critique');
    expect(critique.description).toMatch(/daylight, circulation, storage, privacy and furniture fit/);
    expect(critique.description).toMatch(/Not a code review/);
    expect((critique.arguments ?? []).map((a) => [a.name, a.required ?? false])).toEqual([
      ['project', false],
      ['changeset', false],
      ['focus', false],
    ]);
  });

  it('asks for all five categories by default, from the tools only, as structured observations', async () => {
    const mcp = await connect(new MemoryClient());
    const prompt = await mcp.getPrompt({ name: 'design-critique' });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toBe(critiquePrompt());
    for (const heading of ['## Daylight', '## Circulation', '## Storage', '## Privacy', '## Furniture fit']) expect(text).toContain(heading);
    for (const tool of ['floorspec_describe', 'floorspec_render', 'floorspec_query', 'floorspec_validate']) expect(text).toContain(tool);
    expect(text).toMatch(/Rating: good \| could be better \| needs work/);
    expect(text).toMatch(/elements: <IDs/);
    expect(text).toMatch(/Ops: <a floorspec_apply-style batch/);
    await expect(text).toMatchFileSnapshot('./golden/design-critique.txt');
  });

  it('keeps code findings out: no code is cited and no verdict of compliance is asked for', () => {
    const text = critiquePrompt();
    expect(text).not.toMatch(/\b(IRC|IBC|NFPA|ADA|ICC|R3\d\d)\b/);
    expect(text).toContain('This is a design critique, not a code review.');
    expect(text).toContain('Do not call floorspec_findings for this critique');
    // "compliant" appears once, only in the instruction never to say it.
    expect(text.match(/compliant/g)).toEqual(['compliant', 'compliant']);
    expect(text).toMatch(/never say a design is "compliant" or "non-compliant"/);
  });

  it('narrows to the categories asked for, and names the changeset it critiques', async () => {
    const mcp = await connect(new MemoryClient());
    const prompt = await mcp.getPrompt({ name: 'design-critique', arguments: { focus: 'privacy, furniture fit', changeset: 'Open the kitchen', project: 'Lake house' } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('## Privacy');
    expect(text).toContain('## Furniture fit');
    expect(text).not.toContain('## Daylight');
    expect(text).not.toContain('## Storage');
    expect(text).toContain('the pending changeset "Open the kitchen"');
    expect(text).toContain('floorspec_describe {"project": "Lake house","changeset": "Open the kitchen"}');
  });

  it('refuses a focus that names nothing it critiques', async () => {
    const mcp = await connect(new MemoryClient());
    await expect(mcp.getPrompt({ name: 'design-critique', arguments: { focus: 'structure' } })).rejects.toThrow(/focus/);
  });

  it('reads focus as people write it', () => {
    expect(parseFocus(undefined)).toEqual([...CRITIQUE_CATEGORIES]);
    expect(parseFocus('all')).toEqual([...CRITIQUE_CATEGORIES]);
    expect(parseFocus('Furniture fit and daylight')).toEqual(['daylight', 'furniture']);
    expect(parseFocus('storage; privacy / circulation')).toEqual(['circulation', 'storage', 'privacy']);
    expect(parseFocus('light')).toEqual(['daylight']);
    expect(parseFocus('code')).toBeNull();
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
