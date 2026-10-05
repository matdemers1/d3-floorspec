/**
 * The document model: the generated types (FLR-T-1.5) under readable names, and the resolution of
 * typed properties (8.2), thickness and face offsets (5.4) and vertical extents (5.9).
 *
 * Everything here assumes a document that passed the schema tier: every length is a safe integer.
 */
import type * as G from '../generated/types.js';
import type * as R from '../generated/registry-types.js';
import { big } from '../exact/bigint.js';

/**
 * A document this engine reads: Core 0.3's shape, declaring any draft it implements. A document
 * that declares "0.1" or "0.2" passed that draft's schema, so none of the members a later draft
 * adds is present in it (1.2.6).
 */
export type FloorspecDocument = Omit<G.FloorspecCore03Document, 'floorspec'> & { floorspec: '0.1' | '0.2' | '0.3' };
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
/** 15.1 (Core 0.3): a room's floor. */
export type RoomFloor = G.Floor;
/** 15.2 (Core 0.3): a room's ceiling — flat, tray or vaulted. */
export type Ceiling = G.Ceiling;
export type FlatCeiling = G.FlatCeiling;
export type TrayCeiling = G.TrayCeiling;
export type VaultedCeiling = G.VaultedCeiling;
export type Type = G.Type;
export type WallType = G.WallType;
export type DoorType = G.DoorType;
export type WindowType = G.WindowType;
/** 8.4 (0.3): a door type's operation. */
export type DoorOperation = G.DoorOperation;
/** 8.4 (0.3): a window type's operation. */
export type WindowOperation = G.WindowOperation;
/** 7.1, 8.4 (0.3): a declared net clear opening — width, height and, for a window only, area. */
export interface ClearOpening {
  readonly width: number;
  readonly height: number;
  readonly area?: number;
}
export type Material = G.Material;
export type Asset = G.Asset;
export type Program = G.Program;
export type ProgramItem = G.ProgramItem;
export type Adjacency = G.Adjacency;
export type ExtensionDeclaration = G.ExtensionDeclaration;
export type ExtensionElement = G.ExtensionElement;
export type Fallback = G.Fallback;
export type Box = G.Box;
export type Host = G.Host;
export type WallFaceHost = G.WallFaceHost;
export type SurfaceHost = G.SurfaceHost;
export type FreeHost = G.FreeHost;
export type ClearanceEnvelope = G.ClearanceEnvelope;
/** A registry entry (12.2): one version of one extension, as a validator's known extensions list it. */
export type RegistryEntry = R.FloorspecExtensionRegistryEntry;

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

/**
 * 7.2, 8.2 (0.3): an opening's effective clear opening — its own `clearOpening`, resolved whole,
 * else its fill type's; undefined when neither declares one. Never computed (7.4).
 */
export function effectiveClearOpening(doc: FloorspecDocument, o: Opening): ClearOpening | undefined {
  if (o.clearOpening) return o.clearOpening;
  const fill = o.fill === undefined ? undefined : get(doc.types, o.fill);
  return fill && fill.kind !== 'wallType' ? fill.clearOpening : undefined;
}

/** The door and window operations of 8.4 (0.3), in the order of its tables. */
export const DOOR_OPERATIONS: readonly DoorOperation[] = ['swing', 'doubleSwing', 'doubleActing', 'bypassSlide', 'pocket', 'surfaceSlide', 'bifold', 'overhead', 'cased'];
export const WINDOW_OPERATIONS: readonly WindowOperation[] = ['fixed', 'casement', 'awning', 'hopper', 'singleHung', 'doubleHung', 'horizontalSlider', 'tiltTurn', 'pivot'];

/**
 * 1.2.6, 12.5: does the document have a program and extension elements — does it declare "0.2" or a
 * later draft? In a 0.1 document the program is not a member and top-level extension data is opaque.
 */
export const hasCore02Members = (doc: { floorspec: string }): boolean => doc.floorspec !== '0.1';

/** A point of the document as BigInts. */
export const ipoint = (p: readonly [number, number]): readonly [bigint, bigint] => [big(p[0]), big(p[1])];

/** 12.1: the version a declaration in `extensionsUsed` names — a version string, or an object's `version`. */
export const declaredVersion = (d: ExtensionDeclaration): string => (typeof d === 'string' ? d : d.version);

/** One extension element (12.5), with the extension and collection that hold it. */
export interface ExtElement {
  readonly extension: string;
  readonly collection: string;
  readonly id: string;
  readonly element: ExtensionElement;
}

/**
 * 12.5: every extension element of a document, sorted by ID — only in a document that declares
 * "0.2" or "0.3"; in a 0.1 document top-level extension data is opaque, `collections` or not (1.2.6).
 */
export function extElements(doc: FloorspecDocument): ExtElement[] {
  const out: ExtElement[] = [];
  if (!hasCore02Members(doc)) return out;
  for (const [extension, data] of entries(doc.extensions as Record<string, unknown> | undefined)) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;
    const cs = (data as { collections?: unknown }).collections;
    if (typeof cs !== 'object' || cs === null || Array.isArray(cs)) continue;
    for (const [collection, coll] of entries(cs as Record<string, Record<string, ExtensionElement> | undefined>))
      for (const [id, element] of entries(coll)) out.push({ extension, collection, id, element });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 11.1: the program's items, sorted by ID. */
export const programItems = (doc: FloorspecDocument): [string, ProgramItem][] => entries(doc.program?.items);

/** 11.2: the program's adjacencies, in document order. */
export const adjacencies = (doc: FloorspecDocument): readonly Adjacency[] => doc.program?.adjacency ?? [];
