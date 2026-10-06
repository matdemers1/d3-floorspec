/**
 * One level of a document as drawing geometry (FLR-T-9.3), in model coordinates (base units,
 * y up), shared by the PDF sheet and the DXF so the two can never disagree.
 *
 * Everything comes from the engine's derived geometry through `sceneOf` (render2d): wall face
 * ends, junction fills, room polygons, opening points. What is computed here is drafting, not
 * geometry: the wall outline is the union of the wall and junction pieces (their shared edges
 * cancel exactly — the pieces' vertices are the engine's rounded integers, compared with BigInt),
 * then broken where an opening passes through it and closed with jambs; door leaves, swings and
 * glazing are placed relative to the derived opening points the same way the plan renderer does.
 */
import { deriveFrom, evaluate, InvalidDocumentError, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { sceneOf, labelPoint, type ReaderOptions, type Pt, type Scene, type SceneOpening, type SceneWall } from '@floorspec/render2d';
import { layerForDevice, LAYERS } from './layers.js';
import { arrivingStairs, planRoof, planStair, type PlanRoof, type PlanStair } from './symbols.js';

export type XY = readonly [number, number];

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Segment {
  readonly a: XY;
  readonly b: XY;
  readonly layer: string;
}

/** A directed outline edge with the wall material on its left (counter-clockwise pieces). */
export interface OutlineEdge {
  readonly a: Pt;
  readonly b: Pt;
  readonly exterior: boolean;
}

export interface PlanDoor {
  readonly id: string;
  readonly mark: string | undefined;
  /** The hinge point on the face the leaf swings from. */
  readonly hinge: XY;
  /** The open leaf's free end (the leaf is drawn open, 90°). */
  readonly leafEnd: XY;
  /** Where the free end is when the door is closed: the swing arc runs from `leafEnd` to here. */
  readonly closedEnd: XY;
  readonly radius: number;
}

export interface PlanWindow {
  readonly id: string;
  readonly mark: string | undefined;
  readonly lines: readonly (readonly [XY, XY])[];
}

export interface PlanRoom {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  readonly outer: readonly Pt[];
  readonly holes: readonly (readonly Pt[])[];
  readonly label: XY;
  /** The polygon's bounding width (x) and depth (y), base units. */
  readonly width: number;
  readonly depth: number;
}

/** A door or window tag: drawn off the face at `base`, along `normal` (unit, model space). */
export interface PlanTag {
  readonly kind: 'door' | 'window';
  readonly id: string;
  readonly mark: string;
  readonly base: XY;
  readonly normal: XY;
}

export interface PlanDevice {
  readonly id: string;
  readonly extension: string;
  readonly collection: string;
  readonly layer: string;
  readonly footprint: readonly Pt[];
}

export interface LevelPlan {
  readonly levelId: string;
  readonly levelName: string;
  readonly projectName: string;
  readonly trueNorth: number;
  readonly scene: Scene;
  /** Wall and junction pieces, counter-clockwise: the poché. */
  readonly pieces: readonly { readonly ring: readonly Pt[]; readonly exterior: boolean }[];
  /** The quadrilateral each opening cuts through its wall. */
  readonly cuts: readonly (readonly XY[])[];
  /** The wall outline, before openings: the union's boundary, material on the left. */
  readonly outline: readonly OutlineEdge[];
  /** The wall outline as drawn: broken at openings, with jambs. */
  readonly wallLines: readonly Segment[];
  readonly doors: readonly PlanDoor[];
  readonly windows: readonly PlanWindow[];
  readonly rooms: readonly PlanRoom[];
  readonly separators: readonly (readonly [Pt, Pt])[];
  readonly slabs: readonly { readonly id: string; readonly outline: readonly Pt[] }[];
  readonly unanchored: readonly { readonly outer: readonly Pt[]; readonly holes: readonly (readonly Pt[])[]; readonly area: string }[];
  readonly devices: readonly PlanDevice[];
  readonly tags: readonly PlanTag[];
  /** Stairs rising from this level (UP) and arriving at it (DN) — FLR-T-9.7. */
  readonly stairs: readonly PlanStair[];
  /** Roofs on this level: drawn dashed on its plan (above the cut), and on the roof plan. */
  readonly roofs: readonly PlanRoof[];
  /** The wall body (pieces only), for the dimension strings. */
  readonly body: Box | undefined;
  /** Everything drawn, door swings included. */
  readonly extent: Box | undefined;
}

const FUNCTION_LABELS: Readonly<Record<string, string>> = {
  unspecified: 'Room',
  sleeping: 'Bedroom',
  bath: 'Bath',
  kitchen: 'Kitchen',
  living: 'Living',
  dining: 'Dining',
  office: 'Office',
  laundry: 'Laundry',
  utility: 'Utility',
  storage: 'Storage',
  circulation: 'Hall',
  mechanical: 'Mechanical',
  garage: 'Garage',
  exterior: 'Exterior',
};

export function grow(box: Box | undefined, pts: readonly XY[]): Box | undefined {
  let b = box;
  for (const [x, y] of pts) {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

export const union = (a: Box | undefined, b: Box | undefined): Box | undefined =>
  b === undefined ? a && { ...a } : grow(a && { ...a }, [
    [b.minX, b.minY],
    [b.maxX, b.maxY],
  ]);

function signedArea2(ring: readonly XY[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return s;
}

const ccw = (ring: readonly Pt[]): readonly Pt[] => (signedArea2(ring) < 0 ? [...ring].reverse() : ring);

/** Unit vector along a wall and its left normal. */
export function axes(a: XY, b: XY): { u: XY; n: XY; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return len === 0 ? { u: [1, 0], n: [0, 1], len } : { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

const add = (p: XY, v: XY, k: number): XY => [p[0] + v[0] * k, p[1] + v[1] * k];
const key = (p: XY): string => `${p[0]},${p[1]}`;

export function insideRings(x: number, y: number, rings: readonly (readonly XY[])[]): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!;
      const [xj, yj] = r[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/**
 * The boundary of a union of counter-clockwise integer polygons that meet edge to edge: every edge
 * is split at any piece vertex lying on it (exactly, in BigInt), and an edge whose reverse is also
 * present is interior and cancels. What is left is the outline, material on its left.
 */
export function unionOutline(pieces: readonly { readonly ring: readonly Pt[]; readonly exterior: boolean }[]): OutlineEdge[] {
  const vertices = new Map<string, Pt>();
  for (const p of pieces) for (const v of p.ring) vertices.set(key(v), v);
  const verts = [...vertices.values()];
  const edges = new Map<string, OutlineEdge>();
  const push = (a: Pt, b: Pt, exterior: boolean): void => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    const k = `${key(a)}>${key(b)}`;
    const r = `${key(b)}>${key(a)}`;
    if (edges.has(r)) {
      // An edge two pieces share: interior. The exterior flag of a cancelled edge is irrelevant.
      edges.delete(r);
      return;
    }
    const prior = edges.get(k);
    edges.set(k, { a, b, exterior: exterior || (prior?.exterior ?? false) });
  };
  for (const p of pieces) {
    const ring = p.ring;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const ax = BigInt(a[0]);
      const ay = BigInt(a[1]);
      const dx = BigInt(b[0]) - ax;
      const dy = BigInt(b[1]) - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0n) continue;
      const on: { t: bigint; v: Pt }[] = [];
      for (const v of verts) {
        const vx = BigInt(v[0]) - ax;
        const vy = BigInt(v[1]) - ay;
        if (vx * dy - vy * dx !== 0n) continue;
        const t = vx * dx + vy * dy;
        if (t > 0n && t < len2) on.push({ t, v });
      }
      on.sort((p1, p2) => (p1.t < p2.t ? -1 : p1.t > p2.t ? 1 : 0));
      let from = a;
      for (const { v } of on) {
        push(from, v, p.exterior);
        from = v;
      }
      push(from, b, p.exterior);
    }
  }
  return [...edges.values()];
}

/**
 * The outline with collinear runs joined: a straight face split by junctions along it becomes one
 * edge. Exact (BigInt cross products on the engine's integers).
 */
export function mergeCollinear(outline: readonly OutlineEdge[]): OutlineEdge[] {
  const k = (p: XY): string => `${p[0]},${p[1]}`;
  const from = new Map<string, OutlineEdge>();
  const into = new Map<string, OutlineEdge>();
  for (const e of outline) {
    from.set(k(e.a), e);
    into.set(k(e.b), e);
  }
  const straight = (p: OutlineEdge, q: OutlineEdge): boolean =>
    (BigInt(p.b[0]) - BigInt(p.a[0])) * (BigInt(q.b[1]) - BigInt(q.a[1])) - (BigInt(p.b[1]) - BigInt(p.a[1])) * (BigInt(q.b[0]) - BigInt(q.a[0])) === 0n &&
    (p.b[0] - p.a[0]) * (q.b[0] - q.a[0]) + (p.b[1] - p.a[1]) * (q.b[1] - q.a[1]) > 0;
  const out: OutlineEdge[] = [];
  const used = new Set<OutlineEdge>();
  for (const e of outline) {
    if (used.has(e)) continue;
    const prev = into.get(k(e.a));
    if (prev !== undefined && prev !== e && straight(prev, e) && !used.has(prev)) continue; // not a run's first edge
    let last = e;
    let exterior = e.exterior;
    used.add(e);
    for (;;) {
      const next = from.get(k(last.b));
      if (next === undefined || used.has(next) || !straight(last, next)) break;
      used.add(next);
      exterior ||= next.exterior;
      last = next;
    }
    out.push({ a: e.a, b: last.b, exterior });
  }
  // A loop that is one straight run all the way round cannot happen; anything left over is kept.
  for (const e of outline) if (!used.has(e)) out.push(e);
  return out;
}

interface Interval {
  t0: number;
  t1: number;
}

function subtract(spans: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const s of spans) {
    if (cut.t1 <= s.t0 || cut.t0 >= s.t1) {
      out.push(s);
      continue;
    }
    if (cut.t0 > s.t0) out.push({ t0: s.t0, t1: cut.t0 });
    if (cut.t1 < s.t1) out.push({ t0: cut.t1, t1: s.t1 });
  }
  return out;
}

/** How far an outline edge may sit from a face line and still be that face (base units: 1/20 mm). */
const ON_FACE = 64;

function quad(o: SceneOpening, w: SceneWall): XY[] {
  const { n } = axes(w.start, w.end);
  return [add(o.start, n, w.a), add(o.end, n, w.a), add(o.end, n, -w.b), add(o.start, n, -w.b)];
}

/** The square a door leaf sweeps, or the opening's quad. */
function reach(o: SceneOpening, w: SceneWall): XY[] {
  const { n, len } = axes(o.start, o.end);
  if (o.kind !== 'door' || len === 0) return quad(o, w);
  const left = o.swing === 'left';
  const off = left ? w.a : -w.b;
  const k = off + (left ? len : -len);
  return [add(o.start, n, off), add(o.end, n, off), add(o.end, n, k), add(o.start, n, k)];
}

const round = (p: XY): XY => [Math.round(p[0]), Math.round(p[1])];

/**
 * Number the doors and windows of a whole document: D1…, W1… in reading order — level by
 * elevation (then ID), then top to bottom, left to right by the opening's midpoint, then ID.
 */
export function openingMarks(scenes: readonly Scene[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const kind of ['door', 'window'] as const) {
    let n = 0;
    for (const scene of scenes) {
      const list = [...scene.openings.values()]
        .filter((o) => o.kind === kind)
        .map((o) => ({ id: o.id, x: (o.start[0] + o.end[0]) / 2, y: (o.start[1] + o.end[1]) / 2 }))
        .sort((a, b) => (a.y !== b.y ? b.y - a.y : a.x !== b.x ? a.x - b.x : a.id < b.id ? -1 : 1));
      for (const o of list) marks.set(o.id, `${kind === 'door' ? 'D' : 'W'}${String(++n)}`);
    }
  }
  return marks;
}

/**
 * The drawing geometry of one level. `marks` numbers the openings (see `openingMarks`). The document
 * is validated once, with `reader` (default `OFFICIAL_READER`).
 */
export function levelPlan(
  input: string | Uint8Array | object,
  level: string,
  marks: ReadonlyMap<string, string> = new Map(),
  design?: Readonly<Record<string, string>>,
  reader: ReaderOptions = OFFICIAL_READER,
): LevelPlan {
  const ev = evaluate(input, design === undefined ? reader : { ...reader, design });
  if (!ev.valid || !ev.document) throw new InvalidDocumentError(ev.diagnostics);
  if (!ev.view || !ev.analysis) throw new RangeError('the document has no such design, or it is not valid (Core 19.6.2)');
  const doc = ev.view;
  const derived = deriveFrom(doc, ev.analysis);
  return planOf(sceneOf(ev, level, derived), marks, { doc, derived });
}

/** What a plan needs beyond its scene: the document (roof pitches) and its derived geometry (stairs arriving). */
export interface PlanContext {
  readonly doc: FloorspecDocument;
  readonly derived: Derived;
}

export function planOf(scene: Scene, marks: ReadonlyMap<string, string>, context?: PlanContext): LevelPlan {
  const roomRings = [...scene.rooms.values()].map((r) => [r.outer, ...r.holes]);
  const faceRings = [...roomRings, ...scene.unanchored.map((u) => [u.outer, ...u.holes])];
  const inside = (p: XY): boolean => faceRings.some((rings) => insideRings(p[0], p[1], rings));
  const INCHES_3 = 3 * 32_512;

  // ── which walls face the outside: a point just beyond one of its faces is in no room ──
  const exteriorWall = new Map<string, boolean>();
  for (const w of scene.walls.values()) {
    const { n } = axes(w.start, w.end);
    const m: XY = [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];
    exteriorWall.set(w.id, !inside(add(m, n, w.a + INCHES_3)) || !inside(add(m, n, -(w.b + INCHES_3))));
  }
  const exteriorVertex = new Set<string>();
  for (const w of scene.walls.values()) if (exteriorWall.get(w.id) === true) for (const v of w.outline) exteriorVertex.add(key(v));

  const pieces = [
    ...[...scene.walls.values()].filter((w) => w.outline.length >= 3).map((w) => ({ ring: ccw(w.outline), exterior: exteriorWall.get(w.id) ?? true })),
    ...[...scene.fills.values()].filter((r) => r.length >= 3).map((r) => ({ ring: ccw(r), exterior: r.some((v) => exteriorVertex.has(key(v))) })),
  ];
  const outline = unionOutline(pieces);

  // ── break the outline where openings pass through it, and close each break with jambs ──
  const wallLines: Segment[] = [];
  const openingsByWall = new Map<string, SceneOpening[]>();
  for (const o of scene.openings.values()) openingsByWall.set(o.wall, [...(openingsByWall.get(o.wall) ?? []), o]);
  const faces: { w: SceneWall; u: XY; n: XY; off: number; spans: Interval[] }[] = [];
  for (const [wid, list] of openingsByWall) {
    const w = scene.walls.get(wid);
    if (!w) continue;
    const { u, n } = axes(w.start, w.end);
    const spans = list.map((o) => {
      const t0 = (o.start[0] - w.start[0]) * u[0] + (o.start[1] - w.start[1]) * u[1];
      const t1 = (o.end[0] - w.start[0]) * u[0] + (o.end[1] - w.start[1]) * u[1];
      return { t0: Math.min(t0, t1), t1: Math.max(t0, t1) };
    });
    faces.push({ w, u, n, off: w.a, spans }, { w, u, n, off: -w.b, spans });
  }
  for (const e of outline) {
    const layer = e.exterior ? LAYERS.wallExterior : LAYERS.wallInterior;
    let pieces1: { a: XY; b: XY }[] = [{ a: e.a, b: e.b }];
    for (const f of faces) {
      const dist = (p: XY): number => (p[0] - f.w.start[0]) * f.n[0] + (p[1] - f.w.start[1]) * f.n[1] - f.off;
      const along = (p: XY): number => (p[0] - f.w.start[0]) * f.u[0] + (p[1] - f.w.start[1]) * f.u[1];
      const next: { a: XY; b: XY }[] = [];
      for (const s of pieces1) {
        if (Math.abs(dist(s.a)) > ON_FACE || Math.abs(dist(s.b)) > ON_FACE) {
          next.push(s);
          continue;
        }
        const ta = along(s.a);
        const tb = along(s.b);
        const lo = Math.min(ta, tb);
        const hi = Math.max(ta, tb);
        let spans: Interval[] = [{ t0: lo, t1: hi }];
        for (const c of f.spans) spans = subtract(spans, c);
        const at = (t: number): XY => {
          const k = (t - ta) / (tb - ta);
          return [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k];
        };
        for (const sp of spans) if (sp.t1 - sp.t0 > 1) next.push(ta <= tb ? { a: at(sp.t0), b: at(sp.t1) } : { a: at(sp.t1), b: at(sp.t0) });
      }
      pieces1 = next;
    }
    for (const s of pieces1) wallLines.push({ a: round(s.a), b: round(s.b), layer });
  }
  const cuts: XY[][] = [];
  for (const o of scene.openings.values()) {
    const w = scene.walls.get(o.wall)!;
    const q = quad(o, w);
    cuts.push(q);
    const layer = exteriorWall.get(w.id) === true ? LAYERS.wallExterior : LAYERS.wallInterior;
    wallLines.push({ a: round(q[0]!), b: round(q[3]!), layer }, { a: round(q[1]!), b: round(q[2]!), layer });
  }

  // ── doors, windows and their tags ──
  const doors: PlanDoor[] = [];
  const windows: PlanWindow[] = [];
  const tags: PlanTag[] = [];
  for (const o of scene.openings.values()) {
    const w = scene.walls.get(o.wall)!;
    const { n, len } = axes(o.start, o.end);
    if (len === 0) continue;
    const mark = marks.get(o.id);
    const mid: XY = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    if (o.kind === 'door') {
      const left = o.swing === 'left';
      const off = left ? w.a : -w.b;
      const dir: XY = left ? n : [-n[0], -n[1]];
      const J = o.hinge === 'start' ? o.start : o.end;
      const K = o.hinge === 'start' ? o.end : o.start;
      const H = add(J, n, off);
      doors.push({ id: o.id, mark, hinge: round(H), leafEnd: round(add(H, dir, len)), closedEnd: round(add(K, n, off)), radius: len });
      // The tag goes on the side the door does not swing to.
      const side: XY = [-dir[0], -dir[1]];
      if (mark !== undefined) tags.push({ kind: 'door', id: o.id, mark, base: add(mid, side, left ? w.b : w.a), normal: side });
    } else if (o.kind === 'window') {
      const T = w.a + w.b;
      const m = (w.a - w.b) / 2;
      const g = T / 7;
      const lines = [w.a, -w.b, m + g, m - g].map((k) => [round(add(o.start, n, k)), round(add(o.end, n, k))] as const);
      windows.push({ id: o.id, mark, lines });
      // Outside the building, when one side is: a window tag reads from the street.
      const outsideLeft = !inside(add(mid, n, w.a + INCHES_3));
      const side: XY = outsideLeft ? n : [-n[0], -n[1]];
      if (mark !== undefined) tags.push({ kind: 'window', id: o.id, mark, base: add(mid, side, outsideLeft ? w.a : w.b), normal: side });
    }
  }

  // ── stairs and roofs (FLR-T-9.7) ──
  const stairs: PlanStair[] = [...scene.stairs].map(([id, st]) => planStair(id, st.derived, st.form, 'up'));
  if (context !== undefined) for (const [id, st] of arrivingStairs(context.doc, context.derived, scene.levelId)) stairs.push(planStair(id, st.derived, st.form, 'down'));
  const roofs: PlanRoof[] = [...scene.roofs].map(([id, rf]) => planRoof(context?.doc, id, rf));

  // ── rooms: a label keeps clear of door swings and stairs ──
  const swings = [
    ...[...scene.openings.values()].filter((o) => o.kind === 'door').map((o) => reach(o, scene.walls.get(o.wall)!) as Pt[]),
    ...stairs.flatMap((st) => [...st.steps.map((s) => s.outline as Pt[]), ...(st.bounds === null ? [] : [st.bounds as Pt[]])]),
  ];
  const rooms: PlanRoom[] = [...scene.rooms.values()].map((r) => {
    const b = grow(undefined, r.outer)!;
    const lp = labelPoint(r.outer, r.holes, swings);
    const title = r.name !== undefined && r.name.trim() !== '' ? r.name : (FUNCTION_LABELS[r.function] ?? r.function);
    return { id: r.id, title, area: r.area, outer: r.outer, holes: r.holes, label: [lp.x, lp.y], width: b.maxX - b.minX, depth: b.maxY - b.minY };
  });

  const devices: PlanDevice[] = [...scene.fallbacks.values()].map((fb) => ({
    id: fb.id,
    extension: fb.extension,
    collection: fb.collection,
    layer: layerForDevice(fb.extension, fb.collection),
    footprint: fb.footprint,
  }));

  let body: Box | undefined;
  for (const p of pieces) body = grow(body, p.ring);
  let extent = body && { ...body };
  for (const r of scene.rooms.values()) extent = grow(extent, r.outer);
  for (const s of scene.separators.values()) extent = grow(extent, [s.start, s.end]);
  for (const u of scene.unanchored) extent = grow(extent, u.outer);
  for (const s of scene.slabs.values()) extent = grow(extent, s.outline);
  for (const d of devices) extent = grow(extent, d.footprint);
  for (const o of scene.openings.values()) extent = grow(extent, reach(o, scene.walls.get(o.wall)!));
  for (const st of stairs) {
    for (const step of st.steps) extent = grow(extent, step.outline);
    if (st.bounds) extent = grow(extent, st.bounds);
  }
  for (const rf of roofs) extent = grow(extent, rf.eave);

  return {
    levelId: scene.levelId,
    levelName: scene.levelName ?? scene.levelId,
    projectName: scene.projectName,
    trueNorth: scene.trueNorth,
    scene,
    pieces,
    cuts,
    outline,
    wallLines: wallLines.sort(bySegment),
    doors,
    windows,
    rooms,
    separators: [...scene.separators.values()].map((s) => [s.start, s.end] as const),
    slabs: [...scene.slabs.values()].map((s) => ({ id: s.id, outline: s.outline })),
    unanchored: scene.unanchored,
    devices,
    tags,
    stairs,
    roofs,
    body,
    extent,
  };
}

/** A stable order for segments, so the DXF and PDF are the same bytes for the same document. */
function bySegment(p: Segment, q: Segment): number {
  const a = [p.a[0], p.a[1], p.b[0], p.b[1]];
  const b = [q.a[0], q.a[1], q.b[0], q.b[1]];
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return p.layer < q.layer ? -1 : p.layer > q.layer ? 1 : 0;
}
