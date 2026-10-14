import type { Operation } from '@floorspec/ops';
import { kindOf, type EditorModel, type LevelView, type Place, type Point, type WallView } from '../model';
import { cross, dist, faceAt, project, sub } from '../geometry';
import { levelAbove, type Batch } from '../ops';
import { upgradeAtLeast } from '../openings';
import { declarationOps, setRecordMember, usedIds } from '../systems/ops';
import { recordsOf } from '../systems/view';
import { boundsOfIds } from './shapes';
import { wallsOfRoom } from './rooms';

/**
 * Copy, paste and duplicate (FLR-T-18.8). A copy is the selected elements as the document holds
 * them, with what they cannot stand without — a room's walls, a wall's openings, the types,
 * materials and assets they name — and the plan geometry a paste needs to put them down again:
 * a wall's location line, a device's placement point. It is plain JSON, so it travels on the
 * system clipboard to another tab, another level or another project.
 *
 * A paste is one batch of the Ops a person would have sent drawing the same things — drawWall,
 * addRoom, addOpening, placeElement, addElement — so the server judges it like any other and Undo
 * takes it back in one step. The batch names what it adds (`<id>-2`, `<id>-3`…): a pasted opening
 * needs its pasted wall's ID in the same batch, and the store retries with the next numbers when
 * the server answers that one was used before (FS-OPS-005). Duplicate and array are pastes of a
 * copy made on the spot, at one or many offsets.
 */

type Json = Record<string, unknown>;
type Path = (string | number)[];
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const r = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];
const plus = (p: Point, d: Point): [number, number] => r([p[0] + d[0], p[1] + d[1]]);

export type ClipKind = 'wall' | 'separator' | 'opening' | 'room' | 'slab' | 'roof' | 'stair' | 'device';

export interface ClipItem {
  id: string;
  kind: ClipKind;
  element: Json;
  /** An extension element's extension and collection. */
  extension?: string;
  collection?: string;
  /** A wall's or a separator's location line. */
  line?: [Point, Point];
  /** A piece of a wall (a room's side of a longer one): the wall it is of, and where along it the piece starts. */
  source?: string;
  from?: number;
  /** A wall's length along its location line; an opening's width. */
  length?: number;
  width?: number;
  /** A device's placement point; an opening's middle. */
  point?: Point;
  /** Members (as paths) that name another element or a record. */
  refs: Path[];
}

export interface Clip {
  floorspec: 'elements';
  version: 1;
  project: string;
  level: string;
  levelName: string;
  /** The Core draft the copy was made in: a paste into an earlier one migrates it first (Core chapter 20). */
  core: string;
  /** The middle of what was copied, in plan. */
  middle: Point;
  items: ClipItem[];
  /** Types, materials and assets the items name, to add where a paste lands without them. */
  dependencies: { id: string; collection: 'types' | 'materials' | 'assets'; element: Json }[];
  /** The circuits each copied device is a load of: a paste in the same project keeps them on it. */
  circuits: Record<string, string[]>;
  /** A copied light's FS_lighting luminaire record (its colour temperature, dimming): its copy gets one too. */
  luminaires?: Record<string, Json>;
}

/** Members a paste writes itself, not copied as they were. */
const OWN: Record<ClipKind, readonly string[]> = {
  wall: ['start', 'end', 'level', 'option'],
  separator: ['start', 'end', 'level', 'option'],
  opening: ['wall', 'offset', 'option'],
  room: ['level', 'anchor', 'brief', 'option'],
  slab: ['option'],
  roof: ['option'],
  stair: ['option'],
  device: ['host', 'option'],
};

const DEPENDENCY: ReadonlySet<Place> = new Set<Place>(['types', 'materials', 'assets']);

/** Every member path under `value` whose string names an element or record of the model, but not `own`. */
function refsIn(model: EditorModel, value: unknown, path: Path, out: Path[], skip: (path: Path) => boolean): void {
  if (skip(path)) return;
  if (typeof value === 'string') {
    if (model.index.has(value)) out.push(path);
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => { refsIn(model, v, [...path, i], out, skip); });
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) refsIn(model, v, [...path, k], out, skip);
}

const getAt = (root: unknown, path: Path): unknown => path.reduce<unknown>((v, k) => (v === null || typeof v !== 'object' ? undefined : (v as Record<string | number, unknown>)[k]), root);

