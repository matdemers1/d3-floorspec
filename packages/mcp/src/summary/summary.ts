/**
 * The room-centric summary (FLR-T-2.7): what an agent reads before it edits a plan. Everything is
 * read from the engine — its faces (Core 6.1), its room polygons (6.2) and its diagnostics
 * (chapter 10) — and every length is reported exactly in base units beside its ft-in rendering.
 *
 * Sides follow Floorspec Ops §3.4 exactly, so "the north wall of LIV" in this summary is the wall
 * the reference selector `north wall of LIV` resolves to.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- every lookup here is into the engine's
   own analysis of a document it has just validated (a level's geometry, a face's cycles, a wall's
   junctions and offsets); under noUncheckedIndexedAccess the assertion states what the engine
   guarantees, as packages/engine does, and a runtime check would be an unreachable branch. */
import { evaluate, predicates, type Diagnostic, type Evaluation, type FloorspecDocument, type LevelGeometry } from '@floorspec/engine';
import { halfString, length, segmentLength, squareFeet, type Length } from './units.js';

export type Side = 'north' | 'east' | 'south' | 'west';
export const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

/** What is on the far side of a wall or separator. */
export type Neighbour =
  | { readonly kind: 'room'; readonly id: string; readonly name?: string }
  | { readonly kind: 'exterior' }
  | { readonly kind: 'unanchored'; readonly index: number }
  | { readonly kind: 'degenerate' };

export interface OpeningSummary {
  readonly id: string;
  readonly name?: string;
  readonly kind: 'door' | 'window' | 'opening';
  /** The door or window type that fills it. */
  readonly fill?: string;
  readonly width: Length;
  /** From the wall's start junction along its location line to the near edge (Core 7.3). */
  readonly offset: Length;
  readonly hinge?: 'start' | 'end';
  readonly swing?: 'left' | 'right';
  /** For a door: the space its leaf opens into. */
  readonly swingsInto?: Neighbour;
}

export interface EdgeSummary {
  readonly kind: 'wall' | 'separator';
  readonly id: string;
  readonly name?: string;
  /** The length of its location line. */
  readonly length: Length;
  /** Walls only: the wall type, if it has one. */
  readonly type?: { readonly id: string; readonly name?: string };
  /** Walls only: its thickness (sum of its effective layers). */
  readonly thickness?: Length;
  readonly otherSide: Neighbour;
  /** Walls only: every opening in it, by offset. */
  readonly openings: readonly OpeningSummary[];
}

export interface RoomSummary {
  readonly id: string;
  readonly name?: string;
  readonly function: string;
  readonly level: string;
  readonly anchor: readonly [number, number];
  /** False when the anchor is in no bounded face (the document is not valid). */
  readonly placed: boolean;
  /** Net area (Core 6.4). */
  readonly area?: { readonly squareFeet: string; readonly squareBaseUnits: string };
  /** The room polygon's bounding box: east–west by north–south. */
  readonly size?: { readonly eastWest: Length; readonly northSouth: Length };
  /** Walls and separators on the room's outer boundary, by side (Ops §3.4), west→east or north→south. */
  readonly sides: Readonly<Record<Side, readonly EdgeSummary[]>>;
  /** Walls standing inside the room (its holes: a freestanding closet, a chase). */
  readonly inside: readonly EdgeSummary[];
}

export interface FaceSummary {
  /** 1-based, in the engine's order of unanchored faces (by least first vertex). */
  readonly index: number;
  readonly area: { readonly squareFeet: string; readonly squareBaseUnits: string };
  readonly size: { readonly eastWest: Length; readonly northSouth: Length };
  /** A point strictly inside its room polygon: an anchor a new room here could use. */
  readonly suggestedAnchor?: readonly [number, number];
  readonly boundary: readonly EdgeSummary[];
}

