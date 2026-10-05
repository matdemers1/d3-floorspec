/**
 * Stairs (Core 0.3 and 0.4, chapter 17): the layout of a stair in its frame, its foot and head, its
 * rise and riser count, the steps, run and walkline of a straight, L-shaped or U-shaped stair, its
 * headroom, the stair invariants FS-INV-901 to FS-INV-904, the lint FS-LINT-016, the derived `stairs`,
 * and the links a stair adds to the door graph (14.1). A Core 0.4 reader also derives the tapered
 * treads of winder and spiral stairs (17.7) — their steps, walkline, goings and headroom — and the
 * opening a stair with a `minHeadroom` needs (17.6), checks FS-INV-905 and FS-INV-906, and reports
 * FS-LINT-018 and FS-LINT-019 in place of FS-LINT-016.
 *
 * Tapered treads are exact too. A winder's nosing lines lie on rays from the pivot of its turn in the
 * directions F(β) of whole-microdegree angles (13.1), so where a ray meets the sides of the turn or
 * of its newel is rational; a spiral's lie on rays from its centre in the directions F(φ). A point
 * on a walkline arc adds one radicand, |F|². A going is the square root of a value with one radicand,
 * decided by exact comparison with the squares of half-integers; a walkline's length includes an arc,
 * r · θ in radians, which π makes irrational and so never a tie (angle.ts, roundArc).
 *
 * A stair is laid out in its own frame (13.1): the origin is its `position` — the middle of its first
 * nosing line — facing F(rotation), the direction the first flight rises in. Local coordinates
 * (p, q) are exact rationals (halves of a width, multiples of a tread); a plan point is the frame's
 * exact image of one, rounded once. Elevations are the foot's floor top plus a multiple of the exact
 * riser height rise / n, rounded once where output.
 *
 * Headroom is measured on the rounded plan points of the stair's lanes — the two sides and the
 * centre line of every flight, and the edges and middle lines of every landing — so every point of a
 * lane is rational, a vaulted ceiling's elevation over it has one radicand, and every comparison is
 * exact. Along a lane the obstacles above it are constant between the places where the lane crosses
 * an edge of a room polygon, a well, a tray's centre or a vault's ridge line, and each is linear
 * there, so the infimum of the clearance is reached at the ends of those pieces (17.6).
 */
import { facingVector, roundArc } from '../exact/angle.js';
import { floorDiv, isqrt, roundHalfEvenRational, toSafeNumber } from '../exact/bigint.js';
import { Q } from '../exact/rational.js';
import { Surd } from '../exact/surd.js';
import { cross, dot, locate, type IPoint } from '../geometry/predicates.js';
import { startAtLeast } from '../derive/level.js';
import { entries, get, type FloorspecDocument, type Stair, type StairForm, type VaultedCeiling } from '../model/document.js';
import { ceilingBase, ceilingOf, floorThickness, floorTop, trayCentre, type TrayCentre } from '../slabs/floors.js';
import { cmpStr } from '../validate/diagnostic.js';
import type { LevelAnalysis } from '../validate/invariants.js';

const STRAIGHT: StairForm = { kind: 'straight' };
const DERIVED_FORMS = new Set(['straight', 'lShaped', 'uShaped']);
const QUARTER = 90_000_000n;
const HALF = 180_000_000n;

export const formOf = (st: Stair): StairForm => st.form ?? STRAIGHT;

/** Is this a form whose steps, run, walkline and headroom Core 0.3 derives (17.5, 17.7 of 0.3)? A Core 0.4 reader derives every form's. */
export const stepsDerived = (st: Stair): boolean => DERIVED_FORMS.has(formOf(st).kind);

/** Is this a winder or a spiral stair — one with tapered treads (Core 0.4, 17.7)? */
export const isTapered = (st: Stair): boolean => !stepsDerived(st);

/** An angle in (−180°, 180°], in microdegrees. */
function normalize(theta: bigint): bigint {
  const full = 360_000_000n;
  const t = ((theta % full) + full) % full;
  return t > 180_000_000n ? t - full : t;
}

// ── the layout (17.3) ───────────────────────────────────────────────────────────

type LP = readonly [Q, Q];

class Rect {
  readonly p0: Q;
  readonly q0: Q;
  readonly p1: Q;
  readonly q1: Q;
  constructor(p0: Q, q0: Q, p1: Q, q1: Q) {
    this.p0 = Q.min(p0, p1);
    this.p1 = Q.max(p0, p1);
    this.q0 = Q.min(q0, q1);
    this.q1 = Q.max(q0, q1);
  }
  corners(): LP[] {
    return [
      [this.p0, this.q0],
      [this.p1, this.q0],
      [this.p1, this.q1],
      [this.p0, this.q1],
    ];
  }
  mirrored(): Rect {
    return new Rect(this.p0, this.q1.neg(), this.p1, this.q0.neg());
  }
}

/** A straight run of `risers` risers: its first nosing line's middle `c`, its direction `e` (a local unit axis), `before` risers below its first. */
class Flight {
  constructor(
    readonly c: LP,
    readonly e: readonly [bigint, bigint],
    readonly risers: number,
    readonly before: number,
    readonly tread: bigint,
    readonly width: bigint,
  ) {}
  at(along: Q, across: Q): LP {
    const [ex, ey] = this.e;
    return [this.c[0].add(along.mul(ex)).sub(across.mul(ey)), this.c[1].add(along.mul(ey)).add(across.mul(ex))];
  }
  get length(): Q {
    return Q.of(BigInt(this.risers - 1) * this.tread);
  }
  /** (rectangle, the riser it tops) of each tread, bottom to top. */
  treads(): [Rect, number][] {
    const hw = Q.of(this.width, 2n);
    const out: [Rect, number][] = [];
    for (let k = 1; k < this.risers; k++) {
      const a = this.at(Q.of(BigInt(k - 1) * this.tread), hw.neg());
      const b = this.at(Q.of(BigInt(k) * this.tread), hw);
      out.push([new Rect(a[0], a[1], b[0], b[1]), this.before + k]);
    }
    return out;
  }
  /** Its two sides and its centre line: (start, end, riser at the start, at the end). */
  lanes(): [LP, LP, number, number][] {
    const hw = Q.of(this.width, 2n);
    return [hw, Q.ZERO, hw.neg()].map((x) => [this.at(Q.ZERO, x), this.at(this.length, x), this.before + 1, this.before + this.risers]);
  }
  mirrored(): Flight {
    return new Flight([this.c[0], this.c[1].neg()], [this.e[0], -this.e[1]], this.risers, this.before, this.tread, this.width);
  }
}

type Piece = { kind: 'flight'; flight: Flight } | { kind: 'landing'; rect: Rect; index: number };

interface Layout {
  pieces: Piece[];
  head: LP;
  /** What bounds a winder stair in plan. */
  rects: Rect[];
  /** The walkline's vertices. */
  walk: LP[];
}

