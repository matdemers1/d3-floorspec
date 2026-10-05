import { check, extElements, OFFICIAL_READER, type Derived, type DerivedRoof, type DerivedStair, type Diagnostic, type FloorspecDocument } from '@floorspec/engine';
import { twiceArea } from './units';
import { deviceViews, recordIndex, type DeviceView, type RecordRef } from './systems/view';
import { kindLabel } from './systems/catalog';

/**
 * The editor's reading of one version of the model: the document as the server stored it, checked
 * and derived by `@floorspec/engine` — the same engine the server runs (FLR-ADR-010). Nothing here
 * computes geometry of its own; it indexes what the engine derived, per level, so the canvas, the
 * tree and the inspector can find things.
 */

export type Point = readonly [number, number];
export type Ring = readonly Point[];

/** Every collection an element can live in (Core 1.1), in the order the tree lists them. */
export type Collection =
  | 'buildings' | 'levels' | 'junctions' | 'walls' | 'separators' | 'openings' | 'rooms' | 'slabs' | 'roofs' | 'stairs' | 'types' | 'materials' | 'assets';

export const COLLECTIONS: readonly Collection[] = [
  'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'roofs', 'stairs', 'types', 'materials', 'assets',
];

/**
 * Where an ID lives: a Core collection, the program's items (Core 0.2, 11.1), or an extension's
 * collection (12.5) — one space of IDs (3.1.3).
 */
export type Place = Collection | 'items' | 'extension' | 'record';

export type Kind =
  | 'building' | 'level' | 'junction' | 'wall' | 'separator' | 'opening' | 'room' | 'slab' | 'roof' | 'stair'
  | 'wallType' | 'doorType' | 'windowType' | 'material' | 'asset' | 'item' | 'extensionElement'
  /** A record an extension keeps beside its elements (FS_electrical's circuits …): not an element. */
  | 'circuit' | 'stack' | 'gasSource';

type Json = Record<string, unknown>;

export interface Layer {
  thickness: number;
  function: string;
  material?: string;
}

export interface WallView {
  id: string;
  level: string;
  start: string;
  end: string;
  a: Point;
  b: Point;
  /** The outline startRight → endRight → endLeft → startLeft, as the engine derived it. */
  ring: Ring;
  thickness: number;
  /** Distance from the location line to the left and right faces (Core 5.4). */
  left: number;
  right: number;
  type: string | undefined;
  justification: string;
}

export interface OpeningView {
  id: string;
  wall: string;
  kind: 'door' | 'window' | 'opening';
  /** On the location line, as derived (Core 7.4). */
  start: Point;
  end: Point;
  offset: number;
  width: number;
  hinge: 'start' | 'end';
  swing: 'left' | 'right';
}

export interface RoomView {
  id: string;
  name: string;
  anchor: Point;
  outer: Ring;
  holes: Ring[];
  area2: bigint;
  /**
   * Its ceiling as the engine derived it (Core 0.3, 15.5) — the kind, a tray's centre (outer ring
   * and holes), a vault's ridge points as declared — or null when the reader derived none.
   */
  ceiling: { kind: 'flat' | 'tray' | 'vaulted'; low: number; high: number; tray?: Ring[]; ridge?: [Point, Point] } | null;
  /** Its floor's top (Core 0.3, 15.1), or null when the reader derived none. */
  floorTop: number | null;
}

/** A slab (Core 6.7) as the engine derived its bounding geometry (Core 0.3, 15.7). */
export interface SlabView {
  id: string;
  /** Its outline, counter-clockwise from its least vertex. */
  outline: Ring;
  purpose: string | undefined;
  top: number;
  bottom: number;
}

/** A roof (Core 0.3, 16) as the engine derived it: its kind, eave outline and surface. */
export interface RoofView {
  id: string;
  /** Its footprint as drawn (Core 16.1). */
  footprint: Ring;
  derived: DerivedRoof;
}

/** A stair (Core 0.3, 17) on the level it rises from, as the engine derived it. */
export interface StairView {
  id: string;
  to: string;
  form: string;
  derived: DerivedStair;
}

