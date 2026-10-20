/**
 * Exterior lighting (FLR-T-15.5): the electrical assistant's proposal for the grounds — path lights
 * along the walks and the drive, a step light on each riser of exterior steps, a wall-washer beside
 * each entry that has no light, a low-voltage landscape transformer fed from the panel, the
 * photocell-and-timer that switches them, and an "Evening exterior" lighting scene — as one batch a
 * person reviews as a changeset (FLR-ADR-016). Nothing is written here.
 *
 * Advisory: its spacing is Floorspec's own round defaults (`EXTERIOR_DEFAULTS`), each configurable,
 * and it says so; it checks no code and never says a design meets one (FLR-ADR-011). The kinds of
 * exterior light and their beams are the application's catalogue (`@floorspec/render2d/exterior`,
 * FLR-ADR-062), recorded on FS_electrical's `exterior` lights; their lumens and colour on FS_lighting.
 *
 * A landscape transformer is recorded as FS_electrical has it: a panel that supplies 12 V, fed by a
 * 120 V circuit of the main panel (FS_electrical 3.4) — its taps are the 12 V circuits.
 *
 * Deterministic: walks, doors and stairs in ID order, positions on a 1" grid, rotations in whole
 * degrees, no clock and no randomness.
 */
import type { FloorspecDocument } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { migrationBatch } from '@floorspec/migrate';
import { EXTERIOR_DEFS, exteriorMembers, exteriorOf, type ExteriorKind } from '@floorspec/render2d/exterior';
import { insideRoom, readPlan, usedIds, type PlanReading } from './plan.js';
import { holesIn, lengthText, list, workingSpace, type ElectricalProposal, type ProposedCircuit } from './propose.js';
import { withDefaults } from './defaults.js';

type Json = Record<string, unknown>;
type Pt = readonly [number, number];

const IN = 32_512;
const FT = 12 * IN;

export interface ExteriorDefaults {
  /** Path lights along a walk this far apart, alternating sides. */
  walkSpacing: number;
  /** Along a drive this far apart, on its house side only. */
  driveSpacing: number;
  /** A path light stands this far off the walk's edge. */
  setback: number;
  /** An entry is lit when an exterior light is within this of its door; else a wall-washer goes beside it. */
  entryReach: number;
  /** From the door's latch jamb to the wall-washer's middle. */
  besideDoor: number;
  /** The landscape lamps' voltage: a transformer's secondary. */
  volts: number;
  /** A transformer: its rating, amperes at `volts` (12 V × 25 A: 300 W), and its taps. */
  transformerRating: number;
  transformerTaps: number;
  /** A tap's fuse, amperes; a tap is filled to `loadFraction` of it, and to at most `maxPerCircuit` lamps. */
  tapBreaker: number;
  loadFraction: number;
  maxPerCircuit: number;
  /** The 120 V circuit that feeds the transformer from the panel: its breaker, GFCI at the breaker. */
  feedBreaker: number;
  /** The lamps' colour temperature, kelvin. */
  cct: number;
  /** The lighting scene that turns the grounds' lights on. */
  sceneName: string;
  /** Slab purposes (Core 6.7) that are walks, and those that are drives. */
  walkPurposes: readonly string[];
  drivePurposes: readonly string[];
  /** FS_landscape hardscape forms that are walks. */
  walkForms: readonly string[];
}

export const EXTERIOR_DEFAULTS: ExteriorDefaults = Object.freeze({
  walkSpacing: 8 * FT,
  driveSpacing: 10 * FT,
  setback: 12 * IN,
  entryReach: 6 * FT,
  besideDoor: 9 * IN,
  volts: 12,
  transformerRating: 25,
  transformerTaps: 4,
  tapBreaker: 15,
  loadFraction: 0.8,
  maxPerCircuit: 16,
  feedBreaker: 15,
  cct: 2700,
  sceneName: 'Evening exterior',
  walkPurposes: Object.freeze(['walkway']),
  drivePurposes: Object.freeze(['driveway']),
  walkForms: Object.freeze(['path', 'steppingStones']),
});

export function withExteriorDefaults(overrides: Partial<ExteriorDefaults> = {}): ExteriorDefaults {
  const out = { ...EXTERIOR_DEFAULTS, ...overrides };
  for (const k of ['walkSpacing', 'driveSpacing', 'entryReach', 'volts', 'transformerRating', 'transformerTaps', 'tapBreaker', 'maxPerCircuit', 'feedBreaker', 'cct'] as const)
    if (!Number.isSafeInteger(out[k]) || out[k] <= 0) throw new RangeError(`${k} must be a whole number greater than zero`);
  for (const k of ['setback', 'besideDoor'] as const) if (!Number.isSafeInteger(out[k]) || out[k] < 0) throw new RangeError(`${k} must be a whole number, zero or more`);
  if (!(out.loadFraction > 0 && out.loadFraction <= 1)) throw new RangeError('loadFraction must be more than 0 and at most 1');
  if (out.cct < 1000 || out.cct > 10000) throw new RangeError('cct must be between 1000 and 10000 kelvin');
  return out;
}

