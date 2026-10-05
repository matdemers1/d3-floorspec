/**
 * Stairs (Core 0.3, chapter 17): the layout of a stair in its frame, its foot and head, its rise and
 * riser count, the steps, run and walkline of a straight, L-shaped or U-shaped stair, its headroom,
 * the stair invariants FS-INV-901 to FS-INV-904, the lint FS-LINT-016, the derived `stairs`, and the
 * links a stair adds to the door graph (14.1).
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
import { facingVector } from '../exact/angle.js';
import { floorDiv, toSafeNumber } from '../exact/bigint.js';
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

export const formOf = (st: Stair): StairForm => st.form ?? STRAIGHT;

/** Is this a form whose steps, run, walkline and headroom this draft derives (17.5, 17.7)? */
export const stepsDerived = (st: Stair): boolean => DERIVED_FORMS.has(formOf(st).kind);

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

export type StairCode = 'FS-INV-901' | 'FS-INV-902' | 'FS-INV-903' | 'FS-INV-904';

/**
 * FS-INV-901 for every stair; FS-INV-904 for every spiral stair; FS-INV-902 and FS-INV-903 for a stair
 * without FS-INV-901 whose two levels are levels where room invariants are evaluated and have no room
 * with FS-INV-201 to FS-INV-204, and FS-INV-903 not for one with FS-INV-902 (10.3). `badRoomLevels`
 * are the levels of rooms with FS-INV-201 to FS-INV-204.
 */
export function stairInvariants(ctx: StairContext, badRoomLevels: ReadonlySet<string>): { id: string; code: StairCode }[] {
  const doc = ctx.doc;
  const out: { id: string; code: StairCode }[] = [];
  for (const [id, st] of entries(doc.stairs)) {
    const lv = get(doc.levels, st.level)!;
    const to = get(doc.levels, st.to)!;
    const f = formOf(st);
    if (f.kind === 'spiral' && 2 * st.width > f.diameter) out.push({ id, code: 'FS-INV-904' });
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

function headroom(ctx: StairContext, st: Stair, lay: Layout, fr: StairFrame, r: Resolved): bigint | undefined {
  const above = new Above(ctx, st);
  let best: Surd | undefined;
  for (const [a, b, za, zb] of lanes(lay, fr, r)) {
    const v = laneClearance(above, a, b, za, zb);
    if (v && (!best || v.cmp(best) < 0)) best = v;
  }
  return best?.round();
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
  steps?: { outline: P2[]; top: number; landing?: true }[];
  run?: number;
  walkline?: { points: P2[]; length: number };
  headroom?: number;
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

/** 17.4–17.6: one stair of a valid document. */
export function deriveStair(ctx: StairContext, st: Stair): DerivedStair {
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
    return v;
  }
  const lay = layout(st, r.n);
  if (f.kind === 'winder') {
    v.box = boxOf(lay.rects.flatMap((rect) => rect.corners().map((c) => rpt(fr, c))), r.bottom, r.top);
    return v;
  }
  const steps: NonNullable<DerivedStair['steps']> = [];
  const pts: IPoint[] = [];
  const ringOf = (rect: Rect): IPoint[] => startAtLeast(rect.corners().map((c) => rpt(fr, c)));
  for (const piece of lay.pieces) {
    if (piece.kind === 'flight') {
      for (const [rect, index] of piece.flight.treads()) {
        const ring = ringOf(rect);
        steps.push({ outline: ring.map(p2), top: num(riserZ(r, index).round()) });
        pts.push(...ring);
      }
    } else {
      const ring = ringOf(piece.rect);
      steps.push({ outline: ring.map(p2), top: num(riserZ(r, piece.index).round()), landing: true });
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
  const h = headroom(ctx, st, lay, fr, r);
  if (h !== undefined) v.headroom = num(h);
  return v;
}

/** 17.4: every stair of a valid document (empty for one that has none). */
export function deriveStairs(ctx: StairContext): Record<string, DerivedStair> {
  const out: Record<string, DerivedStair> = {};
  for (const [id, st] of entries(ctx.doc.stairs)) Object.defineProperty(out, id, { value: deriveStair(ctx, st), enumerable: true, writable: true, configurable: true });
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
