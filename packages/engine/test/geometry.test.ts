/**
 * Hand-computed geometry (chapters 5–7). Every expected value below is worked out from the spec's
 * definitions in the comments, not copied from the engine's output.
 */
import { describe, expect, it } from 'vitest';
import { check } from '../src/index.js';
import { box, codes, doc } from './doc.js';

const T = 12800; // 10 mm: a = b = 6400 when centred

function derived(spec: Parameters<typeof doc>[0]) {
  const r = check(doc(spec));
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.derived!;
}

describe('face ends (5.6, 5.7)', () => {
  it('a free end is cut square: both feet of the junction', () => {
    const d = derived({ junctions: { J1: [0, 0], J2: [1000000, 0] }, walls: { W1: { start: 'J1', end: 'J2', t: T } } });
    // Leaving J1 east, n = (0, 1): the left face line is y = 6400, the right y = −6400.
    expect(d.walls.W1).toEqual({
      startRight: [0, -6400],
      endRight: [1000000, -6400],
      endLeft: [1000000, 6400],
      startLeft: [0, 6400],
      baseElevation: 0,
      topElevation: 3200000,
    });
  });

  it('an L corner mitres at the exact inside and outside corners', () => {
    const d = derived({
      junctions: { J1: [0, 0], J2: [1000000, 0], J3: [1000000, 1000000] },
      walls: { W1: { start: 'J1', end: 'J2', t: T }, W2: { start: 'J2', end: 'J3', t: T } },
    });
    // At J2: e0 = W2 (90°), e1 = W1 (180°). Wedge 0 = W2's left (x = 993600) ∩ W1's right
    // (y = 6400); wedge 1 = W1's left (y = −6400) ∩ W2's right (x = 1006400).
    expect(d.walls.W1).toMatchObject({ endRight: [1006400, -6400], endLeft: [993600, 6400] });
    expect(d.walls.W2).toMatchObject({ startLeft: [993600, 6400], startRight: [1006400, -6400] });
    expect(d.junctionFills).toEqual({});
  });

  it('odd thickness: half a base unit rounds to even (2.2)', () => {
    const d1 = derived({ junctions: { J1: [0, 0], J2: [1000000, 0] }, walls: { W1: { start: 'J1', end: 'J2', t: 1281 } } });
    // a = 640.5 → 640; −640.5 → −640
    expect(d1.walls.W1).toMatchObject({ startLeft: [0, 640], startRight: [0, -640] });
    const d2 = derived({ junctions: { J1: [0, 0], J2: [1000000, 0] }, walls: { W1: { start: 'J1', end: 'J2', t: 1279 } } });
    // a = 639.5 → 640
    expect(d2.walls.W1).toMatchObject({ startLeft: [0, 640], startRight: [0, -640] });
  });

  it('a 3-4-5 oblique wall: n/|d| = (−4/5, 3/5)', () => {
    const d = derived({ junctions: { J1: [0, 0], J2: [768000, 1024000] }, walls: { W1: { start: 'J1', end: 'J2', t: T } } });
    // |d| = 1280000; 6400 · (−0.8, 0.6) = (−5120, 3840)
    expect(d.walls.W1).toMatchObject({
      startLeft: [-5120, 3840],
      startRight: [5120, -3840],
      endRight: [773120, 1020160],
      endLeft: [762880, 1027840],
    });
  });

  it('an irrational offset rounds once: a 45° wall', () => {
    const d = derived({ junctions: { J1: [0, 0], J2: [1000000, 1000000] }, walls: { W1: { start: 'J1', end: 'J2', t: T } } });
    // 6400/√2 = 4525.483… → 4525
    expect(d.walls.W1).toMatchObject({ startLeft: [-4525, 4525], startRight: [4525, -4525] });
  });

  it('a collinear step: unequal offsets meet in a step of two feet', () => {
    const d = derived({
      junctions: { J1: [0, 0], J2: [1000000, 0], J3: [2000000, 0] },
      walls: { W1: { start: 'J1', end: 'J2', t: T }, W2: { start: 'J2', end: 'J3', t: 2 * T } },
    });
    expect(d.walls.W1).toMatchObject({ endRight: [1000000, -6400], endLeft: [1000000, 6400] });
    expect(d.walls.W2).toMatchObject({ startLeft: [1000000, 12800], startRight: [1000000, -12800] });
  });

  it('justification moves the location line to a face (5.4)', () => {
    const d = derived({
      junctions: { J1: [0, 0], J2: [1000000, 0] },
      walls: { W1: { start: 'J1', end: 'J2', t: T, justification: 'exteriorFace' } },
    });
    expect(d.walls.W1).toMatchObject({ startLeft: [0, 0], startRight: [0, -12800] });
    const c = derived({
      junctions: { J1: [0, 0], J2: [1000000, 0] },
      walls: {
        W1: {
          start: 'J1',
          end: 'J2',
          justification: 'coreFace',
          layers: [
            { thickness: 2000, function: 'finish' },
            { thickness: 10000, function: 'core' },
            { thickness: 1000, function: 'finish' },
          ],
        },
      },
    });
    // a = 2000 (the layers before the first core), b = 11000
    expect(c.walls.W1).toMatchObject({ startLeft: [0, 2000], startRight: [0, -11000] });
  });
});

