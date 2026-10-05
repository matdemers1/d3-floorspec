/**
 * Determinism fixtures: documents derived both in Node and in the browser, whose results must be
 * byte-identical. Hand-built cases plus seeded random walls (planarized so they form valid graphs),
 * with oblique walls, odd thicknesses and every justification, so rounding is exercised everywhere.
 */
import { planarize } from '../src/geometry/planarize.js';
import { box, doc, type P, type WallSpec } from './doc.js';

/** mulberry32: a tiny seeded PRNG, so the fixtures are the same on every run and platform. */
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

const JUSTIFICATIONS = ['center', 'exteriorFace', 'interiorFace', 'coreFace'] as const;

function randomDoc(seed: number): object {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const n = int(3, 9);
  const junctions: Record<string, [number, number]> = {};
  const edges: { id: string; start: string; end: string }[] = [];
  for (let i = 0; i < n; i++) {
    junctions[`P${i}`] = [int(-4, 4) * 1000000 + int(-99999, 99999), int(-4, 4) * 1000000 + int(-99999, 99999)];
    junctions[`Q${i}`] = [int(-4, 4) * 1000000 + int(-99999, 99999), int(-4, 4) * 1000000 + int(-99999, 99999)];
    edges.push({ id: `W${i}`, start: `P${i}`, end: `Q${i}` });
  }
  let k = 0;
  const p = planarize({ junctions, edges, mintJunction: () => `N${k++}`, mintEdge: (s) => `${s}x${k++}` });
  const used = new Set(p.edges.flatMap((e) => [e.start, e.end]));
  const walls: Record<string, unknown> = {};
  for (const e of p.edges) {
    const j = JUSTIFICATIONS[int(0, 3)]!;
    walls[e.id] = {
      start: e.start,
      end: e.end,
      justification: j,
      layers: [
        { thickness: int(1, 20001), function: 'finish' },
        { thickness: int(1, 150001), function: 'core' },
        { thickness: int(1, 20001), function: 'finish' },
      ],
    };
  }
  return doc({ junctions: Object.fromEntries([...used].map((id) => [id, p.junctions[id]!])), walls: walls as never });
}

/**
 * Core 0.4, chapter 21: a room of four oblique walls, some of them arcs with random sagittas — outward,
 * inward, flat — and a door on one, so the polyline's snap rounding, face paths cut at joins and stations
 * are exercised on irrational midpoints. Valid or not, Node and the browser must agree.
 */
function randomArcDoc(seed: number): object {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const s = 1000000;
  const corners: P[] = [
    [int(-200000, 200000), int(-200000, 200000)],
    [int(-200000, 200000), 4 * s + int(-200000, 200000)],
    [5 * s + int(-200000, 200000), 4 * s + int(-200000, 200000)],
    [5 * s + int(-200000, 200000), int(-200000, 200000)],
  ];
  const walls: Record<string, WallSpec> = {};
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const kind = int(0, 3);
    const h = kind === 0 ? 0 : kind === 1 ? int(1, 1280) : int(-Math.floor(chord / 8), Math.floor(chord / 4));
    walls[`W${i + 1}`] = { start: `J${i + 1}`, end: `J${(i + 1) % 4 + 1}`, t: int(6400, 40000), ...(h !== 0 && { arc: { sagitta: h } }) };
  }
  return doc({
    junctions: Object.fromEntries(corners.map((c, i) => [`J${i + 1}`, c])),
    walls,
    rooms: { R1: [2500000, 2000000] },
    openings: { O1: { wall: 'W2', offset: int(100000, 1500000), width: 914400, height: 2032000 } },
    extra: { floorspec: '0.4' },
  });
}

export function fixtures(): { name: string; doc: object }[] {
  const out: { name: string; doc: object }[] = [
    { name: 'box with room', doc: doc(box(4000000, 3000000, 12801, { rooms: { R1: [2000000, 1500000] } })) },
    {
      name: 'oblique triangle',
      doc: doc({
        junctions: { A: [0, 0], B: [7654321, 1234567], C: [2345678, 6543210] },
        walls: { W1: { start: 'A', end: 'C', t: 15001 }, W2: { start: 'C', end: 'B', t: 9999 }, W3: { start: 'B', end: 'A', t: 12345 } },
        rooms: { R1: [3000000, 2500000] },
        openings: { O1: { wall: 'W1', offset: 1000001, width: 914401, height: 2032000 } },
      }),
    },
  ];
  for (let s = 1; s <= 40; s++) out.push({ name: `random ${s}`, doc: randomDoc(s) });
  for (let s = 1; s <= 24; s++) out.push({ name: `random arcs ${s}`, doc: randomArcDoc(s) });
  return out;
}