/** Copy elements of a level: null when none of them is something a paste can put down. */
export function copyClip(model: EditorModel, level: LevelView, ids: readonly string[], project: string): Clip | null {
  const doc = model.document as unknown as Json;
  const wanted = new Set<string>(ids);
  // A room brings its sides — the pieces of the walls its face is bounded by — unless their walls are copied whole.
  const pieces = ids.filter((id) => kindOf(model, id) === 'room').flatMap((room) => wallsOfRoom(level, room)).filter((p) => !wanted.has(p.wall.id));
  // A wall brings its openings; a piece, those wholly on it.
  for (const o of level.openings) if (wanted.has(o.wall)) wanted.add(o.id);

  const items: ClipItem[] = [];
  const pieceIds = new Set<string>();
  for (const piece of pieces) {
    const e = (doc['walls'] as Record<string, Json | undefined> | undefined)?.[piece.wall.id];
    if (e === undefined) continue;
    let id = piece.wall.id;
    for (let n = 2; pieceIds.has(id) || wanted.has(id); n++) id = `${piece.wall.id}.${String(n)}`;
    pieceIds.add(id);
    const element = clone(e);
    for (const k of OWN.wall) Reflect.deleteProperty(element, k);
    const refs: Path[] = [];
    refsIn(model, element, [], refs, () => false);
    const length = dist(piece.a, piece.b);
    items.push({ id, kind: 'wall', element, line: [piece.a, piece.b], length, source: piece.wall.id, from: piece.from, refs });
    for (const o of level.openings) {
      if (o.wall !== piece.wall.id || wanted.has(o.id)) continue;
      const start = o.offset - piece.from;
      if (start < -1 || start + o.width > length + 1) continue;
      const oe = (doc['openings'] as Record<string, Json | undefined> | undefined)?.[o.id];
      if (oe === undefined) continue;
      const element = clone(oe);
      element['wall'] = id;
      delete element['option'];
      const orefs: Path[] = [];
      refsIn(model, element, [], orefs, (p) => p.length === 1 && OWN.opening.includes(String(p[0])));
      items.push({ id: o.id, kind: 'opening', element, width: o.width, point: [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2], length: Math.max(0, start), refs: orefs });
      wanted.add(o.id);
    }
  }
  const wallsById = new Map(level.walls.map((w) => [w.id, w]));
  for (const id of wanted) {
    if (items.some((i) => i.id === id)) continue;
    const kind = kindOf(model, id);
    const coll = (c: string) => (doc[c] as Record<string, Json | undefined> | undefined)?.[id];
    let item: Omit<ClipItem, 'refs'> | null = null;
    if (kind === 'wall') {
      const w = wallsById.get(id);
      const e = coll('walls');
      if (w !== undefined && e !== undefined) item = { id, kind, element: clone(e), line: [w.a, w.b], length: w.arc?.length ?? dist(w.a, w.b) };
    } else if (kind === 'separator') {
      const s = level.separators.find((x) => x.id === id);
      const e = coll('separators');
      if (s !== undefined && e !== undefined) item = { id, kind, element: clone(e), line: [s.a, s.b] };
    } else if (kind === 'opening') {
      const o = level.openings.find((x) => x.id === id);
      const e = coll('openings');
      if (o !== undefined && e !== undefined) item = { id, kind, element: clone(e), width: o.width, point: [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2], length: o.offset };
    } else if (kind === 'room' || kind === 'slab' || kind === 'roof' || kind === 'stair') {
      const e = coll(kind === 'room' ? 'rooms' : `${kind}s`);
      const onLevel = e !== undefined && e['level'] === level.id;
      if (onLevel) item = { id, kind, element: clone(e) };
    } else if (kind === 'extensionElement') {
      const d = level.devices.find((x) => x.id === id);
      const where = model.ext.get(id);
      if (d !== undefined && where !== undefined) item = { id, kind: 'device', element: clone(d.element), extension: where.extension, collection: where.collection, ...(d.placement === null ? {} : { point: d.placement.point }) };
    }
    if (item === null) continue;
    Reflect.deleteProperty(item.element, 'option');
    const own = OWN[item.kind];
    const refs: Path[] = [];
    refsIn(model, item.element, [], refs, (p) => p.length === 1 && own.includes(String(p[0])) || (item.kind === 'device' && p[0] === 'fallback' && p[1] === 'level'));
    items.push({ ...item, refs });
  }
  if (items.length === 0) return null;

  // What the items name that lives beside them: types, materials, assets — and what those name.
  const dependencies: Clip['dependencies'] = [];
  const seen = new Set<string>();
  const queue = items.flatMap((i) => i.refs.map((p) => getAt(i.element, p))).filter((v): v is string => typeof v === 'string');
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const place = model.index.get(id);
    if (seen.has(id) || place === undefined || !DEPENDENCY.has(place)) continue;
    seen.add(id);
    const element = (doc[place] as Record<string, Json | undefined> | undefined)?.[id];
    if (element === undefined) continue;
    dependencies.push({ id, collection: place as 'types' | 'materials' | 'assets', element: clone(element) });
    const refs: Path[] = [];
    refsIn(model, element, [], refs, () => false);
    for (const p of refs) {
      const v = getAt(element, p);
      if (typeof v === 'string') queue.push(v);
    }
  }
  const circuits: Record<string, string[]> = {};
  for (const [cid, c] of recordsOf(model.document, 'FS_electrical', 'circuits')) {
    const loads = Array.isArray(c['loads']) ? (c['loads'] as unknown[]).map(String) : [];
    for (const item of items) if (item.kind === 'device' && loads.includes(item.id)) (circuits[item.id] ??= []).push(cid);
  }
  const lighting = (model.document.extensions as Json | undefined)?.['FS_lighting'];
  const records = isObject(lighting) && isObject(lighting['luminaires']) ? lighting['luminaires'] : {};
  const luminaires: Record<string, Json> = {};
  for (const item of items) {
    const record = records[item.id];
    if (item.kind === 'device' && isObject(record)) luminaires[item.id] = clone(record);
  }
  const b = boundsOfIds(level, items.map((i) => i.id));
  const levelName = (model.document.levels?.[level.id] as { name?: string } | undefined)?.name ?? level.id;
  return { floorspec: 'elements', version: 1, project, level: level.id, levelName, core: model.document.floorspec, middle: b === null ? [0, 0] : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], items, dependencies, circuits, ...(Object.keys(luminaires).length > 0 ? { luminaires } : {}) };
}