export interface Link {
  /** The two spaces, in a fixed order: exterior first, then rooms by ID, then unanchored faces. */
  readonly between: readonly [Neighbour, Neighbour];
  readonly via: string;
  readonly kind: 'door' | 'opening' | 'separator' | 'wall';
  /** For a door or opening: the wall it is in. */
  readonly wall?: string;
}

export interface LevelSummary {
  readonly id: string;
  readonly name?: string;
  readonly elevation: Length;
  readonly height: Length;
  /** False when the level's graph breaks Core 5.1–5.3: no faces, so nothing else is reported. */
  readonly derived: boolean;
  readonly rooms: readonly RoomSummary[];
  /** Pairs of spaces that share a wall or separator, with every edge they share. */
  readonly adjacency: readonly { readonly between: readonly [Neighbour, Neighbour]; readonly walls: readonly string[]; readonly separators: readonly string[] }[];
  /** Where you can walk: doors, empty openings, and separators (open plan). */
  readonly doorGraph: readonly Link[];
  readonly unanchored: readonly FaceSummary[];
}

export interface DocumentSummary {
  readonly project: string;
  readonly valid: boolean;
  readonly levels: readonly LevelSummary[];
  readonly diagnostics: readonly DiagnosticSummary[];
}

export interface DiagnosticSummary extends Pick<Diagnostic, 'code' | 'severity' | 'elements' | 'message'> {
  /** The level the diagnostic is located on, when it says. */
  readonly level?: string;
}

export interface DescribeOptions {
  /** Only this level. */
  readonly level?: string;
  /** Only this room (its level, its own section, and the links and diagnostics that involve it). */
  readonly room?: string;
}

type IPoint = readonly [bigint, bigint];
type Analysis = NonNullable<Evaluation['analysis']>;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function entries<T>(c: Readonly<Record<string, T | undefined>> | undefined): [string, T][] {
  if (!c) return [];
  return Object.keys(c)
    .sort()
    .map((k) => [k, c[k] as T]);
}

/**
 * Ops §3.4: the side of an outward normal (nx, ny). East when nx > 0 and −nx < ny ≤ nx; north when
 * ny > 0 and −ny ≤ nx < ny; west when nx < 0 and nx ≤ ny < −nx; south when ny < 0 and ny < nx ≤ −ny.
 */
export function sideOf(nx: bigint, ny: bigint): Side {
  if (nx > 0n && -nx < ny && ny <= nx) return 'east';
  if (ny > 0n && -ny <= nx && nx < ny) return 'north';
  if (nx < 0n && nx <= ny && ny < -nx) return 'west';
  return 'south';
}

/** Sort key of a neighbour: exterior, rooms by ID, unanchored faces by index, degenerate faces. */
function nkey(n: Neighbour): string {
  switch (n.kind) {
    case 'exterior':
      return '0';
    case 'room':
      return `1${n.id}`;
    case 'unanchored':
      return `2${String(n.index).padStart(6, '0')}`;
    case 'degenerate':
      return '3';
  }
}

const sameNeighbour = (a: Neighbour, b: Neighbour): boolean => nkey(a) === nkey(b);

