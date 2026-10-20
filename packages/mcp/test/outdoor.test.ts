/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { check, OFFICIAL_READER } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { DESIGN_PARTNER_PROMPT, fillOutdoor, outdoorItems, vendoredOutdoor } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-15.2: an agent places a plunge pool, a pergola, a kitchen and a fire pit by their starter
 * items, draws a fence with a gate by its line and a style item, and stretches the pergola with
 * resizeElement — its posts re-space; floorspec_describe reports the outdoor rooms. One op each, the
 * same ops the editor sends.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const STANDARD = JSON.parse(readFileSync(new URL('../../engine/standard/registry/FS_outdoor/library.json', import.meta.url), 'utf8')) as {
  items: Record<string, { kind: string; element: Record<string, unknown> & { fallback: { box: { min: number[]; max: number[] } } } }>;
};
const EMPTY = { floorspec: '0.4', project: { name: 'Back terrace' } };
const IN = 32512;
const FT = 12 * IN;

type El = Record<string, unknown> & { fallback: { level: string; box: { min: number[]; max: number[] } } };
type Doc = { extensionsUsed?: Record<string, string>; extensions?: { FS_outdoor?: { collections: Record<string, Record<string, El>> } } };

async function site() {
  const client = new ApplierClient(structuredClone(EMPTY));
  const mcp = await connect(client);
  const built = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } }, { op: 'addLevel', building: 'B1', id: 'L1', elevation: 0, height: "9'" }] } });
  expect(built.isError, texts(built)).toBeFalsy();
  return { client, mcp };
}

const free = (x: string, y: string) => ({ mode: 'free', level: 'L1', at: [x, y] });