/** 17.3: the stair laid out with n risers, in local coordinates. */
function layout(st: Stair, n: number): Layout {
  const f = formOf(st);
  const t = BigInt(st.tread);
  const w = BigInt(st.width);
  const hw = Q.of(w, 2n);
  const lay: Layout = { pieces: [], head: [Q.ZERO, Q.ZERO], rects: [], walk: [] };
  if (f.kind === 'spiral') return lay;
  const m = 'risersBeforeTurn' in f ? f.risersBeforeTurn : n;
  const P = Q.of(BigInt(m - 1) * t);
  const W = Q.of(w);
  const origin: LP = [Q.ZERO, Q.ZERO];
  if (f.kind === 'straight') {
    const fl = new Flight(origin, [1n, 0n], n, 0, t, w);
    lay.pieces = [{ kind: 'flight', flight: fl }];
    lay.head = fl.at(fl.length, Q.ZERO);
    lay.walk = [fl.at(Q.ZERO, Q.ZERO), lay.head];
  } else if (f.kind === 'lShaped') {
    const f1 = new Flight(origin, [1n, 0n], m, 0, t, w);
    const f2 = new Flight([P.add(hw), hw], [0n, 1n], n - m, m, t, w);
    lay.pieces = [{ kind: 'flight', flight: f1 }, { kind: 'landing', rect: new Rect(P, hw.neg(), P.add(W), hw), index: m }, { kind: 'flight', flight: f2 }];
    lay.head = f2.at(f2.length, Q.ZERO);
    lay.walk = [f1.at(Q.ZERO, Q.ZERO), [P.add(hw), Q.ZERO], lay.head];
  } else if (f.kind === 'uShaped') {
    const g = Q.of(BigInt(f.gap ?? 0));
    const f1 = new Flight(origin, [1n, 0n], m, 0, t, w);
    const f2 = new Flight([P, W.add(g)], [-1n, 0n], n - m, m, t, w);
    lay.pieces = [{ kind: 'flight', flight: f1 }, { kind: 'landing', rect: new Rect(P, hw.neg(), P.add(W), hw.mul(3n).add(g)), index: m }, { kind: 'flight', flight: f2 }];
    lay.head = f2.at(f2.length, Q.ZERO);
    lay.walk = [f1.at(Q.ZERO, Q.ZERO), [P.add(hw), Q.ZERO], [P.add(hw), W.add(g)], lay.head];
  } else {
    // A winder stair: bounded, not stepped.
    const s2 = Q.of(BigInt(n - m - f.winders) * t);
    const rects = P.sign() > 0 ? [new Rect(Q.ZERO, hw.neg(), P, hw)] : [];
    if (f.angle === 'quarter') {
      rects.push(new Rect(P, hw.neg(), P.add(W), hw));
      if (s2.sign() > 0) rects.push(new Rect(P, hw, P.add(W), hw.add(s2)));
      lay.head = [P.add(hw), hw.add(s2)];
    } else {
      const g = Q.of(BigInt(f.gap ?? 0));
      rects.push(new Rect(P, hw.neg(), P.add(W), hw.mul(3n).add(g)));
      if (s2.sign() > 0) rects.push(new Rect(P.sub(s2), hw.add(g), P, hw.mul(3n).add(g)));
      lay.head = [P.sub(s2), W.add(g)];
    }
    lay.rects = rects;
  }
  if ('turn' in f && f.turn === 'right') {
    return {
      pieces: lay.pieces.map((p): Piece => (p.kind === 'flight' ? { kind: 'flight', flight: p.flight.mirrored() } : { kind: 'landing', rect: p.rect.mirrored(), index: p.index })),
      head: [lay.head[0], lay.head[1].neg()],
      rects: lay.rects.map((r) => r.mirrored()),
      walk: lay.walk.map(([p, q]) => [p, q.neg()]),
    };
  }
  return lay;
}

// ── the frame (17.3) ────────────────────────────────────────────────────────────

interface StairFrame {
  readonly ox: Surd;
  readonly oy: Surd;
  readonly f: readonly [bigint, bigint];
}

const frameOf = (st: Stair): StairFrame => ({ ox: Surd.of(st.position[0]), oy: Surd.of(st.position[1]), f: facingVector(st.rotation ?? 0) });

/** The exact plan point of local (p, q): O + (p·f + q·rot90(f)) / |f| (13.1). */
function plan(fr: StairFrame, p: Q, q: Q): { x: Surd; y: Surd } {
  const [fx, fy] = fr.f;
  const D = fx * fx + fy * fy;
  const k = Surd.sqrt(D);
  const den = p.d * q.d;
  const pn = p.n * q.d;
  const qn = q.n * p.d;
  return { x: fr.ox.add(k.mulInt(pn * fx - qn * fy).divInt(D * den)), y: fr.oy.add(k.mulInt(pn * fy + qn * fx).divInt(D * den)) };
}

function rpt(fr: StairFrame, p: LP): IPoint {
  const x = plan(fr, p[0], p[1]);
  return [x.x.round(), x.y.round()];
}

/** 17.3: a spiral stair's centre and head, exactly. */
function spiralPoints(st: Stair): { cx: Surd; cy: Surd; hx: Surd; hy: Surd } {
  const f = formOf(st) as Extract<StairForm, { kind: 'spiral' }>;
  const fr = frameOf(st);
  const rw = Q.of(BigInt(f.diameter), 2n).sub(Q.of(BigInt(st.width), 2n));
  const left = f.turn === 'left';
  const c = plan(fr, Q.ZERO, left ? rw : rw.neg());
  const rot = BigInt(st.rotation ?? 0);
  const phi = left ? rot - QUARTER + BigInt(f.sweep) : rot + QUARTER - BigInt(f.sweep);
  const h = plan({ ox: c.x, oy: c.y, f: facingVector(normalize(phi)) }, rw, Q.ZERO);
  return { cx: c.x, cy: c.y, hx: h.x, hy: h.y };
}

function headPoint(st: Stair, n: number): IPoint {
  if (formOf(st).kind === 'spiral') {
    const s = spiralPoints(st);
    return [s.hx.round(), s.hy.round()];
  }
  return rpt(frameOf(st), layout(st, n).head);
}

// ── rooms at a point ────────────────────────────────────────────────────────────

interface Poly {
  readonly outer: IPoint[];
  readonly holes: IPoint[][];
}

/** A rational plan point, as an integer point and the scale it is multiplied by. */
interface QPoint {
  readonly x: Q;
  readonly y: Q;
}

function scaled(p: QPoint): { pt: IPoint; L: bigint } {
  const g = gcdB(p.x.d, p.y.d);
  const L = (p.x.d / g) * p.y.d;
  return { pt: [p.x.n * (L / p.x.d), p.y.n * (L / p.y.d)], L };
}