function box(ring: readonly IPoint[]): { minX: bigint; minY: bigint; maxX: bigint; maxY: bigint } {
  let minX = ring[0]![0];
  let maxX = minX;
  let minY = ring[0]![1];
  let maxY = minY;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** A point strictly inside a room polygon, near the middle of its bounding box: integer and exact. */
function suggestAnchor(outer: readonly IPoint[], holes: readonly (readonly IPoint[])[]): readonly [number, number] | undefined {
  const b = box(outer);
  const n = 16n;
  const cand: IPoint[] = [];
  for (let i = 1n; i < n; i++) for (let j = 1n; j < n; j++) cand.push([b.minX + ((b.maxX - b.minX) * i) / n, b.minY + ((b.maxY - b.minY) * j) / n]);
  const cx = b.minX + b.maxX;
  const cy = b.minY + b.maxY;
  const d = (p: IPoint): bigint => (2n * p[0] - cx) ** 2n + (2n * p[1] - cy) ** 2n;
  cand.sort((p, q) => {
    const a = d(p);
    const c = d(q);
    return a !== c ? (a < c ? -1 : 1) : p[0] !== q[0] ? (p[0] < q[0] ? -1 : 1) : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0;
  });
  const p = cand.find((c) => predicates.locate(c, outer) === 'inside' && holes.every((h) => predicates.locate(c, h) === 'outside'));
  return p && [Number(p[0]), Number(p[1])];
}

const area = (area2: bigint): { squareFeet: string; squareBaseUnits: string } => ({ squareFeet: squareFeet(area2), squareBaseUnits: halfString(area2) });

/** Everything about one level's faces that the summary needs, built once. */
class LevelTopology {
  readonly g: LevelGeometry;
  /** Cycle index → bounded face index, or −1 for the unbounded face. */
  private readonly faceOfCycle = new Map<number, number>();
  private readonly faceNeighbour = new Map<number, Neighbour>();
  readonly unanchoredFaces: { index: number; face: number }[] = [];

  constructor(
    readonly doc: FloorspecDocument,
    readonly analysis: Analysis,
    readonly level: string,
  ) {
    const la = analysis.levels.get(level)!;
    this.g = la.geometry!;
    const graph = this.g.graph;
    const cycleIndex = new Map(graph.cycles.map((c, i) => [c, i]));
    graph.faces.forEach((f, i) => {
      this.faceOfCycle.set(cycleIndex.get(f.outer)!, i);
      for (const c of f.inner) this.faceOfCycle.set(cycleIndex.get(c)!, i);
    });
    const roomOfFace = new Map<number, string>();
    for (const [rid, face] of [...la.roomFaces].sort(([a], [b]) => cmp(a, b))) if (!roomOfFace.has(face)) roomOfFace.set(face, rid);
    // Unanchored faces in the engine's derived order: non-degenerate, by least first vertex.
    const free = graph.faces
      .map((f, i) => ({ i, p: this.g.roomPolygon(f) }))
      .filter(({ i, p }) => !roomOfFace.has(i) && !p.degenerate)
      .sort((a, b) => {
        const [ax, ay] = a.p.outer[0]!;
        const [bx, by] = b.p.outer[0]!;
        return ax !== bx ? (ax < bx ? -1 : 1) : ay < by ? -1 : ay > by ? 1 : 0;
      });
    free.forEach(({ i }, k) => this.unanchoredFaces.push({ index: k + 1, face: i }));
    const unanchoredIndex = new Map(this.unanchoredFaces.map((u) => [u.face, u.index]));
    graph.faces.forEach((_, i) => {
      const rid = roomOfFace.get(i);
      if (rid !== undefined) {
        const name = doc.rooms?.[rid]?.name;
        this.faceNeighbour.set(i, { kind: 'room', id: rid, ...(name !== undefined && { name }) });
      } else {
        const u = unanchoredIndex.get(i);
        this.faceNeighbour.set(i, u === undefined ? { kind: 'degenerate' } : { kind: 'unanchored', index: u });
      }
    });
  }

  /** The space on the left of half-edge h (Core 6.1: every half-edge has its face on its left). */
  leftOf(h: number): Neighbour {
    const face = this.faceOfCycle.get(this.g.graph.cycleOf[h]!);
    return face === undefined ? { kind: 'exterior' } : this.faceNeighbour.get(face)!;
  }

  /** The edge a half-edge belongs to. */
  edgeOf(h: number): { id: string; kind: 'wall' | 'separator'; start: string; end: string } {
    return this.g.edges[h >> 1]!;
  }

  /** The two spaces either side of an edge: left of its direction, then right. */
  sidesOfEdge(edgeId: string): { left: Neighbour; right: Neighbour } | undefined {
    const e = this.g.edges.findIndex((x) => x.id === edgeId);
    return e < 0 ? undefined : { left: this.leftOf(2 * e), right: this.leftOf(2 * e + 1) };
  }

  edgeSummary(h: number, neighbour: Neighbour): EdgeSummary {
    const e = this.edgeOf(h);
    const S = this.g.junctions.get(e.start)!.pos;
    const E = this.g.junctions.get(e.end)!.pos;
    const len = segmentLength((E[0] - S[0]) ** 2n + (E[1] - S[1]) ** 2n);
    if (e.kind === 'separator') {
      const name = this.doc.separators?.[e.id]?.name;
      return { kind: 'separator', id: e.id, ...(name !== undefined && { name }), length: len, otherSide: neighbour, openings: [] };
    }
    const w = this.doc.walls![e.id]!;
    const type = w.type === undefined ? undefined : this.doc.types?.[w.type];
    const offsets = this.analysis.offsets.get(e.id);
    return {
      kind: 'wall',
      id: e.id,
      ...(w.name !== undefined && { name: w.name }),
      length: len,
      ...(w.type !== undefined && !w.layers && { type: { id: w.type, ...(type?.name !== undefined && { name: type.name }) } }),
      ...(offsets && { thickness: length(offsets.thickness) }),
      otherSide: neighbour,
      openings: this.openingsOn(e.id),
    };
  }

  openingsOn(wallId: string): OpeningSummary[] {
    const sides = this.sidesOfEdge(wallId);
    return entries(this.doc.openings)
      .filter(([, o]) => o.wall === wallId)
      .map(([id, o]) => {
        const fill = o.fill === undefined ? undefined : this.doc.types?.[o.fill];
        const kind = fill?.kind === 'doorType' ? 'door' : fill?.kind === 'windowType' ? 'window' : 'opening';
        const t = fill && fill.kind !== 'wallType' ? fill : undefined;
        const width = o.width ?? t?.width ?? 0;
        const swing = o.swing ?? 'right';
        const s: OpeningSummary = {
          id,
          ...(o.name !== undefined && { name: o.name }),
          kind,
          ...(o.fill !== undefined && { fill: o.fill }),
          width: length(BigInt(width)),
          offset: length(BigInt(o.offset)),
          ...(kind === 'door' && { hinge: o.hinge ?? 'start', swing, ...(sides && { swingsInto: swing === 'left' ? sides.left : sides.right }) }),
        };
        return s;
      })
      .sort((a, b) => (a.offset.baseUnits !== b.offset.baseUnits ? a.offset.baseUnits - b.offset.baseUnits : cmp(a.id, b.id)));
  }

  /** The edges of a cycle, each with what is on its far side, and (for an outer cycle) its side. */
  cycleEdges(halfEdges: readonly number[]): { h: number; side: Side; along: bigint; summary: EdgeSummary }[] {
    return halfEdges.map((h) => {
      const d = this.g.graph.direction(h);
      // The outward normal is the right-hand normal of the walk (Ops §3.4): (dy, −dx).
      const side = sideOf(d[1], -d[0]);
      const e = this.edgeOf(h);
      const S = this.g.junctions.get(e.start)!.pos;
      const E = this.g.junctions.get(e.end)!.pos;
      // Order along the side: west→east on north and south sides, north→south on east and west.
      const along = side === 'north' || side === 'south' ? S[0] + E[0] : -(S[1] + E[1]);
      return { h, side, along, summary: this.edgeSummary(h, this.leftOf(h ^ 1)) };
    });
  }
}

const byAlong = (a: { along: bigint; summary: EdgeSummary }, b: { along: bigint; summary: EdgeSummary }): number =>
  a.along !== b.along ? (a.along < b.along ? -1 : 1) : cmp(a.summary.id, b.summary.id);

function levelSummary(doc: FloorspecDocument, analysis: Analysis, lid: string): LevelSummary {
  const lvl = doc.levels![lid]!;
  const la = analysis.levels.get(lid);
  const base = {
    id: lid,
    ...(lvl.name !== undefined && { name: lvl.name }),
    elevation: length(BigInt(lvl.elevation)),
    height: length(BigInt(lvl.height)),
  };
  const roomsHere = entries(doc.rooms).filter(([, r]) => r.level === lid);
  if (!la?.geometry) {
    return {
      ...base,
      derived: false,
      rooms: roomsHere.map(([id, r]) => unplaced(id, r, lid)),
      adjacency: [],
      doorGraph: [],
      unanchored: [],
    };
  }
  const topo = new LevelTopology(doc, analysis, lid);
  const g = topo.g;

  const rooms: RoomSummary[] = roomsHere.map(([id, r]) => {
    const face = la.roomFaces.get(id);
    if (face === undefined) return unplaced(id, r, lid);
    const f = g.faces[face]!;
    const poly = g.roomPolygon(f);
    const b = box(poly.outer);
    const sides: Record<Side, EdgeSummary[]> = { north: [], east: [], south: [], west: [] };
    for (const side of SIDES)
      sides[side] = topo
        .cycleEdges(f.outer.halfEdges)
        .filter((x) => x.side === side)
        .sort(byAlong)
        .map((x) => x.summary);
    const inside = f.inner
      .flatMap((c) => topo.cycleEdges(c.halfEdges))
      .sort((a, b2) => cmp(a.summary.id, b2.summary.id) || (a.h < b2.h ? -1 : 1))
      .map((x) => x.summary);
    return {
      id,
      ...(r.name !== undefined && { name: r.name }),
      function: r.function ?? 'unspecified',
      level: lid,
      anchor: r.anchor,
      placed: true,
      area: area(poly.area2),
      size: { eastWest: length(b.maxX - b.minX), northSouth: length(b.maxY - b.minY) },
      sides,
      inside,
    };
  });

  // Adjacency and the door graph, from every edge's two sides.
  const adj = new Map<string, { between: [Neighbour, Neighbour]; walls: string[]; separators: string[] }>();
  const links: Link[] = [];
  const pair = (a: Neighbour, b: Neighbour): [Neighbour, Neighbour] => (nkey(a) <= nkey(b) ? [a, b] : [b, a]);
  for (const e of g.edges) {
    const s = topo.sidesOfEdge(e.id)!;
    if (sameNeighbour(s.left, s.right)) continue;
    const between = pair(s.left, s.right);
    if (between[0].kind !== 'exterior') {
      const k = `${nkey(between[0])}|${nkey(between[1])}`;
      const entry = adj.get(k) ?? { between, walls: [], separators: [] };
      (e.kind === 'wall' ? entry.walls : entry.separators).push(e.id);
      adj.set(k, entry);
    }
    if (e.kind === 'separator') links.push({ between, via: e.id, kind: 'separator' });
    else
      for (const o of topo.openingsOn(e.id))
        if (o.kind !== 'window') links.push({ between, via: o.id, kind: o.kind === 'door' ? 'door' : 'opening', wall: e.id });
  }
  const adjacency = [...adj.entries()].sort(([a], [b]) => cmp(a, b)).map(([, v]) => ({ ...v, walls: v.walls.sort(cmp), separators: v.separators.sort(cmp) }));
  links.sort((a, b) => cmp(nkey(a.between[0]), nkey(b.between[0])) || cmp(nkey(a.between[1]), nkey(b.between[1])) || cmp(a.via, b.via));

  const unanchored: FaceSummary[] = topo.unanchoredFaces.map(({ index, face }) => {
    const f = g.faces[face]!;
    const poly = g.roomPolygon(f);
    const b = box(poly.outer);
    const anchor = suggestAnchor(poly.outer, poly.holes);
    return {
      index,
      area: area(poly.area2),
      size: { eastWest: length(b.maxX - b.minX), northSouth: length(b.maxY - b.minY) },
      ...(anchor && { suggestedAnchor: anchor }),
      boundary: topo
        .cycleEdges(f.outer.halfEdges)
        .sort((a, c) => cmp(a.summary.id, c.summary.id))
        .map((x) => x.summary),
    };
  });

  return { ...base, derived: true, rooms, adjacency, doorGraph: links, unanchored };
}

function unplaced(id: string, r: NonNullable<FloorspecDocument['rooms']>[string], lid: string): RoomSummary {
  return {
    id,
    ...(r?.name !== undefined && { name: r.name }),
    function: r?.function ?? 'unspecified',
    level: lid,
    anchor: r!.anchor,
    placed: false,
    sides: { north: [], east: [], south: [], west: [] },
    inside: [],
  };
}

/** The elements a room's section mentions: the room, its walls, separators and their openings. */
function roomElements(r: RoomSummary): Set<string> {
  const out = new Set([r.id]);
  for (const e of [...SIDES.flatMap((s) => r.sides[s]), ...r.inside]) {
    out.add(e.id);
    for (const o of e.openings) out.add(o.id);
  }
  return out;
}

const involves = (l: { between: readonly [Neighbour, Neighbour] }, id: string): boolean => l.between.some((n) => n.kind === 'room' && n.id === id);

/** The summary as structured data. */
export function describeJson(document: string | Uint8Array | object, options: DescribeOptions = {}): DocumentSummary {
  const ev = evaluate(document);
  const doc = ev.document;
  const diagnostics: DiagnosticSummary[] = ev.diagnostics.map(({ code, severity, elements, message, location }) => ({
    code,
    severity,
    elements,
    message,
    ...(location.level !== undefined && { level: location.level }),
  }));
  if (!doc || !ev.analysis) return { project: '', valid: ev.valid, levels: [], diagnostics };
  const analysis = ev.analysis;

  let levelIds = entries(doc.levels)
    .sort(([ia, a], [ib, b]) => (a.elevation !== b.elevation ? a.elevation - b.elevation : cmp(ia, ib)))
    .map(([id]) => id);
  if (options.room !== undefined) {
    const r = doc.rooms?.[options.room];
    if (!r || !Object.hasOwn(doc.rooms ?? {}, options.room)) throw new RangeError(`the document has no room ${options.room}`);
    levelIds = [r.level];
  }
  if (options.level !== undefined) {
    if (!Object.hasOwn(doc.levels ?? {}, options.level)) throw new RangeError(`the document has no level ${options.level}`);
    levelIds = levelIds.filter((l) => l === options.level);
  }

  let levels = levelIds.map((lid) => levelSummary(doc, analysis, lid));
  let diags = diagnostics;
  if (options.room !== undefined) {
    const rid = options.room;
    levels = levels.map((l) => ({
      ...l,
      rooms: l.rooms.filter((r) => r.id === rid),
      adjacency: l.adjacency.filter((a) => involves(a, rid)),
      doorGraph: l.doorGraph.filter((d) => involves(d, rid)),
      unanchored: [],
    }));
    const mine = levels[0]?.rooms[0];
    const ids = mine ? roomElements(mine) : new Set([rid]);
    diags = diagnostics.filter((d) => d.elements.some((e) => ids.has(e)));
  } else if (options.level !== undefined) {
    const lid = options.level;
    const onLevel = new Set<string>([lid]);
    for (const c of ['junctions', 'walls', 'separators', 'rooms', 'slabs'] as const)
      for (const [id, e] of entries<{ level: string }>(doc[c])) if (e.level === lid) onLevel.add(id);
    for (const [id, o] of entries(doc.openings)) if (onLevel.has(o.wall)) onLevel.add(id);
    diags = diagnostics.filter((d) => (d.level !== undefined ? d.level === lid : d.elements.length === 0 || d.elements.some((e) => onLevel.has(e))));
  }
  return { project: doc.project.name, valid: ev.valid, levels, diagnostics: diags };
}
