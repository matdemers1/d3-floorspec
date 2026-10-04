/**
 * Determinism fixtures: batches applied both in Node and in the browser, whose results must be
 * byte-identical (1.3.2). Hand-written batches over every composite, plus seeded random ones —
 * oblique walls drawn across a plan, so snap rounding, splitting and re-hosting are exercised —
 * whether they commit or not.
 */
import { box, doc, IN, pair } from './doc.js';

/** mulberry32: a tiny seeded PRNG, the same on every run and platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const core = [{ thickness: 12800, function: 'core' }];
const door = { D36: { kind: 'doorType', width: 36 * IN, height: 80 * IN } };

export interface Fixture {
  name: string;
  doc: object;
  request: object;
}

function random(seed: number): Fixture {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const batch: unknown[] = [];
  const n = int(1, 4);
  for (let i = 0; i < n; i++) {
    const kind = int(0, 5);
    if (kind <= 2)
      batch.push({
        op: 'drawWall',
        level: 'L1',
        from: [int(-1000000, 9000000), int(-1000000, 4000000)],
        to: [int(-1000000, 9000000), int(-1000000, 4000000)],
        layers: [{ thickness: int(1, 30000), function: 'core' }],
      });
    else if (kind === 3) batch.push({ op: 'drawSeparator', level: 'L1', from: [int(0, 7800000), int(0, 2800000)], to: [int(0, 7800000), int(0, 2800000)] });
    else if (kind === 4) batch.push({ op: 'resizeRoom', room: r() < 0.5 ? 'Kitchen' : 'Dining', side: ['north', 'south', 'east', 'west'][int(0, 3)], by: `${int(-12, 24)} ${int(1, 15)}/16"` });
    else batch.push({ op: 'moveWall', wall: `W${int(1, 7)}`, by: int(-999999, 999999) });
  }
  return {
    name: `random ${seed}`,
    doc: pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W2', offset: int(0, 2900000), fill: 'D36' }, O2: { wall: 'W5', offset: int(0, 2900000), width: int(1, 900000), height: 2000000 } } }),
    request: { batch, ...(seed % 3 === 0 && { context: { locks: [{ element: 'W1' }], retired: ['W12', 'J40'] } }) },
  };
}

export function fixtures(): Fixture[] {
  const out: Fixture[] = [
    { name: 'drawWall across a box', doc: box(), request: { batch: [{ op: 'drawWall', level: 'L1', from: [1234567, -500000], to: [2765431, 3300001], layers: core }] } },
    { name: 'resizeRoom with jogs', doc: pair(), request: { batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1' 3 1/3\"" }] } },
    { name: 'moveWall toward', doc: pair(), request: { batch: [{ op: 'moveWall', wall: 'wall between Kitchen and Dining', by: '7/16"', toward: 'Dining' }] } },
    { name: 'moveRoom', doc: pair(), request: { batch: [{ op: 'moveRoom', room: 'Dining', by: '1.5 m west' }] } },
    { name: 'addOpening centred', doc: pair(undefined, undefined, { types: door }), request: { batch: [{ op: 'addOpening', wall: 'wall between Kitchen and Dining', at: 'centered', fill: 'D36' }] } },
    { name: 'removeWall', doc: pair(), request: { batch: [{ op: 'removeWall', wall: 'W7', keep: 'Dining' }] } },
    { name: 'rejected: no keep', doc: pair(), request: { batch: [{ op: 'removeWall', wall: 'W7' }] } },
    {
      name: 'an oblique crossing',
      doc: doc({ junctions: {}, walls: {} }),
      request: { batch: [{ op: 'drawWall', level: 'L1', from: [0, 0], to: [7654321, 1234567], layers: core }, { op: 'drawWall', level: 'L1', from: [0, 1234567], to: [7654321, 3], layers: core }] },
    },
    { name: 'a point toward a junction', doc: box(), request: { batch: [{ op: 'moveJunction', id: 'J2', to: "1' 1/3\" from J1 toward J3" }] } },
  ];
  for (let seed = 1; seed <= 60; seed++) out.push(random(seed));
  return out;
}
