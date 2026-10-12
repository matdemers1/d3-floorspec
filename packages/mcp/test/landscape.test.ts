/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { canonicalize, OFFICIAL_READER, validate } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { DESIGN_PARTNER_PROMPT, fillLandscape, landscapeItems, vendoredLandscape } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FLR-T-13.5: an agent plants a starter size by name and draws a bed, a lawn or a path by its
 * geometry alone; the tools fill in the plant's form, name and box, the box round an outline or a
 * line, and declare FS_landscape. No asset is uploaded: FS_landscape's kinds need none.
 */

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const STANDARD = JSON.parse(readFileSync(new URL('../../engine/standard/registry/FS_landscape/library.json', import.meta.url), 'utf8')) as {
  items: Record<string, { element: { form: string; fallback: { box: unknown } } }>;
};
const EMPTY = { floorspec: '0.4', project: { name: 'Garden house' } };
const MM = 1280;
const FT = 390144;

type Doc = { extensionsUsed?: Record<string, string>; extensions?: { FS_landscape?: { collections: Record<string, Record<string, Record<string, unknown> & { fallback: { level: string; box: { min: number[]; max: number[] } } }>> } } };

async function site() {
  const client = new ApplierClient(structuredClone(EMPTY));
  const mcp = await connect(client);
  const built = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'addElement', collection: 'buildings', id: 'B1', element: { name: 'House' } }, { op: 'addLevel', building: 'B1', id: 'L1', elevation: 0, height: "9'" }] } });
  expect(built.isError, texts(built)).toBeFalsy();
  return { client, mcp };
}

describe('FS_landscape through MCP', () => {
  it('vendors the standard’s starter sizes byte for byte', () => {
    expect(vendoredLandscape()).toEqual(STANDARD);
    expect(landscapeItems()).toContain('tree-medium');
    expect(DESIGN_PARTNER_PROMPT).toMatch(/"catalogue":"tree-medium"/);
  });

  it('plants a tree by its starter size and lays a bed, a lawn and stepping stones by geometry alone; the plan validates', async () => {
    const { client, mcp } = await site();
    const bed = [[0, 0], [8 * FT, 0], [8 * FT, 3 * FT], [0, 3 * FT]];
    const placed = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: {
        batch: [
          { op: 'placeElement', extension: 'FS_landscape', collection: 'plants', id: 'T1', host: { mode: 'free', level: 'L1', at: ["20'", "10'"] }, element: { catalogue: 'tree-medium', habit: 'spreading', species: 'Acer rubrum' } },
          { op: 'placeElement', extension: 'FS_landscape', collection: 'plants', id: 'S1', host: { mode: 'free', level: 'L1', at: ["2'", "1'"] }, element: { catalogue: 'shrub-small' } },
          { op: 'addElement', extension: 'FS_landscape', collection: 'beds', id: 'BED', element: { fallback: { level: 'L1' }, boundary: bed, edging: 'steel' } },
          { op: 'addElement', extension: 'FS_landscape', collection: 'lawns', id: 'LW', element: { fallback: { level: 'L1' }, boundary: [[-10 * FT, -10 * FT], [40 * FT, -10 * FT], [40 * FT, -2 * FT], [-10 * FT, -2 * FT]] } },
          { op: 'addElement', extension: 'FS_landscape', collection: 'hardscape', id: 'P1', element: { fallback: { level: 'L1' }, form: 'steppingStones', points: [[10 * FT, -4 * FT], [16 * FT, -4 * FT]], width: 600 * MM } },
        ],
      },
    });
    expect(placed.isError, texts(placed)).toBeFalsy();
    expect(texts(placed)).toContain('Planted from the FS_landscape 0.1.0 starter sizes (form, name, box): tree-medium, shrub-small.');
    expect(texts(placed)).toContain('Boxed round their geometry (FS_landscape 3.3): BED, LW, P1.');
    const doc = client.document as Doc;
    expect(doc.extensionsUsed).toMatchObject({ FS_landscape: '0.1.0' });
    const c = doc.extensions!.FS_landscape!.collections;
    expect(c['plants']!['T1']).toMatchObject({ form: 'tree', catalogue: 'tree-medium', habit: 'spreading', species: 'Acer rubrum', name: 'Medium tree', fallback: { level: 'L1', box: STANDARD.items['tree-medium']!.element.fallback.box } });
    expect(c['beds']!['BED']!.fallback.box).toEqual({ min: [0, 0, -150 * MM], max: [8 * FT, 3 * FT, 25 * MM] });
    // a line's box is grown by half its width
    expect(c['hardscape']!['P1']!.fallback.box).toEqual({ min: [10 * FT - 300 * MM, -4 * FT - 300 * MM, -50 * MM], max: [16 * FT + 300 * MM, -4 * FT + 300 * MM, 15 * MM] });
    expect(client.uploads).toBe(0);
    const result = validate(canonicalize(doc), OFFICIAL_READER);
    expect(result.diagnostics.filter((d) => d.code.startsWith('FS-LAND') || d.severity === 'error'), JSON.stringify(result.diagnostics)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('names the starter sizes when the agent names one it does not have', async () => {
    const { mcp } = await site();
    const r = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'placeElement', extension: 'FS_landscape', collection: 'plants', host: { mode: 'free', level: 'L1', at: ["2'", "2'"] }, element: { catalogue: 'oak-giant' } }] } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toContain('No FS_landscape starter size is "oak-giant"');
    expect(texts(r)).toMatch(/tree-small, tree-medium, tree-large/);
  });

  it('leaves an element the agent boxed, and declares the extension only once', () => {
    const own = { op: 'addElement', extension: 'FS_landscape', collection: 'lawns', id: 'L', element: { fallback: { level: 'L1', box: { min: [0, 0, 0], max: [MM, MM, MM] } }, boundary: [[0, 0], [MM, 0], [0, MM]] } };
    const declared = { extensionsUsed: { FS_landscape: '0.1.0' } };
    expect(fillLandscape(declared, [own])).toEqual({ prefix: [], batch: [own], items: [], boxed: [] });
    expect(fillLandscape({}, [own]).prefix).toEqual([{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_landscape', value: '0.1.0' }]);
  });
});
