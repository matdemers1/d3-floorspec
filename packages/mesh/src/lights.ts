/**
 * The light FS_electrical's luminaires give (FLR-T-12.22): where each one shines from, which way,
 * how much and how warm — read from what the engine derives, for every view that lights a room with
 * its lamps: the editor's 3D view (three.js lights), the headless render and the path tracer.
 *
 * Like a model (models/), this is a view's picture, not the standard's: FS_electrical records a
 * light's kind, its watts, its box and its switches, not its photometry. So:
 *
 * - **Where:** a ceiling-hung light (ceiling, pendant, fan, track, under-cabinet) shines from just
 *   under its box's bottom at the centre of its footprint — under its lens; a recessed light from
 *   just under the trim at its box's top; a wall light (a sconce, an exterior lantern) from just in
 *   front of the middle of its box's front face.
 * - **Which way:** recessed, track and under-cabinet lights are spots pointing straight down, each
 *   with a cone; every other light shines every way.
 * - **How much:** its `watts` at an LED's 90 lumens a watt, else a typical lamp of its kind.
 * - **How warm:** 2700 K inside, 3000 K for an exterior light; a colour from a fixed table.
 *
 * Exact integers in base units (the document's frame, z up) except the colour; deterministic, and
 * no trigonometry — a spot's cone is the cosines of its angles, written out.
 */