/** A walk or a drive: its centre line in plan, its half-width, and how it is lit. */
export interface Walk {
  /** The slab or hardscape element it is. */
  id: string;
  name: string;
  kind: 'walk' | 'drive';
  level: string;
  line: Pt[];
  halfWidth: number;
  /** For a drive, the side its lights go on: +1 its left, −1 its right (walking the line). */
  side?: 1 | -1;
}

/** A stretch of a walk no exterior light reaches, before the proposal: drawn on the plan, said on the card. */
export interface DarkStretch {
  walk: string;
  name: string;
  kind: 'walk' | 'drive';
  /** Its ends on the walk's centre line, in plan. */
  from: Pt;
  to: Pt;
  length: number;
}

/** What the proposal adds, by group: the card's list. */
export interface ExteriorGroup {
  kind: ExteriorKind | 'transformer' | 'control' | 'scene';
  /** "front walk", "drive", "entry D3", "steps ST2". */
  where: string;
  count: number;
  /** "8′ apart, both sides". */
  detail: string;
}

export interface ExteriorReading {
  stretches: DarkStretch[];
  groups: ExteriorGroup[];
  /** The transformer proposed, its rating and the load on it; null when there is no panel to feed it. */
  transformer: { id: string; watts: number; used: number } | null;
  scene: { id: string; name: string } | null;
  /** The lamps' connected load, watts. */
  watts: number;
}

export interface ExteriorOptions {
  level?: string;
  retired?: readonly string[];
  defaults?: Partial<ExteriorDefaults>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const sub = (a: Pt, b: Pt): [number, number] => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt): number => Math.sqrt(v[0] * v[0] + v[1] * v[1]);
const grid = (v: number): number => Math.round(v / IN) * IN;

/** A direction as a Core angle in whole degrees, microdegrees, in (−180°, 180°]. */
function angleOf(v: Pt): number {
  const deg = Math.round((Math.atan2(v[1], v[0]) * 180) / Math.PI);
  return (deg === -180 ? 180 : deg) * 1_000_000;
}

/** Point in polygon (even-odd), for a check that a lamp is on the ground and not on paving. */
function inPolygon(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** A slab's centre line: along its longest edge's direction, through the middle of its width. */
function slabLine(ring: readonly Pt[]): { line: Pt[]; halfWidth: number } | null {
  let best: [number, number] | null = null;
  let most = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = sub(ring[(i + 1) % ring.length]!, ring[i]!);
    const l = len(d);
    if (l > most) {
      most = l;
      best = [d[0] / l, d[1] / l];
    }
  }
  if (best === null) return null;
  const u = best;
  const v: Pt = [-u[1], u[0]];
  const along = ring.map((p) => p[0] * u[0] + p[1] * u[1]);
  const across = ring.map((p) => p[0] * v[0] + p[1] * v[1]);
  const [a0, a1] = [Math.min(...along), Math.max(...along)];
  const [b0, b1] = [Math.min(...across), Math.max(...across)];
  const mid = (b0 + b1) / 2;
  const at = (a: number): Pt => [a * u[0] + mid * v[0], a * u[1] + mid * v[1]];
  return { line: [at(a0), at(a1)], halfWidth: (b1 - b0) / 2 };
}

/** What a reading of the walks needs: the document and what the engine derived of it (a PlanReading has both). */
export type WalkSource = Pick<PlanReading, 'document' | 'derived'>;