describe('FS_outdoor through MCP', () => {
  it('vendors the standard’s starter library byte for byte', () => {
    expect(vendoredOutdoor()).toEqual(STANDARD);
    expect(outdoorItems()).toContain('plunge-pool-8x14');
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"catalogue":"plunge-pool-8x14"/);
    expect(DESIGN_PARTNER_PROMPT).not.toMatch(/\bis compliant\b/);
  });

  it('places outdoor rooms by catalogue and a fence with a gate by its line; stretching the pergola re-spaces its posts; describe reports them', async () => {
    const { client, mcp } = await site();
    const line = [[-10 * FT, 4 * FT], [-10 * FT, -30 * FT], [10 * FT, -30 * FT]];
    const placed = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [
          { op: 'placeElement', extension: 'FS_outdoor', collection: 'pools', id: 'X1', host: free("7'", "-18'"), element: { catalogue: 'plunge-pool-8x14', name: 'Plunge pool' } },
          { op: 'placeElement', extension: 'FS_outdoor', collection: 'shelters', id: 'X3', host: free("7'", "-5'"), element: { catalogue: 'pergola-12x16', name: 'Pergola' } },
          { op: 'placeElement', extension: 'FS_outdoor', collection: 'kitchens', id: 'X4', host: free("16'", "-5'"), element: { catalogue: 'kitchen-10' } },
          { op: 'placeElement', extension: 'FS_outdoor', collection: 'fires', id: 'X5', host: free("-6'", "-8'"), element: { catalogue: 'fire-pit-4' } },
          { op: 'addElement', extension: 'FS_outdoor', collection: 'fences', id: 'X6', element: { catalogue: 'fence-privacy-6', fallback: { level: 'L1' }, points: line, gates: [{ offset: 40 * FT, width: 4 * FT, selfClosing: true }] } },
        ],
      },
    });
    expect(placed.isError, texts(placed)).toBeFalsy();
    expect(texts(placed)).toContain('Filled in from the FS_outdoor 0.1.0 starter library (members, name, box): plunge-pool-8x14, pergola-12x16, kitchen-10, fire-pit-4, fence-privacy-6.');
    expect(texts(placed)).toContain('Fences boxed round their line (FS_outdoor 3.3): X6.');
    const doc = client.document as Doc;
    expect(doc.extensionsUsed).toMatchObject({ FS_outdoor: '0.1.0' });
    const c = doc.extensions!.FS_outdoor!.collections;
    expect(c['pools']!['X1']).toMatchObject({ form: 'plunge', coping: 12 * IN, name: 'Plunge pool', fallback: { level: 'L1', box: STANDARD.items['plunge-pool-8x14']!.element.fallback.box } });
    // the fence's box: its line grown by half its 4" width, from the ground to the style's 6'
    expect(c['fences']!['X6']!.fallback.box).toEqual({ min: [-10 * FT - 2 * IN, -30 * FT - 2 * IN, 0], max: [10 * FT + 2 * IN, 4 * FT + 2 * IN, 6 * FT] });
    expect(c['fences']!['X6']).toMatchObject({ form: 'fence', style: 'privacy', width: 4 * IN });
    const result = check(doc, OFFICIAL_READER);
    expect(result.diagnostics.filter((d) => d.severity === 'error'), JSON.stringify(result.diagnostics)).toEqual([]);
    const x = result.derived!.extensions!.FS_outdoor!;
    expect(x.shelters['X3']).toMatchObject({ bays: [2, 2], posts: 8 });
    expect(x.fences['X6']).toEqual({ form: 'fence', length: 54 * FT, posts: 9, gates: [[40 * FT, 44 * FT]] });

    const stretched = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'resizeElement', element: 'Pergola', anchor: 'back', depth: "20'" }] } });
    expect(stretched.isError, texts(stretched)).toBeFalsy();
    const after = check(client.document, OFFICIAL_READER).derived!.extensions!.FS_outdoor!;
    expect(after.shelters['X3']).toMatchObject({ bays: [3, 2], spacing: [78 * IN, 93 * IN], posts: 10 });
    expect((client.document as Doc).extensions!.FS_outdoor!.collections['shelters']!['X3']!['postSize']).toBe(6 * IN);

    const d = texts(await mcp.callTool({ name: 'floorspec_describe', arguments: {} }));
    expect(d).toContain('## Outdoor rooms (FS_outdoor');
    expect(d).toMatch(/pool X1 "Plunge pool": plunge, basin 6' 0" × 12' 0", water 5' 0" deep, ≈ 2,693 gal/);
    expect(d).toMatch(/fence X6.*54' 0" long, 9 posts, gate 40' 0"–44' 0" along it/);
    expect(d).toMatch(/shelter X3 "Pergola": slats top, 3 × 2 bays.*10 posts/);
    expect(d).toMatch(/kitchen X4.*10' 0" run — grill, sink, refrigerator/);
    expect(d).not.toMatch(/compliant/i);
  });

  it('names the library when the agent names an item it does not have, or puts one in the wrong collection', async () => {
    const { mcp } = await site();
    const r = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'placeElement', extension: 'FS_outdoor', collection: 'pools', host: free("2'", "2'"), element: { catalogue: 'lap-pool' } }] } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toContain('No FS_outdoor starter item is "lap-pool"');
    expect(texts(r)).toMatch(/pools: plunge-pool-8x14, pool-16x32, spa-7x7/);
    const w = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'placeElement', extension: 'FS_outdoor', collection: 'pools', host: free("2'", "2'"), element: { catalogue: 'pergola-12x16' } }] } });
    expect(texts(w)).toContain('put op 0 in collection "shelters"');
  });

  it('leaves an element the agent boxed, and declares the extension only once', () => {
    const own = { op: 'placeElement', extension: 'FS_outdoor', collection: 'fires', id: 'F', host: free('0', '0'), element: { form: 'pit', fallback: { box: { min: [0, 0, 0], max: [FT, FT, FT] } } } };
    expect(fillOutdoor({ extensionsUsed: { FS_outdoor: '0.1.0' } }, [own])).toEqual({ prefix: [], batch: [own], items: [], boxed: [] });
    expect(fillOutdoor({}, [own]).prefix).toEqual([{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_outdoor', value: '0.1.0' }]);
  });
});
