/**
 * The section box, the section plane and the exploded axonometric (FLR-T-14.6, the board's "14.6 ·
 * Section box" and "14.6 · Exploded axonometric" frames) without three.js, so it can be tested: the
 * box's faces as clipping planes, what dragging or nudging a face does to the box, the cap of each cut
 * face, which faces and edges the camera sees, and how the levels and roofs are lifted apart.
 *
 * Everything is in the 3D view's frame: metres about the mesh's origin, x east, y north, z up — the
 * orbit camera's frame (camera.ts). A box and a plane are view state (mode.ts), never the document.
 *
 * A clipping plane keeps what is on its positive side, `normal · p + constant ≥ 0`, as three.js's
 * clipping planes do: a box keeps what all six of its faces keep. Why it is all view state, capped by the
 * stencil and exported raster: FLR-ADR-052.
 */

export type Vec3 = [number, number, number];

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A face of the box, by the way its outward normal points. */
export type Face = 'west' | 'east' | 'south' | 'north' | 'bottom' | 'top';
export const FACES: readonly Face[] = ['west', 'east', 'south', 'north', 'bottom', 'top'];

/** The axis a face is across (0 x, 1 y, 2 z) and which way its outward normal points along it. */
export const FACE_AXIS: Readonly<Record<Face, { axis: 0 | 1 | 2; sign: -1 | 1 }>> = {
  west: { axis: 0, sign: -1 },
  east: { axis: 0, sign: 1 },
  south: { axis: 1, sign: -1 },
  north: { axis: 1, sign: 1 },
  bottom: { axis: 2, sign: -1 },
  top: { axis: 2, sign: 1 },
};

/** The face across from a face. */
export const OPPOSITE: Readonly<Record<Face, Face>> = { west: 'east', east: 'west', south: 'north', north: 'south', bottom: 'top', top: 'bottom' };

/** How a section cuts: a box, one plane, or not at all. */
export type SectionMode = 'off' | 'box' | 'plane';
/** What is outside the box or past the plane: ghosted, or not drawn. */
export type Outside = 'ghost' | 'hidden';

/** The single section plane: which side of the house it cuts away, and where (metres along its axis). */
export interface SectionPlane {
  readonly face: Face;
  readonly at: number;
}

export interface SectionState {
  readonly mode: SectionMode;
  /** The box: null until the section is first opened over a mesh. */
  readonly box: Box | null;
  /** The plane: null until the plane is first chosen. */
  readonly plane: SectionPlane | null;
  /** Cut faces drawn as solid, capped; else the cut is seen into. */
  readonly caps: boolean;
  /** The caps hatched at 45°, as a drawing hatches what is cut. */
  readonly hatch: boolean;
  readonly outside: Outside;
}

export const DEFAULT_SECTION: SectionState = { mode: 'off', box: null, plane: null, caps: true, hatch: true, outside: 'ghost' };

/** What the outside of the box is drawn at, ghosted: the panel's "Ghosted 15 %". */
export const GHOST_OPACITY = 0.15;
/** The least a box may be across any axis, metres: three inches. */
export const MIN_SIZE = 0.0762;
/** How far past the house a box that holds it all stands off, metres. */
export const PAD = 0.3;

export interface ClipPlane {
  readonly face: Face;
  readonly normal: Vec3;
  readonly constant: number;
}

const unit = (face: Face): Vec3 => {
  const { axis, sign } = FACE_AXIS[face];
  const n: Vec3 = [0, 0, 0];
  n[axis] = sign;
  return n;
};

/** Where a face of the box is, along its axis. */
export function faceAt(box: Box, face: Face): number {
  const { axis, sign } = FACE_AXIS[face];
  return sign > 0 ? box.max[axis] : box.min[axis];
}

/**
 * The clipping plane of a face at `at`: it keeps what is inside, so its normal points inward —
 * against the face's outward normal — and the face itself is on the plane.
 */
export function facePlane(face: Face, at: number): ClipPlane {
  const n = unit(face);
  return { face, normal: [-n[0], -n[1], -n[2]], constant: FACE_AXIS[face].sign * at };
}

