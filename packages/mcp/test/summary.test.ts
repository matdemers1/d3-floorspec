/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { check } from '@floorspec/engine';
import { describe as group, expect, it } from 'vitest';
import { describe, describeJson, feetInches, segmentLength, sideOf, squareFeet, type EdgeSummary, type RoomSummary } from '../src/summary/index.js';

const HOUSES = ['three-room-house', 'two-bedroom-ranch', 'l-shaped-house'] as const;
const FT = 390144;
const text = (name: string): string => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const load = (name: string): Record<string, Record<string, Record<string, unknown>>> => JSON.parse(text(name)) as Record<string, Record<string, Record<string, unknown>>>;

function reversed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversed);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reversed(x)]),
    );
  return v;
}

const room = (name: string, id: string): RoomSummary => describeJson(text(name)).levels[0]!.rooms.find((r) => r.id === id)!;
const ids = (es: readonly EdgeSummary[]): string[] => es.map((e) => e.id);

group('the sample houses', () => {
  it('are valid Core 0.1 documents', () => {
    for (const h of HOUSES) expect(check(text(h)).valid).toBe(true);
  });

  it('include the conformance three-room house byte for byte', () => {
    const vendored = readFileSync(new URL('../../engine/standard/conformance/core/0.1/examples/001-three-room-house/input.json', import.meta.url), 'utf8');
    expect(text('three-room-house')).toBe(vendored);
  });
});

group('golden summaries', () => {
  for (const h of HOUSES) {
    it(`${h}: text`, async () => {
      await expect(describe(text(h))).toMatchFileSnapshot(`./golden/${h}.txt`);
    });
    it(`${h}: JSON`, async () => {
      await expect(`${JSON.stringify(describeJson(text(h)), null, 2)}\n`).toMatchFileSnapshot(`./golden/${h}.json`);
    });
  }
});

group('determinism', () => {
  it('does not depend on the order of a document’s members', () => {
    for (const h of HOUSES) {
      const a = describe(text(h));
      expect(describe(text(h))).toBe(a);
      expect(describe(reversed(JSON.parse(text(h))) as object)).toBe(a);
    }
  });
});

group('rooms', () => {
  it('reports net area exactly as the engine derives it, and ft² to one decimal', () => {
    for (const h of HOUSES) {
      const derived = check(text(h)).derived!;
      for (const r of describeJson(text(h)).levels[0]!.rooms) {
        expect(r.area!.squareBaseUnits).toBe(derived.rooms[r.id]!.area);
        expect(r.area!.squareFeet).toBe(squareFeet(BigInt(derived.rooms[r.id]!.area.replace('.5', '')) * 2n + (derived.rooms[r.id]!.area.endsWith('.5') ? 1n : 0n)));
      }
    }
  });

  it('reports bounding dimensions east–west by north–south, in ft-in and exact base units', () => {
    const liv = room('three-room-house', 'LIV');
    expect(liv.size!.eastWest).toEqual({ baseUnits: 7607808, ftIn: `19' 6"`, exact: true });
    expect(liv.size!.northSouth).toEqual({ baseUnits: 8973312, ftIn: `23' 0"`, exact: true });
  });

  it('puts each wall on the side its outward normal points to (Ops §3.4)', () => {
    const liv = room('three-room-house', 'LIV');
    expect(ids(liv.sides.north)).toEqual(['WN1']);
    // North to south down the east side: the separator to the kitchen, then the wall to the bedroom.
    expect(ids(liv.sides.east)).toEqual(['SK', 'WI1']);
    expect(ids(liv.sides.south)).toEqual(['WS2']);
    expect(ids(liv.sides.west)).toEqual(['WW']);
    const bed1 = room('two-bedroom-ranch', 'BED1');
    expect(ids(bed1.sides.west)).toEqual(['I6', 'I5']);
    const kit = room('two-bedroom-ranch', 'KIT');
    expect(kit.sides.south.map((e) => [e.kind, e.id])).toEqual([['separator', 'SEP']]);
  });

  it('says what is on the other side of every wall', () => {
    const liv = room('three-room-house', 'LIV');
    expect(liv.sides.north[0]!.otherSide).toEqual({ kind: 'exterior' });
    expect(liv.sides.east[0]!.otherSide).toEqual({ kind: 'room', id: 'KIT', name: 'Kitchen' });
    expect(liv.sides.east[1]!.otherSide).toEqual({ kind: 'room', id: 'BED', name: 'Bedroom' });
  });

  it('lists a wall’s openings with kind, width and position from the wall’s start, and where a door opens', () => {
    const liv = room('three-room-house', 'LIV');
    const [fd] = liv.sides.south[0]!.openings;
    expect(fd).toMatchObject({ id: 'FD', kind: 'door', fill: 'D36', width: { baseUnits: 1170432, ftIn: `3' 0"` }, offset: { baseUnits: 2340864, ftIn: `6' 0"` } });
    expect(fd!.swingsInto).toEqual({ kind: 'exterior' });
    const bd = liv.sides.east[1]!.openings[0]!;
    expect(bd).toMatchObject({ id: 'BD', kind: 'door', hinge: 'end', swing: 'right', swingsInto: { kind: 'room', id: 'BED' } });
    const lh = room('two-bedroom-ranch', 'LIV').sides.east.flatMap((e) => e.openings).find((o) => o.id === 'LH')!;
    expect(lh.kind).toBe('opening');
    expect(lh.swingsInto).toBeUndefined();
    expect(liv.sides.north[0]!.openings[0]).toMatchObject({ id: 'LW2', kind: 'window', width: { ftIn: `6' 0"` } });
  });

  it('lists the walls standing inside a room — a freestanding closet is a hole', () => {
    const bed = room('l-shaped-house', 'BED');
    expect(ids(bed.inside)).toEqual(['CE', 'CN', 'CS', 'CW']);
    for (const e of bed.inside) expect(e.otherSide).toEqual({ kind: 'unanchored', index: 1 });
  });
});