function gcdB(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

const scaleRing = (ring: readonly IPoint[], L: bigint): IPoint[] => (L === 1n ? (ring as IPoint[]) : ring.map((p) => [p[0] * L, p[1] * L] as const));

function locateQ(p: QPoint, ring: readonly IPoint[]): 'on' | 'inside' | 'outside' {
  const { pt, L } = scaled(p);
  return locate(pt, scaleRing(ring, L));
}

/** Inside or on the outer ring, and not strictly inside a hole (17.4; a tray's centre, 15.4). */
const closedContains = (poly: Poly, p: QPoint): boolean => locateQ(p, poly.outer) !== 'outside' && poly.holes.every((h) => locateQ(p, h) !== 'inside');
/** Strictly inside the outer ring and outside every hole (17.6). */
const strictlyContains = (poly: Poly, p: QPoint): boolean => locateQ(p, poly.outer) === 'inside' && poly.holes.every((h) => locateQ(p, h) === 'outside');

const qpoint = (p: IPoint): QPoint => ({ x: Q.of(p[0]), y: Q.of(p[1]) });

/** What a stair needs of the levels: room polygons by room, and the wells (unanchored faces that are not degenerate). */
export class StairContext {
  private readonly cache = new Map<string, { rooms: Map<string, Poly>; wells: Poly[] }>();
  constructor(
    readonly doc: FloorspecDocument,
    readonly levels: ReadonlyMap<string, LevelAnalysis>,
  ) {}

  polygons(level: string): { rooms: Map<string, Poly>; wells: Poly[] } {
    const hit = this.cache.get(level);
    if (hit) return hit;
    const la = this.levels.get(level)!;
    const g = la.geometry!;
    const rooms = new Map<string, Poly>();
    const anchored = new Set<number>();
    for (const [rid, face] of [...la.roomFaces].sort(([a], [b]) => cmpStr(a, b))) {
      anchored.add(face);
      const p = g.roomPolygon(g.faces[face]!);
      rooms.set(rid, { outer: p.outer, holes: p.holes });
    }
    const wells: Poly[] = [];
    g.faces.forEach((f, i) => {
      if (anchored.has(i)) return;
      const p = g.roomPolygon(f);
      if (!p.degenerate) wells.push({ outer: p.outer, holes: p.holes });
    });
    const v = { rooms, wells };
    this.cache.set(level, v);
    return v;
  }

  /** 17.4: the room of `level` whose room polygon contains p — the first by ID — or undefined. */
  roomAt(level: string, p: IPoint): string | undefined {
    for (const [rid, poly] of this.polygons(level).rooms) if (closedContains(poly, qpoint(p))) return rid;
    return undefined;
  }

  floorAt(level: string, rid: string | undefined): bigint {
    return rid !== undefined ? floorTop(this.doc, get(this.doc.rooms, rid)!) : BigInt(get(this.doc.levels, level)!.elevation);
  }
}

// ── foot, head, risers (17.4) ───────────────────────────────────────────────────

export interface Resolved {
  readonly foot: IPoint;
  readonly footRoom?: string;
  readonly bottom: bigint;
  readonly n: number;
  readonly head: IPoint;
  readonly headRoom?: string;
  readonly top: bigint;
  readonly rise: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);

/** 17.4: a stair's foot and head, rise and riser count, exactly. */
export function resolve(ctx: StairContext, st: Stair): Resolved {
  const foot: IPoint = [BigInt(st.position[0]), BigInt(st.position[1])];
  const footRoom = ctx.roomAt(st.level, foot);
  const bottom = ctx.floorAt(st.level, footRoom);
  const at = (n: number): { head: IPoint; room: string | undefined; top: bigint } => {
    const head = headPoint(st, n);
    const room = ctx.roomAt(st.to, head);
    return { head, room, top: ctx.floorAt(st.to, room) };
  };
  let n: number;
  if (st.risers !== undefined) n = st.risers;
  else {
    // The least n ≥ 1 with top(n) − bottom ≤ n · maxRiser. top(n) is one of finitely many values —
    // the to level's elevation or a floor top of one of its rooms — so no n below the least of
    // ⌈(T − bottom) / maxRiser⌉ over them can qualify: start there.
    const mr = BigInt(st.maxRiser!);
    const tops = [BigInt(get(ctx.doc.levels, st.to)!.elevation), ...[...ctx.polygons(st.to).rooms.keys()].map((r) => floorTop(ctx.doc, get(ctx.doc.rooms, r)!))];
    const lower = tops.map((T) => ceilDiv(T - bottom, mr)).reduce((a, b) => (b < a ? b : a));
    n = Number(lower > 1n ? lower : 1n);
    while (at(n).top - bottom > BigInt(n) * mr) n++;
  }
  const h = at(n);
  return { foot, ...(footRoom !== undefined && { footRoom }), bottom, n, head: h.head, ...(h.room !== undefined && { headRoom: h.room }), top: h.top, rise: h.top - bottom };
}

/** The exact elevation of the top of riser `index`. */
const riserZ = (r: Resolved, index: number): Q => Q.of(r.rise * BigInt(index), BigInt(r.n)).add(r.bottom);

/** 17.4.2: do n risers fit the stair's form? */
function fits(st: Stair, n: number): boolean {
  const f = formOf(st);
  if (f.kind === 'straight' || f.kind === 'spiral') return n >= 2;
  const m = f.risersBeforeTurn;
  if (f.kind === 'winder') return n >= m + f.winders;
  return m >= 2 && n - m >= 2;
}

// ── invariants (FS-INV-901 … 904) ───────────────────────────────────────────────

export type StairCode = 'FS-INV-901' | 'FS-INV-902' | 'FS-INV-903' | 'FS-INV-904' | 'FS-INV-905' | 'FS-INV-906';

/**
 * FS-INV-901 for every stair; FS-INV-904 for every spiral stair; FS-INV-902 and FS-INV-903 for a stair
 * without FS-INV-901 whose two levels are levels where room invariants are evaluated and have no room
 * with FS-INV-201 to FS-INV-204, and FS-INV-903 not for one with FS-INV-902 (10.3). `badRoomLevels`
 * are the levels of rooms with FS-INV-201 to FS-INV-204. A Core 0.4 reader (`core04`) also checks
 * FS-INV-905 for every winder stair, and FS-INV-906 where FS-INV-903 is evaluated, for a stair with
 * neither FS-INV-902 nor FS-INV-903.
 */
export function stairInvariants(ctx: StairContext, badRoomLevels: ReadonlySet<string>, core04 = false): { id: string; code: StairCode }[] {
  const doc = ctx.doc;
  const out: { id: string; code: StairCode }[] = [];
  for (const [id, st] of entries(doc.stairs)) {
    const lv = get(doc.levels, st.level)!;
    const to = get(doc.levels, st.to)!;
    const f = formOf(st);
    if (f.kind === 'spiral' && 2 * st.width > f.diameter) out.push({ id, code: 'FS-INV-904' });
    if (core04 && f.kind === 'winder' && !newelInside(st)) out.push({ id, code: 'FS-INV-905' });
    if (st.to === st.level || to.building !== lv.building) {
      out.push({ id, code: 'FS-INV-901' });
      continue;
    }
    const usable = (l: string): boolean => {
      const la = ctx.levels.get(l);
      return !!la && !la.broken && !!la.geometry && !badRoomLevels.has(l);
    };
    if (!usable(st.level) || !usable(st.to)) continue;
    const r = resolve(ctx, st);
    if (r.rise <= 0n) out.push({ id, code: 'FS-INV-902' });
    else if (!fits(st, r.n)) out.push({ id, code: 'FS-INV-903' });
    else if (core04 && isTapered(st) && !anglesOk(st, r.n)) out.push({ id, code: 'FS-INV-906' });
  }
  return out;
}

// ── headroom (17.6) ─────────────────────────────────────────────────────────────

type Obstacle = { kind: 'floor'; rid: string } | { kind: 'ceiling'; rid: string; inTray: boolean | undefined };
type Seg = readonly [IPoint, IPoint];

const ringEdges = (ring: readonly IPoint[]): Seg[] => ring.map((p, i) => [p, ring[(i + 1) % ring.length]!] as const);

/** What can be above a stair: the rooms of its level (their ceilings), the rooms of its `to` level (their floors' bottoms and ceilings), and the wells of its `to` level. */
class Above {
  readonly lower: Map<string, Poly>;
  readonly upper: Map<string, Poly>;
  readonly wells: Poly[];
  readonly trays = new Map<string, TrayCentre>();
  readonly edges: Seg[] = [];
  readonly ridges: VaultedCeiling[] = [];

  constructor(
    readonly ctx: StairContext,
    st: Stair,
  ) {
    const doc = ctx.doc;
    this.lower = ctx.polygons(st.level).rooms;
    const up = ctx.polygons(st.to);
    this.upper = up.rooms;
    this.wells = up.wells;
    for (const [rid, poly] of [...this.lower, ...this.upper]) {
      for (const ring of [poly.outer, ...poly.holes]) this.edges.push(...ringEdges(ring));
      const c = ceilingOf(get(doc.rooms, rid)!);
      if (c.kind === 'tray') {
        const tr = trayCentre(poly.outer, poly.holes, BigInt(c.border))!;
        this.trays.set(rid, tr);
        for (const ring of [tr.outer, ...tr.holes]) this.edges.push(...ringEdges(ring));
      } else if (c.kind === 'vaulted' && (c.slopes ?? 'both') === 'both') this.ridges.push(c);
    }
    for (const w of this.wells) for (const ring of [w.outer, ...w.holes]) this.edges.push(...ringEdges(ring));
  }

  /** The obstacles above a plan point that is on no edge or ridge line. */
  obstacles(m: QPoint): Obstacle[] {
    const out: Obstacle[] = [];
    const inWell = this.wells.some((w) => closedContains(w, m));
    const tray = (rid: string): boolean | undefined => {
      const t = this.trays.get(rid);
      return t ? closedContains(t, m) : undefined;
    };
    if (!inWell) for (const [rid, poly] of this.lower) if (strictlyContains(poly, m)) out.push({ kind: 'ceiling', rid, inTray: tray(rid) });
    for (const [rid, poly] of this.upper)
      if (strictlyContains(poly, m)) {
        out.push({ kind: 'floor', rid });
        out.push({ kind: 'ceiling', rid, inTray: tray(rid) });
      }
    return out;
  }

  /** The exact elevation of an obstacle at a plan point. */
  value(ob: Obstacle, p: QPoint): Surd {
    const doc = this.ctx.doc;
    const room = get(doc.rooms, ob.rid)!;
    if (ob.kind === 'floor') return Surd.of(floorTop(doc, room) - floorThickness(doc, room));
    const c = ceilingOf(room);
    const base = ceilingBase(doc, room);
    if (c.kind === 'flat') return Surd.of(base);
    if (c.kind === 'tray') return Surd.of(ob.inTray ? base + BigInt(c.depth) : base);
    return vaultAtQ(base, c, p);
  }
}

/** c(P) of 15.3 at a rational point: the ridge line's cross with P. */
function vaultCrossQ(c: VaultedCeiling, p: QPoint): Q {
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  return p.y.sub(BigInt(ay)).mul(dx).sub(p.x.sub(BigInt(ax)).mul(dy));
}

/** 15.3: E + h − (rise / run) · f(P) / √D, at a rational point. */
function vaultAtQ(base: bigint, c: VaultedCeiling, p: QPoint): Surd {
  const cr = vaultCrossQ(c, p);
  const slopes = c.slopes ?? 'both';
  const f = slopes === 'both' ? cr.abs() : slopes === 'left' ? cr : cr.neg();
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  const D = dx * dx + dy * dy;
  return Surd.sqrt(D).mulInt(-BigInt(c.pitch.rise) * f.n).divInt(BigInt(c.pitch.run) * D * f.d).addInt(base);
}

const crossAt = (c: VaultedCeiling, p: IPoint): bigint => {
  const [[ax, ay], [bx, by]] = c.ridge;
  return BigInt(bx - ax) * (p[1] - BigInt(ay)) - BigInt(by - ay) * (p[0] - BigInt(ax));
};

/** Every parameter s in [0, 1] at which the segment a → b meets an edge or a ridge line, sorted. */
function crossings(a: IPoint, b: IPoint, edges: readonly Seg[], ridges: readonly VaultedCeiling[]): Q[] {
  const d: IPoint = [b[0] - a[0], b[1] - a[1]];
  const out = new Map<string, Q>();
  const add = (s: Q): void => {
    out.set(s.toString(), s);
  };
  add(Q.ZERO);
  add(Q.ONE);
  const inUnit = (s: Q): boolean => s.sign() >= 0 && s.cmp(1n) <= 0;
  for (const [u, v] of edges) {
    const e: IPoint = [v[0] - u[0], v[1] - u[1]];
    const ua: IPoint = [u[0] - a[0], u[1] - a[1]];
    const den = cross(d, e);
    if (den !== 0n) {
      const s = Q.of(cross(ua, e), den);
      const r = Q.of(cross(ua, d), den);
      if (inUnit(s) && inUnit(r)) add(s);
    } else if (cross(ua, d) === 0n) {
      const dd = dot(d, d);
      for (const x of [u, v]) {
        const s = Q.of(dot([x[0] - a[0], x[1] - a[1]], d), dd);
        if (inUnit(s)) add(s);
      }
    }
  }
  for (const c of ridges) {
    const ca = crossAt(c, a);
    const cb = crossAt(c, b);
    if ((ca < 0n && cb > 0n) || (cb < 0n && ca > 0n)) add(Q.of(ca, ca - cb));
  }
  return [...out.values()].sort((x, y) => x.cmp(y));
}

/** The least clearance along a lane, over the points with something above them; undefined when nothing is above any. */
function laneClearance(above: Above, a: IPoint, b: IPoint, za: Q, zb: Q): Surd | undefined {
  if (a[0] === b[0] && a[1] === b[1]) return undefined;
  let best: Surd | undefined;
  const ss = crossings(a, b, above.edges, above.ridges);
  const pt = (s: Q): QPoint => ({ x: s.mul(b[0] - a[0]).add(a[0]), y: s.mul(b[1] - a[1]).add(a[1]) });
  for (let i = 0; i + 1 < ss.length; i++) {
    const s0 = ss[i]!;
    const s1 = ss[i + 1]!;
    const obs = above.obstacles(pt(s0.add(s1).div(2n)));
    if (!obs.length) continue;
    for (const s of [s0, s1]) {
      const p = pt(s);
      let low: Surd | undefined;
      for (const ob of obs) {
        const v = above.value(ob, p);
        if (!low || v.cmp(low) < 0) low = v;
      }
      const v = low!.sub(za.add(s.mul(zb.sub(za))).toSurd());
      if (!best || v.cmp(best) < 0) best = v;
    }
  }
  return best;
}

function lanes(lay: Layout, fr: StairFrame, r: Resolved): [IPoint, IPoint, Q, Q][] {
  const out: [IPoint, IPoint, Q, Q][] = [];
  for (const piece of lay.pieces) {
    if (piece.kind === 'flight') {
      for (const [p0, p1, i0, i1] of piece.flight.lanes()) out.push([rpt(fr, p0), rpt(fr, p1), riserZ(r, i0), riserZ(r, i1)]);
    } else {
      const { rect, index } = piece;
      const z = riserZ(r, index);
      const cs = rect.corners();
      const pm = rect.p0.add(rect.p1).div(2n);
      const qm = rect.q0.add(rect.q1).div(2n);
      const segs: [LP, LP][] = cs.map((c, i) => [c, cs[(i + 1) % 4]!]);
      segs.push([[rect.p0, qm], [rect.p1, qm]], [[pm, rect.q0], [pm, rect.q1]]);
      for (const [p0, p1] of segs) out.push([rpt(fr, p0), rpt(fr, p1), z, z]);
    }
  }
  return out;
}

/** 17.6: the exact headroom over the lanes of the laid-out stair and of its tapered treads, or undefined when nothing is above any. */
function headroomOf(ctx: StairContext, st: Stair, lay: Layout, fr: StairFrame, r: Resolved, extra: readonly [IPoint, IPoint, Q, Q][] = []): Surd | undefined {
  const above = new Above(ctx, st);
  let best: Surd | undefined;
  for (const [a, b, za, zb] of [...lanes(lay, fr, r), ...extra]) {
    const v = laneClearance(above, a, b, za, zb);
    if (v && (!best || v.cmp(best) < 0)) best = v;
  }
  return best;
}

/** The exact headroom of any stair as a Core 0.4 reader derives it, or undefined. */
function exactHeadroom(ctx: StairContext, st: Stair): Surd | undefined {
  const r = resolve(ctx, st);
  const fr = frameOf(st);
  if (isTapered(st)) {
    const tp = tapered(st, r.n);
    return headroomOf(ctx, st, { pieces: tp.flights.map((flight) => ({ kind: 'flight', flight })), head: [Q.ZERO, Q.ZERO], rects: [], walk: [] }, fr, r, taperedLanes(tp, r));
  }
  return headroomOf(ctx, st, layout(st, r.n), fr, r);
}

/**
 * Core 0.4's stair lints (17.6.4, 17.7.6): FS-LINT-018 for a winder stair without a newel or a spiral
 * whose width is half its diameter, FS-LINT-019 for a stair whose headroom is less than its minHeadroom.
 */
export function stairLints(ctx: StairContext): { id: string; code: 'FS-LINT-018' | 'FS-LINT-019' }[] {
  const out: { id: string; code: 'FS-LINT-018' | 'FS-LINT-019' }[] = [];
  for (const [id, st] of entries(ctx.doc.stairs)) {
    const f = formOf(st);
    if ((f.kind === 'winder' && f.newel === undefined) || (f.kind === 'spiral' && 2 * st.width === f.diameter)) out.push({ id, code: 'FS-LINT-018' });
    if (st.minHeadroom !== undefined) {
      const h = exactHeadroom(ctx, st);
      if (h && h.cmp(Surd.of(BigInt(st.minHeadroom))) < 0) out.push({ id, code: 'FS-LINT-019' });
    }
  }
  return out;
}

// ── tapered treads (Core 0.4, 17.7) ────────────────────────────────────────────

/** An exact plan or local point whose coordinates may carry square roots. */
type SP = readonly [Surd, Surd];
type Dir = readonly [bigint, bigint];

/** round(j · total / k) for j = 0 … k: an angle divided into k parts, each end a whole microdegree (17.7). */
function divisions(total: bigint, k: bigint): bigint[] {
  const out: bigint[] = [];
  for (let j = 0n; j <= k; j++) out.push(roundHalfEvenRational(j * total, k));
  return out;
}

/**
 * FS-INV-906 (17.7.5): every winder turns through an angle greater than zero — round(j·A/W) −
 * round((j − 1)·A/W) is at least 1 exactly when W ≤ A — and every spiral tread through more than zero
 * and less than 180°.
 */
export function anglesOk(st: Stair, n: number): boolean {
  const f = formOf(st);
  if (f.kind === 'winder') return BigInt(f.winders) <= (f.angle === 'half' ? HALF : QUARTER);
  if (f.kind !== 'spiral') return true;
  const cuts = divisions(BigInt(f.sweep), BigInt(n - 1));
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i]! - cuts[i - 1]!;
    if (a <= 0n || a >= HALF) return false;
  }
  return true;
}

