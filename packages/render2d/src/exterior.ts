/**
 * Exterior lighting (FLR-T-15.5, FLR-ADR-063): the kinds of exterior light a landscape is lit with —
 * path lights, uplights, wall-washers, step lights and string lights — and where each one's light
 * lands, drawn on the plan as a beam.
 *
 * FS_electrical 0.1.0 records an exterior luminaire as a light whose `fixture` is `exterior`, with
 * its volts, watts, host and box; FS_lighting 0.1.0 its lumens and colour temperature. Neither says
 * which kind of exterior light it is or how wide its beam is: that is this application's catalogue,
 * kept on the element under `extras.d3floorspec.exterior` (Core 1.7) — `{ kind, beam?, reach? }` —
 * the way a starter library's item is. A reader without it draws an exterior light as the lantern
 * it always has, and the standard is unchanged.
 *
 * A beam is a picture of the fixture, not a lighting calculation: a pool under a path light, a cone
 * from an uplight towards what it lights, a fan from a wall-washer, a half-disc before a step light
 * and a run of bulbs for a string — each sized from the fixture's height and beam by a round rule,
 * in one warm tint. Nothing here predicts illuminance.
 *
 * Lengths are integers in base units (1/1280 mm), the document's frame (x east, y north, z up); round
 * things use a written-out table of cosines, so the outline is the same in every JavaScript engine.
 */
import { facingVector } from '@floorspec/engine';

type Json = Record<string, unknown>;
type Pt = readonly [number, number];

const IN = 32_512;
const FT = 12 * IN;

export const EXTERIOR_KINDS = ['path', 'uplight', 'wallWash', 'step', 'string'] as const;
export type ExteriorKind = (typeof EXTERIOR_KINDS)[number];

/** Where a kind is put: on the ground, on a wall face, on a step's riser, or strung between two points. */
export type ExteriorMount = 'ground' | 'wall' | 'step' | 'string';

/** The shape a beam is drawn with on the plan (the board's P15/Beam). */
export type BeamShape = 'pool' | 'cone' | 'fan' | 'halfDisc' | 'string';

export interface ExteriorDef {
  readonly kind: ExteriorKind;
  /** "Path light". */
  readonly label: string;
  /** "Ground · stake": where it goes and how, in a chip's words. */
  readonly where: string;
  readonly mount: ExteriorMount;
  readonly shape: BeamShape;
  /** The fallback box, in the element's frame (Core 13.2); a string light's x is its run, set when it is placed. */
  readonly box: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  /** A wall mount's height above the wall's base, to its frame. */
  readonly height?: number;
  /** Its lamp's connected load, watts (FS_electrical `watts`): what a landscape circuit counts. A string's is a bulb's. */
  readonly watts: number;
  /** Its light at full, lumens (FS_lighting `lumens`, when the document says none). A string's is a bulb's. */
  readonly lumens: number;
  /** Its colour temperature, kelvin: a warm landscape lamp's. */
  readonly cct: number;
  /** A low-voltage landscape lamp's 12 V. */
  readonly volts: number;
  /** Its beam's spread, degrees, whole angle: the default, and what the inspector offers. */
  readonly beam: number;
  readonly beams: readonly number[];
  /** For a beam aimed along the ground (an uplight's, a wall-washer's): how far it is drawn, by default. */
  readonly reach: number;
}

export const EXTERIOR_DEFS: Readonly<Record<ExteriorKind, ExteriorDef>> = {
  // A stake light 22" tall under a 7" cap: its light pools on the ground about it, a 6' pool.
  path: { kind: 'path', label: 'Path light', where: 'Ground · stake', mount: 'ground', shape: 'pool', box: { min: [-113_792, -113_792, -51_200], max: [113_792, 113_792, 22 * IN] }, watts: 3, lumens: 150, cct: 2700, volts: 12, beam: 360, beams: [360], reach: 3 * FT },
  // A 4" canister at grade, aimed up into a canopy or up a wall.
  uplight: { kind: 'uplight', label: 'Uplight', where: 'Ground · aimed', mount: 'ground', shape: 'cone', box: { min: [-65_024, -65_024, -51_200], max: [65_024, 65_024, 6 * IN] }, watts: 5, lumens: 300, cct: 2700, volts: 12, beam: 25, beams: [15, 25, 40, 60], reach: 4 * FT },
  // A small fixture on a wall face, 6' up, washing down the wall and onto the ground before it.
  wallWash: { kind: 'wallWash', label: 'Wall-wash', where: 'Wall · 6′ up', mount: 'wall', shape: 'fan', box: { min: [0, -76_800, -76_800], max: [96_000, 76_800, 76_800] }, height: 6 * FT, watts: 4, lumens: 250, cct: 2700, volts: 12, beam: 40, beams: [25, 40, 60, 90], reach: 5 * FT },
  // A louvred plate in a riser, 4" above the tread below it, lighting that tread.
  step: { kind: 'step', label: 'Step light', where: 'Step · riser', mount: 'step', shape: 'halfDisc', box: { min: [0, -89_408, 4 * IN], max: [25_600, 89_408, 7 * IN] }, watts: 1, lumens: 60, cct: 2700, volts: 12, beam: 120, beams: [120], reach: 2 * FT },
  // Bulbs every 2' on a cable hung 8' up with a foot of sag; its box's x is its run.
  string: { kind: 'string', label: 'String lights', where: 'Strung · 8′ up', mount: 'string', shape: 'string', box: { min: [0, -32_512, 84 * IN], max: [12 * FT, 32_512, 96 * IN] }, watts: 1, lumens: 25, cct: 2200, volts: 12, beam: 360, beams: [360], reach: 18 * IN },
};