/** The six planes that keep what is inside a box. */
export const boxPlanes = (box: Box): ClipPlane[] => FACES.map((f) => facePlane(f, faceAt(box, f)));

/** The planes a section cuts with: six for a box, one for a plane, none when off. */
export function sectionPlanes(s: Pick<SectionState, 'mode' | 'box' | 'plane'>): ClipPlane[] {
  if (s.mode === 'box' && s.box !== null) return boxPlanes(s.box);
  if (s.mode === 'plane' && s.plane !== null) return [facePlane(s.plane.face, s.plane.at)];
  return [];
}

/** Whether a point is kept by every plane. */
export const kept = (planes: readonly ClipPlane[], p: Vec3, eps = 1e-9): boolean => planes.every((c) => c.normal[0] * p[0] + c.normal[1] * p[1] + c.normal[2] * p[2] + c.constant >= -eps);

/** The same plane facing the other way: what keeps exactly what it cuts away (the ghost of the outside). */
export const flipped = (c: ClipPlane): ClipPlane => ({ face: c.face, normal: [-c.normal[0], -c.normal[1], -c.normal[2]], constant: -c.constant });

/** A box with one face moved to `at` — never past the face across from it, nor nearer than MIN_SIZE to it. */
export function moveFace(box: Box, face: Face, at: number): Box {
  const { axis, sign } = FACE_AXIS[face];
  const min: Vec3 = [...box.min];
  const max: Vec3 = [...box.max];
  if (!Number.isFinite(at)) return box;
  if (sign > 0) max[axis] = Math.max(at, min[axis] + MIN_SIZE);
  else min[axis] = Math.min(at, max[axis] - MIN_SIZE);
  return { min, max };
}

/** A face moved out (a positive `by`, metres) or in along its outward normal. */
export const nudgeFace = (box: Box, face: Face, by: number): Box => moveFace(box, face, faceAt(box, face) + FACE_AXIS[face].sign * by);

/** A value rounded to a step (metres), when there is one. */
export const snap = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v);

export const centreOf = (box: Box): Vec3 => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
export const sizeOf = (box: Box): Vec3 => [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];

/** The middle of a face: where its handle is. */
export function faceCentre(box: Box, face: Face): Vec3 {
  const c = centreOf(box);
  const { axis } = FACE_AXIS[face];
  c[axis] = faceAt(box, face);
  return c;
}

/** A box grown (or shrunk, negative) by `by` metres on every side. */
export const padBox = (box: Box, by: number): Box => ({ min: [box.min[0] - by, box.min[1] - by, box.min[2] - by], max: [box.max[0] + by, box.max[1] + by, box.max[2] + by] });

export function unionBox(a: Box | null, b: Box): Box {
  if (a === null) return b;
  return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] };
}

/** Whether two boxes overlap (touching counts). */
export const overlaps = (a: Box, b: Box): boolean => a.min.every((v, i) => v <= (b.max[i] ?? 0)) && b.min.every((v, i) => v <= (a.max[i] ?? 0));

/** A level's band of height, metres: its floor (less a little for its structure) to just under the next floor. */
export interface Band {
  readonly bottom: number;
  readonly top: number;
}

/**
 * Where a section box starts: around the selection when there is one — across it, padded, and up
 * the height of its level (the board's "Fit to selection") — else around the whole house at the
 * current level's band, so its ceilings and what is above come off and its rooms are seen into.
 */
export function defaultBox(house: Box, selection: Box | null, band: Band | null): Box {
  const z: [number, number] = band === null ? [house.min[2] - PAD, house.max[2] + PAD] : [band.bottom, band.top];
  if (selection !== null) {
    const s = padBox(selection, PAD);
    return { min: [s.min[0], s.min[1], z[0]], max: [s.max[0], s.max[1], Math.max(z[1], z[0] + MIN_SIZE)] };
  }
  const h = padBox(house, PAD);
  return { min: [h.min[0], h.min[1], z[0]], max: [h.max[0], h.max[1], Math.max(z[1], z[0] + MIN_SIZE)] };
}

/**
 * Where the plane starts: across the middle of the house, cutting away the side the camera looks from
 * (the face whose outward normal points most towards it, horizontally) — so the house is seen opened.
 */