/** FS-INV-905 (17.7.4): the newel lies inside the walkline's circle, and a half turn's gap is no wider than the stair. */
export function newelInside(st: Stair): boolean {
  const f = formOf(st) as Extract<StairForm, { kind: 'winder' }>;
  const w = BigInt(st.width);
  const a = BigInt(f.newel ?? 0);
  const g = f.angle === 'half' ? BigInt(f.gap ?? 0) : 0n;
  return (2n * a) ** 2n + (2n * a + g) ** 2n < (w + g) ** 2n && g <= w;
}

/** round(√x) for an exact x ≥ 0, ties to even: x compared with (k + ½)² exactly. */
export function roundSqrt(x: Surd): bigint {
  const fl = x.floor();
  const k = isqrt(fl > 0n ? fl : 0n);
  const c = x.sub(Surd.of((2n * k + 1n) ** 2n, 4n)).sign();
  if (c > 0) return k + 1n;
  if (c < 0) return k;
  return k % 2n === 0n ? k : k + 1n;
}

/** |g₀/|g₀| − g₁/|g₁||² = 2 − 2·(g₀·g₁)/√(|g₀|²·|g₁|²), exact, in one radicand. */
function unitSqGap(g0: Dir, g1: Dir): Surd {
  const M = (g0[0] * g0[0] + g0[1] * g0[1]) * (g1[0] * g1[0] + g1[1] * g1[1]);
  const G = g0[0] * g1[0] + g0[1] * g1[1];
  return Surd.of(2n).add(Surd.sqrt(M).mulInt(-2n * G).divInt(M));
}

