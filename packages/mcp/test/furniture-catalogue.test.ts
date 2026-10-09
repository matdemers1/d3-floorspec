/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { canonicalize, OFFICIAL_READER, Package, validate } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { furnitureItems, OPENING_FIT_HINT, vendoredFurniture } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-12.25: furnishing a house through MCP took 38 hand-written asset operations with SHA-256
 * digests copied out of the FS_furniture library. A placeElement now names a library item in
 * `catalogue` and the tools fill in the rest — members, box, envelopes, the model and symbol as
 * assets (each file uploaded into the project's asset store, each asset once) — and declare the
 * extension; the plan validates with the files in its package.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const LIB = new URL('../../engine/standard/registry/FS_furniture/library/', import.meta.url);
const STANDARD = JSON.parse(readFileSync(new URL('library.json', LIB), 'utf8')) as { items: Record<string, { model: { path: string; sha256: string }; symbol: { path: string; sha256: string }; element: { fallback: { box: unknown }; clearances?: unknown } }> };

/** The document a new project starts as (apps/server/src/model/document.ts). */
const EMPTY = { floorspec: '0.4', project: { name: 'West house' } };

/** A 20 × 14 ft living room of US starter walls. */
const ROOM = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } },
  { op: 'addLevel', building: 'B1', id: 'L1', elevation: 0, height: "9'" },
  ...[
    [["0'", "0'"], ["20'", "0'"]],
    [["20'", "0'"], ["20'", "14'"]],
    [["20'", "14'"], ["0'", "14'"]],
    [["0'", "14'"], ["0'", "0'"]],
  ].map(([from, to]) => ({ op: 'drawWall', level: 'L1', from, to, type: 'wall-2x6-exterior-fibre-cement' })),
];

const SOFA = { op: 'placeElement', extension: 'FS_furniture', collection: 'pieces', id: 'SOFA', host: { mode: 'surface', room: 'Living', surface: 'floor', at: ["10'", "3'"], rotation: 90_000_000 }, element: { catalogue: 'sofa-2100' } };
const FRIDGE = { op: 'placeElement', extension: 'FS_furniture', collection: 'appliances', id: 'FRIDGE', host: { mode: 'wallFace', wall: 'north wall of Living', toward: 'Living', at: "3' from start", height: 0 }, element: { catalogue: 'refrigerator-900' } };

type Doc = {
  extensionsUsed?: Record<string, string>;
  assets?: Record<string, { path: string; sha256: string; mediaType: string; byteLength: number }>;
  extensions?: { FS_furniture?: { collections: Record<string, Record<string, { category: string; name?: string; seats?: number; catalogue?: string; clearances?: unknown; fallback: { box: unknown; asset: string; symbol: string } }>> } };
};

async function livingRoom() {
  const client = new ApplierClient(structuredClone(EMPTY));
  const mcp = await connect(client);
  const built = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [...ROOM] } });
  expect(built.isError, texts(built)).toBeFalsy();
  const named = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addRoom', level: 'L1', at: ["10'", "7'"], name: 'Living', function: 'living' }] } });
  expect(named.isError, texts(named)).toBeFalsy();
  return { client, mcp };
}

/** The document as a package: model.json and every asset's file from the client's store, at its path. */
function packaged(client: ApplierClient) {
  const doc = client.document as Doc;
  const files: Record<string, Uint8Array> = {};
  for (const a of Object.values(doc.assets ?? {})) {
    const bytes = client.store.get(a.sha256);
    if (bytes !== undefined) files[a.path] = bytes;
  }
  return validate(canonicalize(doc), { package: new Package(files), ...OFFICIAL_READER });
}