export function defaultPlane(house: Box, azimuth: number): SectionPlane {
  const c = centreOf(house);
  const x = Math.cos(azimuth);
  const y = Math.sin(azimuth);
  const face: Face = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'east' : 'west') : y > 0 ? 'north' : 'south';
  return { face, at: c[FACE_AXIS[face].axis] };
}

/** A plane turned to cut from another side, through the same middle of the house. */
export const planeFrom = (house: Box, face: Face): SectionPlane => ({ face, at: centreOf(house)[FACE_AXIS[face].axis] });

/** A plane moved, kept within the house padded, so it can always be dragged back. */
export function movePlane(plane: SectionPlane, house: Box, at: number): SectionPlane {
  const { axis } = FACE_AXIS[plane.face];
  const lo = house.min[axis] - PAD;
  const hi = house.max[axis] + PAD;
  return { face: plane.face, at: Math.min(hi, Math.max(lo, Number.isFinite(at) ? at : plane.at)) };
}

/** The rectangle a cut face is capped over: four corners, counter-clockwise seen from outside the face. */
export function faceRect(box: Box, face: Face): [Vec3, Vec3, Vec3, Vec3] {
  const { axis, sign } = FACE_AXIS[face];
  const at = faceAt(box, face);
  const u = ((axis + 1) % 3) as 0 | 1 | 2;
  const v = ((axis + 2) % 3) as 0 | 1 | 2;
  const corner = (a: number, b: number): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    p[axis] = at;
    p[u] = a;
    p[v] = b;
    return p;
  };
  const r: [Vec3, Vec3, Vec3, Vec3] = [corner(box.min[u], box.min[v]), corner(box.max[u], box.min[v]), corner(box.max[u], box.max[v]), corner(box.min[u], box.max[v])];
  // (u, v, axis) is right-handed, so u × v is +axis: a face whose normal points the other way is wound backwards.
  return sign > 0 ? r : [r[0], r[3], r[2], r[1]];
}

/** The plane's rectangle: across the house, padded, on the plane. */
export function planeRect(house: Box, plane: SectionPlane): [Vec3, Vec3, Vec3, Vec3] {
  const box = padBox(house, PAD);
  const { axis, sign } = FACE_AXIS[plane.face];
  const min: Vec3 = [...box.min];
  const max: Vec3 = [...box.max];
  if (sign > 0) max[axis] = plane.at;
  else min[axis] = plane.at;
  return faceRect({ min, max }, plane.face);
}

/** Whether a face's outside is towards the eye: the face is seen from outside the box. */
export function facesEye(box: Box, face: Face, eye: Vec3): boolean {
  const { axis, sign } = FACE_AXIS[face];
  return sign * (eye[axis] - faceAt(box, face)) > 0;
}

/** A corner by which way it is on each axis: `-1` the min side, `1` the max. */
export type Corner = readonly [-1 | 1, -1 | 1, -1 | 1];

const C000: Corner = [-1, -1, -1];
const C100: Corner = [1, -1, -1];
const C110: Corner = [1, 1, -1];
const C010: Corner = [-1, 1, -1];
const C001: Corner = [-1, -1, 1];
const C101: Corner = [1, -1, 1];
const C111: Corner = [1, 1, 1];
const C011: Corner = [-1, 1, 1];
export const CORNERS: readonly Corner[] = [C000, C100, C110, C010, C001, C101, C111, C011];

export const cornerAt = (box: Box, c: Corner): Vec3 => [c[0] > 0 ? box.max[0] : box.min[0], c[1] > 0 ? box.max[1] : box.min[1], c[2] > 0 ? box.max[2] : box.min[2]];

/** The faces a corner joins, by axis. */
export const cornerFaces = (c: Corner): [Face, Face, Face] => [c[0] > 0 ? 'east' : 'west', c[1] > 0 ? 'north' : 'south', c[2] > 0 ? 'top' : 'bottom'];

/** A corner in words: "top north-east corner". */
export function cornerWords(c: Corner): string {
  const ns = c[1] > 0 ? 'north' : 'south';
  const ew = c[0] > 0 ? 'east' : 'west';
  return `${c[2] > 0 ? 'top' : 'bottom'} ${ns}-${ew} corner`;
}

