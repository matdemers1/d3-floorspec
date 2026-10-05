/**
 * Arc walls in the editor (Core 0.4, chapter 21; FLR-T-11.1): the batch the arc tool sends, the views the
 * plan draws, and the pointer arithmetic of the tool and of openings placed along an arc.
 */
import { describe, expect, it } from 'vitest';
import { apply, type Operation } from '@floorspec/ops';
import { arcPoints, distanceToLine, pointAtStation, sagittaFromRadius, sagittaToward, stationOf } from '../src/editor/arcs';
import { readModel, arcInfo, type EditorModel, type Point, type WallView } from '../src/editor/model';
import { drawArcWall, setArc, typeChoices, type Batch } from '../src/editor/ops';
import { snapOpeningOn } from '../src/editor/snap';

const FT = 390144;
const IN = 32512;

type Doc = Record<string, unknown> & { walls: Record<string, object>; rooms: Record<string, Record<string, unknown>> };

/** A 24' by 16' Core 0.4 room, drawn clockwise, its walls 6" thick. */
function room(): Doc {
  const J = (x: number, y: number) => ({ level: 'L1', position: [x * FT, y * FT] });
  const W = (start: string, end: string) => ({ level: 'L1', start, end, type: 'T6' });
  return {
    floorspec: '0.4',
    project: { name: 'Arc room' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 9 * FT } },
    types: { T6: { kind: 'wallType', name: '6 in', layers: [{ thickness: 6 * IN, function: 'core' }] } },
    junctions: { J1: J(0, 0), J2: J(0, 16), J3: J(24, 16), J4: J(24, 0) },
    walls: { W1: W('J1', 'J2'), W2: W('J2', 'J3'), W3: W('J3', 'J4'), W4: W('J4', 'J1') },
    rooms: { R1: { level: 'L1', anchor: [12 * FT, 8 * FT], name: 'Living' } },
  };
}

function commit(doc: object, batch: Batch): EditorModel {
  const r = apply(doc, { batch });
  if (r.status !== 'committed') throw new Error(JSON.stringify(r.diagnostics));
  return readModel(r.hash, r.document);
}

function wallOf(m: EditorModel, test: (w: WallView) => boolean): WallView {
  const w = m.levels[0]?.walls.find(test);
  if (w === undefined) throw new Error('no such wall');
  return w;
}

const areaOf = (m: EditorModel, room: string): bigint => m.levels[0]?.faces.find((f) => f.room === room)?.area2 ?? 0n;