group('adjacency and the door graph', () => {
  it('pairs rooms that share a wall or a separator', () => {
    const l = describeJson(text('three-room-house')).levels[0]!;
    expect(l.adjacency.map((a) => [a.between.map((n) => (n.kind === 'room' ? n.id : n.kind)), a.walls, a.separators])).toEqual([
      [['BED', 'KIT'], ['WI2'], []],
      [['BED', 'LIV'], ['WI1'], []],
      [['KIT', 'LIV'], [], ['SK']],
    ]);
  });

  it('connects rooms through doors, empty openings and separators, and to the exterior', () => {
    const l = describeJson(text('two-bedroom-ranch')).levels[0]!;
    const links = l.doorGraph.map((d) => `${d.between.map((n) => (n.kind === 'room' ? n.id : n.kind)).join('-')}:${d.kind}:${d.via}`);
    expect(links).toEqual([
      'exterior-HALL:door:FD',
      'BATH-HALL:door:DB',
      'BED1-HALL:door:D1',
      'BED2-HALL:door:D2',
      'HALL-LIV:opening:LH',
      'KIT-LIV:separator:SEP',
    ]);
  });

  it('includes an unanchored face as a space of its own', () => {
    const l = describeJson(text('l-shaped-house')).levels[0]!;
    expect(l.doorGraph.find((d) => d.via === 'CD')!.between).toEqual([{ kind: 'room', id: 'BED', name: 'Primary suite' }, { kind: 'unanchored', index: 1 }]);
  });
});