const timesQ = (x: Surd, r: Q): Surd => x.mulInt(r.n).divInt(r.d);

/** o + r · d / |d|, exact. */
function onRay(o: SP, d: Dir, r: Q): SP {
  const m = d[0] * d[0] + d[1] * d[1];
  const k = Surd.sqrt(m);
  return [o[0].add(k.mulInt(r.n * d[0]).divInt(r.d * m)), o[1].add(k.mulInt(r.n * d[1]).divInt(r.d * m))];
}

/** The exact plan point of local (p, q), each a surd (13.1). */
function planS(fr: StairFrame, p: Surd, q: Surd): SP {
  const [fx, fy] = fr.f;
  const D = fx * fx + fy * fy;
  const k = Surd.sqrt(D);
  return [fr.ox.add(p.mulInt(fx).sub(q.mulInt(fy)).mul(k).divInt(D)), fr.oy.add(p.mulInt(fy).add(q.mulInt(fx)).mul(k).divInt(D))];
}

const sp = (p: LP): SP => [p[0].toSurd(), p[1].toSurd()];
const roundSP = (p: SP): IPoint => [p[0].round(), p[1].round()];
const samePt = (a: IPoint, b: IPoint): boolean => a[0] === b[0] && a[1] === b[1];

/** A tapered tread's outline (17.7): its exact points rounded once, repeats removed, counter-clockwise from its least vertex. */
function ringOfPoints(points: readonly SP[]): IPoint[] {
  let ring: IPoint[] = [];
  for (const p of points.map(roundSP)) if (!ring.length || !samePt(ring[ring.length - 1]!, p)) ring.push(p);
  while (ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!)) ring.pop();
  let a2 = 0n;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a2 += p[0] * q[1] - p[1] * q[0];
  }
  if (a2 < 0n) ring = [...ring].reverse();
  return startAtLeast(ring);
}

