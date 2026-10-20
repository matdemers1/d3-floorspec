/**
 * FS_context for drawing and generating (registry/FS_context/spec.md chapter 6, informative): what the
 * editor, render2d, the 3D mesh and the renderers draw from a document's context — each street's
 * carriageway, curbs, strips and sidewalks as bands along its centreline, each neighbour's footprint
 * with its roof's ridge and planes, each tree's trunk and crown — and the generator that writes context
 * from a lot's street edges and setbacks (6.3), seeded so that one lot and one seed always give the
 * same street, neighbours and trees.
 *
 * Floating point is fine here: nothing drawn is normative, and the generator rounds what it writes to
 * base units. Context is never the design (1.5): nothing here is read by quantities, schedules or rules.
 */
import { COLLECTIONS, entries, extElements, programItems, type FloorspecDocument } from '../../model/document.js';
import { contextData, CURB, type ContextTree, type Neighbour, type RoofForm, type Street, type TreeForm } from './context.js';
import { gradeAt, siteDrawing } from './site-draw.js';
import { siteData, type Setbacks } from './site.js';

export type XY = [number, number];
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x));
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPos = (v: unknown): v is number => isInt(v) && v > 0;
const byId = <T>(m: unknown): [string, T][] => Object.entries(isObject(m) ? m : {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, T][];

const FT = 390_144;

/** A street, ready to draw: its bands as polygons in plan, and its heights. */
export interface DrawStreet {
  readonly id: string;
  readonly name?: string;
  readonly centreline: XY[];
  readonly carriageway: XY[];
  /** Each side's curb, strip and sidewalk (absent when that band has no width). */
  readonly curbs: XY[][];
  readonly strips: XY[][];
  readonly sidewalks: XY[][];
  /** The curb faces and the sidewalks' backs, as lines: what a plan strokes. */
  readonly curbLines: XY[][];
  readonly backLines: XY[][];
  readonly elevation: number;
  readonly curbHeight: number;
  readonly width: number;
  readonly overall: number;
  readonly generated: boolean;
}

/** A neighbour, ready to draw: its footprint, its roof as a ridge and planes. */
export interface DrawNeighbour {
  readonly id: string;
  readonly name?: string;
  readonly footprint: XY[];
  readonly roof: RoofForm;
  readonly elevation: number;
  readonly eaves: number;
  readonly ridge: number;
  /** The ridge line in plan (a point for a pyramid, none for a flat roof or one that is not a rectangle). */
  readonly ridgeLine: XY[] | null;
  /** The roof's planes in 3D, `[x, y, z]` each, counter-clockwise seen from above; the gable ends' wall triangles are in `gables`. */
  readonly roofPlanes: [number, number, number][][];
  readonly gables: [number, number, number][][];
  readonly generated: boolean;
}

/** A tree beyond the lot, ready to draw. */
export interface DrawContextTree {
  readonly id: string;
  readonly name?: string;
  readonly at: XY;
  readonly height: number;
  readonly spread: number;
  readonly form: TreeForm;
  readonly elevation: number;
  readonly generated: boolean;
}

/** Everything of FS_context a drawing needs, from a document alone. */
export interface ContextDrawing {
  readonly streets: readonly DrawStreet[];
  readonly neighbours: readonly DrawNeighbour[];
  readonly trees: readonly DrawContextTree[];
  /** Whether there is anything to draw. */
  readonly empty: boolean;
}

/** Every ID a document uses: elements, program items, extension elements, and every extension's records (each member that maps IDs to objects). */
export function documentIds(doc: FloorspecDocument): Set<string> {
  const out = new Set<string>();
  for (const c of COLLECTIONS) for (const [id] of entries(doc[c] as Record<string, unknown> | undefined)) out.add(id);
  for (const [id] of programItems(doc)) out.add(id);
  for (const x of extElements(doc)) out.add(x.id);
  const ext = isObject(doc.extensions) ? doc.extensions : {};
  for (const data of Object.values(ext)) if (isObject(data)) for (const m of Object.values(data)) if (isObject(m)) for (const [id, v] of Object.entries(m)) if (isObject(v)) out.add(id);
  return out;
}

/** Was this record written by the generator (extras.d3floorspec.generated)? */
export function isGenerated(r: unknown): boolean {
  const x = isObject(r) && isObject(r.extras) ? r.extras.d3floorspec : undefined;
  return isObject(x) && x.generated === true;
}

/** A polyline offset by d to its left (negative: its right), its joins mitred (and capped at 4× d). */
export function offsetPolyline(points: readonly XY[], d: number): XY[] {
  const n = points.length;
  const normals: XY[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    normals.push([-(b[1] - a[1]) / len, (b[0] - a[0]) / len]);
  }
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const n0 = normals[Math.max(0, i - 1)]!;
    const n1 = normals[Math.min(normals.length - 1, i)]!;
    let mx = n0[0] + n1[0];
    let my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = n1[0];
      my = n1[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = mx * n1[0] + my * n1[1];
    const k = Math.min(4, 1 / Math.max(cos, 0.25));
    out.push([p[0] + mx * d * k, p[1] + my * d * k]);
  }
  return out;
}

/** The band between two offsets of a polyline, as a polygon. */
export function band(points: readonly XY[], d0: number, d1: number): XY[] {
  return [...offsetPolyline(points, d1), ...offsetPolyline(points, d0).reverse()];
}

function drawStreet(id: string, s: Street): DrawStreet | null {
  if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(isPt) || !isPos(s.width)) return null;
  const c: XY[] = s.points.map((p) => [p[0], p[1]]);
  const half = s.width / 2;
  const curb = isInt(s.curb) ? s.curb : CURB;
  const strip = isInt(s.strip) ? s.strip : 0;
  const walk = isInt(s.sidewalk) ? s.sidewalk : 0;
  const sides = [1, -1];
  const bandsOf = (from: number, w: number): XY[][] => (w > 0 ? sides.map((k) => band(c, k * from, k * (from + w))) : []);
  return {
    id,
    ...(typeof s.name === 'string' && { name: s.name }),
    centreline: c,
    carriageway: band(c, -half, half),
    curbs: bandsOf(half, curb),
    strips: bandsOf(half + curb, strip),
    sidewalks: bandsOf(half + curb + strip, walk),
    curbLines: sides.map((k) => offsetPolyline(c, k * half)),
    backLines: sides.map((k) => offsetPolyline(c, k * (half + curb + strip + walk))),
    elevation: isInt(s.elevation) ? s.elevation : 0,
    curbHeight: isInt(s.curbHeight) ? s.curbHeight : CURB,
    width: s.width,
    overall: s.width + 2 * (curb + strip + walk),
    generated: isGenerated(s),
  };
}