/**
 * The corner handles drawn (the frame's T1–T3 and B1–B3): on the top and the bottom, each corner but
 * the one farthest from the eye in plan — the one the box itself hides.
 */
export function cornersShown(box: Box, eye: Vec3): Corner[] {
  const c = centreOf(box);
  const far: [-1 | 1, -1 | 1] = [eye[0] > c[0] ? -1 : 1, eye[1] > c[1] ? -1 : 1];
  return CORNERS.filter((k) => !(k[0] === far[0] && k[1] === far[1]));
}

/** A corner moved in plan to (x, y): the two upright faces it joins follow it. */
export function moveCorner(box: Box, c: Corner, x: number, y: number): Box {
  const [fx, fy] = cornerFaces(c);
  return moveFace(moveFace(box, fx, x), fy, y);
}

/** The box's twelve edges, each with the faces it joins. */
export const EDGES: readonly [Corner, Corner][] = [
  [C000, C100], [C100, C110], [C110, C010], [C010, C000],
  [C001, C101], [C101, C111], [C111, C011], [C011, C001],
  [C000, C001], [C100, C101], [C110, C111], [C010, C011],
];

/** The two faces an edge lies on: the axes its ends agree on. */
export function edgeFaces(a: Corner, b: Corner): Face[] {
  const out: Face[] = [];
  for (const axis of [0, 1, 2] as const) {
    if (a[axis] !== b[axis]) continue;
    const s = a[axis];
    out.push(axis === 0 ? (s > 0 ? 'east' : 'west') : axis === 1 ? (s > 0 ? 'north' : 'south') : s > 0 ? 'top' : 'bottom');
  }
  return out;
}

/**
 * The box's edges as the eye sees them: an edge is behind the box — drawn dashed, as the frame does —
 * when neither face it lies on faces the eye.
 */
export function edgesSeen(box: Box, eye: Vec3): { a: Vec3; b: Vec3; hidden: boolean; faces: Face[] }[] {
  return EDGES.map(([a, b]) => {
    const faces = edgeFaces(a, b);
    return { a: cornerAt(box, a), b: cornerAt(box, b), faces, hidden: !faces.some((f) => facesEye(box, f, eye)) };
  });
}

/**
 * Dragging a face: the point on the face's axis line (through `through`, along `axis`) nearest the
 * pointer's ray — its coordinate along that axis. Null when the ray runs along the axis, where the
 * drag says nothing.
 */
export function alongAxis(origin: Vec3, dir: Vec3, through: Vec3, axis: 0 | 1 | 2): number | null {
  // Lines p = origin + s·dir and q = through + t·e (e the axis): the t of their closest points.
  const e: Vec3 = [0, 0, 0];
  e[axis] = 1;
  const w: Vec3 = [origin[0] - through[0], origin[1] - through[1], origin[2] - through[2]];
  const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  const b = dir[axis];
  const d = dir[0] * w[0] + dir[1] * w[1] + dir[2] * w[2];
  const f = w[axis];
  const den = a - b * b;
  if (den < 1e-9 * a) return null;
  const t = (a * f - b * d) / den;
  return through[axis] + t;
}

/** Where a ray meets the horizontal plane at height z; null when it runs level or away from it. */
export function onLevel(origin: Vec3, dir: Vec3, z: number): [number, number] | null {
  if (Math.abs(dir[2]) < 1e-9) return null;
  const s = (z - origin[2]) / dir[2];
  if (s <= 0) return null;
  return [origin[0] + s * dir[0], origin[1] + s * dir[1]];
}

/** The word for a face's side of the house, as the dimension tag says it: "W wall". */
export const SIDE_WORDS: Readonly<Record<Face, string>> = { west: 'W wall', east: 'E wall', south: 'S wall', north: 'N wall', bottom: 'the ground', top: 'the ground' };
export const FACE_WORDS: Readonly<Record<Face, string>> = { west: 'West face', east: 'East face', south: 'South face', north: 'North face', bottom: 'Bottom face', top: 'Top face' };