import { extElements, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { corners } from './models/sketch.js';
import { elementKind } from './models/kinds.js';
import type { Vec3 } from './types.js';

/** One luminaire's light. */
export interface FixtureLight {
  /** The light's element ID. */
  readonly id: string;
  readonly level: string;
  /** Its FS_electrical `fixture` (a light without one is a ceiling light). */
  readonly fixture: string;
  /** Where it shines from: base units, the document's frame (x east, y north, z up), integers. */
  readonly position: Vec3;
  /** The size of what shines, base units: its shadows' softness. */
  readonly radius: number;
  /**
   * `down`: a spot, pointing straight down (−z), lit fully inside `cone.inner` and fading to dark
   * at `cone.outer` (each the cosine of the angle from straight down); `omni`: every way.
   */
  readonly direction: 'down' | 'omni';
  readonly cone?: { readonly inner: number; readonly outer: number };
  /** Luminous flux: the light it gives, in lumens. */
  readonly lumens: number;
  /** Correlated colour temperature, kelvin. */
  readonly kelvin: number;
  /** Its colour: linear RGB, scaled so its luminance is 1. */
  readonly color: readonly [number, number, number];
  /** The room it is in, as FS_electrical derives (each light's room); null when it is in none. */
  readonly room: string | null;
  /** The switches that control it, as FS_electrical derives; sorted, empty when none does. */
  readonly switches: readonly string[];
}

const MM = 1280;

/** Lumens a watt: an LED lamp's. */
export const LUMENS_PER_WATT = 90;

/** A typical lamp of each kind, lumens: what a light without `watts` gives. */
export const DEFAULT_LUMENS: Readonly<Record<string, number>> = {
  ceiling: 1100,
  recessed: 650,
  pendant: 800,
  wall: 450,
  track: 900,
  underCabinet: 300,
  fan: 800,
  exterior: 600,
};
const FALLBACK_LUMENS = 800;

/** Where each kind shines from: under its box, under its trim at the box's top, or in front of its face. */
const EMITS: Readonly<Record<string, 'bottom' | 'top' | 'front'>> = { recessed: 'top', wall: 'front', exterior: 'front' };

/** Spots: the cosines of the angle from straight down within which each is fully lit, and past which it is dark. */
const CONES: Readonly<Record<string, { inner: number; outer: number }>> = {
  // 35° and 55°: a downlight's wide beam, which scallops the walls near it.
  recessed: { inner: 0.8192, outer: 0.5736 },
  // 25° and 40°: a track head's narrower beam.
  track: { inner: 0.9063, outer: 0.766 },
  // 50° and 75°: a strip's wash over the counter under it.
  underCabinet: { inner: 0.6428, outer: 0.2588 },
};

/**
 * A colour temperature's colour, linear RGB with luminance 1 — a warm white as a camera balanced
 * for daylight-ish interiors renders it, not the raw blackbody (which reads as orange on screen).
 */
const KELVIN: readonly (readonly [number, number, number, number])[] = [
  [2200, 1, 0.56, 0.24],
  [2700, 1, 0.67, 0.4],
  [3000, 1, 0.72, 0.48],
  [3500, 1, 0.79, 0.6],
  [4000, 1, 0.85, 0.71],
  [5000, 1, 0.94, 0.88],
  [6500, 1, 1, 1],
];

/** The colour of a colour temperature: linear RGB, luminance 1, from the table (linear between its rows). */
export function kelvinColor(kelvin: number): [number, number, number] {
  const k = Math.min(Math.max(kelvin, KELVIN[0]![0]), KELVIN[KELVIN.length - 1]![0]);
  let i = 0;
  while (i < KELVIN.length - 2 && KELVIN[i + 1]![0] < k) i++;
  const a = KELVIN[i]!;
  const b = KELVIN[i + 1]!;
  const t = (k - a[0]) / (b[0] - a[0]);
  const rgb: [number, number, number] = [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / lum, rgb[1] / lum, rgb[2] / lum];
}

/** How far in front of or under what shines a light's sphere is put, so it is not inside its own lens. */
const CLEAR = 5 * MM;
/** Under a recessed light's trim, from its box's top. */
const TRIM = 15 * MM;

/** Every FS_electrical light's light, in ID order. */
export function lightsOf(doc: FloorspecDocument, derived: Derived): FixtureLight[] {
  const out: FixtureLight[] = [];
  const electrical = derived.extensions?.FS_electrical;
  const roomOf = new Map<string, string>();
  for (const [room, ids] of Object.entries(electrical?.rooms ?? {})) for (const id of ids) roomOf.set(id, room);
  for (const e of extElements(doc)) {
    if (e.extension !== 'FS_electrical' || e.collection !== 'lights') continue;
    const f = derived.fallbacks?.[e.id];
    if (f === undefined || f.top <= f.bottom) continue;
    const element = e.element as unknown as Record<string, unknown>;
    const fixture = elementKind(e.extension, e.collection, element);
    const ring = f.footprint;
    const cx = (ring[0]![0] + ring[1]![0] + ring[2]![0] + ring[3]![0]) / 4;
    const cy = (ring[0]![1] + ring[1]![1] + ring[2]![1] + ring[3]![1]) / 4;
    const sides = [0, 1].map((k) => Math.hypot(ring[k + 1]![0] - ring[k]![0], ring[k + 1]![1] - ring[k]![1]));
    const half = Math.min(sides[0]!, sides[1]!) / 2;
    const emits = EMITS[fixture] ?? 'bottom';
    // Small: a lamp, not the fixture — and clear of its own trim and canopy.
    const radius = Math.round(Math.min(emits === 'top' ? TRIM - 3 * MM : 30 * MM, Math.max(8 * MM, half * 0.3)));
    let position: Vec3;
    if (emits === 'front') {
      // The middle of the front face (the frame's x = X), a little in front of it.
      const [c00, c10, c11] = corners(f, derived.placements?.[e.id]?.facing);
      const [fx, fy] = [c10[0] - c00[0], c10[1] - c00[1]];
      const l = Math.hypot(fx, fy) || 1;
      const out = CLEAR + radius;
      position = [Math.round((c10[0] + c11[0]) / 2 + (fx / l) * out), Math.round((c10[1] + c11[1]) / 2 + (fy / l) * out), Math.round((f.bottom + f.top) / 2)];
    } else {
      const z = emits === 'top' ? Math.max(f.bottom, f.top - TRIM) : f.bottom - CLEAR - radius;
      position = [Math.round(cx), Math.round(cy), z];
    }
    const watts = typeof element['watts'] === 'number' && element['watts'] > 0 ? element['watts'] : undefined;
    const lumens = watts === undefined ? (DEFAULT_LUMENS[fixture] ?? FALLBACK_LUMENS) : Math.min(20_000, Math.max(50, Math.round(watts * LUMENS_PER_WATT)));
    const kelvin = fixture === 'exterior' ? 3000 : 2700;
    const cone = CONES[fixture];
    out.push({
      id: e.id,
      level: f.level,
      fixture,
      position,
      radius,
      direction: cone === undefined ? 'omni' : 'down',
      ...(cone === undefined ? {} : { cone }),
      lumens,
      kelvin,
      color: kelvinColor(kelvin),
      room: roomOf.get(e.id) ?? null,
      switches: [...(electrical?.controls[e.id] ?? [])].sort(),
    });
  }
  return out;
}
