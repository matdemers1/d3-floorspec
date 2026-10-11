/**
 * Joinery (FLR-T-13.8): what fills an opening, drawn as the pieces a joiner would make of it,
 * instead of a hole in the wall.
 *
 * - **Every opening** is lined: jambs at its sides and a head across its top, the wall's thickness
 *   deep — a door's and an empty (cased) opening's from face to face, a window's from its frame to
 *   the room's face — and cased on its faces.
 * - **A door**, by its type's operation (Core 8.4), with `hinge` and `swing` (Core 7.1) read as the
 *   plan reads them (render2d plansymbols.ts): a slab hung on hinges with a lever each side (`swing`);
 *   a pair (`doubleSwing`); one slab centred in the wall with push plates (`doubleActing`); a slab
 *   running into a pocket in the wall beyond the hinge jamb, partly in it even when closed
 *   (`pocket`); two panels on two tracks (`bypassSlide`); a barn slab on its rail on the face it
 *   hangs on (`surfaceSlide`); panels hinged in pairs (`bifold`); horizontal sections inside the
 *   opening on the side it rises on — the room's, where only one side has one (`overhead`); nothing
 *   (`cased`). A French or patio door — a pair, or a slider, in an outside wall, or any door whose
 *   type's name says it is glazed — has stiles and rails round a glass panel.
 * - **A window**, by its operation: a frame near the outside face; one sash (`casement`, `awning`,
 *   `hopper`, `tiltTurn`, `pivot`), two offset vertically (`doubleHung`, `singleHung`) or side by
 *   side (`horizontalSlider`), or the glass set in the frame (`fixed`); mullions and muntins only
 *   where its type's name asks for them (`twin`, `triple`, `mullion`; `grille`, `muntin`, `divided`,
 *   `colonial`, `prairie`), so a window is clean and modern by default; a stool and an apron inside
 *   when its sill is off the floor, and a sill outside.
 *
 * A door is drawn closed, or open — swung to 90°, slid into its pocket or past its opening, folded
 * to its jamb, raised under the ceiling — as `MeshOptions.doors` asks; the pieces that move carry the
 * state they are drawn in. Every turn is a quarter turn, so nothing here needs trigonometry: each
 * piece is a block, an extrusion or a cylinder from the circle table, and Node and the browser mesh
 * the same bytes.
 *
 * Every piece is drawn in the opening's own frame: x along it from its derived start point (0) to
 * its end (its width), y across the wall to the left of its location line — the wall's left face at
 * `a`, its right face at `−b` — and z up from its sill. Closed, everything stays inside the cut
 * grown by ENVELOPE: casings and stools along and above, handles and sills proud of the faces, a
 * pocket door's slab and a barn door's rail along the wall on their side (`envelope`).
 *
 * Not drawn: an opening narrower or lower than its jambs leave room for.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { P3 } from './builder.js';
import type { Kernel } from './kernel.js';
import { MM } from './models/common.js';
import { Sketch, type Piece } from './models/sketch.js';
import { get } from './own.js';
import type { RawPart } from './part.js';
import type { ModelRole } from './roles.js';
import { roomsBeside } from './thresholds.js';
import type { DoorState, MeshOptions } from './types.js';

type Sign = 1 | -1;
type XY = readonly [number, number];

/** How far past the cut a closed opening's joinery may reach, base units: along the wall, proud of either face, above its head, below its sill. */
export const ENVELOPE = { along: 100 * MM, proud: 100 * MM, above: 120 * MM, below: 120 * MM } as const;

/** A window sill this far above its wall's base, or more, has a stool and an apron inside. */
export const STOOL_FROM = 300 * MM;

/** The operations whose slab slides along the wall beyond the hinge jamb, closed and open alike. */
export const SLIDES_ALONG: ReadonlySet<string> = new Set(['pocket', 'surfaceSlide']);

/** A door whose type's name says this is glazed. */
const GLAZED = /glass|glaz|french|patio|\blite/i;
/** A window whose type's name asks for divided lites. */
const MUNTINS = /\b(grilles?|grids?|muntins?|divided|colonial|prairie|sdl|gbg)\b/i;

/** The opening's frame and what it fills. */
export interface OpeningFrame {
  /** The derived start point, base units, and the unit vectors along the opening and to its left. */
  readonly start: XY;
  readonly u: XY;
  readonly n: XY;
  /** Its width (base units, along u) and height (sill to head). */
  readonly len: number;
  readonly H: number;
  /** The wall's faces: left at +a, right at −b, from the location line. */
  readonly a: number;
  readonly b: number;
  readonly sill: number;
  /** The sill's height above its wall's base, and the wall's top above the sill. */
  readonly sillHeight: number;
  readonly wallTop: number;
  /** How much wall there is beyond the opening, along it: before its start, after its end — to the junction at each end. */
  readonly before: number;
  readonly after: number;
}