export interface FaceView {
  /** The room anchored in it, or null for an unanchored face. */
  room: string | null;
  outer: Ring;
  holes: Ring[];
  area2: bigint;
}

export interface SeparatorView {
  id: string;
  start: string;
  end: string;
  a: Point;
  b: Point;
}

export interface LevelView {
  id: string;
  name: string;
  building: string;
  elevation: number;
  height: number;
  junctions: { id: string; position: Point; edges: number }[];
  walls: WallView[];
  fills: { id: string; ring: Ring }[];
  separators: SeparatorView[];
  openings: OpeningView[];
  rooms: RoomView[];
  /** Every bounded face: anchored rooms and unanchored ones (Core 6.3). */
  faces: FaceView[];
  /** The extension elements on this level, as derived (Core 12.6, 13.4, 13.5). */
  devices: DeviceView[];
  /** The slabs on this level, as derived (Core 0.3, 15.7). */
  slabs: SlabView[];
  /** The roofs on this level (Core 0.3, 16.5) and the stairs rising from it (17.4). */
  roofs: RoofView[];
  stairs: StairView[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

export interface EditorModel {
  hash: string;
  document: FloorspecDocument;
  valid: boolean;
  derived: Derived | null;
  /** The head's own findings: lints when it is valid, every diagnostic when it is not. */
  diagnostics: Diagnostic[];
  levels: LevelView[];
  /** Which collection every ID is in. */
  index: Map<string, Place>;
  /** The extension and collection of every extension element. */
  ext: Map<string, { extension: string; collection: string }>;
  /** The official extensions' records — circuits, stacks, gas sources — by ID. */
  records: Map<string, RecordRef>;
}

const entriesOf = (c: unknown): [string, Json][] =>
  Object.entries((c ?? {}) as Record<string, Json | undefined>).filter((e): e is [string, Json] => e[1] !== undefined);

/** Read a version: check, derive and index it. */
export function readModel(hash: string, text: string | object): EditorModel {
  // The reader implements the official extensions (FS_electrical …): their derived values — circuits,
  // loads, panel spaces — are what the systems panels and schedules read (FLR-T-5.7, 5.8).
  const result = check(text, OFFICIAL_READER);
  const document = (typeof text === 'string' ? JSON.parse(text) : text) as FloorspecDocument;
  const index = new Map<string, Place>();
  for (const c of COLLECTIONS) for (const [id] of entriesOf((document as unknown as Json)[c])) index.set(id, c);
  for (const [id] of entriesOf(document.program?.items)) index.set(id, 'items');
  const ext = new Map<string, { extension: string; collection: string }>();
  for (const e of extElements(document)) {
    index.set(e.id, 'extension');
    ext.set(e.id, { extension: e.extension, collection: e.collection });
  }
  const derived = result.valid ? (result.derived ?? null) : null;
  const records = recordIndex(document);
  for (const [id] of records) if (!index.has(id)) index.set(id, 'record');
  return {
    hash,
    document,
    valid: result.valid,
    derived,
    diagnostics: result.diagnostics,
    levels: derived === null ? levelsWithoutGeometry(document) : levelViews(document, derived),
    index,
    ext,
    records,
  };
}

export function kindOf(model: EditorModel, id: string): Kind | null {
  const c = model.index.get(id);
  if (c === undefined) return null;
  if (c === 'items') return 'item';
  if (c === 'extension') return 'extensionElement';
  if (c === 'record') {
    const r = model.records.get(id)?.collection;
    return r === 'circuits' ? 'circuit' : r === 'stacks' ? 'stack' : 'gasSource';
  }
  if (c === 'types') {
    const kind = (model.document.types?.[id] as Json | undefined)?.['kind'];
    return kind === 'wallType' || kind === 'doorType' || kind === 'windowType' ? kind : null;
  }
  const singular: Record<Collection, Kind> = {
    buildings: 'building', levels: 'level', junctions: 'junction', walls: 'wall', separators: 'separator', openings: 'opening',
    rooms: 'room', slabs: 'slab', roofs: 'roof', stairs: 'stair', types: 'wallType', materials: 'material', assets: 'asset',
  };
  return singular[c];
}

/** The element's JSON as the document holds it. */
export function elementOf(model: EditorModel, id: string): Json | undefined {
  const c = model.index.get(id);
  if (c === undefined) return undefined;
  if (c === 'items') return model.document.program?.items?.[id] as Json | undefined;
  if (c === 'record') {
    const at = model.records.get(id);
    const data = at === undefined ? undefined : ((model.document.extensions as Record<string, Json | undefined> | undefined)?.[at.extension]);
    return (data?.[at?.collection ?? ''] as Record<string, Json> | undefined)?.[id];
  }
  if (c === 'extension') {
    const at = model.ext.get(id);
    const data = at === undefined ? undefined : ((model.document.extensions as Record<string, Json | undefined> | undefined)?.[at.extension]);
    return ((data?.['collections'] as Record<string, Record<string, Json> | undefined> | undefined)?.[at?.collection ?? ''])?.[id];
  }
  return ((model.document as unknown as Json)[c] as Record<string, Json> | undefined)?.[id];
}

/** The level an element sits on, if it sits on one. */
export function levelOfElement(model: EditorModel, id: string): string | undefined {
  const c = model.index.get(id);
  const element = elementOf(model, id);
  if (element === undefined) return undefined;
  if (c === 'levels') return id;
  // An item's level is a preference, not where it is (11.1); an extension element is where its fallback is (12.6).
  if (c === 'items' || c === 'record') return undefined;
  if (c === 'extension') {
    const fallback = element['fallback'] as Json | undefined;
    return typeof fallback?.['level'] === 'string' ? fallback['level'] : undefined;
  }
  if (c === 'openings') {
    const wall = model.document.walls?.[String(element['wall'])] as Json | undefined;
    return wall === undefined ? undefined : String(wall['level']);
  }
  return typeof element['level'] === 'string' ? element['level'] : undefined;
}

/** Levels by elevation, then ID: the order a level switcher lists them. */
export function sortedLevels(document: FloorspecDocument): { id: string; level: Json }[] {
  return entriesOf(document.levels)
    .map(([id, level]) => ({ id, level }))
    .sort((a, b) => Number(a.level['elevation']) - Number(b.level['elevation']) || (a.id < b.id ? -1 : 1));
}

/** A wall's effective layers (Core 5.4): its own, else its type's. */
export function effectiveLayers(document: FloorspecDocument, wall: Json): Layer[] | undefined {
  const own = wall['layers'] as Layer[] | undefined;
  if (own !== undefined) return own;
  const type = typeof wall['type'] === 'string' ? (document.types?.[wall['type']] as Json | undefined) : undefined;
  return type?.['layers'] as Layer[] | undefined;
}

/** Face offsets (a, b) of a wall: location line to left face, and to right face (Core 5.4). */
export function faceOffsets(layers: readonly Layer[], justification: string): { left: number; right: number } {
  const total = layers.reduce((sum, l) => sum + l.thickness, 0);
  switch (justification) {
    case 'exteriorFace':
      return { left: 0, right: total };
    case 'interiorFace':
      return { left: total, right: 0 };
    case 'coreFace': {
      const first = layers.findIndex((l) => l.function === 'core');
      const a = layers.slice(0, Math.max(first, 0)).reduce((sum, l) => sum + l.thickness, 0);
      return { left: a, right: total - a };
    }
    default:
      return { left: total / 2, right: total / 2 };
  }
}

/** An opening's effective width (Core 7.2): its own, else its fill's. */
export function openingWidth(document: FloorspecDocument, opening: Json): number | undefined {
  if (typeof opening['width'] === 'number') return opening['width'];
  const fill = typeof opening['fill'] === 'string' ? (document.types?.[opening['fill']] as Json | undefined) : undefined;
  return typeof fill?.['width'] === 'number' ? fill['width'] : undefined;
}

function levelsWithoutGeometry(document: FloorspecDocument): LevelView[] {
  return sortedLevels(document).map(({ id, level }) => ({
    id,
    name: typeof level['name'] === 'string' ? level['name'] : id,
    building: String(level['building']),
    elevation: Number(level['elevation']),
    height: Number(level['height']),
    junctions: [], walls: [], fills: [], separators: [], openings: [], rooms: [], faces: [], devices: [], slabs: [], roofs: [], stairs: [],
    bounds: null,
  }));
}

function levelViews(document: FloorspecDocument, derived: Derived): LevelView[] {
  const views = new Map<string, LevelView>(levelsWithoutGeometry(document).map((l) => [l.id, l]));
  const position = (id: string): Point => (document.junctions?.[id]?.position as Point | undefined) ?? [0, 0];
  const edgeCount = new Map<string, number>();
  const bump = (j: string) => edgeCount.set(j, (edgeCount.get(j) ?? 0) + 1);

  for (const [id, w] of entriesOf(document.walls)) {
    const view = views.get(String(w['level']));
    const d = derived.walls[id];
    if (view === undefined || d === undefined) continue;
    const layers = effectiveLayers(document, w) ?? [];
    const justification = typeof w['justification'] === 'string' ? w['justification'] : 'center';
    const offsets = faceOffsets(layers, justification);
    bump(String(w['start']));
    bump(String(w['end']));
    view.walls.push({
      id,
      level: view.id,
      start: String(w['start']),
      end: String(w['end']),
      a: position(String(w['start'])),
      b: position(String(w['end'])),
      ring: [d.startRight, d.endRight, d.endLeft, d.startLeft],
      thickness: offsets.left + offsets.right,
      left: offsets.left,
      right: offsets.right,
      type: typeof w['type'] === 'string' ? w['type'] : undefined,
      justification,
    });
  }
  for (const [id, s] of entriesOf(document.separators)) {
    const view = views.get(String(s['level']));
    if (view === undefined) continue;
    bump(String(s['start']));
    bump(String(s['end']));
    view.separators.push({ id, start: String(s['start']), end: String(s['end']), a: position(String(s['start'])), b: position(String(s['end'])) });
  }
  for (const [id, j] of entriesOf(document.junctions)) {
    const view = views.get(String(j['level']));
    if (view === undefined) continue;
    view.junctions.push({ id, position: j['position'] as Point, edges: edgeCount.get(id) ?? 0 });
    const fill = derived.junctionFills[id];
    if (fill !== undefined) view.fills.push({ id, ring: fill });
  }
  for (const [id, o] of entriesOf(document.openings)) {
    const wall = document.walls?.[String(o['wall'])] as Json | undefined;
    const view = wall === undefined ? undefined : views.get(String(wall['level']));
    const d = derived.openings[id];
    if (view === undefined || d === undefined) continue;
    const fill = typeof o['fill'] === 'string' ? (document.types?.[o['fill']] as Json | undefined) : undefined;
    const kind = fill?.['kind'] === 'doorType' ? 'door' : fill?.['kind'] === 'windowType' ? 'window' : 'opening';
    view.openings.push({
      id,
      wall: String(o['wall']),
      kind,
      start: d.start,
      end: d.end,
      offset: Number(o['offset']),
      width: openingWidth(document, o) ?? 0,
      hinge: o['hinge'] === 'end' ? 'end' : 'start',
      swing: o['swing'] === 'left' ? 'left' : 'right',
    });
  }
  for (const [id, r] of entriesOf(document.rooms)) {
    const view = views.get(String(r['level']));
    const d = derived.rooms[id];
    if (view === undefined || d === undefined) continue;
    const area2 = twiceArea(d.area);
    const c = derived.ceilings?.[id];
    const declared = r['ceiling'] as { kind?: string; ridge?: [Point, Point] } | undefined;
    const ceiling: RoomView['ceiling'] =
      c === undefined
        ? null
        : {
            kind: c.kind,
            low: c.low,
            high: c.high,
            ...(c.tray === undefined ? {} : { tray: [c.tray.outer, ...c.tray.holes] }),
            ...(c.kind === 'vaulted' && declared?.ridge !== undefined ? { ridge: declared.ridge } : {}),
          };
    view.rooms.push({ id, name: typeof r['name'] === 'string' ? r['name'] : id, anchor: r['anchor'] as Point, outer: d.outer, holes: d.holes, area2, ceiling, floorTop: derived.floors?.[id]?.top ?? null });
    view.faces.push({ room: id, outer: d.outer, holes: d.holes, area2 });
  }
  for (const device of deviceViews(document, derived)) views.get(device.level)?.devices.push(device);
  for (const [id, s] of entriesOf(document.slabs)) {
    const d = derived.slabs?.[id];
    if (d === undefined) continue;
    views.get(String(s['level']))?.slabs.push({ id, outline: d.outline, purpose: typeof s['purpose'] === 'string' ? s['purpose'] : undefined, top: d.top, bottom: d.bottom });
  }
  for (const [id, r] of entriesOf(document.roofs)) {
    const d = derived.roofs?.[id];
    if (d === undefined) continue;
    views.get(String(r['level']))?.roofs.push({ id, footprint: r['footprint'] as Ring, derived: d });
  }
  for (const [id, st] of entriesOf(document.stairs)) {
    const d = derived.stairs?.[id];
    if (d === undefined) continue;
    views.get(String(st['level']))?.stairs.push({ id, to: String(st['to']), form: typeof (st['form'] as Json | undefined)?.['kind'] === 'string' ? String((st['form'] as Json)['kind']) : 'straight', derived: d });
  }
  for (const free of derived.unanchored) {
    views.get(free.level)?.faces.push({ room: null, outer: free.outer, holes: free.holes, area2: twiceArea(free.area) });
  }
  for (const view of views.values()) {
    const pts: Point[] = [...view.junctions.map((j) => j.position), ...view.walls.flatMap((w) => w.ring), ...view.slabs.flatMap((s) => s.outline), ...view.stairs.flatMap((s): Point[] => [[s.derived.box.min[0], s.derived.box.min[1]], [s.derived.box.max[0], s.derived.box.max[1]]])];
    if (pts.length > 0) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      view.bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    }
    view.rooms.sort((a, b) => (a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)));
  }
  return [...views.values()];
}

