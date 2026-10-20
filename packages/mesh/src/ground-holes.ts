/**
 * Where the ground opens for a sunken pool (FS_outdoor 2.2, FLR-T-15.2): a pool whose box goes below
 * its frame's origin — its floor under the ground — is seen only through a hole in the ground. Every
 * renderer's ground (the editor's lawn and terrain, the GPU still's plate, the worker's plate and its
 * path tracer's ground plane) leaves out what lies inside these outlines, and none of them sets the
 * ground's height by a sunken pool's floor. The coping, drawn over the outline's edge, covers where a
 * coarse ground's cells stop.
 *
 * View geometry only: nothing here is normative.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';

/** One sunken pool's outline in plan: its box's footprint (Core 13.2), base units, counter-clockwise. */
export interface SunkenOutline {
  readonly id: string;
  readonly level: string;
  readonly ring: readonly (readonly [number, number])[];
  /** Its coping's top and its floor, base units. */
  readonly top: number;
  readonly bottom: number;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The sunken FS_outdoor pools of a document, by ID: those whose box's bottom is below their frame's origin. */
export function sunkenOutlines(document: FloorspecDocument, derived: Pick<Derived, 'fallbacks'> | null | undefined): SunkenOutline[] {
  const ext = (document as { extensions?: Record<string, unknown> }).extensions;
  const data = isObject(ext) ? ext['FS_outdoor'] : undefined;
  const colls = isObject(data) ? data['collections'] : undefined;
  const pools = isObject(colls) ? colls['pools'] : undefined;
  if (!isObject(pools)) return [];
  const out: SunkenOutline[] = [];
  for (const id of Object.keys(pools).sort()) {
    const el = pools[id];
    const fb = isObject(el) ? el['fallback'] : undefined;
    const box = isObject(fb) ? fb['box'] : undefined;
    const min = isObject(box) && Array.isArray(box['min']) ? (box['min'] as unknown[]) : undefined;
    const f = derived?.fallbacks?.[id];
    if (min === undefined || typeof min[2] !== 'number' || min[2] >= 0 || f === undefined) continue;
    out.push({ id, level: f.level, ring: f.footprint.map((p): [number, number] => [p[0], p[1]]), top: f.top, bottom: f.bottom });
  }
  return out;
}

/** Whether (x, y) is inside a ring (even-odd), in the ring's units. */
export function insideRing(x: number, y: number, ring: readonly (readonly [number, number])[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Whether (x, y) is inside any of the holes. */
export const inHoles = (x: number, y: number, holes: readonly (readonly (readonly [number, number])[])[]): boolean => holes.some((h) => insideRing(x, y, h));
