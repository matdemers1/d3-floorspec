/**
 * One level of a document, as the renderer draws it: every coordinate is a value the engine
 * derived exactly and rounded once (Core 2.2) — face ends, junction fills, room polygons, opening
 * points. Nothing here recomputes geometry; the only arithmetic left for the drawing is placing
 * symbols (door leaves, glazing lines) relative to those points.
 */
import {
  arcFits,
  arcPolyline,
  deriveFrom,
  evaluate,
  extElements,
  facingVector,
  InvalidDocumentError,
  OFFICIAL_READER,
  sagittaOf,
  type Derived,
  type DerivedRoof,
  type DerivedStair,
  type DoorOperation,
  type Evaluation,
  type FloorspecDocument,
  type ValidateOptions,
} from '@floorspec/engine';

const ipoint = (p: readonly [number, number]): readonly [bigint, bigint] => [BigInt(p[0]), BigInt(p[1])];
const toPt = (p: readonly [bigint, bigint]): Pt => [Number(p[0]), Number(p[1])];
import { columnRadius, newelOutline } from './symbols.js';
import type { BoxFrame } from './plansymbols.js';

export type Pt = readonly [number, number];

export interface SceneWall {
  readonly id: string;
  /**
   * startRight → endRight → endLeft → startLeft, rounded, repeats removed (Core 5.7); for an arc wall,
   * through its right face vertices and back through its left (Core 0.4, 21.4).
   */
  readonly outline: readonly Pt[];
  readonly start: Pt;
  readonly end: Pt;
  /** Its location line: an arc wall's polyline (21.2), or [start, end]. */
  readonly line: readonly Pt[];
  /** An arc wall's sagitta (21.1), when it has one. */
  readonly sagitta?: number;
  /** Face offsets (Core 5.4), in base units: left (exterior) and right. */
  readonly a: number;
  readonly b: number;
}

export interface SceneSeparator {
  readonly id: string;
  readonly start: Pt;
  readonly end: Pt;
  /** Its location line: an arc separator's polyline (Core 0.4, 21.2), or [start, end]. */
  readonly line: readonly Pt[];
}

export type OpeningKind = 'door' | 'window' | 'opening';

export interface SceneOpening {
  readonly id: string;
  readonly wall: string;
  readonly kind: OpeningKind;
  /** The derived start and end points on the wall's location line (Core 7.4). */
  readonly start: Pt;
  readonly end: Pt;
  readonly hinge: 'start' | 'end';
  readonly swing: 'left' | 'right';
  /** A door's fill type's operation (Core 8.4), when it declares one: how its symbol is drawn. */
  readonly operation?: DoorOperation;
}

export interface SceneRoom {
  readonly id: string;
  readonly name: string | undefined;
  readonly function: string;
  readonly outer: readonly Pt[];
  readonly holes: readonly (readonly Pt[])[];
  /** Net area in square base units, as the engine derives it (`N` or `N.5`). */
  readonly area: string;
  /**
   * Its ceiling, as the engine derives it (Core 0.3, 15.5): the kind, a tray's centre (its rings),
   * a vault's ridge points as the document declares them.
   */
  readonly ceiling: { readonly kind: 'flat' | 'tray' | 'vaulted'; readonly tray?: readonly (readonly Pt[])[]; readonly ridge?: readonly [Pt, Pt] } | undefined;
}

/** A slab (Core 6.7) as the engine derives its outline (Core 0.3, 15.7). */
export interface SceneSlab {
  readonly id: string;
  /** Counter-clockwise from its least vertex. */
  readonly outline: readonly Pt[];
  readonly purpose: string | undefined;
}

export interface SceneFace {
  readonly outer: readonly Pt[];
  readonly holes: readonly (readonly Pt[])[];
  readonly area: string;
}

/** An extension element's fallback box in plan (Core 0.2, 12.6): what a core-only reader shows. */
export interface SceneFallback {
  readonly id: string;
  readonly extension: string;
  readonly collection: string;
  /** Four points, counter-clockwise, as the engine derived them (13.2). */
  readonly footprint: readonly Pt[];
  /** What the element is, when its extension says: FS_furniture's `category`, FS_plumbing's `fixture`. */
  readonly category?: string;
  /**
   * Its box in plan, corner by corner (FLR-T-12.24): the footprint's vertex at the frame's (min x, min y)
   * and the box's sides from it — which way its front faces, for its symbol or outline.
   */
  readonly frame?: BoxFrame;
  /** Its fallback's 2D symbol (Core 12.6), when it names a packaged asset with a digest. */
  readonly symbol?: { readonly id: string; readonly sha256: string; readonly mediaType: string };
}

