/**
 * FS_outdoor 0.1.0 (registry/FS_outdoor/spec.md): outdoor rooms — pools and spas with their coping
 * and water, fences and garden walls drawn as lines with gates along them, shelters (pergolas, covered
 * porches, shade sails) whose posts are derived from their box, outdoor kitchens and fire features
 * (FLR-ADR-063). Each is placed like furniture; a fence is drawn like a wall.
 *
 * Besides the extension's rules, this module gives what a reader draws from (spec.md chapter 4,
 * informative): where a shelter's posts and a fence's posts stand, a pool's basin and water — the
 * mesh, the plan and the editor all read them here, so they agree with what is derived.
 */
import { validate as validateSchema } from '../../generated/validate-FS_outdoor.js';
import type * as G from '../../generated/types-FS_outdoor.js';
import { isqrt, roundHalfEvenRational, toSafeNumber } from '../../exact/bigint.js';
import { get } from '../../model/document.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type OutdoorData = G.FSOutdoor010;
export type Pool = Element<G.Pool>;
export type Fence = Element<G.Fence>;
export type Gate = G.Gate;
export type Shelter = Element<G.Shelter>;
export type Kitchen = Element<G.Kitchen>;
export type Fire = Element<G.FireFeature>;
export type OutdoorElement = Pool | Fence | Shelter | Kitchen | Fire;

/** The kinds (collections) of FS_outdoor (chapter 2). */
export const OUTDOOR_KINDS = ['pools', 'fences', 'shelters', 'kitchens', 'fires'] as const;
export type OutdoorKind = (typeof OUTDOOR_KINDS)[number];
/** 3.2.1: the kinds whose elements always have a host — every one but a fence. */
export const BOXED_KINDS: readonly OutdoorKind[] = ['pools', 'shelters', 'kitchens', 'fires'];

/** Chapter 2's defaults, base units. */
export const DEFAULTS = {
  coping: 384_000,
  waterLine: 192_000,
  fencePostSpacing: 3_072_000,
  postSize: 192_000,
  postSpacing: 3_072_000,
  rafterSpacing: 768_000,
} as const;

/** 6.2: what FS_outdoor derives for one pool. */
export interface DerivedPool {
  form: G.Pool['form'];
  basin: [number, number];
  depth: number;
  area: string;
  volume: string;
  room?: string;
}
/** 6.3: for one fence. */
export interface DerivedFence {
  form: G.Fence['form'];
  length: number;
  posts: number;
  gates: [number, number][];
}
/** 6.4: for one shelter. */
export interface DerivedShelter {
  top: NonNullable<G.Shelter['top']>;
  bays: [number, number];
  spacing: [number, number];
  posts: number;
  room?: string;
}
/** Chapter 6: what FS_outdoor derives. */
export interface DerivedOutdoor {
  pools: Record<string, DerivedPool>;
  fences: Record<string, DerivedFence>;
  shelters: Record<string, DerivedShelter>;
  kitchens: Record<string, { run: number; appliances: string[]; room?: string }>;
  fires: Record<string, { form: G.FireFeature['form']; room?: string }>;
}

type Box = { min: readonly number[]; max: readonly number[] };
const boxOf = (el: { fallback: { box: Box } }): Box => el.fallback.box;

/** 2.1: a box's extents X, Y and Z. */
export function extents(box: Box): [number, number, number] {
  return [box.max[0]! - box.min[0]!, box.max[1]! - box.min[1]!, box.max[2]! - box.min[2]!];
}

/** round(√n) for n ≥ 0: never a tie, since (k + ½)² is never an integer. */
function roundSqrt(n: bigint): bigint {
  const k = isqrt(n);
  return n - k * k > k ? k + 1n : k;
}

/** 6.3: each segment's length, rounded once. */
export function segmentLengths(points: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = BigInt(points[i + 1]![0] - points[i]![0]);
    const dy = BigInt(points[i + 1]![1] - points[i]![1]);
    out.push(toSafeNumber(roundSqrt(dx * dx + dy * dy)));
  }
  return out;
}