const rect = (r: readonly XY[]): boolean => {
  if (r.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = r[(i + 3) % 4]!;
    const b = r[i]!;
    const c = r[(i + 1) % 4]!;
    const d = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(d) > 1e-6 * (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) + 1)) return false;
  }
  return true;
};
const signedArea = (r: readonly XY[]): number => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * p[1], 0) / 2;
const mid = (a: XY, b: XY): XY => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const len = (a: XY, b: XY): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** 3.2: the roof of a rectangular footprint — its ridge along the longer sides (edge 0's when they tie), and its planes. */
export function roofOf(footprint: readonly XY[], roof: RoofForm, eaves: number, ridge: number): { ridgeLine: XY[] | null; planes: [number, number, number][][]; gables: [number, number, number][][] } {
  if (roof === 'flat' || !rect(footprint)) {
    const top = roof === 'flat' ? ridge : eaves;
    const ring = signedArea(footprint) >= 0 ? footprint : [...footprint].reverse();
    return { ridgeLine: null, planes: [ring.map((p) => [p[0], p[1], top] as [number, number, number])], gables: [] };
  }
  // counter-clockwise from the vertex that starts the longer side (edge 0 on a tie)
  let r = signedArea(footprint) >= 0 ? [...footprint] : [...footprint].reverse();
  const e0 = len(r[0]!, r[1]!);
  const e1 = len(r[1]!, r[2]!);
  if (e1 > e0 + 1e-6) r = [r[1]!, r[2]!, r[3]!, r[0]!];
  else if (Math.abs(e1 - e0) <= 1e-6 && signedArea(footprint) < 0) {
    // keep edge 0 of the footprint as written along the ridge, whichever way round it was written
    r = [r[3]!, r[0]!, r[1]!, r[2]!];
  }
  const [a, b, c, d] = r as [XY, XY, XY, XY]; // a-b and c-d are the long sides (eaves); b-c and d-a the short ends
  const short = len(b, c);
  let m0 = mid(d, a);
  let m1 = mid(b, c);
  if (roof === 'hip') {
    const L = len(a, b);
    const inset = Math.min(short / 2, L / 2);
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    m0 = [m0[0] + ux * inset, m0[1] + uy * inset];
    m1 = [m1[0] - ux * inset, m1[1] - uy * inset];
  }
  const E = (p: XY): [number, number, number] => [p[0], p[1], eaves];
  const R = (p: XY): [number, number, number] => [p[0], p[1], ridge];
  const planes: [number, number, number][][] = [
    [E(a), E(b), R(m1), R(m0)],
    [E(c), E(d), R(m0), R(m1)],
  ];
  const ends: [number, number, number][][] = [
    [E(b), E(c), R(m1)],
    [E(d), E(a), R(m0)],
  ];
  const pyramid = len(m0, m1) < 1;
  return {
    ridgeLine: pyramid ? [m0] : [m0, m1],
    planes: roof === 'hip' ? [...planes, ...ends] : planes,
    gables: roof === 'gable' ? ends : [],
  };
}

function drawNeighbour(id: string, n: Neighbour): DrawNeighbour | null {
  if (!Array.isArray(n.boundary) || n.boundary.length < 3 || !n.boundary.every(isPt) || !isPos(n.height)) return null;
  const footprint: XY[] = n.boundary.map((p) => [p[0], p[1]]);
  const roof: RoofForm = n.roof === 'gable' || n.roof === 'hip' ? n.roof : 'flat';
  const elevation = isInt(n.elevation) ? n.elevation : 0;
  const eaves = elevation + n.height;
  const ridge = eaves + (isInt(n.rise) ? n.rise : 0);
  const r = roofOf(footprint, roof, eaves, ridge);
  return { id, ...(typeof n.name === 'string' && { name: n.name }), footprint, roof, elevation, eaves, ridge, ridgeLine: r.ridgeLine, roofPlanes: r.planes, gables: r.gables, generated: isGenerated(n) };
}

function drawTree(id: string, t: ContextTree): DrawContextTree | null {
  if (!isPt(t.at) || !isPos(t.height) || !isPos(t.spread)) return null;
  return { id, ...(typeof t.name === 'string' && { name: t.name }), at: [t.at[0], t.at[1]], height: t.height, spread: t.spread, form: t.form === 'evergreen' ? 'evergreen' : 'deciduous', elevation: isInt(t.elevation) ? t.elevation : 0, generated: isGenerated(t) };
}

/** Everything of FS_context a drawing needs. Records that cannot be read are skipped; nothing here throws. */
export function contextDrawing(doc: FloorspecDocument): ContextDrawing {
  const d = contextData(doc);
  const streets = byId<Street>(d.streets).flatMap(([id, s]) => (isObject(s) ? [drawStreet(id, s)] : [])).filter((x): x is DrawStreet => x !== null);
  const neighbours = byId<Neighbour>(d.neighbours).flatMap(([id, n]) => (isObject(n) ? [drawNeighbour(id, n)] : [])).filter((x): x is DrawNeighbour => x !== null);
  const trees = byId<ContextTree>(d.trees).flatMap(([id, t]) => (isObject(t) ? [drawTree(id, t)] : [])).filter((x): x is DrawContextTree => x !== null);
  return { streets, neighbours, trees, empty: streets.length + neighbours.length + trees.length === 0 };
}

/** A pitch as a builder says it: "6:12" for a rise over half the shorter side. */
export function pitchOf(footprint: readonly XY[], rise: number): string | null {
  if (!rect(footprint) || rise <= 0) return null;
  const short = Math.min(len(footprint[0]!, footprint[1]!), len(footprint[1]!, footprint[2]!));
  const p = (rise / (short / 2)) * 12;
  return `${Number.isInteger(Math.round(p * 2) / 2) ? Math.round(p) : (Math.round(p * 2) / 2).toFixed(1)}:12`;
}

// ── generating context (6.3) ────────────────────────────────────────────────

/** The compass side a street is on, in plan coordinates (y north). */
export type StreetSide = 'north' | 'east' | 'south' | 'west';
export type TreeDensity = 'none' | 'few' | 'some' | 'many';

export interface GenerateContextOptions {
  /** The street sides; default FS_site's street edges, or the lot's south edge. */
  readonly side?: StreetSide;
  /** The carriageway, curb to curb. Default 30′. */
  readonly width?: number;
  /** Each sidewalk. Default 5′. */
  readonly sidewalk?: number;
  /** Each planting strip. Default 4′. */
  readonly strip?: number;
  /** The street's name. */
  readonly name?: string;
  /** Neighbours on both sides, at the lot's own setbacks. Default true. */
  readonly neighbours?: boolean;
  /** Trees beyond the lot. Default "some". */
  readonly trees?: TreeDensity;
  /** The seed: one lot and one seed always generate the same context. Default 1. */
  readonly seed?: number;
}

/** Generated context: records by ID, each marked `extras.d3floorspec.generated`, and the edges used. */
export interface GeneratedContext {
  readonly streets: Record<string, Street>;
  readonly neighbours: Record<string, Neighbour>;
  readonly trees: Record<string, ContextTree>;
  /** The lot edges the street was generated along. */
  readonly streetEdges: number[];
  /** Why nothing was generated, when nothing was. */
  readonly reason?: string;
}

/** mulberry32: a small seeded generator, the same in every engine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SETBACKS = { front: 30 * FT, side: 10 * FT, rear: 25 * FT };
const DIRS: Record<StreetSide, XY> = { north: [0, 1], east: [1, 0], south: [0, -1], west: [-1, 0] };
const TREE_COUNT: Record<TreeDensity, number> = { none: 0, few: 3, some: 8, many: 14 };
const round = (p: XY): [number, number] => [Math.round(p[0]) + 0, Math.round(p[1]) + 0];
const snap = (v: number, step = FT / 2): number => Math.round(v / step) * step;

/** The compass side an edge of a lot faces (its outward normal's nearest). */
export function sideOfEdge(lot: readonly XY[], i: number): StreetSide {
  const ccw = signedArea(lot) >= 0;
  const a = lot[i]!;
  const b = lot[(i + 1) % lot.length]!;
  const L = len(a, b) || 1;
  const n: XY = ccw ? [(b[1] - a[1]) / L, -(b[0] - a[0]) / L] : [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  let best: StreetSide = 'south';
  let bestDot = -Infinity;
  for (const [s, v] of Object.entries(DIRS) as [StreetSide, XY][]) {
    const dot = n[0] * v[0] + n[1] * v[1];
    if (dot > bestDot) {
      best = s;
      bestDot = dot;
    }
  }
  return best;
}

/**
 * Generate context from a lot's street edges and setbacks (FS_context 6.3): a street along each street
 * edge, its sidewalk's back on the lot line; a neighbour on each side lot at the lot's own side setback
 * from the shared line and its front setback from the street, one or two storeys with a gable or a hip;
 * trees beyond the rear and sides, and street trees in the planting strip. Deterministic for one lot and
 * one seed. IDs are the next free `ST<n>`, `NB<n>`, `TR<n>`: free in the document and not in `taken`.
 */
export function generateContext(doc: FloorspecDocument, options: GenerateContextOptions = {}, taken: ReadonlySet<string> = new Set()): GeneratedContext {
  const site = siteDrawing(doc);
  const lot = site.lot;
  if (!lot) return { streets: {}, neighbours: {}, trees: {}, streetEdges: [], reason: 'The lot has no boundary: draw the lot first, then generate its context.' };
  const rand = seeded(options.seed ?? 1);
  const n = lot.length;
  const ccw = signedArea(lot) >= 0;
  const sd = siteData(doc);
  const sb = isObject(sd.setbacks) ? (sd.setbacks as unknown as Partial<Setbacks>) : {};
  const front = isInt(sb.front) ? sb.front : DEFAULT_SETBACKS.front;
  const side = isInt(sb.side) ? sb.side : DEFAULT_SETBACKS.side;
  const rear = isInt(sb.rear) ? sb.rear : DEFAULT_SETBACKS.rear;
  let streetEdges: number[];
  if (options.side) streetEdges = [Array.from({ length: n }, (_, i) => i).sort((p, q) => len(lot[q]!, lot[(q + 1) % n]!) - len(lot[p]!, lot[(p + 1) % n]!)).find((i) => sideOfEdge(lot, i) === options.side) ?? 0];
  else if (Array.isArray(sb.street) && sb.street.length > 0) streetEdges = sb.street.filter((i) => isInt(i) && i < n);
  else streetEdges = [Array.from({ length: n }, (_, i) => i).find((i) => sideOfEdge(lot, i) === 'south') ?? 0];

  const used = new Set([...documentIds(doc), ...taken]);
  const nextId = (prefix: string): string => {
    let k = 1;
    while (used.has(`${prefix}${String(k)}`)) k++;
    const id = `${prefix}${String(k)}`;
    used.add(id);
    return id;
  };
  const surface = site.surface;
  const groundNear = (p: XY): number => {
    if (!surface) return 0;
    const z = gradeAt(surface, p[0], p[1]);
    if (z !== undefined) return Math.round(z);
    // beyond the survey: the ground at the nearest survey point
    let best = surface.points[0]!;
    for (const q of surface.points) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1])) best = q;
    return Math.round(best[2]);
  };
  const outward = (i: number): { a: XY; b: XY; t: XY; o: XY; L: number } => {
    const a = lot[i]!;
    const b = lot[(i + 1) % n]!;
    const L = len(a, b) || 1;
    const t: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const o: XY = ccw ? [t[1], -t[0]] : [-t[1], t[0]];
    return { a, b, t, o, L };
  };

  const width = options.width ?? 30 * FT;
  const walk = options.sidewalk ?? 5 * FT;
  const strip = options.strip ?? 4 * FT;
  const streets: Record<string, Street> = {};
  const neighbours: Record<string, Neighbour> = {};
  const trees: Record<string, ContextTree> = {};
  const avoid: { c: XY; r: number }[] = [];
  const reach = 70 * FT; // how far a street runs past the lot's corners: across the neighbours' lots

  for (const i of streetEdges) {
    const { a, b, t, o } = outward(i);
    const off = walk + strip + CURB + width / 2;
    const p0: XY = [a[0] + o[0] * off - t[0] * reach, a[1] + o[1] * off - t[1] * reach];
    const p1: XY = [b[0] + o[0] * off + t[0] * reach, b[1] + o[1] * off + t[1] * reach];
    const id = nextId('ST');
    const mid0 = mid(a, b);
    streets[id] = {
      ...(options.name ? { name: options.name } : {}),
      points: [round(p0), round(p1)],
      width: Math.round(width),
      ...(strip > 0 && { strip: Math.round(strip) }),
      ...(walk > 0 && { sidewalk: Math.round(walk) }),
      elevation: groundNear(mid0) - CURB,
      extras: { d3floorspec: { generated: true } },
    };
    // street trees in each planting strip, every 40′ or so, on the near side and the far
    if (strip >= 3 * FT && (options.trees ?? 'some') !== 'none') {
      const along = len(p0, p1);
      const spacing = 40 * FT;
      for (const k of [1, -1]) {
        const toStrip = k * (width / 2 + CURB + strip / 2); // from the centreline towards the lot (k = 1) or away
        for (let s = spacing / 2 + rand() * spacing * 0.3; s < along - spacing / 4; s += spacing * (0.85 + rand() * 0.3)) {
          if ((options.trees ?? 'some') === 'few' && rand() < 0.5) continue;
          const at: XY = [p0[0] + t[0] * s - o[0] * toStrip, p0[1] + t[1] * s - o[1] * toStrip];
          const tid = nextId('TR');
          const h = snap((28 + rand() * 14) * FT);
          trees[tid] = { at: round(at), height: h, spread: snap(Math.min(26 * FT, h * (0.5 + rand() * 0.15))), elevation: groundNear(at), extras: { d3floorspec: { generated: true } } };
          avoid.push({ c: at, r: 6 * FT });
        }
      }
    }
  }

  // the neighbours: on each side edge — one sharing an end with a street edge — beyond the shared line
  if (options.neighbours ?? true) {
    const streetSet = new Set(streetEdges);
    for (let i = 0; i < n; i++) {
      if (streetSet.has(i)) continue;
      const prevStreet = streetSet.has((i - 1 + n) % n);
      const nextStreet = streetSet.has((i + 1) % n);
      if (!prevStreet && !nextStreet) continue;
      const { a, b, t, o, L } = outward(i);
      // u runs from the street along the shared line; the street is at the edge's start when the previous edge is the street
      const start: XY = prevStreet ? a : b;
      const u: XY = prevStreet ? t : [-t[0], -t[1]];
      const across = snap((28 + rand() * 14) * FT);
      const deep = snap(Math.min(Math.max(L - front - rear, 24 * FT), (36 + rand() * 20) * FT));
      const s0 = side;
      const corners: XY[] = [
        [start[0] + u[0] * front + o[0] * s0, start[1] + u[1] * front + o[1] * s0],
        [start[0] + u[0] * (front + deep) + o[0] * s0, start[1] + u[1] * (front + deep) + o[1] * s0],
        [start[0] + u[0] * (front + deep) + o[0] * (s0 + across), start[1] + u[1] * (front + deep) + o[1] * (s0 + across)],
        [start[0] + u[0] * front + o[0] * (s0 + across), start[1] + u[1] * front + o[1] * (s0 + across)],
      ];
      // exact right angles: an axis-aligned rectangle rounds exactly; a turned one is rebuilt from integer sides
      const rounded = exactRectangle(corners);
      const storeys = rand() < 0.45 ? 2 : 1;
      const roof: RoofForm = rand() < 0.6 ? 'gable' : 'hip';
      const short = Math.min(across, deep);
      const pitch = 5 + Math.floor(rand() * 4); // 5:12 to 8:12
      const centre = mid(corners[0]!, corners[2]!);
      const id = nextId('NB');
      neighbours[id] = {
        name: `Neighbour, ${sideOfEdge(lot, i)}`,
        boundary: rounded as Neighbour["boundary"],
        height: storeys === 2 ? 19 * FT : 10 * FT,
        roof,
        rise: snap(((short / 2) * pitch) / 12, FT / 4),
        elevation: groundNear([start[0] + u[0] * (front + deep / 2), start[1] + u[1] * (front + deep / 2)]),
        extras: { d3floorspec: { generated: true } },
      };
      avoid.push({ c: centre, r: Math.hypot(across, deep) / 2 + 4 * FT });
    }
  }

  // trees beyond the rear and the sides, in a band 10′ to 45′ beyond the lot line, clear of the neighbours
  const count = TREE_COUNT[options.trees ?? 'some'];
  const ringEdges = Array.from({ length: n }, (_, i) => i).filter((i) => !streetEdges.includes(i));
  const perimeter = ringEdges.reduce((s, i) => s + outward(i).L, 0);
  let placed = 0;
  for (let attempt = 0; placed < count && attempt < count * 40 && perimeter > 0; attempt++) {
    let s = rand() * perimeter;
    let e = ringEdges[0]!;
    for (const i of ringEdges) {
      const L = outward(i).L;
      if (s <= L) {
        e = i;
        break;
      }
      s -= L;
    }
    const { a, t, o } = outward(e);
    const d = (10 + rand() * 35) * FT;
    const at: XY = [a[0] + t[0] * s + o[0] * d, a[1] + t[1] * s + o[1] * d];
    if (insideLot(at, lot)) continue;
    const evergreen = rand() < 0.3;
    const h = snap(evergreen ? (30 + rand() * 25) * FT : (32 + rand() * 20) * FT);
    const spread = snap(evergreen ? h * (0.3 + rand() * 0.15) : h * (0.65 + rand() * 0.2));
    if (avoid.some((x) => Math.hypot(x.c[0] - at[0], x.c[1] - at[1]) < x.r + spread / 3)) continue;
    const tid = nextId('TR');
    trees[tid] = { at: round(at), height: h, spread, ...(evergreen && { form: 'evergreen' as const }), elevation: groundNear(at), extras: { d3floorspec: { generated: true } } };
    avoid.push({ c: at, r: spread / 3 });
    placed++;
  }
  return { streets, neighbours, trees, streetEdges };
}

