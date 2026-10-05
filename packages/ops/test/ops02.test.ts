/**
 * Ops 0.2 beside Ops 0.1 (0.4): the draft is chosen per call; Ops 0.1 is exactly the published
 * draft, and Ops 0.2 — the default — adds the program and extension elements as edit targets.
 * The conformance suites are the oracle; these are the applier's own readable examples.
 */
import { describe, expect, it } from 'vitest';
import { apply, OPS_VERSION, parseArea, resolveBatch, type ApplyResult } from '../src/index.js';
import { committed, pair, rejectedWith } from './doc.js';

/** The two-room plan, as a Core 0.2 document that uses FS_electrical and FS_furniture. */
const pair02 = (): Record<string, unknown> => ({
  ...pair(),
  floorspec: '0.2',
  extensionsUsed: { FS_electrical: '0.1.0', FS_furniture: '0.1.0' },
});

const box = { min: [0, -51200, 0], max: [25600, 51200, 128000] };
const outlet = (host: Record<string, unknown>): Record<string, unknown> => ({ op: 'placeElement', extension: 'FS_electrical', collection: 'devices', host, element: { fallback: { box }, device: 'receptacle' } });
const doc = (r: ApplyResult): Record<string, unknown> => JSON.parse(committed(r).document) as Record<string, unknown>;
const devices = (d: Record<string, unknown>): Record<string, { host: Record<string, unknown>; fallback: Record<string, unknown> }> =>
  (d.extensions as Record<string, { collections: Record<string, unknown> }>).FS_electrical!.collections.devices as never;