/**
 * How far a face is from the house's side it is measured from (metres): an upright face from the
 * house's west or south side — whichever its axis starts from — and the top and bottom from the house's
 * lowest point. The frame's tag: "21′-4″ from W wall".
 */
export function faceDistance(house: Box, face: Face, at: number): { metres: number; from: string } {
  const { axis } = FACE_AXIS[face];
  const from: Face = axis === 0 ? 'west' : axis === 1 ? 'south' : 'bottom';
  return { metres: at - house.min[axis], from: SIDE_WORDS[from] };
}

// ─── The exploded axonometric ────────────────────────────────────────────────────────────────

/** A layer of the exploded view: a level, or the roofs its walls carry. */
export interface Layer {
  readonly key: string;
  readonly level: string;
  readonly roof: boolean;
}

export interface ExplodeState {
  /** The exploded view is showing: the camera axonometric, the levels and roofs apart (or going apart, or coming down). */
  readonly active: boolean;
  /** Its panel is open. Closed, the levels come down and the view then leaves the exploded view. */
  readonly open: boolean;
  /** Apart, or together: what the animation runs towards. */
  readonly apart: boolean;
  /** Metres added between each layer and the next. */
  readonly spread: number;
  readonly labels: boolean;
  readonly plumb: boolean;
  readonly roofs: boolean;
  /** Only what the section box keeps (its upright faces; the levels its height takes in). */
  readonly keep: boolean;
}

/** 8′-0″, the frame's spread. */
export const DEFAULT_SPREAD = 2.4384;
export const SPREAD_MIN = 0.3048;
export const SPREAD_MAX = 3.9624;
export const DEFAULT_EXPLODE: ExplodeState = { active: false, open: false, apart: false, spread: DEFAULT_SPREAD, labels: true, plumb: true, roofs: true, keep: false };
/** Milliseconds the levels take to come apart, or together. */
export const EXPLODE_MS = 700;

const ROOF_KINDS: ReadonlySet<string> = new Set(['roof', 'roofGable']);

/** The layer a part is lifted with: its level's, or its level's roofs'. */
export const layerOf = (part: { kind: string; level: string }): string => (ROOF_KINDS.has(part.kind) ? `roof:${part.level}` : `level:${part.level}`);

/**
 * The layers from the bottom up: each level, and over it the roofs its walls carry (when roofs are
 * shown) — so a garage's roof lifts off between the ground floor and the floor above, and the main
 * roof off the top.
 */
export function layersOf(levels: readonly { id: string }[], roofed: ReadonlySet<string>, roofs: boolean): Layer[] {
  const out: Layer[] = [];
  for (const l of levels) {
    out.push({ key: `level:${l.id}`, level: l.id, roof: false });
    if (roofs && roofed.has(l.id)) out.push({ key: `roof:${l.id}`, level: l.id, roof: true });
  }
  return out;
}

/** Each layer's lift when fully apart, metres: the k-th from the bottom by k spreads. */
export const layerLifts = (layers: readonly Layer[], spread: number): Map<string, number> => new Map(layers.map((l, k) => [l.key, k * spread]));

/** The animation's curve: eased in and out (cubic). */
export const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/**
 * How far apart (0 together, 1 apart) the layers are at `now`, moving from `from` towards `to` since
 * `start` over `ms`; at once under reduced motion.
 */
export function progressAt(from: number, to: number, start: number, now: number, ms: number, reduced: boolean): number {
  if (reduced || ms <= 0) return to;
  const t = Math.min(1, Math.max(0, (now - start) / ms));
  return from + (to - from) * ease(t);
}

/**
 * The levels a box's height takes in, for the exploded view of what the box keeps: those whose band
 * of height meets it. (Its upright faces still cut: lifting a level moves it along them.)
 */
export function levelsKept(levels: readonly { id: string; bottom: number; top: number }[], box: Box): Set<string> {
  return new Set(levels.filter((l) => l.top > box.min[2] && l.bottom < box.max[2]).map((l) => l.id));
}

/** The upright planes of a section: what still cuts once its levels are lifted apart. */
export const uprightPlanes = (planes: readonly ClipPlane[]): ClipPlane[] => planes.filter((p) => FACE_AXIS[p.face].axis !== 2);