describe('junction fills (5.7)', () => {
  it('a T leaves a triangle', () => {
    const d = derived({
      junctions: { J1: [0, 0], J2: [1000000, 0], J3: [2000000, 0], J4: [1000000, 1000000] },
      walls: { W1: { start: 'J1', end: 'J2', t: T }, W2: { start: 'J2', end: 'J3', t: T }, W3: { start: 'J2', end: 'J4', t: T } },
    });
    // Wedges at J2: W2→W3 (1006400, 6400); W3→W1 (993600, 6400); W1→W2 opposite, one foot (1000000, −6400).
    expect(d.junctionFills).toEqual({ J2: [[993600, 6400], [1000000, -6400], [1006400, 6400]] });
  });

  it('an X leaves a square', () => {
    const d = derived({
      junctions: { J0: [0, 0], J1: [1000000, 0], J2: [0, 1000000], J3: [-1000000, 0], J4: [0, -1000000] },
      walls: {
        W1: { start: 'J0', end: 'J1', t: T },
        W2: { start: 'J0', end: 'J2', t: T },
        W3: { start: 'J0', end: 'J3', t: T },
        W4: { start: 'J0', end: 'J4', t: T },
      },
    });
    expect(d.junctionFills).toEqual({ J0: [[-6400, -6400], [6400, -6400], [6400, 6400], [-6400, 6400]] });
  });
});

describe('butt joins (5.8)', () => {
  it('one through wall: A runs to the outer corner, B stops against it', () => {
    const d = derived({
      junctions: { J1: [0, 0], J2: { position: [1000000, 0], join: { kind: 'butt', through: ['W1'] } }, J3: [1000000, 1000000] },
      walls: { W1: { start: 'J1', end: 'J2', t: T }, W2: { start: 'J2', end: 'J3', t: T } },
    });
    // Convex wedge W2→W1: c = (993600, 6400); r = (1006400, −6400);
    // p = A's right (y = 6400) ∩ B's right (x = 1006400) = (1006400, 6400).
    expect(d.walls.W1).toMatchObject({ endRight: [1006400, -6400], endLeft: [1006400, 6400] });
    expect(d.walls.W2).toMatchObject({ startLeft: [993600, 6400], startRight: [1006400, 6400] });
  });

  it('two through walls: a square cut through J; the stem stops on their face; no fill', () => {
    const d = derived({
      junctions: {
        J1: [0, 0],
        J2: { position: [1000000, 0], join: { kind: 'butt', through: ['W1', 'W2'] } },
        J3: [2000000, 0],
        J4: [1000000, 1000000],
      },
      walls: { W1: { start: 'J1', end: 'J2', t: T }, W2: { start: 'J2', end: 'J3', t: T }, W3: { start: 'J2', end: 'J4', t: T } },
    });
    expect(d.walls.W1).toMatchObject({ endRight: [1000000, -6400], endLeft: [1000000, 6400] });
    expect(d.walls.W2).toMatchObject({ startLeft: [1000000, 6400], startRight: [1000000, -6400] });
    expect(d.walls.W3).toMatchObject({ startLeft: [993600, 6400], startRight: [1006400, 6400] });
    expect(d.junctionFills).toEqual({});
  });

  it('rooms are the same under any join', () => {
    const mitre = derived(box(4000000, 3000000, T, { rooms: { R1: [2000000, 1500000] } }));
    const spec = box(4000000, 3000000, T, { rooms: { R1: [2000000, 1500000] } });
    spec.junctions.J2 = { position: [0, 3000000], join: { kind: 'butt', through: ['W1'] } };
    const butt = derived(spec);
    expect(butt.rooms).toEqual(mitre.rooms);
  });
});