const crossQ = (d: Dir, v: LP): Q => v[1].mul(d[0]).sub(v[0].mul(d[1]));
const sameLP = (a: LP, b: LP): boolean => a[0].eq(b[0]) && a[1].eq(b[1]);

/** The turn of a winder stair (17.7), in the local coordinates of a left turn. */
class Turn {
  readonly P: Q;
  readonly half: boolean;
  readonly A: bigint;
  readonly W: number;
  readonly O: LP;
  readonly r: Q;
  readonly dirs: Dir[];
  readonly inner: LP[];
  readonly outer: LP[];
  readonly outerCorners: LP[];
  readonly newelCorners: LP[];

  constructor(st: Stair) {
    const f = formOf(st) as Extract<StairForm, { kind: 'winder' }>;
    const w = BigInt(st.width);
    this.half = f.angle === 'half';
    const g = f.angle === 'half' ? BigInt(f.gap ?? 0) : 0n;
    const a = BigInt(f.newel ?? 0);
    const hw = Q.of(w, 2n);
    this.P = Q.of(BigInt(f.risersBeforeTurn - 1) * BigInt(st.tread));
    this.W = f.winders;
    this.A = this.half ? HALF : QUARTER;
    this.O = [this.P, hw.add(Q.of(g, 2n))];
    this.r = Q.of(w + g, 2n);
    const qLo = hw.neg();
    const top = this.half ? hw.mul(3n).add(g) : hw;
    const nLo = hw.sub(a);
    const nHi = this.half ? hw.add(g + a) : hw;
    this.dirs = divisions(this.A, BigInt(this.W)).map((b) => facingVector(-QUARTER + b));
    this.inner = this.dirs.map((d) => (a > 0n ? this.end(d, this.P.add(a), nLo, nHi) : this.O));
    this.outer = this.dirs.map((d) => this.end(d, this.P.add(w), qLo, top));
    this.outerCorners = [[this.P.add(w), qLo], ...(this.half ? [[this.P.add(w), top] as LP] : [])];
    this.newelCorners = a > 0n ? [[this.P.add(a), nLo], ...(this.half ? [[this.P.add(a), nHi] as LP] : [])] : [];
  }

  /** Where the ray from O in the direction d leaves the rectangle [P, pHi] × [qLo, qHi]. */
  private end(d: Dir, pHi: Q, qLo: Q, qHi: Q): LP {
    const [px, qy] = this.O;
    const [dx, dy] = d;
    let best: Q | undefined;
    const cand = (x: Q): void => {
      if (!best || x.cmp(best) < 0) best = x;
    };
    if (dx > 0n) cand(pHi.sub(px).div(dx));
    if (dy < 0n) cand(qLo.sub(qy).div(dy));
    if (dy > 0n) cand(qHi.sub(qy).div(dy));
    return [px.add(best!.mul(dx)), qy.add(best!.mul(dy))];
  }

  private between(j: number, c: LP): boolean {
    const v: LP = [c[0].sub(this.O[0]), c[1].sub(this.O[1])];
    const d0 = this.dirs[j - 1]!;
    const d1 = this.dirs[j]!;
    // d₀ × v > 0 and v × d₁ > 0
    return crossQ(d0, v).sign() > 0 && v[0].mul(d1[1]).sub(v[1].mul(d1[0])).sign() > 0;
  }

  /** Winder j (1 … W): out along nosing line j − 1, along the turn's sides, in along nosing line j, back along the newel. */
  winder(j: number): LP[] {
    const pts: LP[] = [this.inner[j - 1]!, this.outer[j - 1]!, ...this.outerCorners.filter((c) => this.between(j, c)), this.outer[j]!, this.inner[j]!];
    pts.push(...[...this.newelCorners].reverse().filter((c) => this.between(j, c)));
    const out: LP[] = [];
    for (const p of pts) if (!out.length || !sameLP(out[out.length - 1]!, p)) out.push(p);
    if (out.length > 1 && sameLP(out[0]!, out[out.length - 1]!)) out.pop();
    return out;
  }

  /** Where the walkline — the arc of radius (w + g)/2 about O — crosses nosing line j. */
  walk(j: number): SP {
    return onRay(sp(this.O), this.dirs[j]!, this.r);
  }

  /** (the square of winder j's going at the walkline, the square of its going at its narrow end). */
  goings(j: number): [Surd, Surd] {
    const walk = timesQ(unitSqGap(this.dirs[j - 1]!, this.dirs[j]!), this.r.mul(this.r));
    const a = this.inner[j - 1]!;
    const b = this.inner[j]!;
    const dp = a[0].sub(b[0]);
    const dq = a[1].sub(b[1]);
    return [walk, dp.mul(dp).add(dq.mul(dq)).toSurd()];
  }
}

