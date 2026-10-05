import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * FS_furniture through the tool path (FLR-T-8.3): a refrigerator placed with floorspec_apply —
 * the extension declared, its model and symbol as assets, placeElement — and floorspec_describe
 * listing it, briefly, in the room it stands in.
 */

const RANCH = JSON.parse(readFileSync(new URL('./fixtures/two-bedroom-ranch.json', import.meta.url), 'utf8')) as object;
const FT = 390_144;
const BOX = { min: [0, -576000, 0], max: [896000, 576000, 2278400] };

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const summaryOf = (result: { structuredContent?: unknown }) => (result.structuredContent as { summary: DocumentSummary }).summary;

const PLACE = [
  { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' },
  { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' },
  { op: 'addElement', collection: 'assets', id: 'FA1', element: { path: `assets/${'a'.repeat(64)}.glb`, sha256: 'a'.repeat(64), mediaType: 'model/gltf-binary', byteLength: 2300 } },
  { op: 'addElement', collection: 'assets', id: 'FA2', element: { path: `assets/${'b'.repeat(64)}.svg`, sha256: 'b'.repeat(64), mediaType: 'image/svg+xml', byteLength: 527 } },
  {
    op: 'placeElement',
    extension: 'FS_furniture',
    collection: 'appliances',
    id: 'X1',
    host: { mode: 'surface', room: 'Kitchen', surface: 'floor', at: [8 * FT, 20 * FT] },
    element: {
      category: 'refrigerator',
      name: 'Refrigerator, 900 mm',
      clearances: { door: { purpose: 'swing', shape: 'box', min: [896000, -576000, 0], max: [2048000, 576000, 2278400] } },
      fallback: { box: BOX, asset: 'FA1', symbol: 'FA2' },
    },
  },
];

describe('furniture in floorspec_describe', () => {
  it('lists each room’s furniture with its category and size, and gives each element its room', async () => {
    const mcp = await connect(new ApplierClient(RANCH));
    const placed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: PLACE } });
    expect(placed.isError, texts(placed)).toBeFalsy();
    const described = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
    expect(described.isError, texts(described)).toBeFalsy();
    const s = summaryOf(described);
    const kitchen = s.levels[0]?.rooms.find((r) => r.name === 'Kitchen');
    expect(kitchen?.furniture).toEqual([{ id: 'X1', name: 'Refrigerator, 900 mm', category: 'refrigerator', size: [1152000, 896000, 2278400] }]);
    expect(s.levels[0]?.rooms.find((r) => r.name === 'Bath')?.furniture).toBeUndefined();
    expect(s.levels[0]?.elements?.find((e) => e.id === 'X1')).toMatchObject({ kind: 'FS_furniture:appliances', room: 'KIT' });
    expect(texts(described)).toContain('Furniture (FS_furniture): refrigerator X1 "Refrigerator, 900 mm" 35-7/16" W × 27-9/16" D.');
  });
});