/**
 * Four corners of a rectangle as integers whose corners are exactly right angles (FS_context 3.2): its sides
 * along an integer direction D = (p, q) close to the first side's — within a thousandth of a radian — and its
 * perpendicular (-q, p), each a whole multiple of D, so every corner's dot product is exactly 0.
 */
export function exactRectangle(c: readonly XY[]): [number, number][] {
  const p0 = round(c[0]!);
  const ux = c[1]![0] - c[0]![0];
  const uy = c[1]![1] - c[0]![1];
  const vx = c[3]![0] - c[0]![0];
  const vy = c[3]![1] - c[0]![1];
  const lu = Math.hypot(ux, uy) || 1;
  const lv = Math.hypot(vx, vy);
  let D: [number, number] = [Math.round((ux / lu) * 1000), Math.round((uy / lu) * 1000)];
  const g = gcd(Math.abs(D[0]), Math.abs(D[1]));
  D = [D[0] / g + 0, D[1] / g + 0];
  const ld = Math.hypot(D[0], D[1]);
  const sgn = ux * vy - uy * vx >= 0 ? 1 : -1;
  const ku = Math.max(1, Math.round(lu / ld));
  const kv = Math.max(1, Math.round(lv / ld)) * sgn;
  const U: [number, number] = [D[0] * ku, D[1] * ku];
  const V: [number, number] = [-D[1] * kv + 0, D[0] * kv + 0];
  return [p0, [p0[0] + U[0], p0[1] + U[1]], [p0[0] + U[0] + V[0], p0[1] + U[1] + V[1]], [p0[0] + V[0], p0[1] + V[1]]];
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function insideLot(p: XY, lot: readonly XY[]): boolean {
  let w = false;
  for (let i = 0, j = lot.length - 1; i < lot.length; j = i++) {
    const a = lot[i]!;
    const b = lot[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) w = !w;
  }
  return w;
}

/** The IDs of the generated records in a document: what regenerating replaces (hand-drawn context stays). */
export function generatedIds(doc: FloorspecDocument): { member: 'streets' | 'neighbours' | 'trees'; id: string }[] {
  const d = contextData(doc);
  const out: { member: 'streets' | 'neighbours' | 'trees'; id: string }[] = [];
  for (const member of ['streets', 'neighbours', 'trees'] as const) for (const [id, r] of byId<unknown>(d[member])) if (isGenerated(r)) out.push({ member, id });
  return out;
}