/** The walks and drives of a level: Core slabs by purpose, FS_landscape hardscape by form. */
export function walksOf(plan: WalkSource, d: ExteriorDefaults = EXTERIOR_DEFAULTS, level?: string): Walk[] {
  const doc = plan.document;
  const out: Walk[] = [];
  const house = houseCentre(plan, level);
  for (const [id, slab] of Object.entries((doc.slabs ?? {}) as unknown as Record<string, Json>).sort(([a], [b]) => cmp(a, b))) {
    const purpose = typeof slab['purpose'] === 'string' ? slab['purpose'] : '';
    const kind = d.walkPurposes.includes(purpose) ? 'walk' : d.drivePurposes.includes(purpose) ? 'drive' : null;
    const lvl = String(slab['level']);
    if (kind === null || (level !== undefined && lvl !== level)) continue;
    const ring = (plan.derived.slabs?.[id]?.outline ?? (slab['boundary'] as Pt[] | undefined) ?? []);
    const sl = ring.length >= 3 ? slabLine(ring) : null;
    if (sl === null) continue;
    const walk: Walk = { id, name: typeof slab['name'] === 'string' ? slab['name'].toLowerCase() : kind, kind, level: lvl, line: sl.line, halfWidth: sl.halfWidth };
    if (kind === 'drive' && house !== null) {
      const [a, b] = [sl.line[0]!, sl.line[1]!];
      const cross = (b[0] - a[0]) * (house[1] - a[1]) - (b[1] - a[1]) * (house[0] - a[0]);
      walk.side = cross >= 0 ? 1 : -1;
    }
    out.push(walk);
  }
  const landscape = (doc.extensions as Json | undefined)?.['FS_landscape'];
  const hardscape = isObject(landscape) && isObject(landscape['collections']) ? landscape['collections']['hardscape'] : undefined;
  if (isObject(hardscape))
    for (const [id, el] of Object.entries(hardscape).sort(([a], [b]) => cmp(a, b))) {
      if (!isObject(el) || !d.walkForms.includes(String(el['form']))) continue;
      const lvl = (el['fallback'] as Json | undefined)?.['level'];
      if (typeof lvl !== 'string' || (level !== undefined && lvl !== level)) continue;
      const pl = plan.derived.placements?.[id];
      const rad = ((pl?.facing ?? 0) / 1_000_000) * (Math.PI / 180);
      const [c, s] = [Math.cos(rad), Math.sin(rad)];
      const o: Pt = pl === undefined ? [0, 0] : [pl.point[0], pl.point[1]];
      const pts = Array.isArray(el['points']) ? (el['points'] as Pt[]).map((p): Pt => [o[0] + p[0] * c - p[1] * s, o[1] + p[0] * s + p[1] * c]) : [];
      if (pts.length < 2) continue;
      const width = typeof el['width'] === 'number' ? el['width'] : 0;
      out.push({ id, name: typeof el['name'] === 'string' ? el['name'].toLowerCase() : 'path', kind: 'walk', level: lvl, line: pts, halfWidth: width / 2 });
    }
  return out;
}