/** How far apart a string's bulbs are hung. */
export const BULB_SPACING = 2 * FT;

export const isExteriorKind = (v: unknown): v is ExteriorKind => typeof v === 'string' && (EXTERIOR_KINDS as readonly string[]).includes(v);

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the application records of an exterior light: `extras.d3floorspec.exterior`. */
export interface ExteriorData {
  readonly kind: ExteriorKind;
  /** Its beam's spread, degrees. */
  readonly beam: number;
  /** How far its beam is drawn along the ground, base units: an uplight's distance to what it lights. */
  readonly reach: number;
}

/** The path of the application's record on an element (Ops 2.3, relative to the element). */
export const EXTERIOR_PATH = '/extras/d3floorspec/exterior';

/**
 * An FS_electrical light's exterior kind, its beam and its reach — or null for a light that is not one
 * of the kinds (an interior light, or an exterior light with no kind: the lantern).
 */
export function exteriorOf(element: Json): ExteriorData | null {
  if (element['fixture'] !== 'exterior') return null;
  const extras = isObject(element['extras']) ? element['extras'] : undefined;
  const ours = extras !== undefined && isObject(extras['d3floorspec']) ? extras['d3floorspec'] : undefined;
  const ext = ours !== undefined && isObject(ours['exterior']) ? ours['exterior'] : undefined;
  if (ext === undefined || !isExteriorKind(ext['kind'])) return null;
  const def = EXTERIOR_DEFS[ext['kind']];
  const beam = typeof ext['beam'] === 'number' && ext['beam'] > 0 && ext['beam'] <= 360 ? ext['beam'] : def.beam;
  const reach = typeof ext['reach'] === 'number' && Number.isSafeInteger(ext['reach']) && ext['reach'] > 0 ? ext['reach'] : def.reach;
  return { kind: ext['kind'], beam, reach };
}

/** The application's record for a kind, as an element's `extras` (Core 1.7). */
export function exteriorExtras(kind: ExteriorKind, patch: { beam?: number; reach?: number } = {}): Json {
  return { d3floorspec: { exterior: { kind, ...(patch.beam === undefined ? {} : { beam: patch.beam }), ...(patch.reach === undefined ? {} : { reach: patch.reach }) } } };
}

/** The members a new exterior light of a kind starts with: FS_electrical's, and the application's record. */
export function exteriorMembers(kind: ExteriorKind, patch: { beam?: number; reach?: number; bulbs?: number } = {}): Json {
  const def = EXTERIOR_DEFS[kind];
  const watts = kind === 'string' ? Math.max(1, patch.bulbs ?? 6) * def.watts : def.watts;
  return { fixture: 'exterior', volts: def.volts, watts, name: def.label, extras: exteriorExtras(kind, patch) };
}

/** A string light's bulbs for a run of `length`: one every `BULB_SPACING`, the ends a half-spacing in. */
export function bulbCount(length: number): number {
  return Math.max(2, Math.round(length / BULB_SPACING));
}

/** A string light's box for a run of `length` from its frame's origin. */
export function stringBox(length: number): { min: [number, number, number]; max: [number, number, number] } {
  const b = EXTERIOR_DEFS.string.box;
  return { min: [0, b.min[1], b.min[2]], max: [Math.max(FT, Math.round(length)), b.max[1], b.max[2]] };
}

// ─── Beams on the plan ───────────────────────────────────────────────────────────────────────

/** cos(15° · k), k = 0 … 23, written out (as render2d's landscape and the circle table). */
const Q = [1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5, 0.25881904510252074, 0] as const;
const COS: readonly number[] = Array.from({ length: 24 }, (_, k) => (k <= 6 ? Q[k]! : k <= 12 ? -Q[12 - k]! : k <= 18 ? -Q[k - 12]! : Q[24 - k]!));
const SIN: readonly number[] = Array.from({ length: 24 }, (_, k) => COS[(k + 18) % 24]!);

/** tan(half a beam), for the spreads the catalogue offers; others by the nearest below. */
const TAN_HALF: readonly (readonly [number, number])[] = [
  [15, 0.131652],
  [25, 0.221695],
  [40, 0.36397],
  [60, 0.57735],
  [90, 1],
  [120, 1.732051],
];
const tanHalf = (beam: number): number => {
  let t = TAN_HALF[0]![1];
  for (const [b, v] of TAN_HALF) if (beam >= b) t = v;
  return t;
};