describe('choosing the draft', () => {
  it('applies Ops 0.2 by default', () => {
    expect(OPS_VERSION).toBe('0.2');
    committed(apply(pair02(), { batch: [{ op: 'addProgramItem', function: 'kitchen' }] }));
  });

  it('as Ops 0.1, reads Core 0.1 documents only', () => {
    rejectedWith(apply(pair02(), { batch: [{ op: 'removeElement', id: 'RA' }] }, { ops: '0.1' }), 'FS-OPS-002', []);
    committed(apply(pair(), { batch: [{ op: 'removeElement', id: 'RA' }] }, { ops: '0.1' }));
  });

  it("as Ops 0.1, rejects 0.2's operations and members with FS-OPS-001", () => {
    for (const op of [
      { op: 'addLevel', building: 'B1', above: 'L1', height: "8'" },
      { op: 'moveOpening', opening: 'O1', by: "1'" },
      { op: 'addProgramItem', function: 'kitchen' },
      { op: 'setAdjacency', a: 'P1', b: 'P2', kind: 'required' },
      { op: 'addRoom', level: 'L1', at: [1, 1], brief: 'P1' },
      { op: 'addElement', collection: 'items', element: { function: 'kitchen' } },
    ])
      rejectedWith(apply(pair(), { batch: [op] }, { ops: '0.1' }), 'FS-OPS-001');
  });

  it('gives the same result for a 0.1 request on a 0.1 document under either draft', () => {
    const request = { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1' 3\"" }, { op: 'setRoomFinish', room: 'Dining', surface: 'floor', material: 'M1' }], context: { retired: ['W9'] } };
    const d = pair(undefined, undefined, { materials: { M1: { name: 'Oak' } } });
    expect(JSON.stringify(apply(d, request, { ops: '0.2' }))).toBe(JSON.stringify(apply(d, request, { ops: '0.1' })));
  });

  it('keeps a 0.1 document 0.1 unless the batch says otherwise', () => {
    expect(doc(apply(pair(), { batch: [{ op: 'moveWall', wall: 'W7', by: 1000 }] })).floorspec).toBe('0.1');
    // A program in a document that declares "0.1" is not a member: the result is invalid.
    expect(apply(pair(), { batch: [{ op: 'addProgramItem', function: 'kitchen' }] }).status).toBe('rejected');
    // Declaring "0.2" in the same batch makes it a program item.
    const r = committed(apply(pair(), { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' }, { op: 'addProgramItem', function: 'kitchen', name: 'Kitchen' }] }));
    expect(r.created).toEqual(['P1']);
    // …and its inverse gives back the 0.1 document, without a program.
    const back = committed(apply(r.document, { batch: r.inverse }));
    expect(JSON.parse(back.document)).toEqual(JSON.parse(committed(apply(pair(), { batch: [{ op: 'moveJunction', id: 'J1', to: [0, 0] }] })).document));
  });

  it('refuses a draft it does not implement', () => {
    expect(() => apply(pair(), { batch: [{ op: 'removeElement', id: 'RA' }] }, { ops: '0.3' as never })).toThrow(RangeError);
  });
});

describe('the program (Ops 0.2)', () => {
  it('draws a bubble diagram and gives rooms their briefs', () => {
    const r = committed(
      apply(pair02(), {
        batch: [
          { op: 'addProgramItem', function: 'kitchen', name: 'Cook', minArea: '8 m2' },
          { op: 'addProgramItem', id: 'DIN', function: 'dining', name: 'Eat', targetArea: '120 sq ft', level: 'L1' },
          { op: 'setAdjacency', a: 'Cook', b: 'Eat', kind: 'required', weight: 10 },
          { op: 'setAdjacency', a: 'DIN', b: 'item Cook', kind: 'required', weight: 8 },
          { op: 'setRoomBrief', room: 'Kitchen', item: 'Cook' },
          { op: 'setRoomBrief', room: 'Dining', item: 'item Eat' },
        ],
      }),
    );
    expect(r.created).toEqual(['DIN', 'P1']);
    const d = doc(r) as { program: { items: Record<string, Record<string, unknown>>; adjacency: unknown[] }; rooms: Record<string, Record<string, unknown>> };
    expect(d.program.items.P1).toEqual({ function: 'kitchen', name: 'Cook', minArea: 8 * 1_638_400_000_000 });
    expect(d.program.items.DIN!.targetArea).toBe(Number(parseArea('120 sq ft').ok && 120n * 152_212_340_736n));
    // The pair is unordered: the second setAdjacency replaced the first where it stood.
    expect(d.program.adjacency).toEqual([{ a: 'DIN', b: 'P1', kind: 'required', weight: 8 }]);
    expect(d.rooms.RA!.brief).toBe('P1');
    expect(d.rooms.RB!.brief).toBe('DIN');
    // An item a room's brief names cannot be removed; brief of <room> resolves it.
    rejectedWith(apply(r.document, { batch: [{ op: 'removeElement', id: 'brief of Kitchen' }] }), 'FS-OPS-006', ['P1', 'RA']);
    // A plain string is the room everywhere but where an item is expected.
    expect(resolveBatch(r.document, { batch: [{ op: 'setProperty', id: 'Eat', path: '/count', value: 2 }] }).status).toBe('rejected');
    const undo = committed(apply(r.document, { batch: r.inverse }));
    expect(undo.document).toBe(committed(apply(pair02(), { batch: [{ op: 'moveJunction', id: 'J1', to: [0, 0] }] })).document);
  });

  it('reads areas exactly', () => {
    expect(parseArea('11 m2')).toEqual({ ok: true, value: 11n * 1_638_400_000_000n });
    expect(parseArea('11 M²')).toEqual({ ok: true, value: 11n * 1_638_400_000_000n });
    expect(parseArea('1600 in2')).toEqual({ ok: true, value: 1600n * 1_057_030_144n });
    expect(parseArea('0.5 sq ft')).toEqual({ ok: true, value: 76_106_170_368n });
    expect(parseArea('-3 m2').ok).toBe(false);
    expect(parseArea('3 m 2').ok).toBe(false);
    rejectedWith(apply(pair02(), { batch: [{ op: 'addProgramItem', function: 'kitchen', minArea: '11 acres' }] }), 'FS-OPS-012');
  });
});

describe('placing devices (Ops 0.2)', () => {
  it('places an outlet on the face looking into a room, and it follows its wall', () => {
    const r = committed(apply(pair02(), { batch: [outlet({ mode: 'wallFace', wall: 'wall between Kitchen and Dining', toward: 'Dining', at: '2\' from start', height: '12"' })] }));
    expect(r.created).toEqual(['X1']);
    const x1 = devices(doc(r)).X1!;
    expect(x1.host).toEqual({ mode: 'wallFace', wall: 'W7', side: 'right', offset: 2 * 390144, height: 12 * 32512 });
    expect(x1.fallback.level).toBe('L1');
    // Moving the wall changes no byte of the outlet (2.7).
    const moved = committed(apply(r.document, { batch: [{ op: 'moveWall', wall: 'W7', by: "1'", toward: 'Dining' }] }));
    expect(devices(doc(moved)).X1).toEqual(x1);
    // Removing the wall is blocked by it, and cascade takes it.
    rejectedWith(apply(r.document, { batch: [{ op: 'removeElement', id: 'W7' }] }), 'FS-OPS-006', ['W7', 'X1']);
    expect(committed(apply(r.document, { batch: [{ op: 'removeWall', wall: 'W7', keep: 'Kitchen' }] })).removed).toEqual(['RB', 'W7', 'X1']);
  });

  it('moves a device to another host, and a toilet with its room', () => {
    const placed = committed(
      apply(pair02(), {
        batch: [
          outlet({ mode: 'wallFace', wall: 'W1', side: 'left', at: 'centered', height: 0 }),
          { op: 'placeElement', extension: 'FS_furniture', collection: 'pieces', host: { mode: 'surface', room: 'Dining', surface: 'floor', at: [5000000, 1000000] }, element: { fallback: { box } } },
        ],
      }),
    );
    expect(placed.created).toEqual(['X1', 'X2']);
    const moved = committed(apply(placed.document, { batch: [{ op: 'moveElement', element: 'X1', host: { mode: 'surface', room: 'Kitchen', surface: 'ceiling', at: [100000, 100000] } }] }));
    expect(devices(doc(moved)).X1!.host).toEqual({ mode: 'surface', room: 'RA', surface: 'ceiling', position: [100000, 100000] });
    const r = committed(apply(placed.document, { batch: [{ op: 'moveRoom', room: 'Dining', by: '1 m north' }] }));
    const pieces = (doc(r).extensions as Record<string, { collections: Record<string, Record<string, { host: { position: number[] } }>> }>).FS_furniture!.collections.pieces!;
    expect(pieces.X2!.host.position).toEqual([5000000, 2280000]);
  });
});