/** A clip read back from the clipboard's text, or null when the text is not one. */
export function readClip(text: string): Clip | null {
  try {
    const v = JSON.parse(text) as Partial<Clip>;
    return v.floorspec === 'elements' && v.version === 1 && Array.isArray(v.items) ? (v as Clip) : null;
  } catch {
    return null;
  }
}

// ─── Paste ──────────────────────────────────────────────────────────────────────────────────

export interface PasteOptions {
  /** Where each copy goes, as an offset from where the items were: one for a paste, many for an array. */
  offsets: readonly Point[];
  /** The store's retry count: the names a batch picks start one further on each time. */
  attempt: number;
  /** The clip came from this project — references to its elements and records may be kept. */
  sameProject: boolean;
  /** Add each copied device to the circuits its original is on (same project only). */
  keepCircuits?: boolean;
}

export interface Pasted {
  batch: Batch;
  /** The IDs the batch gives what it adds, in order. */
  ids: string[];
  /** Items that had nowhere to go — a wall-face device with no wall under it on this level. */
  skipped: string[];
}

/** The wall on a level whose location line runs through a point (within its thickness), and how far along. */
export function wallAt(level: LevelView, p: Point, slack = 0): { wall: WallView; offset: number; side: 'left' | 'right' } | null {
  let best: { wall: WallView; offset: number; side: 'left' | 'right'; d: number } | null = null;
  for (const w of level.walls) {
    const L = dist(w.a, w.b);
    if (L === 0 || w.arc !== undefined) continue;
    const pr = project(p, w.a, w.b);
    if (pr.t <= 0 || pr.t >= 1) continue;
    const reach = Math.max(w.left, w.right) + slack;
    if (pr.distance > reach || (best !== null && pr.distance >= best.d)) continue;
    best = { wall: w, offset: pr.t * L, side: cross(sub(w.b, w.a), sub(p, w.a)) > 0 ? 'left' : 'right', d: pr.distance };
  }
  return best === null ? null : { wall: best.wall, offset: best.offset, side: best.side };
}