group('unanchored faces and diagnostics', () => {
  it('reports an unanchored face with its area, size, boundary and an anchor that would place a room in it', () => {
    const doc = JSON.parse(text('l-shaped-house')) as Record<string, Record<string, unknown>>;
    const [u] = describeJson(doc).levels[0]!.unanchored;
    expect(u!.index).toBe(1);
    expect(u!.area.squareFeet).toBe('31.6');
    expect(ids(u!.boundary)).toEqual(['CE', 'CN', 'CS', 'CW']);
    // Use the suggested anchor: the face becomes a room and the lint goes away.
    doc['rooms']!['CLO'] = { level: 'MAIN', anchor: u!.suggestedAnchor, name: 'Closet', function: 'storage' };
    const after = describeJson(doc);
    expect(after.valid).toBe(true);
    expect(after.levels[0]!.unanchored).toEqual([]);
    expect(after.diagnostics).toEqual([]);
    expect(after.levels[0]!.rooms.find((r) => r.id === 'CLO')!.area!.squareFeet).toBe('31.6');
  });

  it('carries the validator’s open diagnostics', () => {
    expect(describeJson(text('l-shaped-house')).diagnostics).toEqual([
      { code: 'FS-LINT-003', severity: 'info', elements: [], message: 'A bounded face on MAIN has no room anchored in it.', level: 'MAIN' },
    ]);
  });

  it('describes an invalid document as far as it can, errors first', () => {
    const doc = load('three-room-house');
    doc['rooms']!['LIV']!['anchor'] = [-FT, -FT];
    const s = describeJson(doc);
    expect(s.valid).toBe(false);
    expect(s.diagnostics.map((d) => d.code)).toContain('FS-INV-201');
    const liv = s.levels[0]!.rooms.find((r) => r.id === 'LIV')!;
    expect(liv.placed).toBe(false);
    expect(s.levels[0]!.unanchored).toHaveLength(1);
    const t = describe(doc);
    expect(t).toContain('The document is NOT valid');
    expect(t).toContain('Not placed: its anchor');
  });

  it('describes a document that does not parse by its diagnostics alone', () => {
    const s = describeJson('{"floorspec": ');
    expect(s.valid).toBe(false);
    expect(s.levels).toEqual([]);
    expect(describe('{"floorspec": ')).toContain('FS-JSON-001');
  });
});

group('options', () => {
  it('narrows to one room: its section, its links, its diagnostics', () => {
    const t = describe(text('three-room-house'), { room: 'KIT' });
    expect(t).toContain('### KIT "Kitchen"');
    expect(t).not.toContain('### LIV');
    expect(t).toContain('KIT "Kitchen" | LIV "Living room": separator SK');
    expect(t).not.toContain('BED "Bedroom" | LIV');
    const j = describeJson(text('l-shaped-house'), { room: 'KIT' });
    expect(j.diagnostics).toEqual([]);
  });

  it('narrows to one level', () => {
    const s = describeJson(text('l-shaped-house'), { level: 'MAIN' });
    expect(s.levels.map((l) => l.id)).toEqual(['MAIN']);
    expect(s.diagnostics).toHaveLength(1);
  });

  it('refuses a room or level the document does not have', () => {
    expect(() => describe(text('three-room-house'), { room: 'GARAGE' })).toThrow(RangeError);
    expect(() => describe(text('three-room-house'), { level: 'ATTIC' })).toThrow(RangeError);
  });
});

group('oblique walls', () => {
  it('reports an irrational length rounded, and marked as not exact', () => {
    // A 3-4-5 triangle has an exact hypotenuse; a 1-1-√2 one does not.
    expect(segmentLength(BigInt(3 * FT) ** 2n + BigInt(4 * FT) ** 2n)).toEqual({ baseUnits: 5 * FT, ftIn: `5' 0"`, exact: true });
    const d = segmentLength(2n * BigInt(FT) ** 2n);
    expect(d.exact).toBe(false);
    expect(d.baseUnits).toBe(Math.round(Math.SQRT2 * FT));
    expect(d.ftIn).toBe(`1' 5"`);
  });

  it('sides a 45° wall counter-clockwise before it (Ops §3.4)', () => {
    expect(sideOf(1n, 1n)).toBe('east');
    expect(sideOf(-1n, 1n)).toBe('north');
    expect(sideOf(-1n, -1n)).toBe('west');
    expect(sideOf(1n, -1n)).toBe('south');
    expect(sideOf(1n, 0n)).toBe('east');
    expect(sideOf(0n, 1n)).toBe('north');
    expect(sideOf(-1n, 0n)).toBe('west');
    expect(sideOf(0n, -1n)).toBe('south');
    expect(sideOf(2n, 1n)).toBe('east');
    expect(sideOf(1n, 2n)).toBe('north');
  });

  it('describes a room with a chamfered corner', () => {
    const doc = load('three-room-house');
    // Cut the north-west corner of the living room with a 45° wall from (0, 18') to (6', 24').
    const j = doc['junctions']!;
    j['CA'] = { level: 'MAIN', position: [0, 18 * FT] };
    j['CB'] = { level: 'MAIN', position: [6 * FT, 24 * FT] };
    delete j['C2'];
    const w = doc['walls']!;
    w['WW'] = { ...w['WW'], end: 'CA' };
    w['WC'] = { level: 'MAIN', start: 'CA', end: 'CB', type: 'EXT26', justification: 'coreFace' };
    w['WN1'] = { ...w['WN1'], start: 'CB' };
    delete doc['openings']!['LW2'];
    expect(check(doc).valid).toBe(true);
    const liv = describeJson(doc).levels[0]!.rooms.find((r) => r.id === 'LIV')!;
    // The chamfer's outward normal is (−1, 1)·k: north-west, which Ops §3.4 puts on the north side.
    expect(ids(liv.sides.north)).toEqual(['WC', 'WN1']);
    const wc = liv.sides.north[0]!;
    expect(wc.length.exact).toBe(false);
    expect(wc.length.ftIn).toBe(feetInches(Math.round(6 * FT * Math.SQRT2)));
    expect(describe(doc)).toContain(`wall WC, ≈8' 5-13/16"`);
  });
});