/** A clearance envelope in plan (Core 0.2, 13.5), by owner — an opening or an extension element — and name. */
export interface SceneClearance {
  readonly owner: string;
  readonly name: string;
  readonly purpose: string;
  readonly footprint: readonly Pt[];
}

export interface Scene {
  readonly projectName: string;
  readonly levelId: string;
  readonly levelName: string | undefined;
  /** The site's true north, in microdegrees counter-clockwise from project north (Core 1.8). */
  readonly trueNorth: number;
  readonly walls: ReadonlyMap<string, SceneWall>;
  readonly fills: ReadonlyMap<string, readonly Pt[]>;
  readonly separators: ReadonlyMap<string, SceneSeparator>;
  readonly openings: ReadonlyMap<string, SceneOpening>;
  readonly rooms: ReadonlyMap<string, SceneRoom>;
  readonly unanchored: readonly SceneFace[];
  /** Extension elements on this level, by ID (Core 0.2; empty for a 0.1 document). */
  readonly fallbacks: ReadonlyMap<string, SceneFallback>;
  /** Clearance envelopes on this level, by owner then name. */
  readonly clearances: readonly SceneClearance[];
  /** Slabs on this level, by ID (Core 0.3, 15.7). */
  readonly slabs: ReadonlyMap<string, SceneSlab>;
  /** Roofs on this level, by ID, as derived (Core 0.3, 16.5). */
  readonly roofs: ReadonlyMap<string, DerivedRoof>;
  /** Stairs rising from this level, by ID, as derived (Core 0.3 and 0.4, 17.4–17.7), with their form and a spiral's column radius. */
  readonly stairs: ReadonlyMap<string, SceneStair>;
  /** Stairs rising to this level from another, by ID: what is seen of them through the floor's well. */
  readonly stairsBelow: ReadonlyMap<string, SceneStair>;
}

export interface SceneStair {
  readonly derived: DerivedStair;
  readonly form: string;
  readonly column: number;
  readonly newel: readonly Pt[] | null;
}

/** A collection as [id, element] pairs sorted by ID (absent: empty). */
function entries<T>(c: Readonly<Record<string, T | undefined>> | undefined): [string, T][] {
  if (!c) return [];
  return Object.keys(c)
    .sort()
    .map((k) => [k, c[k] as T]);
}