/** The paste of a clip onto a level, at each offset. */
export function pasteBatch(model: EditorModel, level: LevelView, clip: Clip, o: PasteOptions): Pasted {
  const doc = model.document;
  const used = usedIds(doc);
  const taken = new Set<string>();
  const ops: Operation[] = [];
  const ids: string[] = [];
  const skipped: string[] = [];
  const sameLevel = o.sameProject && clip.level === level.id;

  /** The next free name for a copy of `id`: its base and -2, -3 … (and on further on a retry). */
  const mint = (id: string): string => {
    const base = id.replace(/-\d+$/, '');
    for (let n = 2 + o.attempt; ; n++) {
      const candidate = `${base}-${String(n)}`;
      if (!used.has(candidate) && !taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };

  // What the target lacks first: the draft a roof, a stair or an arc needs, extensions declared, dependencies added.
  const kinds = new Set(clip.items.map((i) => i.kind));
  const needs = clip.items.some((i) => i.kind === 'wall' && i.element['arc'] !== undefined) || (!o.sameProject && clip.core === '0.4') ? '0.4' : kinds.has('roof') || kinds.has('stair') || (!o.sameProject && clip.core === '0.3') ? '0.3' : null;
  if (needs !== null) ops.push(...(upgradeAtLeast(doc, needs)));
  for (const ext of new Set(clip.items.map((i) => i.extension).filter((e): e is string => e !== undefined))) ops.push(...(declarationOps(doc, ext)));
  for (const dep of clip.dependencies) if (!model.index.has(dep.id)) ops.push({ op: 'addElement', collection: dep.collection, id: dep.id, element: clone(dep.element) });

  const byKind = (k: ClipKind) => clip.items.filter((i) => i.kind === k);
  const circuitLoads = new Map<string, string[]>();

  for (const offset of o.offsets) {
    const map = new Map<string, string>();
    for (const item of clip.items) if (item.kind === 'wall' || item.kind === 'separator' || item.kind === 'room' || item.kind === 'device') map.set(item.id, mint(item.source ?? item.id));
    // References: to an element copied with it, its copy; to one the target has, kept (same project); otherwise dropped.
    const rewrite = (item: ClipItem): Json => {
      const element = clone(item.element);
      const drops: Path[] = [];
      for (const path of item.refs) {
        const v = getAt(element, path);
        if (typeof v !== 'string') continue;
        const copied = map.get(v);
        const parent = getAt(element, path.slice(0, -1)) as Record<string | number, unknown>;
        const key = path[path.length - 1] as string | number;
        if (copied !== undefined) parent[key] = copied;
        else if (clip.dependencies.some((d) => d.id === v) || (o.sameProject && model.index.has(v))) continue;
        else drops.push(path);
      }
      // Dropped from the deepest, and from the end of an array first, so earlier paths stay right.
      for (const path of drops.reverse()) {
        const parent = getAt(element, path.slice(0, -1));
        const key = path[path.length - 1] as string | number;
        if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
        else if (isObject(parent)) Reflect.deleteProperty(parent, key);
      }
      for (const k of OWN[item.kind]) Reflect.deleteProperty(element, k);
      return element;
    };
    /** setProperty for every member a composite does not take. */
    const rest = (id: string, element: Json, taken: readonly string[]) => {
      for (const [k, v] of Object.entries(element)) if (!taken.includes(k) && v !== undefined) ops.push({ op: 'setProperty', id, path: `/${k}`, value: v });
    };

    // Walls and separators: drawn between their ends, moved.
    for (const item of [...byKind('wall'), ...byKind('separator')]) {
      const id = map.get(item.id) as string;
      const [a, b] = item.line as [Point, Point];
      const element = rewrite(item);
      if (item.kind === 'separator') {
        ops.push({ op: 'drawSeparator', id, level: level.id, from: plus(a, offset), to: plus(b, offset) });
        rest(id, element, []);
      } else {
        const members = ['type', 'layers', 'justification', 'base', 'top', 'name', 'extensions', 'extras'] as const;
        const draw: Json = { op: 'drawWall', id, level: level.id, from: plus(a, offset), to: plus(b, offset) };
        for (const m of members) if (element[m] !== undefined) draw[m] = element[m];
        ops.push(draw as unknown as Operation);
        rest(id, element, members);
      }
      ids.push(id);
    }
    // Rooms: named at their anchor, moved; a copy beside its original in the same project gets a number.
    const names = new Set(Object.values(doc.rooms ?? {}).map((x) => (x as { name?: string } | undefined)?.name));
    for (const item of byKind('room')) {
      const id = map.get(item.id) as string;
      const element = rewrite(item);
      const anchor = item.element['anchor'] as Point;
      let name = typeof element['name'] === 'string' ? element['name'] : undefined;
      if (name !== undefined && o.sameProject && names.has(name)) {
        const base = name.replace(/ \d+$/, '');
        for (let n = 2; ; n++) if (!names.has(`${base} ${String(n)}`)) { name = `${base} ${String(n)}`; break; }
      }
      if (name !== undefined) names.add(name);
      const add: Json = { op: 'addRoom', id, level: level.id, at: plus(anchor, offset) };
      if (name !== undefined) add['name'] = name;
      for (const m of ['function', 'wallFinish', 'floorFinish', 'ceilingFinish'] as const) if (element[m] !== undefined) add[m] = element[m];
      ops.push(add as unknown as Operation);
      const ceiling = element['ceiling'];
      if (isObject(ceiling) && Array.isArray(ceiling['ridge'])) ceiling['ridge'] = (ceiling['ridge'] as Point[]).map((p) => plus(p, offset));
      rest(id, element, ['name', 'function', 'wallFinish', 'floorFinish', 'ceilingFinish']);
      ids.push(id);
    }
    // Openings: on their copied wall at the same offset, or slid along the wall they were on, or on whatever wall is there.
    for (const item of byKind('opening')) {
      const element = rewrite(item);
      const source = String(item.element['wall']);
      const width = item.width ?? 0;
      let wall: string | undefined = map.get(source);
      let at = item.length ?? 0;
      if (wall === undefined) {
        const host = sameLevel ? level.walls.find((w) => w.id === source) : undefined;
        const mid = plus(item.point ?? [0, 0], offset);
        const found = host !== undefined ? { wall: host, offset: project(mid, host.a, host.b).t * dist(host.a, host.b) } : wallAt(level, mid);
        if (found === null) {
          skipped.push(item.id);
          continue;
        }
        wall = found.wall.id;
        at = Math.max(0, Math.min(Math.round(dist(found.wall.a, found.wall.b) - width), Math.round(found.offset - width / 2)));
      }
      const id = mint(item.id);
      const add: Json = { op: 'addOpening', id, wall, at: Math.round(at) };
      const members = ['fill', 'width', 'height', 'sill', 'hinge', 'swing', 'name'] as const;
      for (const m of members) if (element[m] !== undefined) add[m] = element[m];
      ops.push(add as unknown as Operation);
      rest(id, element, members);
      ids.push(id);
    }
    // Slabs, roofs and stairs: added whole, their points moved, on this level.
    for (const item of [...byKind('slab'), ...byKind('roof'), ...byKind('stair')]) {
      const element = rewrite(item);
      element['level'] = level.id;
      if (item.kind === 'slab' && Array.isArray(element['boundary'])) element['boundary'] = (element['boundary'] as Point[]).map((p) => plus(p, offset));
      if (item.kind === 'roof' && Array.isArray(element['footprint'])) element['footprint'] = (element['footprint'] as Point[]).map((p) => plus(p, offset));
      if (item.kind === 'stair') {
        element['position'] = plus(element['position'] as Point, offset);
        const to = sameLevel ? element['to'] : levelAbove(doc, level.id);
        if (typeof to !== 'string') {
          skipped.push(item.id);
          continue;
        }
        element['to'] = to;
      }
      const id = mint(item.id);
      ops.push({ op: 'addElement', collection: `${item.kind}s`, id, element });
      ids.push(id);
    }
    // Devices and furniture: placed on a host like the original's, moved.
    for (const item of byKind('device')) {
      const id = map.get(item.id) as string;
      const element = rewrite(item);
      const host = isObject(item.element['host']) ? item.element['host'] : null;
      if (host === null) {
        // A hostless element (a landscape bed, a lawn): its points and its fallback box moved.
        for (const m of ['boundary', 'points']) if (Array.isArray(element[m])) element[m] = (element[m] as Point[]).map((p) => plus(p, offset));
        const fb = element['fallback'];
        if (isObject(fb)) {
          fb['level'] = level.id;
          const box = fb['box'];
          if (isObject(box) && Array.isArray(box['min']) && Array.isArray(box['max'])) {
            const min = box['min'] as number[];
            const max = box['max'] as number[];
            box['min'] = [Math.round((min[0] ?? 0) + offset[0]), Math.round((min[1] ?? 0) + offset[1]), min[2] ?? 0];
            box['max'] = [Math.round((max[0] ?? 0) + offset[0]), Math.round((max[1] ?? 0) + offset[1]), max[2] ?? 0];
          }
        }
        ops.push({ op: 'addElement', collection: item.collection as string, extension: item.extension as string, id, element });
        ids.push(id);
        continue;
      }
      const placed = hostFor(level, item, host, offset, { map, sameLevel, pieces: clip.items.filter((i) => i.source !== undefined) });
      if (placed === null) {
        map.delete(item.id);
        skipped.push(item.id);
        continue;
      }
      ops.push({ op: 'placeElement', extension: item.extension, collection: item.collection, id, host: placed, element } as unknown as Operation);
      ids.push(id);
      // Its luminaire record, where the document reads FS_lighting.
      const record = clip.luminaires?.[item.id];
      if (record !== undefined && Object.hasOwn((doc as { extensionsUsed?: Record<string, unknown> }).extensionsUsed ?? {}, 'FS_lighting')) ops.push({ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/luminaires/${id}`, value: clone(record) });
      if (o.sameProject && o.keepCircuits !== false) for (const cid of clip.circuits[item.id] ?? []) circuitLoads.set(cid, [...(circuitLoads.get(cid) ?? []), id]);
    }
  }
  // Each copy on its original's circuit: one write of each circuit's loads.
  for (const [cid, added] of circuitLoads) {
    const c = recordsOf(doc, 'FS_electrical', 'circuits').find(([x]) => x === cid)?.[1];
    if (c === undefined) continue;
    const loads = Array.isArray(c['loads']) ? (c['loads'] as string[]) : [];
    ops.push(...(setRecordMember('FS_electrical', 'circuits', cid, 'loads', [...loads, ...added])));
  }
  return { batch: ops, ids, skipped };
}

/** The host reference (Ops 4.10) a pasted device goes on, or null when there is nowhere for it. */
function hostFor(level: LevelView, item: ClipItem, host: Json, offset: Point, o: { map: ReadonlyMap<string, string>; sameLevel: boolean; pieces: readonly ClipItem[] }): Json | null {
  const mode = host['mode'];
  if (mode === 'wallFace') {
    const source = String(host['wall']);
    const height = host['height'];
    const side = host['side'];
    const copied = o.map.get(source);
    if (copied !== undefined) return { mode: 'wallFace', wall: copied, side, at: host['offset'], height };
    // On a room's side copied as a piece of its wall: measured from where the piece starts.
    const piece = o.pieces.find((p) => p.source === source && Number(host['offset']) >= (p.from ?? 0) - 1 && Number(host['offset']) <= (p.from ?? 0) + (p.length ?? 0) + 1);
    if (piece !== undefined) {
      const wall = o.map.get(piece.id);
      if (wall !== undefined) return { mode: 'wallFace', wall, side, at: Math.max(0, Math.round(Number(host['offset']) - (piece.from ?? 0))), height };
    }
    const wall = o.sameLevel ? level.walls.find((w) => w.id === source) : undefined;
    if (wall !== undefined) {
      // Along the same face: the offset's run along the wall (all of it, when it is square to the wall).
      const L = dist(wall.a, wall.b);
      const dir: Point = L === 0 ? [1, 0] : [(wall.b[0] - wall.a[0]) / L, (wall.b[1] - wall.a[1]) / L];
      let along = offset[0] * dir[0] + offset[1] * dir[1];
      if (Math.abs(along) < 1 && (offset[0] !== 0 || offset[1] !== 0)) along = Math.hypot(offset[0], offset[1]);
      const at = Math.round(Number(host['offset']) + along);
      if (at < 0 || at > Math.floor(L)) return null;
      return { mode: 'wallFace', wall: wall.id, side, at, height };
    }
    // Another level or project: the wall that stands where it was.
    const point = item.point;
    if (point === undefined) return null;
    const found = wallAt(level, plus(point, offset), 25_600);
    if (found === null) return null;
    return { mode: 'wallFace', wall: found.wall.id, side: found.side, at: Math.round(found.offset), height };
  }
  const position = host['position'];
  if (!Array.isArray(position)) return null;
  const at = plus(position as unknown as Point, offset);
  const rotation = typeof host['rotation'] === 'number' && host['rotation'] !== 0 ? { rotation: host['rotation'] } : {};
  if (mode === 'surface') {
    const room = String(host['room']);
    const surface = host['surface'] === 'ceiling' ? 'ceiling' : 'floor';
    const landed = o.map.get(room) ?? faceAt(level, at)?.room ?? null;
    if (landed !== null) return { mode: 'surface', room: landed, surface, at, ...rotation };
    if (surface === 'ceiling') return null;
    return { mode: 'free', level: level.id, at, ...rotation };
  }
  return { mode: 'free', level: level.id, at, ...rotation };
}
