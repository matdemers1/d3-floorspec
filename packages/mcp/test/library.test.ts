/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { libraryTypes, missingLibraryTypes, OPENING_FIT_HINT } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * Found designing the first real house over MCP (FLR-T-2.13): a new project has no types, and the
 * agent had to copy 25 wall, door and window types and their materials into its first batch by hand.
 * A batch now names a US starter type and the tool embeds it the first time.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

/** The document a new project starts as (apps/server/src/model/document.ts). */
const EMPTY = { floorspec: '0.4', project: { name: 'West house' } };
const BOX = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
  { op: 'addLevel', building: 'B1', id: 'L1', elevation: 0, height: "9'" },
  ...[
    [[0, 0], [20, 0]],
    [[20, 0], [20, 4]],
    [[20, 4], [0, 4]],
    [[0, 4], [0, 0]],
  ].map(([from, to]) => ({ op: 'drawWall', level: 'L1', from: from!.map((v) => `${String(v)}'`), to: to!.map((v) => `${String(v)}'`), type: 'wall-2x6-exterior-fibre-cement' })),
];

describe('the US starter library through MCP', () => {
  it('is the same file the editor vendors', () => {
    const mcp = readFileSync(new URL('../src/library/us-starter-0.1.0.json', import.meta.url));
    const web = readFileSync(new URL('../../../apps/web/src/editor/library/us-starter-0.1.0.json', import.meta.url));
    expect(mcp.equals(web)).toBe(true);
    expect(libraryTypes().doorType).toContain('door-interior-swing-30x80');
  });

  it('embeds a wall type and its materials the first time a batch names it, and never twice', async () => {
    const client = new ApplierClient(structuredClone(EMPTY));
    const mcp = await connect(client);
    const first = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: BOX } });
    expect(first.isError, texts(first)).toBeFalsy();
    expect(texts(first)).toContain('Embedded from the US starter library 0.1.0: wall-2x6-exterior-fibre-cement.');
    expect(first.structuredContent).toMatchObject({ embedded: ['wall-2x6-exterior-fibre-cement'] });
    const doc = client.document as { types: Record<string, unknown>; materials: Record<string, unknown> };
    expect(Object.keys(doc.types)).toEqual(['wall-2x6-exterior-fibre-cement']);
    expect(Object.keys(doc.materials).sort()).toEqual(['fibre-cement-siding', 'gypsum-board', 'osb-sheathing', 'weather-resistive-barrier', 'wood-stud-framing-insulated']);

    // A door on the box: the door type comes in; the wall type, already there, does not come again.
    const door = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'drawWall', level: 'L1', from: ["10'", "0'"], to: ["10'", "4'"], type: 'wall-2x6-exterior-fibre-cement' }, { op: 'addOpening', wall: 'W1', at: "1' from start", fill: 'door-exterior-swing-36x80' }] },
    });
    expect(door.isError, texts(door)).toBeFalsy();
    expect(door.structuredContent).toMatchObject({ embedded: ['door-exterior-swing-36x80'] });
    expect(Object.keys((client.document as { types: object }).types).sort()).toEqual(['door-exterior-swing-36x80', 'wall-2x6-exterior-fibre-cement']);
  });

  it('leaves a type the batch adds itself alone, and does not read the plan for a batch that names none', () => {
    const own = { op: 'addElement', collection: 'types', id: 'wall-2x4-interior', element: { kind: 'wallType', layers: [{ function: 'core', thickness: 113792 }] } };
    expect(missingLibraryTypes(EMPTY, [own, { op: 'drawWall', level: 'L1', from: [0, 0], to: [1, 0], type: 'wall-2x4-interior' }])).toEqual([]);
    expect(missingLibraryTypes(EMPTY, [{ op: 'setProperty', id: 'O1', path: '/fill', value: 'window-fixed-72x48' }])).toEqual(['window-fixed-72x48']);
  });

  it('points a refusal at the agent\'s own op, not at the embedded ones put ahead of it', async () => {
    const client = new ApplierClient(structuredClone(EMPTY));
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [...BOX, { op: 'removeElement', id: 'W99' }] } });
    expect(result.isError).toBe(true);
    const diagnostics = (result.structuredContent as { diagnostics: { code: string; location?: { pointer?: string } }[] }).diagnostics;
    expect(diagnostics.find((d) => d.code === 'FS-OPS-003')?.location?.pointer).toBe(`/batch/${String(BOX.length)}/id`);
  });

  it('leaves the echo of a long batch out of the answer; created still names what it made', async () => {
    const client = new ApplierClient(structuredClone(EMPTY));
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [...BOX, ...Array.from({ length: 22 }, (_, i) => ({ op: 'addProgramItem', function: 'storage', name: `Closet ${String(i + 1)}` }))] } });
    expect(result.isError, texts(result)).toBeFalsy();
    const structured = result.structuredContent as { resolved?: unknown; resolvedOps?: number; created: string[] };
    expect(structured.resolved).toBeUndefined();
    expect(structured.resolvedOps).toBeGreaterThan(25);
    expect(structured.created).toContain('W1');
  });

  it('says why an opening does not fit its wall', async () => {
    const client = new ApplierClient(structuredClone(EMPTY));
    const mcp = await connect(client);
    await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: BOX } });
    // The box's east wall is 4' long; a 60" pair of doors centred on it starts before the wall does.
    const result = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addOpening', wall: 'W2', at: 'centered', fill: 'door-double-swing-60x80' }] } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain(OPENING_FIT_HINT);
  });

  it('lists the library when a project is created', async () => {
    class Fresh extends ApplierClient {
      override listProjects() {
        return Promise.resolve([]);
      }
      override createProject(name: string) {
        return Promise.resolve({ id: 'p', name, head: null });
      }
    }
    const mcp = await connect(new Fresh(structuredClone(EMPTY)));
    const created = await mcp.callTool({ name: 'floorspec_create_project', arguments: { name: 'West house' } });
    expect(texts(created)).toMatch(/walls: [^;]*wall-2x4-interior/);
  });
});
