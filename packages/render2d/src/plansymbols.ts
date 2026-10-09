/**
 * Plan symbols of doors, furniture and plumbing fixtures (FLR-T-12.24), as geometry in base units:
 * what the SVG renderer and the worker's PDF and DXF drawings all draw, so they never disagree.
 *
 * Every point here is placed relative to points the engine derived — an opening's start and end on
 * its wall's location line, an extension element's footprint — and is drawing only: nothing here
 * reaches a normative output. Only `+ − × ÷` and `Math.sqrt` (correctly rounded in every engine)
 * are used; circles and ellipses are traced through rational points of the unit circle, so there
 * is no trigonometry and the same input gives the same bytes everywhere.
 */
import type { DoorOperation } from '@floorspec/engine';
import type { Pt } from './scene.js';

/**
 * How a part is drawn:
 * - `leaf`: a door leaf or panel, the heaviest line;
 * - `swing`: a swing arc (dashed on the screen plan, thin on a sheet);
 * - `hidden`: above or beyond the cut, dashed — an overhead door, a wall cabinet, a barn door's open position;
 * - `inWall`: inside the wall's poché, dashed in the paper's colour — a pocket and the leaf in it;
 * - `outline`: a fixture's or furniture item's outline;
 * - `detail`: the lines inside an outline — pillows, cushions, basins, burners.
 */
export type SymbolStroke = 'leaf' | 'swing' | 'hidden' | 'inWall' | 'outline' | 'detail';

/** A polyline through points, closed or open. */
export interface SymbolPath {
  readonly kind: 'path';
  readonly pts: readonly Pt[];
  readonly closed: boolean;
  readonly stroke: SymbolStroke;
}

/** A circular arc of at most a half turn about `centre`, from `from` to `to`, the short way round. */
export interface SymbolArc {
  readonly kind: 'arc';
  readonly centre: Pt;
  readonly radius: number;
  readonly from: Pt;
  readonly to: Pt;
  readonly stroke: SymbolStroke;
}

export type SymbolPart = SymbolPath | SymbolArc;

type XY = readonly [number, number];

const add = (p: Pt, v: XY, k: number): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];