export interface Beam {
  readonly id: string;
  readonly kind: ExteriorKind;
  readonly shape: BeamShape;
  /** Where the light lands, a closed ring in plan (base units, integers). */
  readonly ring: readonly Pt[];
  /** The fixture, in plan. */
  readonly at: Pt;
  /** A string's bulbs, in plan. */
  readonly bulbs?: readonly Pt[];
  /** "6′ ⌀ pool", "25° flood": its label, in words, lengths for the caller to format. */
  readonly spread: number;
  /** A pool's or a half-disc's radius, a cone's or a fan's reach, a string's run: base units. */
  readonly size: number;
}

/** "15° spot", "25° flood", "60° wide": a beam's spread in words. */
export function beamWords(beam: number): string {
  if (beam >= 360) return 'all round';
  return `${String(beam)}° ${beam <= 15 ? 'spot' : beam <= 40 ? 'flood' : 'wide'}`;
}

/**
 * Where an exterior light's light lands, on the plan: from its kind, beam and reach, and its frame —
 * the placement's point and facing (Core 13.4) — and its box. Null for a light that is not an exterior
 * kind. A picture of the fixture, not a calculation (see the module's note).
 */
export function beamOf(id: string, element: Json, placement: { readonly point: readonly number[]; readonly facing: number } | undefined): Beam | null {
  const ext = exteriorOf(element);
  if (ext === null) return null;
  const box = (isObject(element['fallback']) ? element['fallback']['box'] : undefined) as { min?: number[]; max?: number[] } | undefined;
  const b = EXTERIOR_DEFS[ext.kind].box;
  const min = Array.isArray(box?.min) ? box.min : [...b.min];
  const max = Array.isArray(box?.max) ? box.max : [...b.max];
  const [fx, fy] = facingVector(placement?.facing ?? 0).map(Number) as [number, number];
  const k = Math.hypot(fx, fy) || 1;
  const u: Pt = [fx / k, fy / k];
  const o: Pt = placement === undefined ? [0, 0] : [placement.point[0] ?? 0, placement.point[1] ?? 0];
  // A point of the element's frame in plan: forward along its facing, and to its left.
  const plan = (x: number, y: number): Pt => [Math.round(o[0] + x * u[0] - y * u[1]), Math.round(o[1] + x * u[1] + y * u[0])];
  const cx = ((min[0] ?? 0) + (max[0] ?? 0)) / 2;
  const cy = ((min[1] ?? 0) + (max[1] ?? 0)) / 2;
  const top = max[2] ?? 0;
  const front = max[0] ?? 0;
  const base = { id, kind: ext.kind, spread: ext.beam };
  switch (ext.kind) {
    case 'path': {
      // About 1.6 times the lamp's height: a 22" stake light's 6' pool.
      const r = Math.max(12 * IN, Math.round((top - (min[2] ?? 0)) * 1.6));
      return { ...base, shape: 'pool', at: plan(cx, cy), size: r, ring: COS.map((c, i) => plan(cx + r * c, cy + r * SIN[i]!)) };
    }
    case 'uplight': {
      // From the canister towards what it lights, `reach` along its facing, spreading by its beam.
      const r = ext.reach;
      const half = Math.max(2 * IN, Math.round(r * tanHalf(ext.beam)));
      return { ...base, shape: 'cone', at: plan(cx, cy), size: r, ring: [plan(cx, cy - 1 * IN), plan(cx + r, cy - half), plan(cx + r + half * 0.4, cy), plan(cx + r, cy + half), plan(cx, cy + 1 * IN)] };
    }
    case 'wallWash': {
      // Out from the wall face, widening by its beam: a fan, its near edge the fixture's width.
      const r = ext.reach;
      const near = Math.max(2 * IN, ((max[1] ?? 0) - (min[1] ?? 0)) / 2);
      const far = near + Math.round(r * tanHalf(ext.beam));
      return { ...base, shape: 'fan', at: plan(front, cy), size: r, ring: [plan(front, cy - near), plan(front + r, cy - far), plan(front + r, cy + far), plan(front, cy + near)] };
    }
    case 'step': {
      // A half-disc on the tread before the riser.
      const r = ext.reach;
      const ring: Pt[] = [];
      for (let i = 18; i <= 30; i++) ring.push(plan(front + r * COS[i % 24]!, cy + r * SIN[i % 24]!));
      return { ...base, shape: 'halfDisc', at: plan(front, cy), size: r, ring };
    }
    case 'string': {
      // The run, its bulbs every BULB_SPACING, each with a small glow: drawn as one band along the run.
      const run = (max[0] ?? 0) - (min[0] ?? 0);
      const n = bulbCount(run);
      const step = run / n;
      const bulbs = Array.from({ length: n }, (_, i) => plan((min[0] ?? 0) + step * (i + 0.5), cy));
      const w = ext.reach;
      return { ...base, shape: 'string', at: plan(min[0] ?? 0, cy), size: run, bulbs, ring: [plan(min[0] ?? 0, cy - w), plan(max[0] ?? 0, cy - w), plan(max[0] ?? 0, cy + w), plan(min[0] ?? 0, cy + w)] };
    }
  }
}