const byId = <T>(m: Map<string, T>): Map<string, T> => new Map([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function dedupeCyclic(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

/** The level a plan shows when none is named: the lowest by elevation, then by ID. */
export function defaultLevel(doc: FloorspecDocument): string | undefined {
  const levels = entries(doc.levels).sort(([ia, a], [ib, b]) =>
    a.elevation !== b.elevation ? a.elevation - b.elevation : ia < ib ? -1 : ia > ib ? 1 : 0,
  );
  return levels[0]?.[0];
}

/**
 * The reader a document is validated with when render2d is given the document itself (Core 1.6.4,
 * 12.2): the extensions it implements, the extensions it knows, the newest Core draft it reads and,
 * for a package validator, the package's files. Everything `ValidateOptions` holds but the design,
 * which is a drawing option of its own.
 */
export type ReaderOptions = Omit<ValidateOptions, 'design'>;

/**
 * The reader render2d validates with when the caller names none: the one the reference
 * implementation runs everywhere (`OFFICIAL_READER`), so a document that requires an official
 * extension is drawn. A caller with a reader of its own passes it as `reader`; a caller that has
 * already evaluated the document passes the evaluation (`sceneOf`, `renderEvaluation`) and nothing
 * is validated again.
 */
export const DEFAULT_READER: ReaderOptions = OFFICIAL_READER;

/**
 * Validate and derive a document with `reader` (default `DEFAULT_READER`), and keep one level of
 * it. Throws InvalidDocumentError when the document is not valid — a plan is only drawn from
 * geometry the engine can derive. A document with design options (Core 0.3, chapter 19) is drawn in
 * one design: `design`, a design input (19.6), or the primary design; a design the engine derives
 * nothing for is a RangeError. A caller that has evaluated the document already calls `sceneOf`.
 */
export function buildScene(input: string | Uint8Array | object, level?: string, design?: Readonly<Record<string, string>>, reader: ReaderOptions = DEFAULT_READER): Scene {
  return sceneOf(evaluate(input, design === undefined ? reader : { ...reader, design }), level);
}

/**
 * One level of a document the caller has already evaluated — with its own reader and in the design
 * it chose — drawn without validating it again. `derived`, when the caller has it, is Core's derived
 * values of that evaluation's view (`deriveFrom(ev.view, ev.analysis)` or `deriveEvaluation(ev)`),
 * so several levels of one document derive it once. Throws InvalidDocumentError for an evaluation
 * that is not valid, and RangeError when it derived nothing (no such design, 19.6.2) or the document
 * has no such level.
 */
export function sceneOf(ev: Evaluation, level?: string, given?: Derived): Scene {
  if (!ev.valid || !ev.document) throw new InvalidDocumentError(ev.diagnostics);
  if (!ev.view || !ev.analysis) throw new RangeError('the document has no such design, or it is not valid (Core 19.6.2)');
  const doc = ev.view;
  const analysis = ev.analysis;
  const derived = given ?? deriveFrom(doc, analysis);
  const lid = level ?? defaultLevel(doc);
  const lvl = lid === undefined ? undefined : doc.levels?.[lid];
  if (lid === undefined || !lvl || !Object.hasOwn(doc.levels ?? {}, lid)) throw new RangeError(`the document has no level ${level ?? ''}`.trim());

  const walls = new Map<string, SceneWall>();
  for (const [id, w] of entries(doc.walls)) {
    if (w.level !== lid) continue;
    const d = derived.walls[id]!;
    const o = analysis.offsets.get(id)!;
    const start = doc.junctions![w.start]!.position;
    const end = doc.junctions![w.end]!.position;
    walls.set(id, {
      id,
      outline: dedupeCyclic([d.startRight, ...(d.right ?? []), d.endRight, d.endLeft, ...[...(d.left ?? [])].reverse(), d.startLeft]),
      start,
      end,
      line: d.polyline ?? [start, end],
      ...(w.arc === undefined ? {} : { sagitta: w.arc.sagitta }),
      a: Number(o.a2) / 2,
      b: Number(o.b2) / 2,
    });
  }

  const fills = new Map<string, readonly Pt[]>();
  for (const [id, ring] of Object.entries(derived.junctionFills)) if (doc.junctions![id]!.level === lid) fills.set(id, ring);

  const separators = new Map<string, SceneSeparator>();
  for (const [id, s] of entries(doc.separators)) {
    if (s.level !== lid) continue;
    const start = doc.junctions![s.start]!.position;
    const end = doc.junctions![s.end]!.position;
    const h = sagittaOf(s);
    const line = h === undefined || !arcFits(ipoint(start), ipoint(end), h) ? [start, end] : arcPolyline(ipoint(start), ipoint(end), h).map(toPt);
    separators.set(id, { id, start, end, line });
  }

  const openings = new Map<string, SceneOpening>();
  for (const [id, o] of entries(doc.openings)) {
    if (!walls.has(o.wall)) continue;
    const fill = o.fill === undefined ? undefined : doc.types?.[o.fill];
    const kind: OpeningKind = fill?.kind === 'doorType' ? 'door' : fill?.kind === 'windowType' ? 'window' : 'opening';
    const d = derived.openings[id]!;
    const operation = fill?.kind === 'doorType' ? fill.operation : undefined;
    openings.set(id, { id, wall: o.wall, kind, start: d.start, end: d.end, hinge: o.hinge ?? 'start', swing: o.swing ?? 'right', ...(operation === undefined ? {} : { operation }) });
  }

  const rooms = new Map<string, SceneRoom>();
  for (const [id, r] of entries(doc.rooms)) {
    if (r.level !== lid) continue;
    const p = derived.rooms[id]!;
    const c = derived.ceilings?.[id];
    const ridge = c?.kind === 'vaulted' && r.ceiling?.kind === 'vaulted' ? (r.ceiling.ridge as unknown as readonly [Pt, Pt]) : undefined;
    rooms.set(id, {
      id,
      name: r.name,
      function: r.function ?? 'unspecified',
      outer: p.outer,
      holes: p.holes,
      area: p.area,
      ceiling: c === undefined ? undefined : { kind: c.kind, ...(c.tray === undefined ? {} : { tray: [c.tray.outer, ...c.tray.holes] }), ...(ridge === undefined ? {} : { ridge }) },
    });
  }

  const unanchored = derived.unanchored.filter((u) => u.level === lid).map((u) => ({ outer: u.outer, holes: u.holes, area: u.area }));

  const fallbacks = new Map<string, SceneFallback>();
  const elements = new Map(extElements(doc).map((x) => [x.id, x.element as unknown as Json]));
  for (const [id, fb] of entries(derived.fallbacks)) {
    if (fb.level !== lid) continue;
    const element = elements.get(id);
    const frame = element === undefined ? undefined : boxFrame(element, fb.footprint, derived.placements?.[id]);
    const category = element === undefined ? undefined : categoryOf(element);
    const symbol = element === undefined ? undefined : symbolOf(doc, element);
    fallbacks.set(id, {
      id,
      extension: fb.extension,
      collection: fb.collection,
      footprint: fb.footprint,
      ...(category === undefined ? {} : { category }),
      ...(frame === undefined ? {} : { frame }),
      ...(symbol === undefined ? {} : { symbol }),
    });
  }
  const clearances: SceneClearance[] = [];
  for (const [owner, envs] of entries(derived.clearances))
    for (const [name, env] of entries(envs)) if (env.level === lid) clearances.push({ owner, name, purpose: env.purpose, footprint: env.footprint });

  const slabs = new Map<string, SceneSlab>();
  for (const [id, sl] of entries(doc.slabs)) {
    const d = derived.slabs?.[id];
    if (sl.level === lid && d !== undefined) slabs.set(id, { id, outline: d.outline, purpose: sl.purpose });
  }

  const roofs = new Map<string, DerivedRoof>();
  for (const [id, rf] of entries(doc.roofs)) {
    const d = derived.roofs?.[id];
    if (rf.level === lid && d !== undefined) roofs.set(id, d);
  }
  const stairs = new Map<string, SceneStair>();
  const stairsBelow = new Map<string, SceneStair>();
  for (const [id, st] of entries(doc.stairs)) {
    const d = derived.stairs?.[id];
    if (d === undefined) continue;
    const seen = { derived: d, form: st.form?.kind ?? 'straight', column: columnRadius(st), newel: newelOutline(st) };
    if (st.level === lid) stairs.set(id, seen);
    else if (st.to === lid) stairsBelow.set(id, seen);
  }

  return {
    projectName: doc.project.name,
    levelId: lid,
    levelName: lvl.name,
    trueNorth: doc.site?.trueNorth ?? 0,
    walls: byId(walls),
    fills: byId(fills),
    separators: byId(separators),
    openings: byId(openings),
    rooms: byId(rooms),
    unanchored,
    fallbacks: byId(fallbacks),
    clearances,
    slabs: byId(slabs),
    roofs: byId(roofs),
    stairs: byId(stairs),
    stairsBelow: byId(stairsBelow),
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an extension element is, in its extension's own term: FS_furniture's `category`, FS_plumbing's `fixture`, `heater` or `receptor`. */
function categoryOf(element: Json): string | undefined {
  for (const k of ['category', 'fixture', 'heater', 'receptor']) if (typeof element[k] === 'string') return element[k];
  return undefined;
}

/** An element's fallback symbol (Core 12.6), when it names an asset of the document with a SHA-256. */
function symbolOf(doc: FloorspecDocument, element: Json): SceneFallback['symbol'] {
  const fb = element['fallback'];
  const id = isObject(fb) ? fb['symbol'] : undefined;
  if (typeof id !== 'string') return undefined;
  const assets = doc.assets as Record<string, unknown> | undefined;
  const a = assets !== undefined && Object.hasOwn(assets, id) ? assets[id] : undefined;
  if (!isObject(a) || typeof a['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(a['sha256'])) return undefined;
  return { id, sha256: a['sha256'], mediaType: typeof a['mediaType'] === 'string' ? a['mediaType'] : '' };
}

/**
 * An element's box in plan, corner by corner: its frame (Core 13.1) — its placement, else its level's
 * — maps the box's corners, and each is snapped to the footprint vertex the engine derived for it,
 * so the corners drawn are the engine's own points and only their order is worked out here.
 */
function boxFrame(element: Json, footprint: readonly Pt[], placement: { readonly point: readonly number[]; readonly facing: number } | undefined): BoxFrame | undefined {
  const fb = element['fallback'];
  const box = isObject(fb) ? fb['box'] : undefined;
  if (!isObject(box) || !Array.isArray(box['min']) || !Array.isArray(box['max']) || footprint.length !== 4) return undefined;
  const [x0, y0] = box['min'] as number[];
  const [x1, y1] = box['max'] as number[];
  if (typeof x0 !== 'number' || typeof y0 !== 'number' || typeof x1 !== 'number' || typeof y1 !== 'number') return undefined;
  const [fx, fy] = facingVector(placement?.facing ?? 0);
  const k = Math.sqrt(Number(fx) * Number(fx) + Number(fy) * Number(fy));
  const u: Pt = [Number(fx) / k, Number(fy) / k];
  const o: Pt = placement === undefined ? [0, 0] : [placement.point[0] ?? 0, placement.point[1] ?? 0];
  const corner = (x: number, y: number): Pt => {
    const p: Pt = [o[0] + x * u[0] - y * u[1], o[1] + x * u[1] + y * u[0]];
    let best = footprint[0]!;
    let near = Infinity;
    for (const q of footprint) {
      const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
      if (d < near) [near, best] = [d, q];
    }
    return best;
  };
  const origin = corner(x0, y0);
  const front = corner(x1, y0);
  const side = corner(x0, y1);
  return { origin, depth: [front[0] - origin[0], front[1] - origin[1]], width: [side[0] - origin[0], side[1] - origin[1]] };
}