function axes(a: Pt, b: Pt): { u: XY; n: XY; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return len === 0 ? { u: [1, 0], n: [0, 1], len } : { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

const path = (pts: readonly Pt[], stroke: SymbolStroke, closed = false): SymbolPath => ({ kind: 'path', pts, closed, stroke });

// ── doors (Core 8.4) ─────────────────────────────────────────────────────────

/** Base units. */
const INCH = 32_512;
const FOOT = 390_144;

/** What a door symbol needs of its opening: the derived points, its hinge and swing, and its type's operation. */
export interface DoorSource {
  readonly start: Pt;
  readonly end: Pt;
  readonly hinge: 'start' | 'end';
  readonly swing: 'left' | 'right';
  /** Its fill type's operation (Core 8.4); absent: drawn as a single swing, as a plan always has. */
  readonly operation?: DoorOperation | undefined;
}

/** The face offsets (Core 5.4) of the wall the door is in: left and right of its location line. */
export interface WallFaces {
  readonly a: number;
  readonly b: number;
}

export interface DoorSymbol {
  /** The operation drawn: the type's, or `swing` when it declares none. */
  readonly operation: DoorOperation;
  readonly parts: readonly SymbolPart[];
  /** The quadrilateral the symbol covers — the square a leaf sweeps, else the opening — for labels and the drawing's extent. */
  readonly reach: readonly Pt[];
}

const OPERATIONS: ReadonlySet<string> = new Set<DoorOperation>(['swing', 'doubleSwing', 'doubleActing', 'bypassSlide', 'pocket', 'surfaceSlide', 'bifold', 'overhead', 'cased']);

/**
 * A door's plan symbol, by its type's operation (Core 8.4), with `hinge` and `swing` (Core 7.1) as
 * Core gives them meaning — `hinge` for a single swing, `swing` for leaves that swing one way — and,
 * where Core leaves them meaningless, read as the drawing's hint: the jamb a pocket, a sliding leaf or
 * a single bifold pair goes to, and the side a bifold folds into and an overhead door rises on.
 *
 * - `swing` (and no operation): the leaf open at 90° from the hinge jamb and its quarter swing.
 * - `doubleSwing`: two leaves from both jambs, their swings meeting at the middle.
 * - `doubleActing`: one leaf with a swing to each side.
 * - `pocket`: the leaf half drawn into a pocket inside the wall beyond the hinge jamb, dashed there.
 * - `bypassSlide`: two leaves on two parallel tracks, overlapping at the middle.
 * - `surfaceSlide`: the leaf on the wall's face across the opening, its open position dashed beside it.
 * - `bifold`: the leaves folded part-open as a zig-zag — one pair to the hinge jamb, or a pair to each jamb in a wide opening.
 * - `overhead`: a dashed door line just inside the opening on the side it rises on.
 * - `cased`: nothing — a cased opening has no leaf.
 */
export function doorSymbol(o: DoorSource, w: WallFaces): DoorSymbol {
  const operation: DoorOperation = o.operation !== undefined && OPERATIONS.has(o.operation) ? o.operation : 'swing';
  const { u, n, len } = axes(o.start, o.end);
  const quad: Pt[] = [add(o.start, n, w.a), add(o.end, n, w.a), add(o.end, n, -w.b), add(o.start, n, -w.b)];
  if (len === 0) return { operation, parts: [], reach: quad };
  const left = o.swing === 'left';
  const side = left ? 1 : -1;
  const off = left ? w.a : -w.b;
  const dir: XY = left ? n : [-n[0], -n[1]];
  /** A point `t` along the opening from its start, `k` off the location line (left positive). */
  const at = (t: number, k: number): Pt => add(add(o.start, u, t), n, k);
  /** A strip `t0`–`t1` along the opening, between offsets `k0` and `k1`, as a closed ring. */
  const strip = (t0: number, t1: number, k0: number, k1: number): Pt[] => [at(t0, k0), at(t1, k0), at(t1, k1), at(t0, k1)];
  const T = w.a + w.b;
  const mid = (w.a - w.b) / 2;
  const hingeAtStart = o.hinge === 'start';

  switch (operation) {
    case 'doubleSwing': {
      const half = len / 2;
      const H1 = add(o.start, n, off);
      const H2 = add(o.end, n, off);
      const M = at(half, off);
      const L1 = add(H1, dir, half);
      const L2 = add(H2, dir, half);
      return {
        operation,
        parts: [path([H1, L1], 'leaf'), { kind: 'arc', centre: H1, radius: half, from: L1, to: M, stroke: 'swing' }, path([H2, L2], 'leaf'), { kind: 'arc', centre: H2, radius: half, from: L2, to: M, stroke: 'swing' }],
        reach: [H1, H2, add(H2, dir, half), add(H1, dir, half)],
      };
    }
    case 'doubleActing': {
      // One leaf drawn open to the swing side, and its swing to the other side too.
      const one = swingLeaf(o, n, off, dir, len);
      const otherOff = left ? -w.b : w.a;
      const two = swingLeaf(o, n, otherOff, [-dir[0], -dir[1]], len);
      const [leaf2, arc2] = two.parts as [SymbolPath, SymbolArc];
      return {
        operation,
        parts: [...one.parts, { ...leaf2, stroke: 'swing' }, arc2],
        reach: [one.reach[0]!, one.reach[1]!, two.reach[2]!, two.reach[3]!],
      };
    }
    case 'pocket': {
      // The pocket runs into the wall beyond the hinge jamb; the leaf is drawn half out of it.
      const t0 = hingeAtStart ? 0 : len;
      const s = hingeAtStart ? -1 : 1;
      const leafHalf = Math.min(T / 6, 0.875 * INCH);
      const cavityHalf = Math.min(T * 0.4, leafHalf * 1.75);
      return {
        operation,
        parts: [
          path(strip(t0, t0 + s * len, mid - cavityHalf, mid + cavityHalf), 'inWall', true),
          path(strip(t0 + s * (len / 2), t0, mid - leafHalf, mid + leafHalf), 'inWall', true),
          path(strip(t0, t0 - s * (len / 2), mid - leafHalf, mid + leafHalf), 'leaf', true),
        ],
        reach: quad,
      };
    }
    case 'bypassSlide': {
      // Two leaves on two tracks either side of the wall's middle, overlapping at the middle of the opening.
      const g = Math.min(T / 5, INCH);
      const half = Math.min(T / 14, 0.75 * INCH);
      const lap = Math.min(len * 0.05, 2 * INCH);
      return {
        operation,
        parts: [path(strip(0, len / 2 + lap, mid + g - half, mid + g + half), 'leaf', true), path(strip(len / 2 - lap, len, mid - g - half, mid - g + half), 'leaf', true)],
        reach: quad,
      };
    }
    case 'surfaceSlide': {
      // A barn door: the leaf on the face it hangs on, across the opening, and where it slides to — beyond the hinge jamb — dashed.
      const gap = 0.5 * INCH;
      const thick = 1.5 * INCH;
      const lap = Math.min(len * 0.05, 2 * INCH);
      const k0 = off + side * gap;
      const k1 = off + side * (gap + thick);
      const shift = hingeAtStart ? -(len + 2 * lap) : len + 2 * lap;
      const lo = Math.min(-lap, -lap + shift);
      const hi = Math.max(len + lap, len + lap + shift);
      return {
        operation,
        parts: [path(strip(-lap, len + lap, k0, k1), 'leaf', true), path(strip(-lap + shift, len + lap + shift, k0, k1), 'hidden', true)],
        reach: [at(lo, off), at(hi, off), at(hi, k1), at(lo, k1)],
      };
    }
    case 'bifold': {
      // Leaves hinged to each other, folding into the swing side: drawn half folded, as a V per pair.
      const pairs: { t: number; s: 1 | -1; span: number }[] =
        len > 3.5 * FOOT ? [{ t: 0, s: 1, span: len / 2 }, { t: len, s: -1, span: len / 2 }] : [{ t: hingeAtStart ? 0 : len, s: hingeAtStart ? 1 : -1, span: len }];
      let depth = 0;
      const parts: SymbolPart[] = [];
      for (const p of pairs) {
        const d = (p.span * Math.sqrt(3)) / 4;
        depth = Math.max(depth, d);
        parts.push(path([at(p.t, off), at(p.t + (p.s * p.span) / 4, off + side * d), at(p.t + (p.s * p.span) / 2, off)], 'leaf'));
      }
      return { operation, parts, reach: [at(0, off), at(len, off), at(len, off + side * depth), at(0, off + side * depth)] };
    }
    case 'overhead': {
      // A garage door rises inside: its line just inside the opening on the side it rises on, dashed.
      const gap = 2 * INCH;
      const thick = 2 * INCH;
      const k0 = off + side * gap;
      const k1 = off + side * (gap + thick);
      return { operation, parts: [path(strip(0, len, k0, k1), 'hidden', true)], reach: [at(0, off), at(len, off), at(len, k1), at(0, k1)] };
    }
    case 'cased':
      return { operation, parts: [], reach: quad };
    default: {
      const one = swingLeaf(o, n, off, dir, len);
      return { operation, ...one };
    }
  }
}

/**
 * A single leaf open at 90° from its hinge jamb on the face at `off`, and its quarter swing back to
 * the other jamb — placed exactly as the plan always has, so a plan of swing doors draws the same.
 */
function swingLeaf(o: DoorSource, n: XY, off: number, dir: XY, len: number): { parts: SymbolPart[]; reach: Pt[] } {
  const J = o.hinge === 'start' ? o.start : o.end;
  const K = o.hinge === 'start' ? o.end : o.start;
  const H = add(J, n, off);
  const L = add(H, dir, len);
  const O = add(K, n, off);
  const k = off + (dir[0] * n[0] + dir[1] * n[1] > 0 ? len : -len);
  return {
    parts: [path([H, L], 'leaf'), { kind: 'arc', centre: H, radius: len, from: L, to: O, stroke: 'swing' }],
    reach: [add(o.start, n, off), add(o.end, n, off), add(o.end, n, k), add(o.start, n, k)],
  };
}

// ── furniture and plumbing fixtures ──────────────────────────────────────────

/**
 * An element's box in plan: the corner at its frame's (min x, min y), and the box's two sides from
 * it — `depth` along +x, from its back to its front, and `width` along +y. FS_furniture 3.1 and
 * FS_plumbing 2.1 both put an item's front at +x: the side a person uses it from.
 */
export interface BoxFrame {
  readonly origin: Pt;
  readonly depth: Pt;
  readonly width: Pt;
}

/** What a fixture symbol needs of an extension element. */
export interface FixtureSource {
  readonly extension: string;
  readonly collection: string;
  /** FS_furniture's `category`, FS_plumbing's `fixture`, `heater`, `receptor`: what the item is. */
  readonly category?: string | undefined;
  readonly frame?: BoxFrame | undefined;
}

/**
 * Rational points of the unit circle's first quadrant, from (1, 0) to (0, 1): ((1 − t²)/(1 + t²),
 * 2t/(1 + t²)) for t = 0, 1/8, …, 1 — exact enough to draw, and the same in every engine.
 */
const QUADRANT: readonly XY[] = Array.from({ length: 9 }, (_, i) => {
  const t = i / 8;
  return [(1 - t * t) / (1 + t * t), (2 * t) / (1 + t * t)] as const;
});

/** The whole unit circle, counter-clockwise from (1, 0), 32 segments. */
const CIRCLE: readonly XY[] = [
  ...QUADRANT,
  ...QUADRANT.slice(1).map(([c, s]) => [-s, c] as const),
  ...QUADRANT.slice(1).map(([c, s]) => [-c, -s] as const),
  ...QUADRANT.slice(1, -1).map(([c, s]) => [s, -c] as const),
];

/**
 * A fixture's or furniture item's plan outline, by what it is, in its box (`frame`): a bed with its
 * pillows, a sofa with its back and arms, a table, a chair, a cabinet with its counter line, a
 * toilet's tank and bowl, a basin, a tub, a shower and its drain. Null for an item this knows no
 * outline for (FS_furniture's `other`, an element of another extension): its box is drawn alone.
 */
export function fixtureSymbol(x: FixtureSource): SymbolPart[] | null {
  const fr = x.frame;
  if (fr === undefined) return null;
  const D = Math.sqrt(fr.depth[0] * fr.depth[0] + fr.depth[1] * fr.depth[1]);
  const W = Math.sqrt(fr.width[0] * fr.width[0] + fr.width[1] * fr.width[1]);
  if (!(D > 0) || !(W > 0)) return null;
  const k = new Sketch(fr, D, W);
  const draw = x.extension === 'FS_furniture' ? FURNITURE[x.category ?? ''] : x.extension === 'FS_plumbing' ? PLUMBING[x.collection === 'fixtures' ? (x.category ?? '') : x.collection] : undefined;
  if (draw === undefined) return null;
  draw(k);
  return k.parts.length === 0 ? null : k.parts;
}

/**
 * Drawing in an item's box: `d` from its back (0) to its front (D) and `w` across it (0 to W), in
 * base units, mapped onto the plan by the box's frame.
 */
class Sketch {
  readonly parts: SymbolPart[] = [];
  readonly m: number;
  constructor(
    readonly fr: BoxFrame,
    readonly D: number,
    readonly W: number,
  ) {
    this.m = Math.min(D, W);
  }

  p(d: number, w: number): Pt {
    const { origin, depth, width } = this.fr;
    return [origin[0] + (depth[0] * d) / this.D + (width[0] * w) / this.W, origin[1] + (depth[1] * d) / this.D + (width[1] * w) / this.W];
  }

  rect(d0: number, w0: number, d1: number, w1: number, stroke: SymbolStroke = 'detail'): this {
    this.parts.push(path([this.p(d0, w0), this.p(d1, w0), this.p(d1, w1), this.p(d0, w1)], stroke, true));
    return this;
  }

  /** The whole box. */
  box(stroke: SymbolStroke = 'outline'): this {
    return this.rect(0, 0, this.D, this.W, stroke);
  }

  line(d0: number, w0: number, d1: number, w1: number, stroke: SymbolStroke = 'detail'): this {
    this.parts.push(path([this.p(d0, w0), this.p(d1, w1)], stroke));
    return this;
  }

  /** A rectangle with its corners rounded by `r` (at most half its shorter side). */
  rounded(d0: number, w0: number, d1: number, w1: number, r: number, stroke: SymbolStroke = 'detail'): this {
    const rr = Math.max(0, Math.min(r, Math.abs(d1 - d0) / 2, Math.abs(w1 - w0) / 2));
    const [dl, dh] = d0 < d1 ? [d0, d1] : [d1, d0];
    const [wl, wh] = w0 < w1 ? [w0, w1] : [w1, w0];
    const pts: Pt[] = [];
    const corner = (cd: number, cw: number, q: number): void => {
      // Quadrant q of the circle about (cd, cw): 0 front-right (+d, +w), 1 back-right, 2 back-left, 3 front-left.
      for (const [c, s] of QUADRANT) {
        const [ud, uw] = q === 0 ? [c, s] : q === 1 ? [-s, c] : q === 2 ? [-c, -s] : [s, -c];
        pts.push(this.p(cd + ud * rr, cw + uw * rr));
      }
    };
    corner(dh - rr, wh - rr, 0);
    corner(dl + rr, wh - rr, 1);
    corner(dl + rr, wl + rr, 2);
    corner(dh - rr, wl + rr, 3);
    this.parts.push(path(dedupe(pts), stroke, true));
    return this;
  }

  /** An ellipse about (cd, cw) with semi-axes rd (along the depth) and rw (across). */
  ellipse(cd: number, cw: number, rd: number, rw: number, stroke: SymbolStroke = 'detail'): this {
    this.parts.push(path(CIRCLE.map(([c, s]) => this.p(cd + c * rd, cw + s * rw)), stroke, true));
    return this;
  }

  /** The front half of an ellipse about (cd, cw), from one side round the front to the other, closed across its back. */
  frontHalf(cd: number, cw: number, rd: number, rw: number, stroke: SymbolStroke = 'detail'): this {
    const half = [...QUADRANT.map(([c, s]) => [s, -c] as const), ...QUADRANT.slice(1).map(([c, s]) => [c, s] as const)];
    this.parts.push(path(half.map(([c, s]) => this.p(cd + c * rd, cw + s * rw)), stroke, true));
    return this;
  }

  circle(cd: number, cw: number, r: number, stroke: SymbolStroke = 'detail'): this {
    return this.ellipse(cd, cw, r, r, stroke);
  }
}

function dedupe(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q === undefined || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

type Draw = (k: Sketch) => void;

/** A bed: its headboard at the back, pillows, and the sheet turned down. */
const bed: Draw = (k) => {
  const { D, W, m } = k;
  const head = Math.min(D * 0.04, 3 * INCH);
  k.box().rect(0, 0, head, W);
  const pd0 = head + Math.min(D * 0.03, 2 * INCH);
  const pd1 = pd0 + Math.min(D * 0.14, 12 * INCH);
  const gap = Math.min(W * 0.04, 3 * INCH);
  const r = m * 0.02;
  // Two pillows on a bed wide enough for two (over 1.2 m), else one.
  if (W > 1_536_000) {
    k.rounded(pd0, gap, pd1, W / 2 - gap / 2, r).rounded(pd0, W / 2 + gap / 2, pd1, W - gap, r);
  } else k.rounded(pd0, gap, pd1, W - gap, r);
  const fold = pd1 + Math.min(D * 0.12, 9 * INCH);
  k.line(fold, 0, fold, W);
};

/** A sofa or an armchair: its back, its two arms, and its seat cushions. */
function seating(armShare: number, seats: number | 'auto'): Draw {
  return (k) => {
    const { D, W, m } = k;
    const back = Math.min(D * 0.25, 9 * INCH);
    const arm = Math.min(W * armShare, 7 * INCH);
    k.box().rounded(0, 0, back, W, m * 0.04).rounded(back, 0, D, arm, m * 0.04).rounded(back, W - arm, D, W, m * 0.04);
    const n = seats === 'auto' ? Math.max(1, Math.min(4, Math.round((W - 2 * arm) / (24 * INCH)))) : seats;
    const step = (W - 2 * arm) / n;
    for (let i = 1; i < n; i++) k.line(back, arm + step * i, D, arm + step * i);
  };
}

/** A chair: its back along the rear, its seat. */
const chair: Draw = (k) => {
  const { D, W, m } = k;
  const back = Math.min(D * 0.14, 3 * INCH);
  k.rounded(back, 0, D, W, m * 0.12, 'outline').rounded(0, 0, back, W, back / 2, 'outline');
};

/** A table: its top, and the edge of its top just inside it. */
const table: Draw = (k) => {
  const { m } = k;
  const inset = Math.min(m * 0.06, 1.5 * INCH);
  k.box().rect(inset, inset, k.D - inset, k.W - inset);
};

/** A round-ish small table or stool: the ellipse its box holds. */
const roundTop: Draw = (k) => {
  k.ellipse(k.D / 2, k.W / 2, k.D / 2, k.W / 2, 'outline');
};

/** A cabinet or counter: its outline and the counter's front edge, just behind the front. */
const counter: Draw = (k) => {
  const front = k.D - Math.min(k.D * 0.08, 1.5 * INCH);
  k.box().line(front, 0, front, k.W);
};

/** A wall cabinet: above the plan's cut, dashed, with its diagonal. */
const overhead: Draw = (k) => {
  k.box('hidden').line(0, 0, k.D, k.W, 'hidden');
};

/** A tall cabinet, wardrobe or bookcase: its outline and its doors' or shelves' front line. */
const casegood: Draw = (k) => {
  const front = k.D - Math.min(k.D * 0.1, 2 * INCH);
  k.box().line(front, 0, front, k.W);
};

/** A wardrobe: its outline, its doors' line and the hanging rod down its middle, dashed. */
const wardrobe: Draw = (k) => {
  casegood(k);
  k.line(k.D / 2, k.W * 0.06, k.D / 2, k.W * 0.94, 'hidden');
};

/** A desk: its top and a line along its back. */
const desk: Draw = (k) => {
  const back = Math.min(k.D * 0.1, 3 * INCH);
  k.box().line(back, 0, back, k.W);
};

/** A range or cooktop: four burners. */
const cooktop: Draw = (k) => {
  const { D, W, m } = k;
  k.box();
  const r = m * 0.16;
  for (const d of [D * 0.32, D * 0.7]) for (const w of [W * 0.27, W * 0.73]) k.circle(d, w, r);
};

/** A refrigerator, freezer or oven: its body and its door line at the front. */
const appliance: Draw = (k) => {
  const front = k.D - Math.min(k.D * 0.08, 2 * INCH);
  k.box().line(front, 0, front, k.W);
};

/** A dishwasher: its body, its door line, and an X across it. */
const dishwasher: Draw = (k) => {
  appliance(k);
  k.line(0, 0, k.D, k.W, 'detail').line(0, k.W, k.D, 0, 'detail');
};

/** A washer or dryer: its body and its drum. */
const drum: Draw = (k) => {
  k.box().circle(k.D / 2, k.W / 2, k.m * 0.36);
};

/** A water closet: the tank against the wall and the bowl in front of it. */
const waterCloset: Draw = (k) => {
  const { D, W } = k;
  const tank = Math.min(D * 0.3, 9 * INCH);
  k.rounded(0, W * 0.06, tank, W * 0.94, k.m * 0.06, 'outline');
  const bowl = D - tank;
  k.ellipse(tank + bowl * 0.5, W / 2, bowl * 0.5, W * 0.4, 'outline');
  k.ellipse(tank + bowl * 0.52, W / 2, bowl * 0.32, W * 0.26);
};

/** A bidet: a bowl, without a tank. */
const bidet: Draw = (k) => {
  k.ellipse(k.D / 2, k.W / 2, k.D / 2, k.W * 0.42, 'outline').circle(k.D * 0.55, k.W / 2, k.m * 0.05);
};

/** A urinal: its bowl, against the wall. */
const urinal: Draw = (k) => {
  k.frontHalf(0, k.W / 2, k.D, k.W / 2, 'outline');
};

/** A lavatory: its top and the basin in it, with the drain. */
const lavatory: Draw = (k) => {
  const { D, W } = k;
  k.box();
  const back = Math.min(D * 0.22, 4 * INCH);
  const rd = (D - back) * 0.42;
  const rw = Math.min(W * 0.4, rd * 1.35);
  k.ellipse(back + (D - back) / 2, W / 2, rd, rw).circle(back + (D - back) / 2, W / 2, Math.min(k.m * 0.04, INCH));
};

/** A sink: its top and one basin, or two in a kitchen sink wide enough for them, each with a drain. */
function sink(double: boolean): Draw {
  return (k) => {
    const { D, W, m } = k;
    k.box();
    const rim = Math.min(m * 0.08, 1.5 * INCH);
    const back = Math.min(D * 0.18, 3 * INCH);
    const two = double && W > D * 1.4;
    const basins: [number, number][] = two
      ? [
          [rim, W / 2 - rim / 2],
          [W / 2 + rim / 2, W - rim],
        ]
      : [[rim, W - rim]];
    for (const [w0, w1] of basins) {
      k.rounded(back, w0, D - rim, w1, m * 0.08);
      k.circle(back + (D - rim - back) / 2, (w0 + w1) / 2, Math.min(m * 0.04, INCH));
    }
  };
}

/** A bathtub: its rim, the rounded basin inside it, and the drain at one end. */
const bathtub: Draw = (k) => {
  const { D, W, m } = k;
  const rim = Math.min(m * 0.12, 3.5 * INCH);
  k.box().rounded(rim, rim, D - rim, W - rim, Math.min(D, W) * 0.3);
  // The drain at the end of its length, whichever way the tub is long.
  if (W >= D) k.circle(D / 2, rim * 2.2, Math.min(m * 0.04, INCH));
  else k.circle(rim * 2.2, W / 2, Math.min(m * 0.04, INCH));
};

/** A shower: its pan, an X falling to the drain at its middle. */
const shower: Draw = (k) => {
  const { D, W, m } = k;
  k.box().line(0, 0, D, W).line(0, W, D, 0).circle(D / 2, W / 2, Math.min(m * 0.05, 1.5 * INCH));
};

/** A tub, a basin: its outline with a rounded basin. */
const tub: Draw = (k) => {
  const { D, W, m } = k;
  const rim = Math.min(m * 0.1, 2 * INCH);
  k.box().rounded(rim, rim, D - rim, W - rim, m * 0.1).circle(D / 2, W / 2, Math.min(m * 0.05, INCH));
};

/** A round thing in its box: a water heater's tank, a floor drain. */
const round: Draw = (k) => {
  k.circle(k.D / 2, k.W / 2, k.m / 2, 'outline');
};

/** A cleanout: a circle with a cross through it. */
const cleanout: Draw = (k) => {
  const r = k.m / 2;
  k.circle(k.D / 2, k.W / 2, r, 'outline').line(k.D / 2 - r, k.W / 2, k.D / 2 + r, k.W / 2).line(k.D / 2, k.W / 2 - r, k.D / 2, k.W / 2 + r);
};

/** FS_furniture categories (2.2): pieces, appliances and casework. */
const FURNITURE: Readonly<Record<string, Draw>> = {
  bed,
  crib: bed,
  sofa: seating(0.12, 'auto'),
  armchair: seating(0.2, 1),
  chair,
  bench: table,
  stool: roundTop,
  diningTable: table,
  coffeeTable: table,
  sideTable: table,
  desk,
  nightstand: casegood,
  dresser: casegood,
  wardrobe,
  bookcase: casegood,
  sideboard: casegood,
  mediaUnit: casegood,
  shelf: casegood,
  refrigerator: appliance,
  freezer: appliance,
  range: cooktop,
  cooktop,
  wallOven: appliance,
  microwave: appliance,
  dishwasher,
  washer: drum,
  dryer: drum,
  baseCabinet: counter,
  island: counter,
  vanity: counter,
  wallCabinet: overhead,
  tallCabinet: casegood,
  shelving: casegood,
};

/** FS_plumbing fixtures (2.1) by `fixture`, and its other kinds by collection. */
const PLUMBING: Readonly<Record<string, Draw>> = {
  waterCloset,
  bidet,
  urinal,
  lavatory,
  kitchenSink: sink(true),
  barSink: sink(false),
  laundryTub: tub,
  mopSink: tub,
  bathtub,
  bathtubShower: bathtub,
  shower,
  clothesWasher: drum,
  dishwasher,
  waterHeaters: round,
  drains: round,
  cleanouts: cleanout,
};

/**
 * Where an element's symbol image goes (Core 12.6), as an affine map from the image's own pixels —
 * `width` × `height` — onto its box in plan: its top left at the frame's (min x, min y), its top
 * right at (min x, max y), its bottom left at (max x, min y). So its front is along the image's
 * bottom edge and it is never mirrored (FS_furniture 3.3).
 */
export function symbolCorners(frame: BoxFrame): { readonly topLeft: Pt; readonly topRight: Pt; readonly bottomLeft: Pt } {
  const { origin, depth, width } = frame;
  return { topLeft: origin, topRight: [origin[0] + width[0], origin[1] + width[1]], bottomLeft: [origin[0] + depth[0], origin[1] + depth[1]] };
}

/** Furniture and plumbing fixtures: what a room label keeps clear of (FLR-T-12.24). Small devices — a receptacle, a switch — it may sit beside. */
export function standsInRoom(fb: { readonly extension: string }): boolean {
  return fb.extension === 'FS_furniture' || fb.extension === 'FS_plumbing';
}