/** A short human label for an element: "Wall W14", "Kitchen", "Door O3". */
export function labelOf(model: EditorModel, id: string): string {
  const kind = kindOf(model, id);
  const element = elementOf(model, id);
  const name = typeof element?.['name'] === 'string' ? element['name'] : undefined;
  switch (kind) {
    case 'room':
      return name ?? `Room ${id}`;
    case 'opening': {
      const fill = typeof element?.['fill'] === 'string' ? model.document.types?.[element['fill']] : undefined;
      const noun = (fill as Json | undefined)?.['kind'] === 'doorType' ? 'Door' : (fill as Json | undefined)?.['kind'] === 'windowType' ? 'Window' : 'Opening';
      return name === undefined ? `${noun} ${id}` : name;
    }
    case 'wall': return name ?? `Wall ${id}`;
    case 'separator': return name ?? `Separator ${id}`;
    case 'slab': return name ?? `Slab ${id}`;
    case 'roof': return name ?? `Roof ${id}`;
    case 'stair': return name ?? `Stair ${id}`;
    case 'junction': return name ?? `Junction ${id}`;
    case 'level': return name ?? `Level ${id}`;
    case 'building': return name ?? `Building ${id}`;
    case 'wallType': return name ?? `Wall type ${id}`;
    case 'doorType': return name ?? `Door type ${id}`;
    case 'windowType': return name ?? `Window type ${id}`;
    case 'material': return name ?? `Material ${id}`;
    case 'item': return name ?? `Item ${id}`;
    case 'extensionElement': {
      const at = model.ext.get(id);
      return name ?? `${at === undefined ? 'Element' : kindLabel(at.extension, at.collection, element ?? {})} ${id}`;
    }
    case 'circuit': return name === undefined ? `Circuit ${id}` : `${id} · ${name}`;
    case 'stack': return name === undefined ? `Stack ${id}` : `${id} · ${name}`;
    case 'gasSource': return name === undefined ? `Gas source ${id}` : `${id} · ${name}`;
    default: return name ?? id;
  }
}
