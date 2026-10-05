import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonicalize, contentHash } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { describe, expect, it } from 'vitest';
import { createFloorspecMcpHandler, FloorspecApiError, SET_PROPERTY_HINT, UPGRADE_HINT, type ApplyInput, type Committed, type FloorspecClient } from '../src/index.js';

/**
 * The Ops 0.2 vocabulary end to end through the tool path: an agent sends floorspec_apply batches
 * that build a brief and place devices, the in-process MCP server checks them against the
 * advertised schema, and a client backed by the reference applier (`@floorspec/ops`, Ops 0.2, as
 * the API runs it) commits them — then floorspec_describe reads the result back.
 */

/** One room, 4 m × 3 m, named Kitchen, on a Core 0.2 document: what a new project grows into. */
const HOUSE = {
  floorspec: '0.2',
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
  rooms: { R1: { level: 'L1', anchor: [2560000, 1920000], name: 'Kitchen', function: 'kitchen' } },
};

const PROJECT = '01a10000-0000-7000-8000-000000000001';

/** A client whose main head is a document in memory, edited by the reference applier. */
class ApplierClient implements FloorspecClient {
  document: object;
  seq = 1;
  constructor(document: object) {
    this.document = document;
  }
  listProjects() {
    return Promise.resolve([{ id: PROJECT, name: 'Lake house', head: contentHash(this.document) }]);
  }
  model() {
    return Promise.resolve({ hash: contentHash(this.document), document: this.document, text: canonicalize(this.document) });
  }
  apply(_projectId: string, input: ApplyInput): Promise<Committed> {
    const before = contentHash(this.document);
    const r = apply(this.document, { batch: input.batch as never }, { ops: '0.2' });
    if (r.status === 'rejected')
      return Promise.reject(new FloorspecApiError(422, { type: '/problems/ops-rejected', error: 'the batch was rejected and nothing changed', diagnostics: r.diagnostics }));
    this.document = JSON.parse(r.document) as object;
    this.seq++;
    return Promise.resolve({ status: 'committed', head: 'main', before, hash: r.hash, op: { id: `op-${String(this.seq)}`, seq: this.seq, kind: 'apply' }, resolved: r.resolved as unknown as Committed['resolved'], created: r.created, removed: r.removed, changeset: null });
  }
  propose(): never {
    throw new Error('not used');
  }
  changesets() {
    return Promise.resolve([]);
  }
  accept(): never {
    throw new Error('not used');
  }
  reject(): never {
    throw new Error('not used');
  }
  proposeLayouts(): never {
    throw new Error('not used');
  }
  validate() {
    return Promise.resolve({ head: 'main', hash: contentHash(this.document), valid: true, diagnostics: [] });
  }
  findings() {
    return Promise.resolve({ head: 'main', hash: contentHash(this.document), findings: [], rulePacks: [], note: '' });
  }
  render(): Promise<Uint8Array> {
    return Promise.reject(new FloorspecApiError(501, { error: 'no renderer here' }));
  }
}

async function connect(client: FloorspecClient) {
  const handler = createFloorspecMcpHandler(() => client);
  const fetchLike = (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init));
  const mcp = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://floorspec.test/mcp'), { fetch: fetchLike }));
  return mcp;
}

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
type Doc = {
  program: { items: Record<string, Record<string, unknown>>; adjacency: Record<string, unknown>[] };
  rooms: Record<string, Record<string, unknown>>;
  extensions: Record<string, { collections: Record<string, Record<string, { host: Record<string, unknown>; fallback: Record<string, unknown> }>> }>;
};

