/**
 * One level of a document, as the renderer draws it: every coordinate is a value the engine
 * derived exactly and rounded once (Core 2.2) — face ends, junction fills, room polygons, opening
 * points. Nothing here recomputes geometry; the only arithmetic left for the drawing is placing
 * symbols (door leaves, glazing lines) relative to those points.
 */
import { deriveFrom, evaluate, InvalidDocumentError, type DerivedRoof, type DerivedStair, type FloorspecDocument } from '@floorspec/engine';

export type Pt = readonly [number, number];

export interface SceneWall {
  readonly id: string;
  /** startRight → endRight → endLeft → startLeft, rounded, repeats removed (Core 5.7). */
  readonly outline: readonly Pt[];
  readonly start: Pt;
  readonly end: Pt;
  /** Face offsets (Core 5.4), in base units: left (exterior) and right. */
  readonly a: number;
  readonly b: number;
}

export interface SceneSeparator {
  readonly id: string;
  readonly start: Pt;
  readonly end: Pt;
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
  /** Stairs rising from this level, by ID, as derived (Core 0.3, 17.4–17.6), with their form. */
  readonly stairs: ReadonlyMap<string, { readonly derived: DerivedStair; readonly form: string }>;
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
 * Validate and derive a document, and keep one level of it. Throws InvalidDocumentError when the
 * document is not valid — a plan is only drawn from geometry the engine can derive. A document
 * with design options (Core 0.3, chapter 19) is drawn in one design: `design`, a design input
 * (19.6), or the primary design; a design the engine derives nothing for is a RangeError.
 */
export function buildScene(input: string | Uint8Array | object, level?: string, design?: Readonly<Record<string, string>>): Scene {
  const ev = evaluate(input, design === undefined ? {} : { design });
  if (!ev.valid || !ev.document) throw new InvalidDocumentError(ev.diagnostics);
  if (!ev.view || !ev.analysis) throw new RangeError('the document has no such design, or it is not valid (Core 19.6.2)');
  const doc = ev.view;
  const derived = deriveFrom(doc, ev.analysis);
  const lid = level ?? defaultLevel(doc);
  const lvl = lid === undefined ? undefined : doc.levels?.[lid];
  if (lid === undefined || !lvl || !Object.hasOwn(doc.levels ?? {}, lid)) throw new RangeError(`the document has no level ${level ?? ''}`.trim());

  const walls = new Map<string, SceneWall>();
  for (const [id, w] of entries(doc.walls)) {
    if (w.level !== lid) continue;
    const d = derived.walls[id]!;
    const o = ev.analysis.offsets.get(id)!;
    walls.set(id, {
      id,
      outline: dedupeCyclic([d.startRight, d.endRight, d.endLeft, d.startLeft]),
      start: doc.junctions![w.start]!.position,
      end: doc.junctions![w.end]!.position,
      a: Number(o.a2) / 2,
      b: Number(o.b2) / 2,
    });
  }

  const fills = new Map<string, readonly Pt[]>();
  for (const [id, ring] of Object.entries(derived.junctionFills)) if (doc.junctions![id]!.level === lid) fills.set(id, ring);

  const separators = new Map<string, SceneSeparator>();
  for (const [id, s] of entries(doc.separators))
    if (s.level === lid) separators.set(id, { id, start: doc.junctions![s.start]!.position, end: doc.junctions![s.end]!.position });

  const openings = new Map<string, SceneOpening>();
  for (const [id, o] of entries(doc.openings)) {
    if (!walls.has(o.wall)) continue;
    const fill = o.fill === undefined ? undefined : doc.types?.[o.fill];
    const kind: OpeningKind = fill?.kind === 'doorType' ? 'door' : fill?.kind === 'windowType' ? 'window' : 'opening';
    const d = derived.openings[id]!;
    openings.set(id, { id, wall: o.wall, kind, start: d.start, end: d.end, hinge: o.hinge ?? 'start', swing: o.swing ?? 'right' });
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
  for (const [id, fb] of entries(derived.fallbacks))
    if (fb.level === lid) fallbacks.set(id, { id, extension: fb.extension, collection: fb.collection, footprint: fb.footprint });
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
  const stairs = new Map<string, { derived: DerivedStair; form: string }>();
  for (const [id, st] of entries(doc.stairs)) {
    const d = derived.stairs?.[id];
    if (st.level === lid && d !== undefined) stairs.set(id, { derived: d, form: st.form?.kind ?? 'straight' });
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
  };
}