/** 6.3: a fence's length, the sum of its segments' rounded lengths. */
export const fenceLength = (points: readonly (readonly [number, number])[]): number => segmentLengths(points).reduce((a, b) => a + b, 0);

const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);
const repeats = (pts: readonly (readonly number[])[]): boolean => pts.some((p, i) => i + 1 < pts.length && p[0] === pts[i + 1]![0] && p[1] === pts[i + 1]![1]);

/** 6.3: a fence's gates, as sorted intervals along its line. */
export function gateIntervals(gates: readonly Gate[] | undefined): [number, number][] {
  return (gates ?? []).map((g): [number, number] => [g.offset, g.offset + g.width]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** 6.3: a fence's posts: one per started spacing along each segment, plus one — less one when the line closes. */
export function fencePostCount(points: readonly (readonly [number, number])[], spacing: number = DEFAULTS.fencePostSpacing): number {
  const spaces = segmentLengths(points).reduce((a, l) => a + ceilDiv(l, spacing), 0);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return first[0] === last[0] && first[1] === last[1] ? spaces : spaces + 1;
}

/** 6.4: a shelter's bays, spacing (each rounded once, ties to even) and posts. */
export function shelterLayout(el: { fallback: { box: Box }; postSize?: number; postSpacing?: number; attached?: boolean }): { bays: [number, number]; spacing: [number, number]; posts: number } {
  const [X, Y] = extents(boxOf(el));
  const size = el.postSize ?? DEFAULTS.postSize;
  const s = el.postSpacing ?? DEFAULTS.postSpacing;
  const lx = X - size;
  const ly = Y - size;
  const bx = Math.max(1, ceilDiv(lx, s));
  const by = Math.max(1, ceilDiv(ly, s));
  const posts = 2 * (bx + by) - (el.attached === true ? by + 1 : 0);
  return {
    bays: [bx, by],
    spacing: [toSafeNumber(roundHalfEvenRational(BigInt(lx), BigInt(bx))), toSafeNumber(roundHalfEvenRational(BigInt(ly), BigInt(by)))],
    posts,
  };
}

/** 6.2: a pool's basin and its water's depth. */
export function poolWater(el: Pool): { basin: [number, number]; depth: number; coping: number; waterLine: number } {
  const [X, Y, Z] = extents(boxOf(el));
  const coping = el.coping ?? DEFAULTS.coping;
  const waterLine = el.waterLine ?? DEFAULTS.waterLine;
  return { basin: [X - 2 * coping, Y - 2 * coping], depth: Z - waterLine, coping, waterLine };
}

// ─── Drawing (chapter 4, informative) ───────────────────────────────────────────────────────

/**
 * Where a shelter's posts stand, in its box's local units (x from its least x, y from its least y):
 * the centres of a grid of its bays round its perimeter, inset by half a post — the corners, and
 * along each side between them at the derived spacing — less the back's (x least) when attached.
 */
export function shelterPosts(el: { fallback: { box: Box }; postSize?: number; postSpacing?: number; attached?: boolean }): [number, number][] {
  const [X, Y] = extents(boxOf(el));
  const size = el.postSize ?? DEFAULTS.postSize;
  const { bays } = shelterLayout(el);
  const [bx, by] = bays;
  const xs = Array.from({ length: bx + 1 }, (_, i) => size / 2 + ((X - size) * i) / bx);
  const ys = Array.from({ length: by + 1 }, (_, j) => size / 2 + ((Y - size) * j) / by);
  const out: [number, number][] = [];
  for (let i = 0; i <= bx; i++)
    for (let j = 0; j <= by; j++) {
      const edge = i === 0 || i === bx || j === 0 || j === by;
      if (!edge) continue;
      if (el.attached === true && i === 0) continue;
      out.push([xs[i]!, ys[j]!]);
    }
  return out;
}

/** A point at distance `d` along a polyline, and the unit direction of the segment it is on. */
export function alongLine(points: readonly (readonly [number, number])[], d: number): { at: [number, number]; dir: [number, number]; segment: number } {
  const lengths = segmentLengths(points);
  let rest = d;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!;
    const a = points[i]!;
    const b = points[i + 1]!;
    const dir: [number, number] = l === 0 ? [1, 0] : [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    if (rest <= l || i === lengths.length - 1) {
      const t = Math.max(0, Math.min(l, rest));
      return { at: [a[0] + dir[0] * t, a[1] + dir[1] * t], dir, segment: i };
    }
    rest -= l;
  }
  const p = points[0]!;
  return { at: [p[0], p[1]], dir: [1, 0], segment: 0 };
}

/**
 * Where a fence's posts stand, in its frame: each segment's ends and, between them, evenly at most
 * `postSpacing` apart (6.3's count) — a closed line's first post once.
 */
export function fencePosts(points: readonly (readonly [number, number])[], spacing: number = DEFAULTS.fencePostSpacing): [number, number][] {
  const lengths = segmentLengths(points);
  const out: [number, number][] = [[points[0]![0], points[0]![1]]];
  lengths.forEach((l, i) => {
    const a = points[i]!;
    const b = points[i + 1]!;
    const n = Math.max(1, ceilDiv(l, spacing));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  });
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

// ─── The rules ──────────────────────────────────────────────────────────────────────────────

function elements(ctx: ExtensionContext): [OutdoorKind, string, OutdoorElement][] {
  return OUTDOOR_KINDS.flatMap((k) => ctx.coll<OutdoorElement>(k).map(([id, el]): [OutdoorKind, string, OutdoorElement] => [k, id, el]));
}

function invariants(ctx: ExtensionContext): void {
  for (const [kind, id, el] of elements(ctx)) {
    const host = el.host;
    if (host?.mode === 'wallFace' || (host?.mode === 'surface' && host.surface === 'ceiling'))
      ctx.report('FS-OUTD-INV-001', `${id} is hosted on a ${host.mode === 'wallFace' ? 'wall face' : 'ceiling'}: an outdoor room stands on the ground or a floor.`, [id]);
    if (BOXED_KINDS.includes(kind) && host === undefined) ctx.report('FS-OUTD-INV-002', `${id} has no host: its box has no place.`, [id]);
    if (kind === 'pools') {
      const p = el as Pool;
      const [X, Y, Z] = extents(boxOf(p));
      const c = p.coping ?? DEFAULTS.coping;
      if (!(2 * c < X && 2 * c < Y)) ctx.report('FS-OUTD-INV-003', `${id}'s coping leaves no basin.`, [id]);
      if (!((p.waterLine ?? DEFAULTS.waterLine) < Z)) ctx.report('FS-OUTD-INV-004', `${id}'s water line is at or below its floor: no water.`, [id]);
    } else if (kind === 'fences') {
      const f = el as Fence;
      if (repeats(f.points)) {
        ctx.report('FS-OUTD-INV-005', `${id}'s line repeats a point.`, [id]);
        continue;
      }
      const total = fenceLength(f.points);
      const gates = gateIntervals(f.gates);
      if (gates.some(([, b]) => b > total)) ctx.report('FS-OUTD-INV-006', `A gate of ${id} runs past the end of its line.`, [id]);
      if (gates.some((g, i) => i + 1 < gates.length && gates[i + 1]![0] < g[1])) ctx.report('FS-OUTD-INV-007', `Two gates of ${id} overlap.`, [id]);
    } else if (kind === 'shelters') {
      const s = el as Shelter;
      const [X, Y, Z] = extents(boxOf(s));
      const size = s.postSize ?? DEFAULTS.postSize;
      if (!(size < X && size < Y)) ctx.report('FS-OUTD-INV-008', `${id}'s posts are as wide as it is.`, [id]);
      if (!((s.postSpacing ?? DEFAULTS.postSpacing) > size)) ctx.report('FS-OUTD-INV-009', `${id}'s posts are closer than they are wide.`, [id]);
      if (s.clearHeight !== undefined && !(s.clearHeight < Z)) ctx.report('FS-OUTD-INV-010', `${id}'s clear height is not below its top.`, [id]);
    }
  }
}

/** 3.3: a fence's line, grown by half its width, inside its box, horizontally and exactly. */
export function fenceInsideBox(el: Fence): boolean {
  const { min, max } = boxOf(el);
  const h = Math.floor(el.width / 2);
  return el.points.every(([p, q]) => min[0]! <= p - h && p + h <= max[0]! && min[1]! <= q - h && q + h <= max[1]!);
}

function lints(ctx: ExtensionContext): void {
  const rooms = ctx.rooms();
  for (const [kind, id, el] of elements(ctx)) {
    if (kind === 'fences') {
      if (!fenceInsideBox(el as Fence)) ctx.report('FS-OUTD-LINT-001', `${id}'s line is not inside its box.`, [id]);
      continue;
    }
    const rid = rooms.get(id);
    if (rid !== undefined && (get(ctx.doc.rooms, rid)?.function ?? 'unspecified') !== 'exterior') ctx.report('FS-OUTD-LINT-002', `${id} stands in ${rid}, which is not exterior.`, [id, rid]);
  }
}

function derive(ctx: ExtensionContext): DerivedOutdoor {
  const rooms = ctx.rooms();
  const withRoom = <T extends object>(id: string, v: T): T & { room?: string } => {
    const rid = rooms.get(id);
    return rid === undefined ? v : { ...v, room: rid };
  };
  return {
    pools: record(
      ctx.coll<Pool>('pools').map(([id, el]) => {
        const { basin, depth } = poolWater(el);
        const area = BigInt(basin[0]) * BigInt(basin[1]);
        return [id, withRoom(id, { form: el.form, basin, depth, area: area.toString(), volume: (area * BigInt(depth)).toString() })];
      }),
    ),
    fences: record(ctx.coll<Fence>('fences').map(([id, el]) => [id, { form: el.form, length: fenceLength(el.points), posts: fencePostCount(el.points, el.postSpacing), gates: gateIntervals(el.gates) }])),
    shelters: record(ctx.coll<Shelter>('shelters').map(([id, el]) => [id, withRoom(id, { top: el.top ?? 'slats', ...shelterLayout(el) })])),
    kitchens: record(ctx.coll<Kitchen>('kitchens').map(([id, el]) => [id, withRoom(id, { run: extents(boxOf(el))[1], appliances: [...(el.appliances ?? [])] as string[] })])),
    fires: record(ctx.coll<Fire>('fires').map(([id, el]) => [id, withRoom(id, { form: el.form })])),
  };
}

export const FS_OUTDOOR: ExtensionImplementation<DerivedOutdoor> = {
  name: 'FS_outdoor',
  version: '0.1.0',
  code: 'OUTD',
  catalogue: [
    { code: 'FS-OUTD-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-OUTD-INV-001', severity: 'error', condition: 'an element hosted on a wall face or a ceiling' },
    { code: 'FS-OUTD-INV-002', severity: 'error', condition: 'a pool, a shelter, a kitchen or a fire without a host' },
    { code: 'FS-OUTD-INV-003', severity: 'error', condition: 'a pool whose coping leaves no basin' },
    { code: 'FS-OUTD-INV-004', severity: 'error', condition: "a pool whose `waterLine` is not less than its box's extent `Z`" },
    { code: 'FS-OUTD-INV-005', severity: 'error', condition: 'a fence with two equal consecutive points' },
    { code: 'FS-OUTD-INV-006', severity: 'error', condition: "a gate beyond the end of its fence's line" },
    { code: 'FS-OUTD-INV-007', severity: 'error', condition: 'two gates of one fence that overlap' },
    { code: 'FS-OUTD-INV-008', severity: 'error', condition: "a shelter whose `postSize` is not less than its box's extents" },
    { code: 'FS-OUTD-INV-009', severity: 'error', condition: 'a shelter whose `postSpacing` is not greater than its `postSize`' },
    { code: 'FS-OUTD-INV-010', severity: 'error', condition: "a shelter whose `clearHeight` is not less than its box's extent `Z`" },
    { code: 'FS-OUTD-LINT-001', severity: 'warning', condition: 'a fence whose line, grown by half its width, is not inside its box (3.3)' },
    { code: 'FS-OUTD-LINT-002', severity: 'info', condition: 'an outdoor room indoors: a pool, a shelter, a kitchen or a fire in a room whose `function` is not `"exterior"`' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
