/**
 * The document model: the generated types (FLR-T-1.5) under readable names, and the resolution of
 * typed properties (8.2), thickness and face offsets (5.4) and vertical extents (5.9).
 *
 * Everything here assumes a document that passed the schema tier: every length is a safe integer.
 */
import type * as G from '../generated/types.js';
import { big } from '../exact/bigint.js';

export type FloorspecDocument = G.FloorspecCore01Document;
export type Project = G.Project;
export type Site = G.Site;
export type Building = G.Building;
export type Level = G.Level;
export type Junction = G.Junction;
export type JoinOverride = G.JoinOverride;
export type Wall = G.Wall;
export type Layer = G.Layer;
export type Separator = G.Separator;
export type Opening = G.Opening;
export type Room = G.Room;
export type Slab = G.Slab;
export type Type = G.Type;
export type WallType = G.WallType;
export type DoorType = G.DoorType;
export type WindowType = G.WindowType;
export type Material = G.Material;
export type Asset = G.Asset;

/** The element collections of 1.1, in table order. */
export const COLLECTIONS = [
  'buildings',
  'levels',
  'junctions',
  'walls',
  'separators',
  'openings',
  'rooms',
  'slabs',
  'types',
  'materials',
  'assets',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** A collection as a sorted list of [id, element] pairs (absent: `{}`, its default). */
export function entries<T>(c: Record<string, T | undefined> | undefined): [string, T][] {
  if (!c) return [];
  return Object.keys(c)
    .sort()
    .map((k) => [k, c[k] as T]);
}

export function get<T>(c: Record<string, T | undefined> | undefined, id: string): T | undefined {
  return c && Object.hasOwn(c, id) ? c[id] : undefined;
}

/** 8.2 / 5.4: a wall's effective layers — its own, else its type's; undefined if it has none. */
export function effectiveLayers(doc: FloorspecDocument, wall: Wall): readonly Layer[] | undefined {
  if (wall.layers) return wall.layers;
  if (wall.type === undefined) return undefined;
  const t = get(doc.types, wall.type);
  return t?.kind === 'wallType' ? t.layers : undefined;
}

/** Face offsets (5.4), doubled so that T/2 stays an integer: a2 = 2a, b2 = 2b. */
export interface FaceOffsets {
  readonly a2: bigint;
  readonly b2: bigint;
  readonly thickness: bigint;
}

/** 5.4.2: does a coreFace wall's layer list have a core layer, with its core layers consecutive? */
export function coreLayersOk(layers: readonly Layer[]): boolean {
  const idx = layers.flatMap((l, i) => (l.function === 'core' ? [i] : []));
  return idx.length > 0 && idx[idx.length - 1]! - idx[0]! === idx.length - 1;
}

export function faceOffsets(wall: Wall, layers: readonly Layer[]): FaceOffsets | undefined {
  const T = layers.reduce((s, l) => s + big(l.thickness), 0n);
  switch (wall.justification ?? 'center') {
    case 'center':
      return { a2: T, b2: T, thickness: T };
    case 'exteriorFace':
      return { a2: 0n, b2: 2n * T, thickness: T };
    case 'interiorFace':
      return { a2: 2n * T, b2: 0n, thickness: T };
    case 'coreFace': {
      if (!coreLayersOk(layers)) return undefined;
      const first = layers.findIndex((l) => l.function === 'core');
      const a = layers.slice(0, first).reduce((s, l) => s + big(l.thickness), 0n);
      return { a2: 2n * a, b2: 2n * (T - a), thickness: T };
    }
  }
}

/** 5.9: a wall's base and top elevations. Undefined when a level it needs does not resolve. */
export function wallElevations(doc: FloorspecDocument, wall: Wall): { base: bigint; top: bigint } | undefined {
  const own = get(doc.levels, wall.level);
  const baseLevel = get(doc.levels, wall.base?.level ?? wall.level);
  if (!own || !baseLevel) return undefined;
  const base = big(baseLevel.elevation) + big(wall.base?.offset ?? 0);
  let top: bigint;
  const t = wall.top;
  if (t === undefined) top = big(own.elevation) + big(own.height);
  else if ('height' in t) top = base + big(t.height);
  else {
    const L = get(doc.levels, t.level);
    if (!L) return undefined;
    top = big(L.elevation) + big(t.offset ?? 0);
  }
  return { base, top };
}

/** 7.2: an opening's effective width, height and sill (8.2: own member, else its fill's, else default). */
export function openingDimensions(doc: FloorspecDocument, o: Opening): { width?: number; height?: number; sill: number } {
  const fill = o.fill === undefined ? undefined : get(doc.types, o.fill);
  const t: DoorType | WindowType | undefined = fill && fill.kind !== 'wallType' ? fill : undefined;
  const width = o.width ?? t?.width;
  const height = o.height ?? t?.height;
  const sill = o.sill ?? t?.sill ?? 0;
  return { ...(width !== undefined && { width }), ...(height !== undefined && { height }), sill };
}

/** A point of the document as BigInts. */
export const ipoint = (p: readonly [number, number]): readonly [bigint, bigint] => [big(p[0]), big(p[1])];
