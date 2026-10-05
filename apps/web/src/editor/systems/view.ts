import { extElements, type Derived, type FloorspecDocument } from '@floorspec/engine';
import type { Point, Ring } from '../model';
import { kindLabel, kindOfElement, systemOfExtension, type DeviceKind, type SystemId } from './catalog';

/**
 * What the canvas, the inspector and the schedules read of the building systems (FLR-T-5.7): every
 * extension element as the engine derived it — its fallback footprint (Core 12.6), its placement
 * (13.4) and its clearance envelopes (13.5) — and the records the extensions keep beside their
 * elements (circuits, stacks, gas sources). Nothing here computes a position: it indexes the
 * engine's derived values, which follow their hosts when a wall moves.
 */

type Json = Record<string, unknown>;

export interface DeviceView {
  id: string;
  extension: string;
  collection: string;
  /** The editor's system for an official extension; null for another extension's element. */
  system: SystemId | null;
  kind: DeviceKind | null;
  /** "Receptacle", "Toilet". */
  kindLabel: string;
  element: Json;
  level: string;
  /** The fallback box's footprint in plan (Core 12.6, 13.2): what a core-only reader draws. */
  footprint: Ring;
  bottom: number;
  top: number;
  /** The host frame's origin and facing (Core 13.4), for a hosted element. */
  placement: { point: Point; z: number; facing: number } | null;
  host: Json | null;
  clearances: { name: string; purpose: string; ring: Ring }[];
}

/** A record an extension keeps beside its elements, not an element: a circuit, a stack, a gas source. */
export interface RecordRef {
  extension: string;
  collection: 'circuits' | 'stacks' | 'gasSources';
}

export const RECORD_COLLECTIONS: readonly (RecordRef & { prefix: string; noun: string })[] = [
  { extension: 'FS_electrical', collection: 'circuits', prefix: 'C', noun: 'Circuit' },
  { extension: 'FS_plumbing', collection: 'stacks', prefix: 'K', noun: 'Stack' },
  { extension: 'FS_mechanical', collection: 'gasSources', prefix: 'G', noun: 'Gas source' },
];

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An extension's top-level data, or an empty object. */
export function extensionData(document: FloorspecDocument, extension: string): Json {
  const data = (document.extensions as Json | undefined)?.[extension];
  return isObject(data) ? data : {};
}

/** One element of an extension's collection, or undefined. */
export function elementOfExtension(document: FloorspecDocument, extension: string, collection: string, id: string): Json | undefined {
  const coll = (extensionData(document, extension)['collections'] as Json | undefined)?.[collection];
  const el = isObject(coll) ? coll[id] : undefined;
  return isObject(el) ? el : undefined;
}

/** Every element of an extension's collection, sorted by ID. */
export function elementsOfExtension(document: FloorspecDocument, extension: string, collection: string): [string, Json][] {
  const coll = (extensionData(document, extension)['collections'] as Json | undefined)?.[collection];
  if (!isObject(coll)) return [];
  return Object.entries(coll)
    .filter((e): e is [string, Json] => isObject(e[1]))
    .sort(([a], [b]) => compareIds(a, b));
}

/** The records of one kind, sorted by ID. */
export function recordsOf(document: FloorspecDocument, extension: string, collection: string): [string, Json][] {
  const records = extensionData(document, extension)[collection];
  if (!isObject(records)) return [];
  return Object.entries(records)
    .filter((e): e is [string, Json] => isObject(e[1]))
    .sort(([a], [b]) => compareIds(a, b));
}

/** Every record of every official extension, by ID. */
export function recordIndex(document: FloorspecDocument): Map<string, RecordRef> {
  const out = new Map<string, RecordRef>();
  if (document.floorspec === '0.1') return out;
  for (const r of RECORD_COLLECTIONS) for (const [id] of recordsOf(document, r.extension, r.collection)) out.set(id, { extension: r.extension, collection: r.collection });
  return out;
}

/** IDs in natural order: C2 before C10. */
export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** Every extension element of the document, as the engine derived it. Without derived values: none. */
export function deviceViews(document: FloorspecDocument, derived: Derived | null): DeviceView[] {
  if (derived === null) return [];
  const out: DeviceView[] = [];
  for (const x of extElements(document)) {
    const fb = derived.fallbacks?.[x.id];
    if (fb === undefined) continue;
    const pl = derived.placements?.[x.id];
    const element = x.element as unknown as Json;
    out.push({
      id: x.id,
      extension: x.extension,
      collection: x.collection,
      system: systemOfExtension(x.extension),
      kind: kindOfElement(x.extension, x.collection, element),
      kindLabel: kindLabel(x.extension, x.collection, element),
      element,
      level: fb.level,
      footprint: fb.footprint,
      bottom: fb.bottom,
      top: fb.top,
      placement: pl === undefined ? null : { point: [pl.point[0], pl.point[1]], z: pl.point[2], facing: pl.facing },
      host: isObject(element['host']) ? element['host'] : null,
      clearances: Object.entries(derived.clearances?.[x.id] ?? {}).map(([name, c]) => ({ name, purpose: c.purpose, ring: c.footprint })),
    });
  }
  return out;
}

/** The facing as a unit vector in plan: forward, out of the wall for a wall-face host. */
export function facingVector(facing: number): Point {
  const rad = (facing / 1_000_000) * (Math.PI / 180);
  return [Math.cos(rad), Math.sin(rad)];
}

/** Where a device is, for a label or a home run: its placement, else the middle of its footprint. */
export function anchorOf(d: DeviceView): Point {
  if (d.placement !== null) return d.placement.point;
  const xs = d.footprint.map((p) => p[0]);
  const ys = d.footprint.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** The longer side of a footprint, in base units: whether a device is drawn by its outline or as a glyph. */
export function footprintSize(d: DeviceView): number {
  const xs = d.footprint.map((p) => p[0]);
  const ys = d.footprint.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** The circuits that list an element as a load. */
export function circuitsOf(document: FloorspecDocument, id: string): string[] {
  return recordsOf(document, 'FS_electrical', 'circuits')
    .filter(([, c]) => Array.isArray(c['loads']) && (c['loads'] as unknown[]).includes(id))
    .map(([cid]) => cid);
}

/** The switches that control an element. */
export function switchesOf(document: FloorspecDocument, id: string): string[] {
  const switches = (extensionData(document, 'FS_electrical')['collections'] as Json | undefined)?.['switches'];
  if (!isObject(switches)) return [];
  return Object.entries(switches)
    .filter(([, s]) => isObject(s) && Array.isArray(s['controls']) && (s['controls'] as unknown[]).includes(id))
    .map(([sid]) => sid)
    .sort(compareIds);
}