group('Core 0.2: the program and extension elements', () => {
  function briefed(): Record<string, unknown> {
    const d = load('three-room-house') as Record<string, unknown> & { rooms: Record<string, Record<string, unknown>> };
    d.floorspec = '0.2';
    d.rooms['BED']!.brief = 'BEDS';
    d.rooms['KIT']!.brief = 'KITCHEN';
    d.program = {
      items: { BEDS: { function: 'sleeping', name: 'Bedrooms', count: 2, minArea: 1 }, KITCHEN: { function: 'kitchen' } },
      adjacency: [{ a: 'KITCHEN', b: 'BEDS', kind: 'forbidden' }],
    };
    d.extensionsUsed = { FS_furniture: '0.1' };
    d.extensions = {
      FS_furniture: {
        collections: {
          pieces: {
            BED1: {
              name: 'Queen bed',
              fallback: { level: 'MAIN', box: { min: [0, 0, 0], max: [1600000, 2000000, 600000] } },
              host: { mode: 'surface', room: 'BED', surface: 'floor', position: d.rooms['BED']!.anchor, rotation: 90000000 },
            },
          },
        },
      },
    };
    return d;
  }

  it('lists every item with its rooms, met or unmet, and every adjacency', () => {
    const s = describeJson(briefed());
    expect(s.valid).toBe(true);
    expect(s.program!.items).toEqual([
      { id: 'BEDS', name: 'Bedrooms', function: 'sleeping', count: 2, rooms: ['BED'], countMet: false, minAreaMet: true },
      { id: 'KITCHEN', function: 'kitchen', count: 1, rooms: ['KIT'], countMet: true },
    ]);
    expect(s.program!.adjacency).toHaveLength(1);
    expect(s.program!.adjacency[0]).toMatchObject({ a: 'KITCHEN', b: 'BEDS', kind: 'forbidden' });
    const t = describe(briefed());
    expect(t).toContain('## Program');
    expect(t).toContain('- BEDS "Bedrooms" — sleeping: 1 of 2 rooms (BED), count NOT met, minimum area met');
  });

  it('lists extension elements by level, with their hosts and placements, and in a room section', () => {
    const s = describeJson(briefed());
    const [bed, ...more] = s.levels[0]!.elements!;
    expect(more).toEqual([]);
    expect(bed).toMatchObject({ id: 'BED1', name: 'Queen bed', kind: 'FS_furniture:pieces', host: { mode: 'surface', room: 'BED', surface: 'floor' } });
    expect(bed!.placement).toEqual({ point: [10924032, 2340864, 0], facing: 90000000 });
    expect(describe(briefed())).toContain('- FS_furniture:pieces BED1 "Queen bed": on the floor of BED; at [');
    expect(describeJson(briefed(), { room: 'BED' }).levels[0]!.elements!.map((e) => e.id)).toEqual(['BED1']);
    expect(describeJson(briefed(), { room: 'KIT' }).levels[0]!.elements).toEqual([]);
  });

  it('says nothing new about a 0.1 document', () => {
    const s = describeJson(text('three-room-house'));
    expect(s.program).toBeUndefined();
    expect(s.levels[0]!.elements).toBeUndefined();
  });
});