interface TaperedTread {
  readonly outline: readonly SP[];
  /** The riser it is the top of. */
  readonly index: number;
  readonly chord: readonly [SP, SP];
  readonly walk: Surd;
  readonly narrow: Surd;
}

interface Tapered {
  /** A winder stair's two flights, local and mirrored for a right turn; a spiral has none. */
  readonly flights: Flight[];
  readonly treads: TaperedTread[];
  readonly walk: SP[];
  readonly length: bigint;
  readonly centre?: SP;
}

/** 17.7: the tapered treads of a winder or a spiral stair of n risers, exactly. */
function tapered(st: Stair, n: number): Tapered {
  const f = formOf(st);
  const fr = frameOf(st);
  const t = BigInt(st.tread);
  const w = BigInt(st.width);
  const hw = Q.of(w, 2n);
  if (f.kind === 'spiral') {
    const { cx, cy } = spiralPoints(st);
    const C: SP = [cx, cy];
    const R = Q.of(BigInt(f.diameter), 2n);
    const rc = R.sub(hw);
    const ri = R.sub(Q.of(w));
    const left = f.turn === 'left';
    const rot = BigInt(st.rotation ?? 0);
    const base = left ? rot - QUARTER : rot + QUARTER;
    const dirs = divisions(BigInt(f.sweep), BigInt(n - 1)).map((b) => facingVector(normalize(left ? base + b : base - b)));
    const walk = dirs.map((d) => onRay(C, d, rc));
    const treads: TaperedTread[] = [];
    for (let k = 1; k < n; k++) {
      const d0 = dirs[k - 1]!;
      const d1 = dirs[k]!;
      const outline = ri.sign() > 0 ? [onRay(C, d0, ri), onRay(C, d0, R), onRay(C, d1, R), onRay(C, d1, ri)] : [C, onRay(C, d0, R), onRay(C, d1, R)];
      const gap = unitSqGap(d0, d1);
      treads.push({ outline, index: k, chord: [walk[k - 1]!, walk[k]!], walk: timesQ(gap, rc.mul(rc)), narrow: timesQ(gap, ri.mul(ri)) });
    }
    return { flights: [], treads, walk, length: roundArc(0n, 1n, rc.n, rc.d, BigInt(f.sweep)), centre: C };
  }
  // A winder stair: its first flight, the winders of its turn, and its second flight.
  const wf = f as Extract<StairForm, { kind: 'winder' }>;
  const m = wf.risersBeforeTurn;
  const W = wf.winders;
  const turn = new Turn(st);
  const P = turn.P;
  const g = wf.angle === 'half' ? BigInt(wf.gap ?? 0) : 0n;
  const s2 = BigInt(n - m - W) * t;
  const right = wf.turn === 'right';
  const mir = (p: SP): SP => (right ? [p[0], p[1].neg()] : p);
  const plan = (p: SP): SP => {
    const q = mir(p);
    return planS(fr, q[0], q[1]);
  };
  const f1 = new Flight([Q.ZERO, Q.ZERO], [1n, 0n], m, 0, t, w);
  const f2 = turn.half ? new Flight([P, Q.of(w + g)], [-1n, 0n], n - m - W + 1, m + W - 1, t, w) : new Flight([P.add(hw), hw], [0n, 1n], n - m - W + 1, m + W - 1, t, w);
  const crossings = Array.from({ length: W + 1 }, (_, j) => plan(turn.walk(j)));
  const treads: TaperedTread[] = [];
  for (let j = 1; j <= W; j++) {
    const [walk, narrow] = turn.goings(j);
    treads.push({ outline: turn.winder(j).map((p) => plan(sp(p))), index: m + j - 1, chord: [crossings[j - 1]!, crossings[j]!], walk, narrow });
  }
  const head = f2.at(f2.length, Q.ZERO);
  return {
    flights: right ? [f1.mirrored(), f2.mirrored()] : [f1, f2],
    treads,
    walk: [plan(sp([Q.ZERO, Q.ZERO])), ...crossings, plan(sp(head))],
    length: ((straight: Q) => roundArc(straight.n, straight.d, turn.r.n, turn.r.d, turn.A))(P.add(s2)),
  };
}

/** 17.6: each tapered tread's lanes — the edges of its outline and its walkline chord, level at its top. */
function taperedLanes(tp: Tapered, r: Resolved): [IPoint, IPoint, Q, Q][] {
  const out: [IPoint, IPoint, Q, Q][] = [];
  for (const tr of tp.treads) {
    const z = riserZ(r, tr.index);
    const ring = ringOfPoints(tr.outline);
    for (let i = 0; i < ring.length; i++) out.push([ring[i]!, ring[(i + 1) % ring.length]!, z, z]);
    out.push([roundSP(tr.chord[0]), roundSP(tr.chord[1]), z, z]);
  }
  return out;
}

/** 17.6: the index of the first step whose top is less than minHeadroom below the floor at the head, or undefined. */
function openingFrom(ctx: StairContext, st: Stair, r: Resolved, tops: readonly Q[]): number | undefined {
  if (st.minHeadroom === undefined) return undefined;
  const thick = r.headRoom !== undefined ? floorThickness(ctx.doc, get(ctx.doc.rooms, r.headRoom)!) : BigInt(get(ctx.doc.levels, st.to)!.floorThickness ?? 0);
  const limit = r.top - thick - BigInt(st.minHeadroom);
  const i = tops.findIndex((z) => z.cmp(limit) > 0);
  return i < 0 ? undefined : i;
}

// ── derived values (17.4–17.6) ──────────────────────────────────────────────────

type P2 = [number, number];
export interface DerivedStair {
  risers: number;
  riserHeight: number;
  rise: number;
  bottom: number;
  top: number;
  foot: P2;
  head: P2;
  footRoom?: string;
  headRoom?: string;
  box: { min: [number, number, number]; max: [number, number, number] };
  steps?: { outline: P2[]; top: number; landing?: true; winder?: true }[];
  run?: number;
  walkline?: { points: P2[]; length: number };
  /** Core 0.4 (17.7): the least going of a winder or spiral stair's tapered treads at the walkline, and at their narrow ends. */
  walklineGoing?: number;
  narrowGoing?: number;
  /** Core 0.4 (17.7): a spiral stair's centre. */
  centre?: P2;
  headroom?: number;
  /** Core 0.4 (17.6): the index in `steps` of the first step the floor above must be open over. */
  opening?: { first: number };
}

const num = toSafeNumber;
const p2 = (p: IPoint): P2 => [num(p[0]), num(p[1])];

function boxOf(points: readonly IPoint[], z0: bigint, z1: bigint): DerivedStair['box'] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const mn = (v: bigint[]): bigint => v.reduce((a, b) => (b < a ? b : a));
  const mx = (v: bigint[]): bigint => v.reduce((a, b) => (b > a ? b : a));
  return { min: [num(mn(xs)), num(mn(ys)), num(z0)], max: [num(mx(xs)), num(mx(ys)), num(z1)] };
}