/** An opening's frame, from what the engine derived; undefined for one with no width, height or wall thickness. */
export function openingFrame(doc: FloorspecDocument, derived: Derived, oid: string): OpeningFrame | undefined {
  const o = get(doc.openings, oid);
  const dop = derived.openings[oid];
  const w = o === undefined ? undefined : get(doc.walls, o.wall);
  const dw = o === undefined ? undefined : derived.walls[o.wall];
  if (o === undefined || dop === undefined || w === undefined || dw === undefined) return undefined;
  const dx = dop.end[0] - dop.start[0];
  const dy = dop.end[1] - dop.start[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const H = dop.headElevation - dop.sillElevation;
  // The wall's faces, from its outline's corners at its start, square to its location line there.
  const line = dw.polyline ?? [get(doc.junctions, w.start)!.position, get(doc.junctions, w.end)!.position];
  const p0 = line[0]!;
  const p1 = line[1]!;
  const ll = Math.sqrt((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2);
  if (len <= 0 || H <= 0 || ll <= 0) return undefined;
  const n0: XY = [-(p1[1] - p0[1]) / ll, (p1[0] - p0[0]) / ll];
  const a = (dw.startLeft[0] - p0[0]) * n0[0] + (dw.startLeft[1] - p0[1]) * n0[1];
  const b = -((dw.startRight[0] - p0[0]) * n0[0] + (dw.startRight[1] - p0[1]) * n0[1]);
  if (a + b <= 4 * MM) return undefined;
  const u: XY = [dx / len, dy / len];
  const S = get(doc.junctions, w.start)!.position;
  const E = get(doc.junctions, w.end)!.position;
  const before = (dop.start[0] - S[0]) * u[0] + (dop.start[1] - S[1]) * u[1];
  const after = (E[0] - dop.end[0]) * u[0] + (E[1] - dop.end[1]) * u[1];
  return { start: dop.start, u, n: [-u[1], u[0]], len, H, a, b, sill: dop.sillElevation, sillHeight: dop.sillElevation - dw.baseElevation, wallTop: dw.topElevation - dop.sillElevation, before, after };
}

/** A box in the opening's frame. */
export interface LocalBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Where a closed opening's joinery stays, in its own frame: its cut grown by ENVELOPE — and, for a
 * pocket door or a barn door, along the wall on the side it slides to by its width.
 */
export function envelope(f: Pick<OpeningFrame, 'len' | 'H' | 'a' | 'b'>, operation: string | undefined, hinge: 'start' | 'end' | undefined): LocalBox {
  const e = ENVELOPE;
  const extra = operation !== undefined && SLIDES_ALONG.has(operation) ? f.len + e.along : 0;
  const atStart = (hinge ?? 'start') === 'start';
  return {
    min: [-e.along - (atStart ? extra : 0), -f.b - e.proud, -e.below],
    max: [f.len + e.along + (atStart ? 0 : extra), f.a + e.proud, f.H + e.above],
  };
}

/** Where an open door's joinery stays: a door swung or folded through 90° reaches its width (or a garage door its height) past either face. */
export function openEnvelope(f: Pick<OpeningFrame, 'len' | 'H' | 'a' | 'b'>): LocalBox {
  const e = ENVELOPE;
  const reach = Math.max(f.len, f.H) + e.proud;
  return { min: [-f.len - 2 * e.along, -f.b - reach, -e.below], max: [2 * f.len + 2 * e.along, f.a + reach, f.H + e.above] };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────────────────────

/**
 * A leaf's own frame: p across its width from its hinge edge, q through its thickness from the face
 * on the side it swings to, z up — carried into the opening's frame by a quarter-turned axis pair.
 */
interface Leaf {
  readonly o: XY;
  readonly P: XY;
  readonly Q: XY;
}

const atLeaf = (L: Leaf, p: number, q: number): [number, number] => [L.o[0] + L.P[0] * p + L.Q[0] * q, L.o[1] + L.P[1] * p + L.Q[1] * q];

/** A leaf hinged at (xh, face), its free edge towards +x (`hdir` 1) or −x, swinging to the +y (`s` 1) or −y side: closed in the wall, or open at 90°. */
function hung(xh: number, hdir: Sign, face: number, s: Sign, state: DoorState): Leaf {
  return state === 'closed' ? { o: [xh, face], P: [hdir, 0], Q: [0, -s] } : { o: [xh, face], P: [0, s], Q: [hdir, 0] };
}

/** Wraps the sketch: names a moving piece by its state, and remembers which pieces move. */
class Board {
  readonly moving = new Map<Piece, DoorState>();
  constructor(readonly sk: Sketch) {}

  box(name: string, role: ModelRole, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.sk.box(name, role, x0, y0, z0, x1, y1, z1);
  }

  /** Draw the pieces of `draw` as moving pieces in `state`. */
  as(state: DoorState | undefined, draw: (name: (n: string) => string) => void): void {
    const from = this.sk.pieces.length;
    draw((n) => (state === 'open' ? `${n}Open` : n));
    if (state !== undefined) for (const p of this.sk.pieces.slice(from)) this.moving.set(p, state);
  }

  lbox(name: string, role: ModelRole, L: Leaf, p0: number, q0: number, z0: number, p1: number, q1: number, z1: number): void {
    const A = atLeaf(L, p0, q0);
    const B = atLeaf(L, p1, q1);
    this.sk.box(name, role, A[0], A[1], z0, B[0], B[1], z1);
  }

  /** A cylinder through the leaf's thickness, about (p, z), from q0 to q1. */
  lcyl(name: string, role: ModelRole, L: Leaf, p: number, z: number, r: number, q0: number, q1: number): void {
    const A = atLeaf(L, p, q0);
    const B = atLeaf(L, p, q1);
    if (L.Q[0] !== 0) this.sk.cylinder(name, role, 'x', [A[1], z], r, Math.min(A[0], B[0]), Math.max(A[0], B[0]));
    else this.sk.cylinder(name, role, 'y', [z, A[0]], r, Math.min(A[1], B[1]), Math.max(A[1], B[1]));
  }

  /** A polygon in the leaf's (p, q) plane from z0 to z1. */
  lpoly(name: string, role: ModelRole, L: Leaf, pts: readonly XY[], z0: number, z1: number): void {
    this.sk.extrude(name, role, 'z', pts.map((p) => atLeaf(L, p[0], p[1])), z0, z1);
  }
}

const min = Math.min;
const max = Math.max;

/** What a leaf has for handles. */
type Hardware = 'lever' | 'push' | 'pull' | 'knob' | 'none';

interface LeafSpec {
  /** Its width (p), thickness (q) and height. */
  W: number;
  t: number;
  z0: number;
  z1: number;
  glazed: boolean;
  hardware: Hardware;
}

/** A leaf: a slab, or stiles and rails round a glass panel; and its handles on both faces, by its free edge. */
function leaf(bd: Board, nm: (n: string) => string, L: Leaf, s: LeafSpec, role: ModelRole): void {
  const { W, t, z0, z1 } = s;
  if (W < 4 * MM || t < 4 * MM || z1 - z0 < 4 * MM) return;
  if (s.glazed) {
    const sw = min(110 * MM, W * 0.2);
    const tr = min(110 * MM, (z1 - z0) * 0.1);
    const br = min(230 * MM, (z1 - z0) * 0.14);
    const gt = min(8 * MM, t / 3);
    bd.lbox(nm('stile'), 'frame', L, 0, 0, z0, sw, t, z1);
    bd.lbox(nm('stile'), 'frame', L, W - sw, 0, z0, W, t, z1);
    bd.lbox(nm('rail'), 'frame', L, sw, 0, z0, W - sw, t, z0 + br);
    bd.lbox(nm('rail'), 'frame', L, sw, 0, z1 - tr, W - sw, t, z1);
    bd.lbox(nm('glass'), 'glass', L, sw, (t - gt) / 2, z0 + br, W - sw, (t + gt) / 2, z1 - tr);
  } else bd.lbox(nm('slab'), role, L, 0, 0, z0, W, t, z1);
  const zc = min(915 * MM, z0 + (z1 - z0) * 0.45);
  for (const side of [0, 1] as const) {
    // Proud of the face at q = 0 (−q) or of the one at q = t (+q).
    const q = (d: number): number => (side === 0 ? -d : t + d);
    switch (s.hardware) {
      case 'lever': {
        const p = W - min(65 * MM, W * 0.15);
        const r = min(26 * MM, W * 0.06);
        bd.lcyl(nm('rose'), 'darkMetal', L, p, zc, r, q(0), q(9 * MM));
        // An L: a neck out from the rose, and the lever back towards the hinge.
        const k = min(9 * MM, r * 0.4);
        const reach = min(120 * MM, W * 0.3);
        bd.lpoly(nm('lever'), 'darkMetal', L, [
          [p - k, q(9 * MM)],
          [p + k, q(9 * MM)],
          [p + k, q(60 * MM)],
          [p - reach, q(60 * MM)],
          [p - reach, q(44 * MM)],
          [p - k, q(44 * MM)],
        ], zc - k, zc + k);
        break;
      }
      case 'push': {
        const p = W - min(120 * MM, W * 0.25);
        bd.lbox(nm('plate'), 'stainless', L, p - min(50 * MM, W * 0.1), q(0), zc, p + min(50 * MM, W * 0.1), q(2 * MM), min(zc + 300 * MM, z1 - 50 * MM));
        break;
      }
      case 'pull': {
        const p = W - min(45 * MM, W * 0.1);
        bd.lbox(nm('pull'), 'darkMetal', L, p - min(15 * MM, W * 0.04), q(0), zc - 60 * MM, p + min(15 * MM, W * 0.04), q(2 * MM), zc + 60 * MM);
        break;
      }
      case 'knob': {
        const p = min(50 * MM, W * 0.2);
        bd.lcyl(nm('knob'), 'darkMetal', L, p, zc, min(16 * MM, W * 0.05), q(0), q(28 * MM));
        break;
      }
      case 'none':
        break;
    }
  }
}

/** A hinge's knuckles at (x, y), up the leaf's height: three on a tall leaf, two on a short one. */
function hinges(bd: Board, x: number, y: number, z0: number, z1: number, r: number): void {
  const h = min(90 * MM, (z1 - z0) * 0.08);
  const at = [z0 + min(180 * MM, (z1 - z0) * 0.1), z1 - min(280 * MM, (z1 - z0) * 0.14) - h];
  if (z1 - z0 > 1_600 * MM) at.splice(1, 0, (z0 + z1) / 2 - h / 2);
  for (const z of at) bd.sk.cylinder('hinge', 'darkMetal', 'z', [x, y], r, z, z + h);
}

/** The painted trim on one face: two side casings and a head casing over them, `ci` in from the cut's edges, from z0 up. */
function casing(bd: Board, f: OpeningFrame, side: Sign, ci: number, z0: number): void {
  const face = side > 0 ? f.a : -f.b;
  const ct = min(16 * MM, (f.a + f.b) * 0.2);
  const cw = min(70 * MM, f.len * 0.15, f.H * 0.15);
  const y1 = face + side * ct;
  const top = f.H - ci;
  bd.box('casing', 'millwork', ci - cw, face, z0, ci, y1, top);
  bd.box('casing', 'millwork', f.len - ci, face, z0, f.len - ci + cw, y1, top);
  bd.box('casing', 'millwork', ci - cw, face, top, f.len - ci + cw, y1, top + cw);
}

/** Jambs and a head lining the cut from y0 to y1, `J` thick, from z0 up; a pocket's jamb is split round its slot. */
function lining(bd: Board, f: OpeningFrame, y0: number, y1: number, J: number, z0: number, role: ModelRole, slot?: { atStart: boolean; y0: number; y1: number }): void {
  const sides: [number, number][] = [[0, J], [f.len - J, f.len]];
  sides.forEach(([x0, x1], i) => {
    if (slot !== undefined && slot.atStart === (i === 0)) {
      bd.box('jamb', role, x0, y0, z0, x1, slot.y0, f.H - J);
      bd.box('jamb', role, x0, slot.y1, z0, x1, y1, f.H - J);
    } else bd.box('jamb', role, x0, y0, z0, x1, y1, f.H - J);
  });
  bd.box('head', role, 0, y0, f.H - J, f.len, y1, f.H);
}

interface Facts {
  operation: string;
  hinge: 'start' | 'end';
  /** The side a door swings to: +1 left, −1 right (Core 7.1, default right). */
  s: Sign;
  swingDeclared: boolean;
  /** The side outside the house: +1 left, −1 right, 0 when both or neither side is a room. */
  outside: 0 | Sign;
  name: string;
}

/** A door, by its operation. */
function door(bd: Board, f: OpeningFrame, x: Facts, states: readonly DoorState[]): void {
  const { len, H, a, b } = f;
  const T = a + b;
  const mid = (a - b) / 2;
  const J = min(19 * MM, len / 12, H / 12);
  const g = min(3 * MM, len / 200);
  const exterior = x.outside !== 0;
  const glazed = GLAZED.test(x.name) || (exterior && (x.operation === 'doubleSwing' || x.operation === 'bypassSlide'));
  const t = min(exterior ? 45 * MM : 35 * MM, T * 0.45);
  const face = x.s > 0 ? a : -b;
  const top = H - J - g;
  const under = min(10 * MM, H * 0.01);
  const atStart = x.hinge === 'start';
  const ci = J - min(4 * MM, J / 4);
  const rk = min(7 * MM, t / 4);
  // A glazed door in an outside wall is clad like a window: dark lining, no casing outside.
  const clad = glazed && exterior;
  const liningRole: ModelRole = clad ? 'frame' : 'millwork';

  switch (x.operation) {
    case 'pocket': {
      const lead = min(50 * MM, len * 0.1);
      const into = min(25 * MM, len * 0.05);
      const W = len - J - g + into;
      lining(bd, f, -b, a, J, 0, liningRole, { atStart, y0: mid - t / 2 - g, y1: mid + t / 2 + g });
      for (const s of [1, -1] as const) if (!(clad && s === x.outside)) casing(bd, f, s, ci, 0);
      // Open, it runs into the pocket as far as the wall beyond the hinge jamb goes — short of the wall it meets there.
      const room = max(into, (atStart ? f.before : f.after) - T);
      for (const st of states)
        bd.as(st, (nm) => {
          // The pocket is beyond the hinge jamb; p runs from the slab's edge in the pocket to its leading edge.
          const x0 = st === 'closed' ? -into : max(J + lead - W, -room);
          const L: Leaf = atStart ? { o: [x0, mid + t / 2], P: [1, 0], Q: [0, -1] } : { o: [len - x0, mid + t / 2], P: [-1, 0], Q: [0, -1] };
          leaf(bd, nm, L, { W, t, z0: under, z1: top, glazed, hardware: 'pull' }, 'door');
        });
      return;
    }
    case 'bypassSlide': {
      const tp = min(t, (T - 4 * g) / 2);
      const lap = min(25 * MM, len * 0.03);
      const W = (len - 2 * J) / 2 + lap;
      lining(bd, f, -b, a, J, 0, liningRole);
      for (const s of [1, -1] as const) if (!(clad && s === x.outside)) casing(bd, f, s, ci, 0);
      // The panel at the hinge jamb stays on the front track; the other slides behind it.
      const front: Leaf = atStart ? { o: [J, mid + g + tp], P: [1, 0], Q: [0, -1] } : { o: [len - J, mid + g + tp], P: [-1, 0], Q: [0, -1] };
      bd.as(undefined, (nm) => { leaf(bd, nm, front, { W, t: tp, z0: under, z1: top, glazed, hardware: 'pull' }, 'door'); });
      for (const st of states)
        bd.as(st, (nm) => {
          const x0 = st === 'closed' ? len - J : J + W;
          const back: Leaf = atStart ? { o: [x0, mid - g], P: [-1, 0], Q: [0, -1] } : { o: [len - x0, mid - g], P: [1, 0], Q: [0, -1] };
          leaf(bd, nm, back, { W, t: tp, z0: under, z1: top, glazed, hardware: 'pull' }, 'door');
        });
      return;
    }
    case 'surfaceSlide': {
      // A barn door: its slab on the face it hangs on, clear of the casing, under a rail along the wall.
      const s = x.s;
      const lap = min(60 * MM, len * 0.1);
      const W = len + 2 * lap;
      const off = 24 * MM;
      const tb = min(36 * MM, len * 0.05);
      const zTop = H + min(40 * MM, H * 0.03);
      lining(bd, f, -b, a, J, 0, 'millwork');
      for (const sd of [1, -1] as const) casing(bd, f, sd, ci, 0);
      // The rail, from where the slab hangs closed to where it slides to beyond the hinge jamb.
      const reach = len + lap;
      const rx0 = atStart ? -lap - reach - 20 * MM : -lap - 20 * MM;
      const rx1 = atStart ? len + lap + 20 * MM : len + lap + reach + 20 * MM;
      bd.box('rail', 'darkMetal', rx0, face, H + 62 * MM, rx1, face + s * 18 * MM, H + 90 * MM);
      for (const st of states)
        bd.as(st, (nm) => {
          const shift = st === 'closed' ? 0 : atStart ? -reach : reach;
          const x0 = -lap + shift;
          const L: Leaf = { o: [atStart ? x0 + W : x0, face + s * (off + tb)], P: [atStart ? -1 : 1, 0], Q: [0, -s] };
          // p from its leading edge (its pull) back to the edge that leads it into the wall.
          bd.lbox(nm('slab'), 'door', L, 0, 0, under, W, tb, zTop);
          for (const p of [min(150 * MM, W * 0.15), W - min(150 * MM, W * 0.15)]) {
            bd.lbox(nm('strap'), 'darkMetal', L, p - 20 * MM, tb, zTop - 120 * MM, p + 20 * MM, tb + 6 * MM, H + 96 * MM);
            bd.lcyl(nm('roller'), 'darkMetal', L, p, H + 96 * MM, 22 * MM, tb + 6 * MM, tb + 22 * MM);
          }
          const pp = min(90 * MM, W * 0.1);
          const zc = min(915 * MM, H * 0.45);
          bd.lpoly(nm('pull'), 'darkMetal', L, [[pp - 10 * MM, -24 * MM], [pp + 10 * MM, -24 * MM], [pp + 10 * MM, 0], [pp - 10 * MM, 0]], zc - 200 * MM, zc + 200 * MM);
        });
      return;
    }
    case 'overhead': {
      // Inside the opening, on the side it rises on — the room's, where Core leaves it to the hint and only one side has one.
      const so: Sign = !x.swingDeclared && x.outside !== 0 ? (-x.outside as Sign) : x.s;
      const fo = so > 0 ? a : -b;
      const tg = min(45 * MM, len * 0.03);
      const gap = 12 * MM;
      const n = max(1, Math.round(H / (530 * MM)));
      const lap = min(50 * MM, len * 0.05);
      const tall = H + min(40 * MM, H * 0.03);
      lining(bd, f, -b, a, J, 0, 'millwork');
      casing(bd, f, -so as Sign, ci, 0);
      for (const st of states)
        bd.as(st, (nm) => {
          const zUp = max(H, min(H + 60 * MM, f.wallTop - tg - 10 * MM));
          for (let k = 0; k < n; k++) {
            const lo = (tall * k) / n;
            const hi = (tall * (k + 1)) / n;
            // Every other section a millimetre thinner each side: no gap to see through, and a line at every joint.
            const d = k % 2 === 1 ? min(1 * MM, tg / 10) : 0;
            if (st === 'closed') bd.box(nm('section'), 'frame', -lap, fo + so * (gap + d), lo, len + lap, fo + so * (gap + tg - d), hi);
            else bd.box(nm('section'), 'frame', -lap, fo + so * (gap + lo), zUp + d, len + lap, fo + so * (gap + hi), zUp + tg - d);
          }
        });
      return;
    }
    case 'cased':
      lining(bd, f, -b, a, J, 0, 'millwork');
      for (const s of [1, -1] as const) casing(bd, f, s, ci, 0);
      return;
    default:
      break;
  }

  lining(bd, f, -b, a, J, 0, liningRole);
  for (const s of [1, -1] as const) if (!(clad && s === x.outside)) casing(bd, f, s, ci, 0);
  const role: ModelRole = 'door';
  switch (x.operation) {
    case 'doubleSwing': {
      const W = (len - 2 * J - 3 * g) / 2;
      hinges(bd, J + g / 2, face, under, top, rk);
      hinges(bd, len - J - g / 2, face, under, top, rk);
      for (const st of states)
        bd.as(st, (nm) => {
          leaf(bd, nm, hung(J + g, 1, face, x.s, st), { W, t, z0: under, z1: top, glazed, hardware: 'lever' }, role);
          leaf(bd, nm, hung(len - J - g, -1, face, x.s, st), { W, t, z0: under, z1: top, glazed, hardware: 'lever' }, role);
        });
      return;
    }
    case 'doubleActing': {
      const W = len - 2 * J - 2 * g;
      const xh = atStart ? J + g : len - J - g;
      for (const st of states) bd.as(st, (nm) => { leaf(bd, nm, hung(xh, atStart ? 1 : -1, mid + (x.s * t) / 2, x.s, st), { W, t, z0: under, z1: top, glazed, hardware: 'push' }, role); });
      return;
    }
    case 'bifold': {
      const tb = min(28 * MM, t);
      const clear = len - 2 * J;
      const pairs: { xh: number; hdir: Sign; span: number }[] =
        clear > 1_067 * MM ? [{ xh: J + g, hdir: 1, span: (clear - 3 * g) / 2 }, { xh: len - J - g, hdir: -1, span: (clear - 3 * g) / 2 }] : [{ xh: atStart ? J + g : len - J - g, hdir: atStart ? 1 : -1, span: clear - 2 * g }];
      for (const st of states)
        bd.as(st, (nm) => {
          for (const pr of pairs) {
            const pw = (pr.span - g) / 2;
            leaf(bd, nm, hung(pr.xh, pr.hdir, face, x.s, st), { W: pw, t: tb, z0: under, z1: top, glazed, hardware: 'none' }, role);
            // The second panel: beside the first across the opening, or folded flat against it.
            const second = st === 'closed' ? hung(pr.xh + pr.hdir * (pw + g), pr.hdir, face, x.s, st) : hung(pr.xh + pr.hdir * (tb + g), pr.hdir, face, x.s, st);
            leaf(bd, nm, second, { W: pw, t: tb, z0: under, z1: top, glazed, hardware: 'knob' }, role);
          }
        });
      return;
    }
    default: {
      // A single swing: hung on its hinge jamb, on the face of the side it swings to.
      const W = len - 2 * J - 2 * g;
      const xh = atStart ? J + g : len - J - g;
      hinges(bd, atStart ? J + g / 2 : len - J - g / 2, face, under, top, rk);
      for (const st of states) bd.as(st, (nm) => { leaf(bd, nm, hung(xh, atStart ? 1 : -1, face, x.s, st), { W, t, z0: under, z1: top, glazed, hardware: 'lever' }, role); });
    }
  }
}

/** A sash: stiles and rails round its glass, between the planes y0 and y1. */
function sash(bd: Board, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, muntins: boolean): void {
  const sw = min(45 * MM, (x1 - x0) / 6, (z1 - z0) / 6);
  bd.box('stile', 'frame', x0, y0, z0, x0 + sw, y1, z1);
  bd.box('stile', 'frame', x1 - sw, y0, z0, x1, y1, z1);
  bd.box('rail', 'frame', x0 + sw, y0, z0, x1 - sw, y1, z0 + sw);
  bd.box('rail', 'frame', x0 + sw, y0, z1 - sw, x1 - sw, y1, z1);
  pane(bd, x0 + sw, x1 - sw, z0 + sw, z1 - sw, (y0 + y1) / 2, muntins);
}

/** A pane of glass about the plane yc, with its muntins when it has divided lites. */
function pane(bd: Board, x0: number, x1: number, z0: number, z1: number, yc: number, muntins: boolean): void {
  const gt = 8 * MM;
  bd.box('glass', 'glass', x0, yc - gt / 2, z0, x1, yc + gt / 2, z1);
  if (!muntins) return;
  const bar = 18 * MM;
  const nx = max(1, Math.round((x1 - x0) / (350 * MM)));
  const nz = max(1, Math.round((z1 - z0) / (350 * MM)));
  for (let i = 1; i < nx; i++) {
    const xc = x0 + ((x1 - x0) * i) / nx;
    bd.box('muntin', 'frame', xc - bar / 2, yc - gt / 2 - 6 * MM, z0, xc + bar / 2, yc + gt / 2 + 6 * MM, z1);
  }
  for (let j = 1; j < nz; j++) {
    const zc = z0 + ((z1 - z0) * j) / nz;
    for (let i = 0; i < nx; i++) {
      const xa = x0 + ((x1 - x0) * i) / nx + (i === 0 ? 0 : bar / 2);
      const xb = x0 + ((x1 - x0) * (i + 1)) / nx - (i === nx - 1 ? 0 : bar / 2);
      bd.box('muntin', 'frame', xa, yc - gt / 2 - 6 * MM, zc - bar / 2, xb, yc + gt / 2 + 6 * MM, zc + bar / 2);
    }
  }
}

/** A window, by its operation. */
function windowJoinery(bd: Board, f: OpeningFrame, x: Facts): void {
  const { len, H, a, b } = f;
  const T = a + b;
  const e: Sign = x.outside === 0 ? 1 : x.outside;
  const FW = min(50 * MM, len / 8, H / 8);
  const FD = min(110 * MM, T * 0.7);
  // The frame flush with the outside face — no reveal of the wall's core outside it; in a wall between two rooms (or none), centred.
  const extFace = e > 0 ? a : -b;
  const yOut = x.outside === 0 ? (a - b) / 2 + (e * FD) / 2 : extFace;
  const yIn = yOut - e * FD;
  const [fy0, fy1] = yOut < yIn ? [yOut, yIn] : [yIn, yOut];
  bd.box('frame', 'frame', 0, fy0, 0, FW, fy1, H);
  bd.box('frame', 'frame', len - FW, fy0, 0, len, fy1, H);
  bd.box('frame', 'frame', FW, fy0, H - FW, len - FW, fy1, H);
  bd.box('frame', 'frame', FW, fy0, 0, len - FW, fy1, FW);

  // Units side by side between mullions, where the type's name asks for them.
  const units = /\btriple\b/i.test(x.name) ? 3 : /\b(twin|mulled|mullions?)\b/i.test(x.name) ? 2 : 1;
  const muntins = MUNTINS.test(x.name);
  const span = (len - 2 * FW - (units - 1) * FW) / units;
  const yc = (yOut + yIn) / 2;
  const SD = min(45 * MM, FD * 0.4);
  const z0 = FW;
  const z1 = H - FW;
  for (let k = 0; k < units; k++) {
    const x0 = FW + k * (span + FW);
    const x1 = x0 + span;
    if (k > 0) bd.box('mullion', 'frame', x0 - FW, fy0, z0, x0, fy1, z1);
    // The outer and inner sash planes: a hung sash or a slider's outer panel towards the outside.
    const outer: [number, number] = [yc + e * 2 * MM, yc + e * (SD + 2 * MM)];
    const inner: [number, number] = [yc - e * SD, yc];
    switch (x.operation) {
      case 'doubleHung':
      case 'singleHung': {
        const zm = (z0 + z1) / 2;
        const sw = min(45 * MM, span / 6, (z1 - z0) / 12);
        sash(bd, x0, x1, zm - sw / 2, z1, outer[0], outer[1], muntins);
        sash(bd, x0, x1, z0, zm + sw / 2, inner[0], inner[1], muntins);
        // The sash lock on the meeting rail, inside.
        bd.box('lock', 'darkMetal', (x0 + x1) / 2 - 30 * MM, inner[0], zm, (x0 + x1) / 2 + 30 * MM, inner[0] - e * 14 * MM, zm + sw / 2 + 12 * MM);
        break;
      }
      case 'horizontalSlider': {
        const xm = (x0 + x1) / 2;
        const sw = min(45 * MM, span / 12, (z1 - z0) / 6);
        sash(bd, x0, xm + sw / 2, z0, z1, outer[0], outer[1], muntins);
        sash(bd, xm - sw / 2, x1, z0, z1, inner[0], inner[1], muntins);
        break;
      }
      case 'casement':
      case 'awning':
      case 'hopper':
      case 'tiltTurn':
      case 'pivot': {
        sash(bd, x0, x1, z0, z1, yc - SD / 2, yc + SD / 2, muntins);
        // Its operator: a crank or a handle on the inside of the frame's sill, or of the sash's side.
        const yI = yc - (e * SD) / 2;
        if (x.operation === 'casement' || x.operation === 'awning') bd.box('handle', 'darkMetal', (x0 + x1) / 2 - 35 * MM, yI, z0 - min(FW * 0.6, 30 * MM), (x0 + x1) / 2 + 35 * MM, yI - e * 22 * MM, z0);
        else bd.box('handle', 'darkMetal', x1 - min(45 * MM, span / 6) / 2 - 8 * MM, yI, (z0 + z1) / 2 - 60 * MM, x1 - min(45 * MM, span / 6) / 2 + 8 * MM, yI - e * 22 * MM, (z0 + z1) / 2 + 60 * MM);
        break;
      }
      default:
        pane(bd, x0, x1, z0, z1, yc, muntins);
    }
  }

  // Inside: lined from the frame to the room's face, a stool and an apron under a sill off the floor, and cased.
  const insides: Sign[] = x.outside === 0 ? [1, -1] : [(-e) as Sign];
  const stool = f.sillHeight >= STOOL_FROM;
  const ci = FW - min(4 * MM, FW / 4);
  // A stool's and a sill's tops stand a little above the cut's bottom, never in its plane.
  const lip = min(3 * MM, H * 0.01);
  for (const s of insides) {
    const face = s > 0 ? a : -b;
    const from = s > 0 ? fy1 : fy0;
    const [ly0, ly1] = from < face ? [from, face] : [face, from];
    const z0 = stool ? lip : 0;
    lining(bd, f, ly0, ly1, FW, z0, 'millwork');
    if (!stool) bd.box('lining', 'millwork', FW, ly0, 0, len - FW, ly1, FW);
    casing(bd, f, s, ci, z0);
    if (stool) {
      const cw = min(70 * MM, len * 0.15, H * 0.15);
      const st = min(22 * MM, H * 0.05);
      const nose = 28 * MM;
      bd.box('stool', 'millwork', ci - cw - 20 * MM, from, lip - st, len - ci + cw + 20 * MM, face + s * nose, lip);
      const ct = min(16 * MM, T * 0.2);
      bd.box('apron', 'millwork', ci - cw, face, lip - st - cw * 0.9, len - ci + cw, face + s * ct, lip - st);
    }
  }
  // Outside: a sill under the frame, out past the face — none at a window down to the floor.
  if (x.outside !== 0 && f.sillHeight >= 60 * MM) {
    const st = min(30 * MM, H * 0.05);
    bd.box('sill', 'millwork', -25 * MM, yOut, lip - st, len + 25 * MM, extFace + e * 35 * MM, lip);
  }
}

/** The facts an opening's joinery is drawn from: its operation, hinge and swing, which side is outside, its type's name. */
function factsOf(doc: FloorspecDocument, derived: Derived, oid: string, category: 'door' | 'window' | 'empty'): Facts {
  const o = get(doc.openings, oid)!;
  const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
  const op = t !== undefined && (t.kind === 'doorType' || t.kind === 'windowType') ? t.operation : undefined;
  const rooms = roomsBeside(doc, derived, oid);
  const outside = rooms.left === undefined && rooms.right !== undefined ? 1 : rooms.right === undefined && rooms.left !== undefined ? -1 : 0;
  return {
    operation: category === 'empty' ? 'cased' : (op ?? (category === 'door' ? 'swing' : 'fixed')),
    hinge: o.hinge ?? 'start',
    s: o.swing === 'left' ? 1 : -1,
    swingDeclared: o.swing !== undefined,
    outside,
    name: typeof t?.name === 'string' ? t.name : '',
  };
}

/** Every opening's joinery, a part per piece, its moving pieces in each of `doors`' states. */
export function joineryParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean, doors: NonNullable<MeshOptions['doors']> = 'closed'): RawPart[] {
  if (!want('joinery')) return [];
  const states: DoorState[] = doors === 'both' ? ['closed', 'open'] : [doors];
  const out: RawPart[] = [];
  for (const oid of Object.keys(derived.openings).sort()) {
    const o = get(doc.openings, oid)!;
    const f = openingFrame(doc, derived, oid);
    if (f === undefined) continue;
    const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
    const category = t?.kind === 'doorType' ? 'door' : t?.kind === 'windowType' ? 'window' : 'empty';
    const x = factsOf(doc, derived, oid, category);
    const place = (px: number, py: number, pz: number): P3 => [
      Math.round(f.start[0] + f.u[0] * px + f.n[0] * py),
      Math.round(f.start[1] + f.u[1] * px + f.n[1] * py),
      f.sill + Math.round(pz),
    ];
    const bd = new Board(new Sketch(kernel, place, f.len, f.a + f.b, f.H));
    if (category === 'window') windowJoinery(bd, f, x);
    else door(bd, f, x, states);
    const level = get(doc.walls, o.wall)!.level;
    for (const p of bd.sk.pieces) {
      if (p.b.tris.length === 0) continue;
      const state = bd.moving.get(p);
      out.push({
        kind: 'joinery',
        id: oid,
        level,
        piece: p.name,
        closed: true,
        opening: { category, wall: o.wall, ...(o.fill !== undefined && { fill: o.fill }) },
        model: { kind: x.operation, role: p.role, ...(p.smooth && { smooth: true as const }) },
        ...(state !== undefined && { state }),
        exact: p.b,
      });
    }
  }
  return out;
}