/** The middle of the house's rooms on a level: which side of a drive the house is on. */
function houseCentre(plan: WalkSource, level?: string): Pt | null {
  const pts: Pt[] = [];
  for (const [rid, r] of Object.entries(plan.derived.rooms)) {
    if (level !== undefined && plan.document.rooms?.[rid]?.level !== level) continue;
    pts.push(...r.outer);
  }
  if (pts.length === 0) return null;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

/** A polyline's length, and the point and unit direction at a distance along it. */
function along(line: readonly Pt[]): { total: number; at: (t: number) => { p: Pt; u: Pt } } {
  const segs = line.slice(1).map((b, i) => ({ a: line[i]!, d: sub(b, line[i]!), l: len(sub(b, line[i]!)) }));
  const total = segs.reduce((a, s) => a + s.l, 0);
  return {
    total,
    at: (t) => {
      let rest = t;
      for (const s of segs) {
        if (rest <= s.l || s === segs[segs.length - 1]) {
          const u: Pt = s.l === 0 ? [1, 0] : [s.d[0] / s.l, s.d[1] / s.l];
          const k = s.l === 0 ? 0 : Math.min(rest, s.l) / s.l;
          return { p: [s.a[0] + s.d[0] * k, s.a[1] + s.d[1] * k], u };
        }
        rest -= s.l;
      }
      return { p: line[0]!, u: [1, 0] };
    },
  };
}

/** An exterior light already placed: its kind (or none, a lantern) and where it is in plan. */
interface Placed {
  id: string;
  kind: ExteriorKind | null;
  level: string;
  at: Pt;
}

/** The FS_electrical exterior lights a plan has. */
function exteriorLights(plan: PlanReading): Placed[] {
  const lights = (plan.document.extensions as Json | undefined)?.['FS_electrical'];
  const coll = isObject(lights) && isObject(lights['collections']) && isObject(lights['collections']['lights']) ? lights['collections']['lights'] : {};
  const out: Placed[] = [];
  for (const [id, el] of Object.entries(coll).sort(([a], [b]) => cmp(a, b))) {
    if (!isObject(el) || el['fixture'] !== 'exterior') continue;
    const pl = plan.derived.placements?.[id];
    const fb = plan.derived.fallbacks?.[id];
    if (pl === undefined || fb === undefined) continue;
    out.push({ id, kind: exteriorOf(el)?.kind ?? null, level: fb.level, at: [pl.point[0], pl.point[1]] });
  }
  return out;
}

/** A host reference (Ops 0.2 4.10). */
type HostRef = Json;

/**
 * The exterior lighting a plan's grounds could have (FLR-T-15.5): see the module's note. Returns the
 * same proposal shape as `proposeElectrical`, its `exterior` member saying what it found and adds.
 */
export function proposeExterior(document: string | Uint8Array | FloorspecDocument | object, options: ExteriorOptions = {}): ElectricalProposal & { exterior: ExteriorReading } {
  const d = withExteriorDefaults(options.defaults);
  const plan = readPlan(document, { level: options.level, grid: IN });
  const doc = plan.document;
  const taken = new Set([...usedIds(doc), ...(options.retired ?? [])]);
  const mint = (prefix: string): string => {
    for (let n = 1; ; n++) {
      const id = `${prefix}${String(n)}`;
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
  const level = options.level;
  const placed = exteriorLights(plan);
  const placements: Operation[] = [];
  const records: Operation[] = [];
  const notes: string[] = [];
  const groups: ExteriorGroup[] = [];
  const stretches: DarkStretch[] = [];
  const lights: { id: string; kind: ExteriorKind; group: 'walk' | 'drive' }[] = [];

  // Where a lamp may stand: on the ground — in no room, on no slab, not on a walk — of its level.
  const roomsOn = (lvl: string) => Object.entries(plan.derived.rooms).filter(([rid]) => doc.rooms?.[rid]?.level === lvl).map(([, r]) => r);
  const slabsOn = (lvl: string) => Object.entries(plan.derived.slabs ?? {}).filter(([sid]) => (doc.slabs as Record<string, { level?: string }> | undefined)?.[sid]?.level === lvl).map(([, s]) => s.outline as Pt[]);
  const onGround = (p: Pt, lvl: string): boolean => {
    const q: [number, number] = [Math.round(p[0]), Math.round(p[1])];
    if (roomsOn(lvl).some((r) => insideRoom(q, r.outer, r.holes))) return false;
    return !slabsOn(lvl).some((ring) => inPolygon(q, ring));
  };

  const place = (kind: ExteriorKind, host: HostRef, box?: Json, patch: { beam?: number; reach?: number } = {}): string => {
    const id = mint('X');
    const def = EXTERIOR_DEFS[kind];
    placements.push({
      op: 'placeElement',
      extension: 'FS_electrical',
      collection: 'lights',
      id,
      host,
      element: { fallback: { box: box ?? structuredClone(def.box) }, ...exteriorMembers(kind, patch) },
    } as unknown as Operation);
    return id;
  };

  // ── Walks and the drive: path lights, alternating sides along a walk, the house side of a drive ──
  for (const walk of walksOf(plan, d, level)) {
    const spacing = walk.kind === 'drive' ? d.driveSpacing : d.walkSpacing;
    const path = along(walk.line);
    if (path.total < spacing / 2) continue;
    // What the lights already there reach: a light within its setback and a little of the walk's
    // edge, along it, covers half the spacing either side.
    const reach = walk.halfWidth + d.setback + 2 * FT;
    const covered: [number, number][] = [];
    for (const l of placed) {
      if (l.level !== walk.level || (l.kind !== 'path' && l.kind !== 'step')) continue;
      let best: { t: number; dist: number } | null = null;
      for (let t = 0; t <= path.total; t += IN * 6) {
        const { p } = path.at(t);
        const dist = len(sub(l.at, p));
        if (best === null || dist < best.dist) best = { t, dist };
      }
      if (best !== null && best.dist <= reach) covered.push([best.t - spacing / 2, best.t + spacing / 2]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    // The dark stretches: the walk less what is covered.
    let from = 0;
    const dark: [number, number][] = [];
    for (const [a, b] of covered) {
      if (a > from) dark.push([from, Math.min(a, path.total)]);
      from = Math.max(from, b);
    }
    if (from < path.total) dark.push([from, path.total]);
    const mine = dark.filter(([a, b]) => b - a >= spacing / 2);
    for (const [a, b] of mine) stretches.push({ walk: walk.id, name: walk.name, kind: walk.kind, from: roundPt(path.at(a).p), to: roundPt(path.at(b).p), length: Math.round(b - a) });
    let count = 0;
    for (const [a, b] of mine) {
      const n = Math.max(1, Math.round((b - a) / spacing));
      const step = (b - a) / n;
      for (let k = 0; k < n; k++) {
        const t = a + step * (k + 0.5);
        const { p, u } = path.at(t);
        const n0: Pt = [-u[1], u[0]];
        // A drive's house side; a walk's sides in turn, by where the lamp falls along the whole walk.
        const prefer = walk.kind === 'drive' ? (walk.side ?? 1) : Math.floor(t / spacing) % 2 === 0 ? 1 : -1;
        const off = walk.halfWidth + d.setback;
        let spot: Pt | null = null;
        let side: 1 | -1 = prefer;
        for (const s of walk.kind === 'drive' ? [prefer] : [prefer, -prefer as 1 | -1]) {
          const q: Pt = [grid(p[0] + n0[0] * off * s), grid(p[1] + n0[1] * off * s)];
          if (onGround(q, walk.level)) {
            spot = q;
            side = s;
            break;
          }
        }
        if (spot === null) continue;
        const facing = angleOf([-n0[0] * side, -n0[1] * side]);
        const id = place('path', { mode: 'free', level: walk.level, at: [spot[0], spot[1]], ...(facing === 0 ? {} : { rotation: facing }) });
        lights.push({ id, kind: 'path', group: walk.kind });
        count++;
      }
    }
    if (count > 0) groups.push({ kind: 'path', where: walk.name, count, detail: `${lengthText(doc, spacing)} apart, ${walk.kind === 'drive' ? 'house side' : 'alternating sides'}` });
  }

  // ── Entries: a wall-washer beside each exterior door no light is near ──
  const sides = new Map<string, Set<string>>();
  for (const room of plan.rooms) for (const e of room.entries) if (e.hinge !== null) sides.set(e.opening, new Set([...(sides.get(e.opening) ?? []), `${e.wall}/${e.side}`]));
  const seen = new Set<string>();
  const cramped: string[] = [];
  for (const room of plan.rooms) {
    for (const e of room.entries) {
      if (e.hinge === null || seen.has(e.opening) || (sides.get(e.opening)?.size ?? 0) !== 1) continue;
      seen.add(e.opening);
      const wall = doc.walls?.[e.wall];
      if (wall === undefined) continue;
      const s = doc.junctions![wall.start]!.position as Pt;
      const t = doc.junctions![wall.end]!.position as Pt;
      const L = Math.floor(len(sub(t, s)));
      const u: Pt = [(t[0] - s[0]) / L, (t[1] - s[1]) / L];
      const mid = (e.from + e.to) / 2;
      const door: Pt = [s[0] + u[0] * mid, s[1] + u[1] * mid];
      if (placed.some((l) => l.level === room.level && len(sub(l.at, door)) <= d.entryReach)) continue;
      const outside: 'left' | 'right' = e.side === 'left' ? 'right' : 'left';
      const holes = holesIn(doc, e.wall);
      const half = EXTERIOR_DEFS.wallWash.box.max[1];
      const clear = (at: number) => at - half >= 12 * IN && at + half <= L - 12 * IN && holes.every((h) => at + half <= h.from - 3 * IN || at - half >= h.to + 3 * IN);
      // The latch side first: away from the hinge.
      const candidates = e.hinge === 'start' ? [e.to + d.besideDoor + half, e.from - d.besideDoor - half] : [e.from - d.besideDoor - half, e.to + d.besideDoor + half];
      const at = candidates.map((c) => Math.round(c)).find(clear);
      if (at === undefined) {
        cramped.push(e.opening);
        continue;
      }
      const height = Math.min(EXTERIOR_DEFS.wallWash.height ?? 6 * FT, (plan.derived.walls[e.wall]?.topElevation ?? Infinity) - (plan.derived.walls[e.wall]?.baseElevation ?? 0) - 6 * IN);
      const id = place('wallWash', { mode: 'wallFace', wall: e.wall, side: outside, at, height });
      lights.push({ id, kind: 'wallWash', group: 'walk' });
      groups.push({ kind: 'wallWash', where: `entry ${e.opening}`, count: 1, detail: `beside the door, ${lengthText(doc, height)} up` });
    }
  }

  if (cramped.length > 0) notes.push(`${cramped.length === 1 ? `The entry at ${cramped[0] ?? ''} has` : `The entries at ${list(cramped)} have`} no clear wall beside the door for a wall-washer: light ${cramped.length === 1 ? 'it' : 'them'} by hand if ${cramped.length === 1 ? 'it needs' : 'they need'} it.`);

  // ── Exterior steps: a step light on each riser of a stair that stands outside every room ──
  for (const [sid, st] of Object.entries(plan.derived.stairs ?? {}).sort(([a], [b]) => cmp(a, b))) {
    if (st.footRoom !== undefined || st.headRoom !== undefined || st.steps === undefined) continue;
    const stair = (doc.stairs as Record<string, { level?: string; name?: string }> | undefined)?.[sid];
    const lvl = stair?.level;
    if (lvl === undefined || (level !== undefined && lvl !== level)) continue;
    const elevation = (doc.levels as Record<string, { elevation?: number }> | undefined)?.[lvl]?.elevation ?? 0;
    const down = sub(st.foot, st.head);
    const dl = len(down) || 1;
    const dir: Pt = [down[0] / dl, down[1] / dl];
    let count = 0;
    let below = st.bottom;
    for (const step of st.steps) {
      if (step.landing === true) {
        below = step.top;
        continue;
      }
      const c: Pt = [step.outline.reduce((a, p) => a + p[0], 0) / step.outline.length, step.outline.reduce((a, p) => a + p[1], 0) / step.outline.length];
      const going = Math.max(...step.outline.map((p) => p[0] * dir[0] + p[1] * dir[1])) - (c[0] * dir[0] + c[1] * dir[1]);
      const at: Pt = [grid(c[0] + dir[0] * going), grid(c[1] + dir[1] * going)];
      const z = below - elevation;
      const b = EXTERIOR_DEFS.step.box;
      const box = { min: [-b.max[0], b.min[1], z + b.min[2]], max: [0, b.max[1], z + b.max[2]] };
      const facing = angleOf(dir);
      const id = place('step', { mode: 'free', level: lvl, at: [at[0], at[1]], ...(facing === 0 ? {} : { rotation: facing }) }, box);
      lights.push({ id, kind: 'step', group: 'walk' });
      count++;
      below = step.top;
    }
    if (count > 0) groups.push({ kind: 'step', where: (stair?.name ?? sid).toLowerCase(), count, detail: 'one per riser' });
  }

  // ── The transformer, its control, its circuits ──
  const electrical = (doc.extensions as Json | undefined)?.['FS_electrical'];
  const collections = (isObject(electrical) && isObject(electrical['collections']) ? electrical['collections'] : {}) as Record<string, Record<string, Json> | undefined>;
  const existingCircuits = (isObject(electrical) && isObject(electrical['circuits']) ? electrical['circuits'] : {}) as Record<string, Json>;
  const panels = Object.entries(collections['panels'] ?? {}).filter(([, p]) => Array.isArray(p['volts']) && (p['volts'] as number[]).includes(120)).sort(([a], [b]) => cmp(a, b));
  const main = panels[0];
  const circuits: ProposedCircuit[] = [];
  const added = { receptacles: [] as string[], switches: [] as string[], lights: lights.map((l) => l.id), panels: [] as string[] };
  let transformer: ExteriorReading['transformer'] = null;
  const watts = lights.reduce((a, l) => a + EXTERIOR_DEFS[l.kind].watts, 0);
  if (lights.length > 0 && main === undefined) notes.push('There is no panel to feed a landscape transformer from: the lights are proposed without one. Place a panel and ask again for the transformer and its circuits.');
  if (lights.length > 0 && main !== undefined) {
    const spot = transformerAt(plan, main[0], level);
    if (spot === null) notes.push('No exterior wall has room for a landscape transformer: the lights are proposed without one.');
    else {
      const feed = mint('C');
      const tid = mint('X');
      const capacity = d.transformerRating * d.volts;
      const box = { min: [0, -162_560, -195_072], max: [130_048, 162_560, 195_072] };
      placements.push({
        op: 'placeElement',
        extension: 'FS_electrical',
        collection: 'panels',
        id: tid,
        host: { mode: 'wallFace', wall: spot.wall, side: spot.side, at: spot.offset, height: 2 * FT },
        element: { fallback: { box }, volts: [d.volts], rating: d.transformerRating, spaces: d.transformerTaps, fedBy: feed, name: `Landscape transformer · ${String(capacity)} W`, clearances: { working: workingSpace(2 * FT) } },
      } as unknown as Operation);
      added.panels.push(tid);
      transformer = { id: tid, watts: capacity, used: watts };
      groups.push({ kind: 'transformer', where: spot.where, count: 1, detail: `${String(capacity)} W, ${String(d.volts)} V` });
      // The feed: a 120 V circuit of the main panel, GFCI at the breaker, in its next free space.
      const usedSpaces = new Set<number>();
      for (const c of Object.values(existingCircuits)) {
        if (c['panel'] !== main[0] || typeof c['space'] !== 'number') continue;
        for (let k = c['space']; k < c['space'] + (typeof c['poles'] === 'number' ? c['poles'] : 1); k++) usedSpaces.add(k);
      }
      const spaces = Number(main[1]['spaces'] ?? 0);
      let space: number | undefined;
      for (let k = 1; k <= spaces; k++) if (!usedSpaces.has(k)) {
        space = k;
        break;
      }
      records.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_electrical/circuits/${feed}`, value: { panel: main[0], breaker: d.feedBreaker, volts: 120, protection: ['gfci'], ...(space === undefined ? {} : { space }), name: 'Landscape transformer feed' } });
      circuits.push({ id: feed, name: 'Landscape transformer feed', panel: main[0], breaker: d.feedBreaker, loads: [], protection: ['gfci'], estimatedLoad: watts });
      // The taps: the walk's lamps, then the drive's, each filled to its share of a tap.
      const tapCap = Math.floor(d.tapBreaker * d.volts * d.loadFraction);
      let tap = 0;
      for (const group of ['walk', 'drive'] as const) {
        let loads: string[] = [];
        let load = 0;
        const flush = () => {
          if (loads.length === 0) return;
          tap++;
          const id = mint('C');
          const name = `LV-${String(tap)} · ${group === 'walk' ? 'walks and entries' : 'drive'}`;
          records.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_electrical/circuits/${id}`, value: { panel: tid, breaker: d.tapBreaker, volts: d.volts, ...(tap <= d.transformerTaps ? { space: tap } : {}), loads, name } });
          circuits.push({ id, name, panel: tid, breaker: d.tapBreaker, loads, protection: [], estimatedLoad: load });
          loads = [];
          load = 0;
        };
        for (const l of lights.filter((x) => x.group === group)) {
          const w = EXTERIOR_DEFS[l.kind].watts;
          if (loads.length > 0 && (load + w > tapCap || loads.length >= d.maxPerCircuit)) flush();
          loads.push(l.id);
          load += w;
        }
        flush();
      }
      if (tap > d.transformerTaps) notes.push(`The transformer has ${String(d.transformerTaps)} taps and ${String(tap)} circuits are proposed: the rest have no tap assigned.`);
      if (watts > capacity * d.loadFraction) notes.push(`The lamps draw ${String(watts)} W, over ${String(Math.round(d.loadFraction * 100))}% of the transformer's ${String(capacity)} W: split them over a second one.`);
      // The control: a photocell and timer beside the transformer, switching every lamp proposed.
      const sw = mint('X');
      placements.push({
        op: 'placeElement',
        extension: 'FS_electrical',
        collection: 'switches',
        id: sw,
        host: { mode: 'wallFace', wall: spot.wall, side: spot.side, at: spot.switchAt, height: 4 * FT },
        element: { fallback: { box: { min: [0, -51_200, -76_800], max: [32_000, 51_200, 76_800] } }, control: 'timer', controls: lights.map((l) => l.id), name: 'Photocell + timer' },
      } as unknown as Operation);
      added.switches.push(sw);
      groups.push({ kind: 'control', where: spot.where, count: 1, detail: 'photocell + timer, dusk to 11 pm' });
    }
  }

  // ── FS_lighting: each lamp's lumens and colour, and the scene that turns the grounds on ──
  let scene: ExteriorReading['scene'] = null;
  const lightingOps: Operation[] = [];
  if (lights.length > 0) {
    for (const l of lights) {
      const def = EXTERIOR_DEFS[l.kind];
      lightingOps.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/luminaires/${l.id}`, value: { lumens: def.lumens, cct: d.cct, dimmable: true } });
    }
    const data = (doc.extensions as Json | undefined)?.['FS_lighting'];
    const scenes = isObject(data) && isObject(data['scenes']) ? data['scenes'] : {};
    const existing = Object.entries(scenes).find(([, s]) => isObject(s) && typeof s['name'] === 'string' && s['name'].toLowerCase() === d.sceneName.toLowerCase());
    if (existing !== undefined) {
      for (const l of lights) lightingOps.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${existing[0]}/on/${l.id}`, value: {} });
      scene = { id: existing[0], name: String((existing[1] as Json)['name']) };
    } else {
      // A new scene: every exterior light of the level on — the lanterns already there and the lamps proposed.
      const sid = mintScene(taken, scenes);
      const on: Json = {};
      for (const id of [...placed.filter((p) => level === undefined || p.level === level).map((p) => p.id), ...lights.map((l) => l.id)].sort(cmp)) on[id] = {};
      lightingOps.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${sid}`, value: { name: d.sceneName, on } });
      scene = { id: sid, name: d.sceneName };
    }
    groups.push({ kind: 'scene', where: scene.name, count: 1, detail: existing === undefined ? 'every exterior light on' : 'the new lamps added to it' });
  }

  // Declarations first: Core 0.3 at least, FS_electrical and FS_lighting declared.
  const batch: Operation[] = [];
  if (placements.length + records.length > 0) {
    if (doc.floorspec === '0.1') batch.push(...migrationBatch(doc, '0.3'));
    const used = (doc.extensionsUsed ?? {}) as Json;
    if (!Object.hasOwn(used, 'FS_electrical')) batch.push({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' });
    if (!Object.hasOwn(used, 'FS_lighting')) batch.push({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_lighting', value: '0.1.0' });
  }
  batch.push(...placements, ...records, ...lightingOps);

  const walkNames = [...new Set(stretches.map((s) => s.name))];
  const counts = (k: ExteriorKind) => lights.filter((l) => l.kind === k).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;
  const parts = [
    counts('path') > 0 && plural(counts('path'), 'path light'),
    counts('step') > 0 && plural(counts('step'), 'step light'),
    counts('wallWash') > 0 && plural(counts('wallWash'), 'wall-washer'),
    transformer !== null && `a ${String(transformer.watts)} W landscape transformer with its photocell and timer`,
    circuits.length > 1 && plural(circuits.length - 1, 'landscape circuit'),
    scene !== null && `the scene “${scene.name}”`,
  ].filter((x): x is string => typeof x === 'string');
  const explanation = [
    lights.length === 0
      ? 'Nothing to add: every walk and entry already has a light within Floorspec’s spacing defaults.'
      : `Dark after dusk: ${walkNames.length === 0 ? 'the entries' : list(walkNames)}. Proposes ${list(parts)}.`,
    `From Floorspec’s spacing defaults, each configurable: path lights ${lengthText(doc, d.walkSpacing)} apart along a walk on alternating sides and ${lengthText(doc, d.driveSpacing)} apart along a drive on its house side, ${lengthText(doc, d.setback)} off the edge; a step light on each riser of exterior steps; a wall-washer beside each exterior door with no light within ${lengthText(doc, d.entryReach)}; ${String(d.volts)} V lamps at ${String(d.cct)} K on taps filled to ${String(Math.round(d.loadFraction * 100))}% of ${String(d.tapBreaker)} A.`,
    'These are spacing defaults, not a code check, and no code is checked or cited. The beams on the plan are a picture of where each fixture’s light lands, not a lighting calculation.',
    ...notes,
  ];
  return {
    batch,
    name: walkNames.length === 0 ? 'Exterior lighting' : `Exterior lighting: ${list(walkNames)}`.slice(0, 120),
    explanation,
    added,
    circuits,
    upgraded: [],
    gaps: [],
    rooms: [],
    notes,
    defaults: withDefaults(),
    exterior: { stretches, groups, transformer, scene, watts },
  };
}

const roundPt = (p: Pt): [number, number] => [Math.round(p[0]), Math.round(p[1])];

/** The next free scene ID, `LS<n>`. */
function mintScene(taken: Set<string>, scenes: Json): string {
  for (let n = 1; ; n++) {
    const id = `LS${String(n)}`;
    if (!taken.has(id) && !Object.hasOwn(scenes, id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Where the transformer goes: on the outside face of the exterior wall nearest the main panel — a
 * wall a room is on one side of only — in the clear stretch nearest the panel, 2' up, its control
 * 16" along. Null when no exterior wall has 4' clear.
 */
function transformerAt(plan: PlanReading, panel: string, level?: string): { wall: string; side: 'left' | 'right'; offset: number; switchAt: number; where: string } | null {
  const doc = plan.document;
  const from = plan.derived.placements?.[panel];
  const faces = new Map<string, Set<'left' | 'right'>>();
  for (const room of plan.rooms) for (const r of room.runs) faces.set(r.wall, new Set([...(faces.get(r.wall) ?? []), r.side]));
  const candidates: { wall: string; side: 'left' | 'right'; offset: number; switchAt: number; dist: number; where: string }[] = [];
  for (const [wid, sides] of [...faces.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (sides.size !== 1) continue;
    const wall = doc.walls?.[wid];
    if (wall === undefined || (level !== undefined && wall.level !== level)) continue;
    const roomSide = [...sides][0]!;
    const side: 'left' | 'right' = roomSide === 'left' ? 'right' : 'left';
    const s = doc.junctions![wall.start]!.position as Pt;
    const t = doc.junctions![wall.end]!.position as Pt;
    const L = Math.floor(len(sub(t, s)));
    const holes = holesIn(doc, wid).map((h) => [h.from - 12 * IN, h.to + 12 * IN] as const);
    let lo = 2 * FT;
    const stretchesHere: [number, number][] = [];
    for (const [a, b] of holes) {
      if (a > lo) stretchesHere.push([lo, a]);
      lo = Math.max(lo, b);
    }
    if (L - 2 * FT > lo) stretchesHere.push([lo, L - 2 * FT]);
    const target = from === undefined ? L / 2 : ((from.point[0] - s[0]) * (t[0] - s[0]) + (from.point[1] - s[1]) * (t[1] - s[1])) / L;
    for (const [a, b] of stretchesHere) {
      if (b - a < 4 * FT) continue;
      const offset = grid(Math.min(b - 3 * FT, Math.max(a + 1 * FT, target)));
      const p: Pt = [s[0] + ((t[0] - s[0]) * offset) / L, s[1] + ((t[1] - s[1]) * offset) / L];
      const dist = from === undefined ? 0 : len(sub(p, [from.point[0], from.point[1]]));
      const room = plan.rooms.find((r) => r.runs.some((run) => run.wall === wid));
      candidates.push({ wall: wid, side, offset, switchAt: offset + 16 * IN, dist, where: room === undefined ? `wall ${wid}` : `${room.name.toLowerCase()} wall` });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist || cmp(a.wall, b.wall) || a.offset - b.offset);
  const best = candidates[0];
  return best === undefined ? null : { wall: best.wall, side: best.side, offset: best.offset, switchAt: best.switchAt, where: best.where };
}