/** 17.4–17.7: one stair of a valid document, as a Core 0.4 reader derives it, or (`core04` false) as a Core 0.3 reader does. */
export function deriveStair(ctx: StairContext, st: Stair, core04 = true): DerivedStair {
  const f = formOf(st);
  const r = resolve(ctx, st);
  const fr = frameOf(st);
  const v: DerivedStair = {
    risers: r.n,
    riserHeight: num(Q.of(r.rise, BigInt(r.n)).round()),
    rise: num(r.rise),
    bottom: num(r.bottom),
    top: num(r.top),
    foot: p2(r.foot),
    head: p2(r.head),
    ...(r.footRoom !== undefined && { footRoom: r.footRoom }),
    ...(r.headRoom !== undefined && { headRoom: r.headRoom }),
    box: { min: [0, 0, 0], max: [0, 0, 0] },
  };
  if (f.kind === 'spiral') {
    const { cx, cy } = spiralPoints(st);
    const rad = Q.of(BigInt(f.diameter), 2n).toSurd();
    v.box = {
      min: [num(cx.sub(rad).round()), num(cy.sub(rad).round()), num(r.bottom)],
      max: [num(cx.add(rad).round()), num(cy.add(rad).round()), num(r.top)],
    };
    return core04 ? deriveTapered(ctx, st, r, fr, v) : v;
  }
  const lay = layout(st, r.n);
  if (f.kind === 'winder') {
    v.box = boxOf(lay.rects.flatMap((rect) => rect.corners().map((c) => rpt(fr, c))), r.bottom, r.top);
    return core04 ? deriveTapered(ctx, st, r, fr, v) : v;
  }
  const steps: NonNullable<DerivedStair['steps']> = [];
  const tops: Q[] = [];
  const pts: IPoint[] = [];
  const ringOf = (rect: Rect): IPoint[] => startAtLeast(rect.corners().map((c) => rpt(fr, c)));
  for (const piece of lay.pieces) {
    if (piece.kind === 'flight') {
      for (const [rect, index] of piece.flight.treads()) {
        const ring = ringOf(rect);
        steps.push({ outline: ring.map(p2), top: num(riserZ(r, index).round()) });
        tops.push(riserZ(r, index));
        pts.push(...ring);
      }
    } else {
      const ring = ringOf(piece.rect);
      steps.push({ outline: ring.map(p2), top: num(riserZ(r, piece.index).round()), landing: true });
      tops.push(riserZ(r, piece.index));
      pts.push(...ring);
    }
  }
  const treads = steps.filter((s) => !s.landing).length;
  let length = Q.ZERO;
  for (let i = 0; i + 1 < lay.walk.length; i++) {
    const a = lay.walk[i]!;
    const b = lay.walk[i + 1]!;
    length = length.add(b[0].sub(a[0]).abs()).add(b[1].sub(a[1]).abs());
  }
  v.box = boxOf(pts, r.bottom, r.top);
  v.steps = steps;
  v.run = num(BigInt(treads) * BigInt(st.tread));
  v.walkline = { points: lay.walk.map((p) => p2(rpt(fr, p))), length: num(length.n / length.d) };
  const h = headroomOf(ctx, st, lay, fr, r);
  if (h !== undefined) v.headroom = num(h.round());
  const first = openingFrom(ctx, st, r, tops);
  if (first !== undefined) v.opening = { first };
  return v;
}

/** 17.7: the steps, run, walkline and goings of a winder or a spiral stair, its headroom (17.6), its opening, and a spiral's centre. */
function deriveTapered(ctx: StairContext, st: Stair, r: Resolved, fr: StairFrame, v: DerivedStair): DerivedStair {
  const tp = tapered(st, r.n);
  const steps: NonNullable<DerivedStair['steps']> = [];
  const tops: Q[] = [];
  const walks: Surd[] = [];
  const narrows: Surd[] = [];
  const pushTapered = (tr: TaperedTread, winder: boolean): void => {
    steps.push({ outline: ringOfPoints(tr.outline).map(p2), top: num(riserZ(r, tr.index).round()), ...(winder && { winder: true as const }) });
    tops.push(riserZ(r, tr.index));
    walks.push(tr.walk);
    narrows.push(tr.narrow);
  };
  const flightSteps = (fl: Flight): void => {
    for (const [rect, index] of fl.treads()) {
      steps.push({ outline: startAtLeast(rect.corners().map((c) => rpt(fr, c))).map(p2), top: num(riserZ(r, index).round()) });
      tops.push(riserZ(r, index));
    }
  };
  if (tp.flights.length) {
    flightSteps(tp.flights[0]!);
    for (const tr of tp.treads) pushTapered(tr, true);
    flightSteps(tp.flights[1]!);
  } else for (const tr of tp.treads) pushTapered(tr, false);
  const least = (xs: Surd[]): Surd => xs.reduce((a, b) => (b.cmp(a) < 0 ? b : a));
  const points: IPoint[] = [];
  for (const p of tp.walk.map(roundSP)) if (!points.length || !samePt(points[points.length - 1]!, p)) points.push(p);
  if (tp.centre) v.centre = p2(roundSP(tp.centre));
  v.steps = steps;
  v.run = num(tp.length);
  v.walkline = { points: points.map(p2), length: num(tp.length) };
  v.walklineGoing = num(roundSqrt(least(walks)));
  v.narrowGoing = num(roundSqrt(least(narrows)));
  const lay: Layout = { pieces: tp.flights.map((flight) => ({ kind: 'flight', flight })), head: [Q.ZERO, Q.ZERO], rects: [], walk: [] };
  const h = headroomOf(ctx, st, lay, fr, r, taperedLanes(tp, r));
  if (h !== undefined) v.headroom = num(h.round());
  const first = openingFrom(ctx, st, r, tops);
  if (first !== undefined) v.opening = { first };
  return v;
}

/** 17.4: every stair of a valid document (empty for one that has none) — as a Core 0.4 reader derives them, or a Core 0.3 reader. */
export function deriveStairs(ctx: StairContext, core04 = true): Record<string, DerivedStair> {
  const out: Record<string, DerivedStair> = {};
  for (const [id, st] of entries(ctx.doc.stairs)) Object.defineProperty(out, id, { value: deriveStair(ctx, st, core04), enumerable: true, writable: true, configurable: true });
  return out;
}

/** 14.1 (Core 0.3): (foot room, head room) of every stair that has both. */
export function stairLinks(ctx: StairContext): [string, string][] {
  const out: [string, string][] = [];
  for (const [, st] of entries(ctx.doc.stairs)) {
    const r = resolve(ctx, st);
    if (r.footRoom !== undefined && r.headRoom !== undefined) out.push([r.footRoom, r.headRoom]);
  }
  return out;
}