describe('the arc tool', () => {
  it('draws an arc wall as drawWall and its arc in one batch', () => {
    const doc = room();
    const model = readModel('a', doc);
    const T6 = typeChoices(model.document, 'wallType').find((c) => c.id === 'T6');
    const ends = [
      { point: [0, 16 * FT] as Point, junction: 'J2' },
      { point: [24 * FT, 16 * FT] as Point, junction: 'J3' },
    ] as const;
    expect(drawArcWall(model.document, 'L1', ends[0], ends[1], 3 * FT, { type: T6 })(0).map((o) => o.op)).toEqual(['drawWall', 'setProperty']);
    // The north wall drawn again as an arc between the same two junctions, in a plan without the straight
    // one (two edges between one pair is no plan, Core 5.2.2) - and its room, which needs a closed face.
    const { W1, W3, W4 } = doc.walls;
    const open = { ...doc, walls: { W1, W3, W4 }, rooms: {} };
    const arc = drawArcWall(readModel('b', open).document, 'L1', ends[0], ends[1], 3 * FT, { type: T6 })(0);
    const addRoom: Operation = { op: 'addElement', collection: 'rooms', id: 'R1', element: { level: 'L1', anchor: [12 * FT, 8 * FT], name: 'Living' } };
    const m = commit(open, [...arc, addRoom]);
    const w = wallOf(m, (x) => x.arc !== undefined);
    expect(w.arc?.sagitta).toBe(3 * FT);
    expect(w.line.length).toBeGreaterThan(20);
    expect(w.ring.length).toBeGreaterThan(w.line.length);
    // A room bounded by an arc grows by the segment the arc adds.
    expect(areaOf(m, 'R1') > areaOf(model, 'R1')).toBe(true);
  });

  it('draws a straight wall for a sagitta of zero', () => {
    const batch = drawArcWall(readModel('a', room()).document, 'L1', { point: [0, 0] }, { point: [FT, 0] }, 0, {})(0);
    expect(batch.map((o) => o.op)).toEqual(['drawWall']);
  });

  it('bends, flips and straightens a wall', () => {
    expect(setArc('W2', 1000)).toEqual([{ op: 'setProperty', id: 'W2', path: '/arc', value: { sagitta: 1000 } }]);
    expect(setArc('W2', null)).toEqual([{ op: 'unsetProperty', id: 'W2', path: '/arc' }]);
    const bent = commit(room(), setArc('W2', 2 * FT));
    const flipped = commit(bent.document, setArc('W2', -2 * FT));
    const w = wallOf(flipped, (x) => x.id === 'W2');
    expect(w.arc?.sagitta).toBe(-2 * FT);
    // Inward: every vertex of its polyline is south of the chord.
    expect(w.line.slice(1, -1).every((p) => p[1] < 16 * FT)).toBe(true);
    expect(areaOf(flipped, 'R1') < areaOf(bent, 'R1')).toBe(true);
  });
});

describe('arc measures', () => {
  it('gives the radius, sweep and chord of the Figma example: 12 ft chord, 2 ft sagitta', () => {
    const a = arcInfo(12 * FT, 2 * FT, 0);
    expect(a.radius / FT).toBeCloseTo(10, 9);
    expect(a.sweep).toBeCloseTo(73.74, 2);
  });

  it('takes the sagitta toward the pointer, at most half the chord', () => {
    expect(sagittaToward([0, 0], [100, 0], [50, 30])).toBe(30);
    expect(sagittaToward([0, 0], [100, 0], [50, -30])).toBe(-30);
    expect(sagittaToward([0, 0], [100, 0], [50, 500])).toBe(50);
  });

  it('turns a radius into a sagitta', () => {
    expect(sagittaFromRadius(12 * FT, 10 * FT, 1)).toBe(2 * FT);
    expect(sagittaFromRadius(12 * FT, 10 * FT, -1)).toBe(-2 * FT);
    expect(sagittaFromRadius(12, 1, 1)).toBe(6); // a radius below half the chord is a semicircle
  });

  it('draws a draft arc through its ends, bulging to the left for a positive sagitta', () => {
    const pts = arcPoints([0, 0], [100, 0], 25);
    expect(pts[0]?.[0]).toBeCloseTo(0, 9);
    expect(pts.at(-1)?.[0]).toBeCloseTo(100, 9);
    expect(pts[24]?.[1]).toBeCloseTo(25, 6);
  });
});

describe('openings along an arc', () => {
  const line: Point[] = [
    [0, 0],
    [3000, 4000],
    [3000, 10000],
  ];

  it('reads a pointer as a station and a distance across', () => {
    const st = stationOf(line, [3100, 6000]);
    expect(st.along).toBeCloseTo(7000, 6);
    expect(st.across).toBeCloseTo(-100, 6);
    expect(st.L).toBe(11000);
    expect(pointAtStation(line, 2500)).toEqual([1500, 2000]);
    expect(distanceToLine([3100, 6000], line)).toBeCloseTo(100, 6);
  });

  it('places an opening by its station on an arc wall', () => {
    const snap = snapOpeningOn({ a: [0, 0], b: [3000, 10000], line, arc: { length: 11000 } }, 1000, [3050, 6000], { tol: 10, grid: 100 });
    expect(snap.offset).toBe(6500);
    expect(snap.fits).toBe(true);
  });
});