describe('FS_furniture by catalogue through MCP', () => {
  it('vendors the standard’s library and files byte for byte', () => {
    const { library, files } = vendoredFurniture();
    expect(library).toEqual(STANDARD);
    for (const item of Object.values(STANDARD.items)) {
      for (const f of [item.model, item.symbol]) expect(Buffer.from(files[f.path]!, 'base64').equals(readFileSync(new URL(f.path, LIB))), f.path).toBe(true);
    }
    expect(furnitureItems().appliances).toContain('refrigerator-900');
  });

  it('places a sofa and a refrigerator by catalogue alone, and the plan validates with no errors', async () => {
    const { client, mcp } = await livingRoom();
    const placed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [SOFA, FRIDGE] } });
    expect(placed.isError, texts(placed)).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ embedded: ['sofa-2100', 'refrigerator-900'] });
    expect(texts(placed)).toContain('Filled in from the FS_furniture starter library 0.1.0 (members, box, envelopes, model and symbol): sofa-2100, refrigerator-900.');

    const doc = client.document as Doc;
    expect(doc.extensionsUsed).toMatchObject({ FS_furniture: '0.1.0' });
    // Two assets an item, each the library's file, under IDs named for the item.
    expect(Object.keys(doc.assets ?? {}).sort()).toEqual(['refrigerator-900-model', 'refrigerator-900-symbol', 'sofa-2100-model', 'sofa-2100-symbol']);
    const sofaLib = STANDARD.items['sofa-2100']!;
    expect(doc.assets!['sofa-2100-model']).toEqual({ path: `assets/${sofaLib.model.sha256}.glb`, sha256: sofaLib.model.sha256, mediaType: 'model/gltf-binary', byteLength: expect.any(Number) as number, name: 'sofa-2100.glb' });
    expect(doc.assets!['sofa-2100-symbol']).toMatchObject({ path: `assets/${sofaLib.symbol.sha256}.svg`, sha256: sofaLib.symbol.sha256, mediaType: 'image/svg+xml' });
    // Every file was uploaded into the asset store, as the editor uploads it.
    expect([...client.store.keys()].sort()).toEqual(Object.values(doc.assets ?? {}).map((a) => a.sha256).sort());

    const sofa = doc.extensions?.FS_furniture?.collections['pieces']?.['SOFA'];
    expect(sofa).toMatchObject({ category: 'sofa', catalogue: 'sofa-2100', name: 'Three-seat sofa', seats: 3, clearances: sofaLib.element.clearances, fallback: { box: sofaLib.element.fallback.box, asset: 'sofa-2100-model', symbol: 'sofa-2100-symbol' } });
    expect(doc.extensions?.FS_furniture?.collections['appliances']?.['FRIDGE']).toMatchObject({ category: 'refrigerator', fallback: { asset: 'refrigerator-900-model', symbol: 'refrigerator-900-symbol' } });

    const result = packaged(client);
    expect(result.diagnostics.filter((d) => d.severity === 'error'), JSON.stringify(result.diagnostics)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('reuses an asset with the same digest, keeps what the agent gave, and declares the extension once', async () => {
    const { client, mcp } = await livingRoom();
    const lib = STANDARD.items['dining-chair-450']!;
    // The editor's asset for the chair's model, already in the plan under its own ID.
    const own = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [
          { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' },
          { op: 'addElement', collection: 'assets', id: 'FA1', element: { path: `assets/${lib.model.sha256}.glb`, sha256: lib.model.sha256, mediaType: 'model/gltf-binary', byteLength: 1, name: 'chair.glb' } },
        ],
      },
    });
    expect(own.isError, texts(own)).toBeFalsy();
    const chairs = [1, 2, 3].map((n) => ({ op: 'placeElement', extension: 'FS_furniture', collection: 'pieces', id: `CH${String(n)}`, host: { mode: 'surface', room: 'Living', surface: 'floor', at: [`${String(4 + 2 * n)}'`, "10'"] }, element: { catalogue: 'dining-chair-450', ...(n === 3 ? { name: 'Carver chair' } : {}) } }));
    const placed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: chairs } });
    expect(placed.isError, texts(placed)).toBeFalsy();
    const doc = client.document as Doc;
    // FA1 for the model; one new asset for the symbol, shared by all three chairs.
    expect(Object.keys(doc.assets ?? {}).sort()).toEqual(['FA1', 'dining-chair-450-symbol']);
    const pieces = doc.extensions?.FS_furniture?.collections['pieces'] ?? {};
    for (const id of ['CH1', 'CH2', 'CH3']) expect(pieces[id]?.fallback).toMatchObject({ asset: 'FA1', symbol: 'dining-chair-450-symbol' });
    expect(pieces['CH3']?.name).toBe('Carver chair');
    expect(pieces['CH1']?.name).toBe('Dining chair');
    expect(placed.structuredContent).toMatchObject({ embedded: ['dining-chair-450'] });
  });

  it('names the library when the agent names an item it does not have, and the right collection when it picks another', async () => {
    const { client, mcp } = await livingRoom();
    const unknown = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ ...SOFA, element: { catalogue: 'loveseat' } }] } });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)).toContain('No FS_furniture library item is "loveseat"');
    expect(texts(unknown)).toMatch(/pieces: [^;]*sofa-2100/);
    const misplaced = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ ...SOFA, collection: 'appliances' }] } });
    expect(texts(misplaced)).toContain('"sofa-2100" is in FS_furniture\'s "pieces" collection, not "appliances"');
    expect(client.uploads).toBe(0);
  });

  it('tells an agent an opening’s `at` is its near edge, not its centre', async () => {
    const { mcp } = await livingRoom();
    // A 36" door 19' 6" from the start of a 20' wall: its near edge, so it runs past the end.
    const rejected = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addOpening', wall: 'south wall of Living', at: "19' 6\" from start", fill: 'door-exterior-swing-36x80' }] } });
    expect(rejected.isError).toBe(true);
    expect(texts(rejected)).toContain(OPENING_FIT_HINT);
    expect(OPENING_FIT_HINT).toContain("An opening's `at` is where it begins, not its centre");
    const { tools } = await mcp.listTools();
    const defs = JSON.stringify(tools.find((t) => t.name === 'floorspec_apply')?.inputSchema);
    expect(defs).toContain("An opening's near edge, not its centre; a hosted element's centre.");
    expect(defs).toContain('{\\"catalogue\\":\\"sofa-2100\\"}');
  });
});