describe('a brief and a device, through floorspec_apply', () => {
  it('builds a bubble diagram, briefs the room, and reads it back with floorspec_describe', async () => {
    const client = new ApplierClient(HOUSE);
    const mcp = await connect(client);
    const result = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [
          { op: 'addProgramItem', function: 'kitchen', name: 'Cook', minArea: '11 m2' },
          { op: 'addProgramItem', id: 'DIN', function: 'dining', name: 'Eat', targetArea: '120 sq ft' },
          { op: 'setAdjacency', a: 'Cook', b: 'Eat', kind: 'required', weight: 10 },
          { op: 'setRoomBrief', room: 'Kitchen', item: 'Cook' },
        ],
      },
    });
    expect(result.isError, texts(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'committed', created: ['DIN', 'P1'] });
    const doc = client.document as Doc;
    expect(doc.program.items['P1']).toEqual({ function: 'kitchen', name: 'Cook', minArea: 11 * 1_638_400_000_000 });
    expect(doc.program.adjacency).toEqual([{ a: 'P1', b: 'DIN', kind: 'required', weight: 10 }]);
    expect(doc.rooms['R1']?.['brief']).toBe('P1');

    const described = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    expect(described).toContain('## Program');
    expect(described).toMatch(/- P1 "Cook" — kitchen: 1 of 1 room \(R1\)/);
    expect(described).toMatch(/- required P1 \| DIN: /);
  });

  it('places an outlet on the face that looks into a room, then moves it to the floor', async () => {
    const client = new ApplierClient(HOUSE);
    const mcp = await connect(client);
    const placed = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [
          { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
          {
            op: 'placeElement',
            extension: 'FS_electrical',
            collection: 'devices',
            host: { mode: 'wallFace', wall: 'north wall of Kitchen', toward: 'Kitchen', at: "2' from start", height: '12"' },
            element: { name: 'Counter outlet', fallback: { box: { min: [0, -51200, 0], max: [25600, 51200, 128000] } }, device: 'receptacle' },
          },
        ],
      },
    });
    expect(placed.isError, texts(placed)).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ status: 'committed', created: ['X1'] });
    const x1 = (client.document as Doc).extensions['FS_electrical']?.collections['devices']?.['X1'];
    expect(x1?.host).toEqual({ mode: 'wallFace', wall: 'W2', side: 'right', offset: 2 * 390144, height: 12 * 32512 });
    expect(x1?.fallback['level']).toBe('L1');
    expect(texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }))).toContain('X1');

    // By name, onto the kitchen floor.
    const moved = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'moveElement', element: 'Counter outlet', host: { mode: 'surface', room: 'Kitchen', surface: 'floor', at: ["3'", "4'"] } }] },
    });
    expect(moved.isError, texts(moved)).toBeFalsy();
    expect((client.document as Doc).extensions['FS_electrical']?.collections['devices']?.['X1']?.host).toEqual({ mode: 'surface', room: 'R1', surface: 'floor', position: [3 * 390144, 4 * 390144] });
  });

  it('refuses a host the schema does not allow before calling the API', async () => {
    const client = new ApplierClient(HOUSE);
    const mcp = await connect(client);
    const result = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'placeElement', extension: 'FS_electrical', collection: 'devices', host: { mode: 'hanging', level: 'L1', at: [0, 0] }, element: {} }] },
    });
    expect(result.isError).toBe(true);
    expect(client.seq).toBe(1);
  });

  it('says how to upgrade a Core 0.1 plan when a brief is sent to it', async () => {
    const client = new ApplierClient({ ...HOUSE, floorspec: '0.1' });
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addProgramItem', function: 'kitchen' }] } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain(`Hint: ${UPGRADE_HINT}`);
    const upgraded = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' }, { op: 'addProgramItem', function: 'kitchen' }] },
    });
    expect(upgraded.isError, texts(upgraded)).toBeFalsy();
  });

  it('names the extension to declare when a device is placed without it', async () => {
    const mcp = await connect(new ApplierClient(HOUSE));
    const result = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [{ op: 'placeElement', extension: 'FS_electrical', collection: 'devices', host: { mode: 'wallFace', wall: 'W1', side: 'left', at: 'centered', height: 0 }, element: { fallback: { box: { min: [0, -51200, 0], max: [25600, 51200, 128000] } } } }],
      },
    });
    expect(texts(result)).toContain('"path":"/extensionsUsed/FS_electrical"');
  });
});

/** The agent eval's misses (2026-10-05 run): a door that came out a cased opening, and an anchor under a new wall. */
describe('what the first agent eval taught the tools', () => {
  const WITH_DOORS = { ...HOUSE, types: { ...HOUSE.types, D30: { kind: 'doorType', name: '30 in interior door', width: 975360, height: 2600960 } } };

  it('says when a committed opening has no fill: an empty cased opening, not a door', async () => {
    const mcp = await connect(new ApplierClient(WITH_DOORS));
    const cased = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addOpening', wall: 'W2', at: 'centered', width: '32"', height: "6' 8\"" }] } });
    expect(cased.isError, texts(cased)).toBeFalsy();
    expect(texts(cased)).toContain('Note: O1 is an empty cased opening — no fill, so no door or window.');
    expect(texts(cased)).toContain('"path":"/fill"');
  });

  it('makes a door of a size the library lacks from the nearest type, its width overriding the type\'s, with no note', async () => {
    const client = new ApplierClient(WITH_DOORS);
    const mcp = await connect(client);
    const door = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addOpening', wall: 'W2', at: 'centered', fill: 'D30', width: '32"' }] } });
    expect(door.isError, texts(door)).toBeFalsy();
    expect(texts(door)).not.toContain('cased opening');
    expect((client.document as { openings: Record<string, unknown> }).openings['O1']).toMatchObject({ fill: 'D30', width: 32 * 32512 });
  });

  it("says a wall drawn through a room's anchor must move the anchor, and that setProperty values are integers", async () => {
    const mcp = await connect(new ApplierClient(HOUSE));
    const hints = (result: { content?: unknown }) => texts(result).split('\n').filter((l) => l.startsWith('Hint: '));
    const through = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'drawWall', level: 'L1', from: [2560000, 0], to: [2560000, 3840000], type: 'WT' }] } });
    expect(texts(through)).toContain('FS-INV-201');
    expect(hints(through)).toEqual([expect.stringContaining("A wall drawn in this batch runs through a room's anchor")]);
    const strings = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'drawWall', level: 'L1', from: [2560000, 0], to: [2560000, 3840000], type: 'WT' }, { op: 'setProperty', id: 'R1', path: '/anchor', value: ["5'", "4'"] }] },
    });
    expect(texts(strings)).toContain('must be integer');
    expect(hints(strings)).toContain(`Hint: ${SET_PROPERTY_HINT}`);
    const fixed = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'drawWall', level: 'L1', from: [2560000, 0], to: [2560000, 3840000], type: 'WT' }, { op: 'setProperty', id: 'R1', path: '/anchor', value: [1280000, 1920000] }] },
    });
    expect(fixed.isError, texts(fixed)).toBeFalsy();
  });
});