describe('rooms (6.1–6.4)', () => {
  const W = 4000000;
  const H = 3000000;

  it('a box: the polygon inside the finished walls, from its least vertex, counter-clockwise', () => {
    const d = derived(box(W, H, T, { rooms: { R1: [2000000, 1500000] } }));
    const area = BigInt(W - T) * BigInt(H - T);
    expect(d.rooms.R1).toEqual({
      outer: [[6400, 6400], [W - 6400, 6400], [W - 6400, H - 6400], [6400, H - 6400]],
      holes: [],
      area: area.toString(),
    });
    expect(d.unanchored).toEqual([]);
  });

  it('a room with a hole: a freestanding chase is a clockwise hole ring', () => {
    const spec = box(W, H, T, { rooms: { R1: [500000, 500000] } });
    Object.assign(spec.junctions, { K1: [1000000, 1000000], K2: [1000000, 2000000], K3: [2000000, 2000000], K4: [2000000, 1000000] });
    Object.assign(spec.walls!, {
      C1: { start: 'K1', end: 'K2', t: T },
      C2: { start: 'K2', end: 'K3', t: T },
      C3: { start: 'K3', end: 'K4', t: T },
      C4: { start: 'K4', end: 'K1', t: T },
    });
    const r = check(doc(spec));
    expect(codes(r)).toEqual(['FS-LINT-003']); // the inside of the chase
    const d = r.derived!;
    expect(d.rooms.R1!.holes).toEqual([[[993600, 993600], [993600, 2006400], [2006400, 2006400], [2006400, 993600]]]);
    const area = BigInt(W - T) * BigInt(H - T) - 1012800n * 1012800n;
    expect(d.rooms.R1!.area).toBe(area.toString());
    expect(d.unanchored).toEqual([
      { level: 'L1', outer: [[1006400, 1006400], [1993600, 1006400], [1993600, 1993600], [1006400, 1993600]], holes: [], area: (987200n * 987200n).toString() },
    ]);
  });

  it('a dangling wall: the ring goes around it', () => {
    const spec: Parameters<typeof doc>[0] = {
      junctions: { J1: [0, 0], J5: [0, 1500000], J2: [0, H], J3: [W, H], J4: [W, 0], J6: [1000000, 1500000] },
      walls: {
        W1a: { start: 'J1', end: 'J5', t: T },
        W1b: { start: 'J5', end: 'J2', t: T },
        W2: { start: 'J2', end: 'J3', t: T },
        W3: { start: 'J3', end: 'J4', t: T },
        W4: { start: 'J4', end: 'J1', t: T },
        W5: { start: 'J5', end: 'J6', t: T },
      },
      rooms: { R1: [2000000, 1500000] },
    };
    const d = derived(spec);
    expect(d.rooms.R1!.outer).toEqual([
      [6400, 6400],
      [W - 6400, 6400],
      [W - 6400, H - 6400],
      [6400, H - 6400],
      [6400, 1506400],
      [1000000, 1506400],
      [1000000, 1493600],
      [6400, 1493600],
    ]);
    const area = BigInt(W - T) * BigInt(H - T) - (1000000n - 6400n) * 12800n;
    expect(d.rooms.R1!.area).toBe(area.toString());
  });

  it('an area that is an odd number of half units ends in .5', () => {
    // A right triangle of separators (zero thickness) with legs 3 and 3: area 4.5.
    const r = check(
      doc({
        junctions: { J1: [0, 0], J2: [3, 0], J3: [0, 3] },
        separators: { S1: { start: 'J1', end: 'J2' }, S2: { start: 'J2', end: 'J3' }, S3: { start: 'J3', end: 'J1' } },
        rooms: { R1: [1, 1] },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.derived!.rooms.R1).toEqual({ outer: [[0, 0], [3, 0], [0, 3]], holes: [], area: '4.5' });
  });
});

describe('openings (7.3, 7.4)', () => {
  const oblique = (width: number) =>
    doc({
      junctions: { J1: [0, 0], J2: [768000, 1024000] },
      walls: { W1: { start: 'J1', end: 'J2', t: T } },
      openings: { O1: { wall: 'W1', offset: 0, width, height: 2032000 } },
    });

  it('an opening exactly the length of an oblique wall fits; one base unit more does not', () => {
    const ok = check(oblique(1280000));
    expect(ok.valid).toBe(true);
    expect(ok.derived!.openings.O1).toEqual({ start: [0, 0], end: [768000, 1024000], sillElevation: 0, headElevation: 2032000 });
    const bad = check(oblique(1280001));
    expect(codes(bad)).toEqual(['FS-INV-302 O1']);
  });

  it('start and end points round once', () => {
    const r = check(
      doc({
        junctions: { J1: [0, 0], J2: [1000000, 1000000] },
        walls: { W1: { start: 'J1', end: 'J2', t: T } },
        openings: { O1: { wall: 'W1', offset: 100000, width: 100000, height: 2032000, sill: 500 } },
      }),
    );
    // 100000/√2 = 70710.678… → 70711; 200000/√2 = 141421.356… → 141421
    expect(r.derived!.openings.O1).toEqual({ start: [70711, 70711], end: [141421, 141421], sillElevation: 500, headElevation: 2032500 });
  });
});
