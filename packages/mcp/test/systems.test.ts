import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocumentSummary, EdgeSummary, RoomSummary } from '../src/index.js';
import { ApplierClient, connect } from './applier-client.js';

/**
 * Building systems through the tool path (FLR-T-5.7): the Phase 5 demo sent as floorspec_apply
 * batches — a panel, kitchen receptacles on two 20 A circuits, a toilet and a water heater — then a
 * wall moved, and floorspec_describe reading the devices on each wall face, with their offsets and
 * circuits, where the moved wall now puts them.
 */

const RANCH = JSON.parse(readFileSync(new URL('./fixtures/two-bedroom-ranch.json', import.meta.url), 'utf8')) as object;
const PLATE = { min: [0, -51200, -76800], max: [32000, 51200, 76800] };
const FT = 390_144;
const IN = 32_512;

type Content = { type: string; text?: string };
const texts = (result: { content?: unknown }) => ((result.content ?? []) as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const receptacle = (at: string) => ({
  op: 'placeElement',
  extension: 'FS_electrical',
  collection: 'receptacles',
  host: { mode: 'wallFace', wall: 'north wall of Kitchen', toward: 'Kitchen', at, height: '42"' },
  element: { fallback: { box: PLATE }, amps: 20, features: ['gfci'] },
});

const DEMO = [
  { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' },
  { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
  { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_plumbing', value: '0.1.0' },
  {
    op: 'placeElement',
    extension: 'FS_electrical',
    collection: 'panels',
    id: 'X1',
    host: { mode: 'wallFace', wall: 'W1', toward: 'Living room', at: "4'", height: "5'" },
    element: { name: 'P1', fallback: { box: { min: [0, -256000, -512000], max: [128000, 256000, 512000] } }, volts: [120, 240], rating: 200, mainBreaker: 200, spaces: 40 },
  },
  { ...receptacle("2' from start"), id: 'X2' },
  { ...receptacle("6' from start"), id: 'X3' },
  { ...receptacle("10' from start"), id: 'X4' },
  { ...receptacle("2' from end"), id: 'X5' },
  {
    op: 'placeElement',
    extension: 'FS_plumbing',
    collection: 'fixtures',
    id: 'X6',
    host: { mode: 'surface', room: 'Bath', surface: 'floor', at: [26 * FT, 24 * FT] },
    element: { fallback: { box: { min: [0, -243200, 0], max: [896000, 243200, 1024000] } }, fixture: 'waterCloset', supply: ['cold'] },
  },
  {
    op: 'placeElement',
    extension: 'FS_plumbing',
    collection: 'waterHeaters',
    id: 'X7',
    host: { mode: 'surface', room: 'Hall', surface: 'floor', at: [26 * FT, 10 * FT] },
    element: { fallback: { box: { min: [-358400, -358400, 0], max: [358400, 358400, 1920000] } }, heater: 'storage', energy: 'electric' },
  },
  { op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C1', value: { panel: 'X1', breaker: 20, volts: 120, rating: 20, space: 1, loads: ['X2', 'X3'], name: 'Kitchen counter 1' } },
  { op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C2', value: { panel: 'X1', breaker: 20, volts: 120, rating: 20, space: 2, loads: ['X4', 'X5'], name: 'Kitchen counter 2' } },
];

const summaryOf = (result: { structuredContent?: unknown }) => (result.structuredContent as { summary: DocumentSummary }).summary;
const kitchenNorth = (s: DocumentSummary): readonly EdgeSummary[] => (s.levels[0]?.rooms.find((r) => r.name === 'Kitchen') as RoomSummary).sides.north;

describe('the Phase 5 demo, through floorspec_apply and floorspec_describe', () => {
  it('places the devices, lists them on their wall faces with circuits, and follows a moved wall', async () => {
    const client = new ApplierClient(RANCH);
    const mcp = await connect(client);
    const placed = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: DEMO } });
    expect(placed.isError, texts(placed)).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ status: 'committed', created: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'] });

    const described = await mcp.callTool({ name: 'floorspec_describe', arguments: {} });
    const s = summaryOf(described);
    // Devices per wall: the kitchen's north wall lists its receptacles on the kitchen face, by offset, with their circuits.
    const devices = kitchenNorth(s).flatMap((e) => e.devices ?? []);
    expect(devices.map((d) => [d.id, d.kind, d.circuits])).toEqual([
      ['X2', 'FS_electrical:receptacles', ['C1']],
      ['X3', 'FS_electrical:receptacles', ['C1']],
      ['X4', 'FS_electrical:receptacles', ['C2']],
      ['X5', 'FS_electrical:receptacles', ['C2']],
    ]);
    expect(devices[0]?.height.baseUnits).toBe(42 * IN);
    expect(devices[0]?.offset.baseUnits).toBe(2 * FT);
    // The room's floor devices, and each element's room as its extension derives it.
    expect(s.levels[0]?.rooms.find((r) => r.name === 'Bath')?.devices).toEqual([{ id: 'X6', kind: 'FS_plumbing:fixtures', surface: 'floor' }]);
    expect(s.levels[0]?.elements?.find((e) => e.id === 'X2')).toMatchObject({ room: 'KIT', circuits: ['C1'] });
    // The circuits, derived: their loads, and connected load against capacity.
    expect(s.levels[0]?.circuits).toEqual([
      { id: 'C1', name: 'Kitchen counter 1', panel: 'X1', breaker: 20, volts: 120, poles: 1, loads: ['X2', 'X3'], connectedLoad: 0, capacity: 2400 },
      { id: 'C2', name: 'Kitchen counter 2', panel: 'X1', breaker: 20, volts: 120, poles: 1, loads: ['X4', 'X5'], connectedLoad: 0, capacity: 2400 },
    ]);
    const text = texts(described);
    expect(text).toContain("FS_electrical:receptacles X2 on this face: 2' 0\" (780288) from the wall's start, 3' 6\" (1365504) high, on circuit C1");
    expect(text).toContain('### Circuits (MAIN, FS_electrical)');
    expect(text).toContain('- C1 "Kitchen counter 1" on panel X1: 20 A, 120 V; loads X2, X3; connected 0 W of 2400 W (stated watts only; not a load calculation)');

    // Move the kitchen's north wall out a foot: the receptacles go with it, the toilet stays.
    const before = s.levels[0]?.elements ?? [];
    const moved = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1'" }] } });
    expect(moved.isError, texts(moved)).toBeFalsy();
    const after = summaryOf(await mcp.callTool({ name: 'floorspec_describe', arguments: { room: 'Kitchen' } }));
    for (const id of ['X2', 'X3', 'X4', 'X5']) {
      const a = before.find((e) => e.id === id)?.placement?.point;
      const b = after.levels[0]?.elements?.find((e) => e.id === id)?.placement?.point;
      expect([b?.[0], (b?.[1] ?? 0) - (a?.[1] ?? 0)]).toEqual([a?.[0], FT]);
    }
    expect(kitchenNorth(after).flatMap((e) => e.devices ?? []).map((d) => d.id)).toEqual(['X2', 'X3', 'X4', 'X5']);
    const bath = summaryOf(await mcp.callTool({ name: 'floorspec_describe', arguments: {} })).levels[0]?.elements?.find((e) => e.id === 'X6');
    expect(bath?.placement).toEqual(before.find((e) => e.id === 'X6')?.placement);
  });

  it('refuses a batch that leaves a circuit naming a removed receptacle, and says which', async () => {
    const client = new ApplierClient(RANCH);
    const mcp = await connect(client);
    await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: DEMO } });
    const refused = await mcp.callTool({ name: 'floorspec_apply', arguments: { batch: [{ op: 'removeElement', id: 'X2' }] } });
    expect(refused.isError).toBe(true);
    expect(texts(refused)).toContain('FS-ELEC-INV-003');
    const removed = await mcp.callTool({
      name: 'floorspec_apply',
      arguments: { batch: [{ op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C1/loads', value: ['X3'] }, { op: 'removeElement', id: 'X2' }] },
    });
    expect(removed.isError, texts(removed)).toBeFalsy();
  });
});
