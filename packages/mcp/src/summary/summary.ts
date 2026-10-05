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
import { analyseCirculation, deriveEvaluation, hasOptions, membership, optionsOf, z765, effectiveClearOpening, evaluate, extElements, OFFICIAL_READER, predicates, type Diagnostic, type Evaluation, type FloorspecDocument, type LevelGeometry } from '@floorspec/engine';
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
  /** Its height: its own, else its fill's (Core 7.2). */
  readonly height: Length;
  /** For a window: its sill above the wall's base, its own, else its fill's (Core 7.2). */
  readonly sill?: Length;
  /** From the wall's start junction along its location line to the near edge (Core 7.3). */
  readonly offset: Length;
  readonly hinge?: 'start' | 'end';
  readonly swing?: 'left' | 'right';
  /** For a door: the space its leaf opens into. */
  readonly swingsInto?: Neighbour;
  /** Core 0.3: how its door or window operates, when its type declares it (Core 8.4). */
  readonly operation?: string;
  /** Core 0.3: its net clear opening as declared — its own, else its type's (Core 7.2, 7.4); never computed. */
  readonly clearOpening?: { readonly width: Length; readonly height: Length; readonly area?: { readonly squareFeet: string; readonly squareBaseUnits: string } };
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
  /**
   * Walls only: the devices on this wall's face toward the space being described (Core 13.3's
   * wall-face hosts: receptacles, switches, a panel …), by offset; absent when there are none.
   */
  readonly devices?: readonly WallDeviceSummary[];
}

/** A device on a wall face: where along the wall and how high, and the circuits that feed it. */
export interface WallDeviceSummary {
  readonly id: string;
  readonly name?: string;
  /** `<extension>:<collection>`. */
  readonly kind: string;
  /** Along the wall's location line from its start junction. */
  readonly offset: Length;
  /** Above the wall's base. */
  readonly height: Length;
  /** FS_electrical circuits that list it as a load. */
  readonly circuits?: readonly string[];
}

/** A device on a room's floor or ceiling. */
export interface SurfaceDeviceSummary {
  readonly id: string;
  readonly name?: string;
  readonly kind: string;
  readonly surface: 'floor' | 'ceiling';
  readonly circuits?: readonly string[];
}

/** An FS_electrical circuit, as its extension derives it (FS_electrical 6.2). */
export interface CircuitSummary {
  readonly id: string;
  readonly name?: string;
  readonly panel: string;
  readonly breaker: number;
  readonly volts: number;
  readonly poles: number;
  readonly loads: readonly string[];
  /** Watts: the sum of its loads' stated watts. */
  readonly connectedLoad: number;
  /** Watts: breaker × volts. */
  readonly capacity: number;
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
  /**
   * Its windows to the outside — those in walls on its outer boundary whose other side is exterior —
   * by the sides they face, and their rough openings (width × height, Core 7.2) as an area and as a
   * share of the room's net area. A design measure for a critique, not a code calculation.
   */
  readonly daylight?: {
    readonly windows: number;
    readonly facing: readonly Side[];
    readonly roughOpening: { readonly squareFeet: string; readonly squareBaseUnits: string };
    /** Rough opening ÷ net area, as a percentage to one decimal. */
    readonly percentOfFloor: string;
  };
  /** Devices on its floor or ceiling; absent when there are none. Wall devices are listed under their walls. */
  readonly devices?: readonly SurfaceDeviceSummary[];
  /**
   * Core 0.3 (chapter 15): its floor's top above the level and its ceiling — kind, and its least and
   * greatest height above that floor — as derived; present when the room or its level declares a
   * floor or ceiling of its own.
   */
  readonly ceiling?: { readonly kind: 'flat' | 'tray' | 'vaulted'; readonly floorOffset: Length; readonly low: Length; readonly high: Length };
  /** FS_furniture (6.2): the furniture, appliances and casework in it, briefly; absent when there are none. */
  readonly furniture?: readonly FurnitureSummary[];
}

/** An FS_furniture element in a room (FS_furniture 6.2): what it is and how big. */
export interface FurnitureSummary {
  readonly id: string;
  readonly name?: string;
  readonly category: string;
  /** Width × depth × height (FS_furniture 3.1), in base units. */
  readonly size: readonly [number, number, number];
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

/** An extension element (Core 0.2, 12.5) and what it is placed on (13.3). */
export interface ElementSummary {
  readonly id: string;
  readonly name?: string;
  /** `<extension>:<collection>`: what kind of element it is. */
  readonly kind: string;
  /** What it is placed on; absent: placed only by its fallback box, in the level's coordinates. */
  readonly host?:
    | { readonly mode: 'wallFace'; readonly wall: string; readonly side: 'left' | 'right'; readonly offset: Length; readonly height: Length }
    | { readonly mode: 'surface'; readonly room: string; readonly surface: 'floor' | 'ceiling' }
    | { readonly mode: 'free' };
  /** Its derived placement (13.4): origin in base units and facing in microdegrees. */
  readonly placement?: { readonly point: readonly [number, number, number]; readonly facing: number };
  /** The room it is in, as its extension derives it (FS_electrical 6.1 and the like). */
  readonly room?: string;
  /** FS_electrical circuits that list it as a load. */
  readonly circuits?: readonly string[];
}

/** One program item (Core 0.2, 11.3) and how far the plan meets it. */
export interface ProgramItemSummary {
  readonly id: string;
  readonly name?: string;
  readonly function: string;
  readonly count: number;
  readonly rooms: readonly string[];
  readonly countMet: boolean;
  readonly minAreaMet?: boolean;
  readonly targetAreaMet?: boolean;
}

/** One adjacency of the program (11.4), with whether its rooms are adjacent and connected. */
export interface ProgramAdjacencySummary {
  readonly a: string;
  readonly b: string;
  readonly kind: 'required' | 'preferred' | 'forbidden';
  readonly adjacent: boolean;
  readonly connected: boolean;
  /** Required or preferred: adjacent; forbidden: not adjacent. */
  readonly met: boolean;
}

export interface ProgramSummary {
  readonly items: readonly ProgramItemSummary[];
  readonly adjacency: readonly ProgramAdjacencySummary[];
}

/**
 * Circulation (Core 0.2, chapter 14), as its lints report it: only buildings that have a door or a
 * cased opening. Present only when something is wrong.
 */
export interface CirculationSummary {
  /** Buildings with doors and rooms but no way in from outside (FS-LINT-014). */
  readonly noEntry: readonly string[];
  /** Rooms that cannot be reached from an entry through doors (FS-LINT-012). */
  readonly unreachable: readonly string[];
  /** Sleeping rooms reachable only through another sleeping room (FS-LINT-013). */
  readonly throughSleeping: readonly string[];
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
  /** Extension elements on this level (Core 0.2), by ID; absent when there are none. */
  readonly elements?: readonly ElementSummary[];
  /** FS_electrical circuits whose panel is on this level; absent when there are none. */
  readonly circuits?: readonly CircuitSummary[];
  /** Core 0.3 (chapter 16): roofs on this level — kind, pitch, eave above the level; absent when there are none. */
  readonly roofs?: readonly RoofSummary[];
  /** Core 0.3 (chapter 17): stairs rising from this level; absent when there are none. */
  readonly stairs?: readonly StairSummary[];
}

/** One roof (Core 16): its kind, its pitch where one pitch rules, and whether Core derives its surface. */
export interface RoofSummary {
  readonly id: string;
  readonly name?: string;
  readonly kind: 'flat' | 'shed' | 'gable' | 'hip';
  /** "6:12", or "mixed" when its sloped edges differ; absent for a flat roof. */
  readonly pitch?: string;
  readonly eave: Length;
  readonly surfaceDerived: boolean;
}

/** One stair (Core 17): where it rises to, its risers, tread and headroom as derived. */
export interface StairSummary {
  readonly id: string;
  readonly name?: string;
  readonly to: string;
  readonly form: string;
  readonly risers: number;
  readonly riserHeight: Length;
  readonly tread: Length;
  readonly width: Length;
  /** Absent where Core derives none (a winder or spiral stair, or nothing above it). */
  readonly headroom?: Length;
}

/**
 * The site (Core 1.8), for orientation: true north, the compass bearing each plan side faces (the
 * direction of its outward normal — what a window on that side looks toward), and the location.
 */
export interface SiteSummary {
  /** Microdegrees from project north (+Y) to true north, counter-clockwise (Core 1.8). */
  readonly trueNorth: number;
  readonly facing: Readonly<Record<Side, { readonly bearing: number; readonly compass: string }>>;
  /** Degrees, WGS 84, when the site has a location. */
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface DocumentSummary {
  readonly project: string;
  readonly valid: boolean;
  /** The site, when the document has one (Core 1.8). */
  readonly site?: SiteSummary;
  readonly levels: readonly LevelSummary[];
  /** The program (Core 0.2), met or not; absent when the document has none or is not valid. */
  readonly program?: ProgramSummary;
  /** Circulation problems (Core 0.2, chapter 14); absent when there are none or the document is not valid. */
  readonly circulation?: CirculationSummary;
  /** Finished area after ANSI Z765-2021 (paraphrased; an app measure, not the standard), per building; absent when not valid. */
  readonly area?: readonly { readonly building: string; readonly aboveGradeSqFt: number; readonly belowGradeSqFt: number }[];
  /**
   * Design options (Core 0.3, chapter 19): every option set, its primary and its options with how
   * many elements each holds. Everything else in the summary describes the primary design.
   */
  readonly options?: readonly OptionSetSummary[];
  readonly diagnostics: readonly DiagnosticSummary[];
}

export interface OptionSetSummary {
  readonly id: string;
  readonly name?: string;
  readonly primary: string;
  readonly options: readonly { readonly id: string; readonly name?: string; readonly members: number }[];
}

/** Core 0.3, 19.1: the option sets of a document, each with its options and their member counts. */
function optionSummary(doc: FloorspecDocument): OptionSetSummary[] | undefined {
  if (!hasOptions(doc)) return undefined;
  const members = membership(doc);
  const count = (oid: string): number => [...members.values()].filter((o) => o === oid).length;
  return entries(doc.optionSets).map(([sid, set]) => ({
    id: sid,
    ...(set.name !== undefined && { name: set.name }),
    primary: set.primary,
    options: optionsOf(doc, sid).map((oid) => ({ id: oid, ...(doc.options?.[oid]?.name !== undefined && { name: doc.options[oid].name }), members: count(oid) })),
  }));
}

export interface DiagnosticSummary extends Pick<Diagnostic, 'code' | 'severity' | 'elements' | 'message'> {
  /** The level the diagnostic is located on, when it says. */
  readonly level?: string;
  /** The option whose design alone has it (Core 0.3, 19.5.2). */
  readonly design?: string;
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
  /** Wall-face devices by wall, and the circuits each load is on. */
  private readonly wallDevices = new Map<string, { side: 'left' | 'right'; summary: WallDeviceSummary }[]>();

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
    const circuits = circuitsByLoad(doc);
    for (const x of extElements(doc)) {
      const h = x.element.host;
      if (h?.mode !== 'wallFace' || x.element.fallback.level !== level) continue;
      const on = circuits.get(x.id);
      const summary: WallDeviceSummary = {
        id: x.id,
        ...(x.element.name !== undefined && { name: x.element.name }),
        kind: `${x.extension}:${x.collection}`,
        offset: length(BigInt(h.offset)),
        height: length(BigInt(h.height)),
        ...(on && { circuits: on }),
      };
      this.wallDevices.set(h.wall, [...(this.wallDevices.get(h.wall) ?? []), { side: h.side, summary }]);
    }
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
    // The space described is on h's left: the wall's left face when h runs the wall's way.
    const face: 'left' | 'right' = ((h & 1) === 0) === (e.start === w.start) ? 'left' : 'right';
    const devices = (this.wallDevices.get(e.id) ?? [])
      .filter((d) => d.side === face)
      .map((d) => d.summary)
      .sort((a, b) => a.offset.baseUnits - b.offset.baseUnits || cmp(a.id, b.id));
    return {
      kind: 'wall',
      id: e.id,
      ...(w.name !== undefined && { name: w.name }),
      length: len,
      ...(w.type !== undefined && !w.layers && { type: { id: w.type, ...(type?.name !== undefined && { name: type.name }) } }),
      ...(offsets && { thickness: length(offsets.thickness) }),
      otherSide: neighbour,
      openings: this.openingsOn(e.id),
      ...(devices.length > 0 && { devices }),
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
        const height = o.height ?? t?.height ?? 0;
        const sill = o.sill ?? (t !== undefined && 'sill' in t ? t.sill : undefined) ?? 0;
        const swing = o.swing ?? 'right';
        const clear = effectiveClearOpening(this.doc, o);
        const s: OpeningSummary = {
          id,
          ...(o.name !== undefined && { name: o.name }),
          kind,
          ...(o.fill !== undefined && { fill: o.fill }),
          width: length(BigInt(width)),
          height: length(BigInt(height)),
          ...(kind === 'window' && { sill: length(BigInt(sill)) }),
          offset: length(BigInt(o.offset)),
          ...(kind === 'door' && { hinge: o.hinge ?? 'start', swing, ...(sides && { swingsInto: swing === 'left' ? sides.left : sides.right }) }),
          ...(t?.operation !== undefined && { operation: t.operation }),
          ...(clear && {
            clearOpening: {
              width: length(BigInt(clear.width)),
              height: length(BigInt(clear.height)),
              ...(clear.area !== undefined && { area: { squareFeet: squareFeet(2n * BigInt(clear.area)), squareBaseUnits: String(clear.area) } }),
            },
          }),
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
  const circuits = circuitsByLoad(doc);

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
    const devices: SurfaceDeviceSummary[] = extElements(doc)
      .filter((x) => x.element.host?.mode === 'surface' && x.element.host.room === id)
      .map((x) => {
        const on = circuits.get(x.id);
        return {
          id: x.id,
          ...(x.element.name !== undefined && { name: x.element.name }),
          kind: `${x.extension}:${x.collection}`,
          surface: x.element.host?.mode === 'surface' && x.element.host.surface === 'ceiling' ? ('ceiling' as const) : ('floor' as const),
          ...(on && { circuits: on }),
        };
      });
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
      ...(devices.length > 0 && { devices }),
      daylight: daylight(sides, poly.area2),
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

/** A room's windows to the outside and their rough openings (RoomSummary.daylight). */
function daylight(sides: Readonly<Record<Side, readonly EdgeSummary[]>>, area2: bigint): NonNullable<RoomSummary['daylight']> {
  let windows = 0;
  let rough2 = 0n;
  const facing: Side[] = [];
  for (const side of SIDES)
    for (const e of sides[side]) {
      if (e.kind !== 'wall' || e.otherSide.kind !== 'exterior') continue;
      for (const o of e.openings) {
        if (o.kind !== 'window') continue;
        windows += 1;
        rough2 += 2n * BigInt(o.width.baseUnits) * BigInt(o.height.baseUnits);
        if (!facing.includes(side)) facing.push(side);
      }
    }
  const tenths = area2 > 0n ? (rough2 * 1000n + area2 / 2n) / area2 : 0n;
  return {
    windows,
    facing,
    roughOpening: { squareFeet: squareFeet(rough2), squareBaseUnits: halfString(rough2) },
    percentOfFloor: `${tenths / 10n}.${tenths % 10n}`,
  };
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

/** Every load of every FS_electrical circuit: the circuits that list it, sorted. */
function circuitsByLoad(doc: FloorspecDocument): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const data = (doc.extensions as Record<string, { circuits?: Record<string, { loads?: unknown }> }> | undefined)?.['FS_electrical'];
  for (const [cid, c] of Object.entries(data?.circuits ?? {}).sort(([a], [b]) => cmp(a, b)))
    for (const load of Array.isArray(c.loads) ? c.loads : []) if (typeof load === 'string') out.set(load, [...(out.get(load) ?? []), cid]);
  return out;
}

/** The elements a room's section mentions: the room, its walls, separators and their openings. */
function roomElements(r: RoomSummary): Set<string> {
  const out = new Set([r.id]);
  for (const e of [...SIDES.flatMap((s) => r.sides[s]), ...r.inside]) {
    out.add(e.id);
    for (const o of e.openings) out.add(o.id);
    for (const d of e.devices ?? []) out.add(d.id);
  }
  for (const d of r.devices ?? []) out.add(d.id);
  return out;
}

const involves = (l: { between: readonly [Neighbour, Neighbour] }, id: string): boolean => l.between.some((n) => n.kind === 'room' && n.id === id);

/** The summary as structured data. */
export function describeJson(document: string | Uint8Array | object, options: DescribeOptions = {}): DocumentSummary {
  // The reader implements the official extensions, so circuits and rooms of devices are derived.
  const ev = evaluate(document, OFFICIAL_READER);
  // The primary design's view (Core 0.3, 19.3): the document itself when it has no design options.
  const doc = ev.view ?? ev.document;
  const diagnostics: DiagnosticSummary[] = ev.diagnostics.map(({ code, severity, elements, message, location, design }) => ({
    code,
    severity,
    elements,
    message,
    ...(location.level !== undefined && { level: location.level }),
    ...(design !== undefined && { design }),
  }));
  const optionSets = ev.document === undefined ? undefined : optionSummary(ev.document);
  if (!doc || !ev.analysis) return { project: '', valid: ev.valid, levels: [], ...(optionSets && { options: optionSets }), diagnostics };
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
  // Core 0.2: extension elements by level, and the program — derived only for a valid document.
  const derived = ev.valid && analysis.core02 ? deriveEvaluation(ev) : undefined;
  const elements = new Map<string, ElementSummary[]>();
  const circuits = circuitsByLoad(doc);
  const roomOf = new Map<string, string>();
  // An extension's rooms are lists of IDs (FS_electrical 6.1 and the like) or, for FS_furniture (6.2), `{ items }`.
  for (const data of Object.values(derived?.extensions ?? {}) as { rooms?: Record<string, string[] | { items?: string[] }> }[])
    for (const [rid, v] of Object.entries(data.rooms ?? {})) for (const id of Array.isArray(v) ? v : (v.items ?? [])) roomOf.set(id, rid);
  for (const x of extElements(doc)) {
    const h = x.element.host;
    const pl = derived?.placements?.[x.id];
    const room = roomOf.get(x.id);
    const on = circuits.get(x.id);
    const summary: ElementSummary = {
      id: x.id,
      ...(x.element.name !== undefined && { name: x.element.name }),
      kind: `${x.extension}:${x.collection}`,
      ...(h && {
        host:
          h.mode === 'wallFace'
            ? { mode: 'wallFace' as const, wall: h.wall, side: h.side, offset: length(BigInt(h.offset)), height: length(BigInt(h.height)) }
            : h.mode === 'surface'
              ? { mode: 'surface' as const, room: h.room, surface: h.surface }
              : { mode: 'free' as const },
      }),
      ...(pl && { placement: { point: pl.point, facing: pl.facing } }),
      ...(room !== undefined && { room }),
      ...(on && { circuits: on }),
    };
    const lid = x.element.fallback.level;
    elements.set(lid, [...(elements.get(lid) ?? []), summary]);
  }
  // FS_electrical's circuits, by the level their panel is on (FS_electrical 6.2).
  const byLevel = new Map<string, CircuitSummary[]>();
  const electrical = derived?.extensions?.FS_electrical;
  if (electrical !== undefined) {
    const data = (doc.extensions as Record<string, { circuits?: Record<string, { name?: string; breaker: number; volts: number; poles?: number }>; collections?: Record<string, Record<string, { fallback: { level: string } }>> }> | undefined)?.['FS_electrical'];
    for (const [cid, c] of Object.entries(electrical.circuits)) {
      const record = data?.circuits?.[cid];
      const lid = data?.collections?.['panels']?.[c.panel]?.fallback.level;
      if (record === undefined || lid === undefined) continue;
      byLevel.set(lid, [
        ...(byLevel.get(lid) ?? []),
        { id: cid, ...(record.name !== undefined && { name: record.name }), panel: c.panel, breaker: record.breaker, volts: record.volts, poles: record.poles ?? 1, loads: c.loads, connectedLoad: c.connectedLoad, capacity: c.capacity },
      ]);
    }
  }
  // Core 0.3: a room's floor and ceiling, where the room or its level declares one (chapter 15).
  const declares = (rid: string): boolean => {
    const r = doc.rooms?.[rid];
    const L = r === undefined ? undefined : doc.levels?.[r.level];
    return r !== undefined && (r.floor !== undefined || r.ceiling !== undefined || L?.ceilingHeight !== undefined || L?.floorThickness !== undefined);
  };
  const ceilingOf = (rid: string): RoomSummary['ceiling'] => {
    const c = derived?.ceilings?.[rid];
    const f = derived?.floors?.[rid];
    const r = doc.rooms?.[rid];
    if (c === undefined || f === undefined || r === undefined || !declares(rid)) return undefined;
    const elevation = doc.levels![r.level]!.elevation;
    return { kind: c.kind, floorOffset: length(BigInt(f.top - elevation)), low: length(BigInt(c.low - f.top)), high: length(BigInt(c.high - f.top)) };
  };
  // Core 0.3: roofs (chapter 16) and stairs (chapter 17), by the level they stand on or rise from.
  const roofsOn = new Map<string, RoofSummary[]>();
  for (const [id, rf] of entries(doc.roofs)) {
    const d = derived?.roofs?.[id];
    if (d === undefined) continue;
    const pitches = new Set<string>();
    rf.footprint.forEach((_, i) => {
      const e = rf.edges?.[String(i)];
      const pt = e?.gable === true ? undefined : (e?.pitch ?? rf.pitch);
      if (pt) pitches.add(`${pt.rise}:${pt.run}`);
    });
    const pitch = pitches.size === 0 ? undefined : pitches.size === 1 ? [...pitches][0]! : 'mixed';
    const L = doc.levels![rf.level]!;
    roofsOn.set(rf.level, [
      ...(roofsOn.get(rf.level) ?? []),
      { id, ...(rf.name !== undefined && { name: rf.name }), kind: d.kind, ...(pitch !== undefined && { pitch }), eave: length(BigInt(d.eave - L.elevation)), surfaceDerived: d.surface !== null },
    ]);
  }
  const stairsOn = new Map<string, StairSummary[]>();
  for (const [id, st] of entries(doc.stairs)) {
    const d = derived?.stairs?.[id];
    if (d === undefined) continue;
    stairsOn.set(st.level, [
      ...(stairsOn.get(st.level) ?? []),
      {
        id,
        ...(st.name !== undefined && { name: st.name }),
        to: st.to,
        form: st.form?.kind ?? 'straight',
        risers: d.risers,
        riserHeight: length(BigInt(d.riserHeight)),
        tread: length(BigInt(st.tread)),
        width: length(BigInt(st.width)),
        ...(d.headroom !== undefined && { headroom: length(BigInt(d.headroom)) }),
      },
    ]);
  }
  // FS_furniture (6.2): each room's items, as the extension derives them.
  const furniture = derived?.extensions?.FS_furniture;
  const furnitureIn = (rid: string): FurnitureSummary[] | undefined => {
    const ids = furniture?.rooms[rid]?.items;
    if (ids === undefined || ids.length === 0) return undefined;
    const names = new Map(extElements(doc).map((x) => [x.id, x.element.name]));
    return ids.flatMap((id) => {
      const it = furniture?.items[id];
      if (it === undefined) return [];
      const name = names.get(id);
      return [{ id, ...(name !== undefined && { name }), category: it.category, size: [it.width, it.depth, it.height] as const }];
    });
  };
  levels = levels.map((l) => ({
    ...l,
    rooms: l.rooms.map((r) => {
      const ceiling = ceilingOf(r.id);
      const items = furnitureIn(r.id);
      return ceiling === undefined && items === undefined ? r : { ...r, ...(ceiling !== undefined && { ceiling }), ...(items !== undefined && { furniture: items }) };
    }),
    ...(roofsOn.has(l.id) && { roofs: roofsOn.get(l.id)! }),
    ...(stairsOn.has(l.id) && { stairs: stairsOn.get(l.id)! }),
    ...(elements.has(l.id) && { elements: elements.get(l.id)! }),
    ...(byLevel.has(l.id) && { circuits: byLevel.get(l.id)!.sort((a, b) => cmp(a.id, b.id)) }),
  }));
  const items = entries(doc.program?.items);
  const program: ProgramSummary | undefined =
    derived?.program && (items.length || derived.program.adjacency.length)
      ? {
          items: items.map(([id, it]) => {
            const d = derived.program!.items[id]!;
            return {
              id,
              ...(it.name !== undefined && { name: it.name }),
              function: it.function,
              count: it.count ?? 1,
              rooms: d.rooms,
              countMet: d.countMet,
              ...(d.minAreaMet !== undefined && { minAreaMet: d.minAreaMet }),
              ...(d.targetAreaMet !== undefined && { targetAreaMet: d.targetAreaMet }),
            };
          }),
          adjacency: derived.program.adjacency.map((a) => ({ ...a, met: a.kind === 'forbidden' ? !a.adjacent : a.adjacent })),
        }
      : undefined;
  const circulation = derived?.circulation && circulationSummary(doc, ev.analysis, options);
  let diags = diagnostics;
  if (options.room !== undefined) {
    const rid = options.room;
    levels = levels.map((l) => ({
      ...l,
      rooms: l.rooms.filter((r) => r.id === rid),
      adjacency: l.adjacency.filter((a) => involves(a, rid)),
      doorGraph: l.doorGraph.filter((d) => involves(d, rid)),
      unanchored: [],
      ...(l.elements && { elements: l.elements.filter((e) => e.room === rid || (e.host?.mode === 'surface' && e.host.room === rid)) }),
    }));
    const mine = levels[0]?.rooms[0];
    const ids = mine ? roomElements(mine) : new Set([rid]);
    diags = diagnostics.filter((d) => d.elements.some((e) => ids.has(e)));
  } else if (options.level !== undefined) {
    const lid = options.level;
    const onLevel = new Set<string>([lid]);
    for (const c of ['junctions', 'walls', 'separators', 'rooms', 'slabs', 'roofs', 'stairs'] as const)
      for (const [id, e] of entries<{ level: string }>(doc[c])) if (e.level === lid) onLevel.add(id);
    for (const [id, o] of entries(doc.openings)) if (onLevel.has(o.wall)) onLevel.add(id);
    diags = diagnostics.filter((d) => (d.level !== undefined ? d.level === lid : d.elements.length === 0 || d.elements.some((e) => onLevel.has(e))));
  }
  const area = ev.valid && options.room === undefined ? z765(doc).buildings.map((b) => ({ building: b.building, aboveGradeSqFt: b.aboveGradeSqFt, belowGradeSqFt: b.belowGradeSqFt })) : undefined;
  const site = siteSummary(doc);
  return { project: doc.project.name, valid: ev.valid, ...(site && { site }), levels, ...(program && { program }), ...(circulation && { circulation }), ...(area && { area }), ...(optionSets && { options: optionSets }), diagnostics: diags };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
const SIDE_BEARING: Readonly<Record<Side, number>> = { north: 0, east: 90, south: 180, west: 270 };

/** The site's orientation and location (SiteSummary); undefined when the document has no site. */
export function siteSummary(doc: FloorspecDocument): SiteSummary | undefined {
  const site = doc.site;
  if (site === undefined) return undefined;
  const trueNorth = site.trueNorth ?? 0;
  const facing = {} as Record<Side, { bearing: number; compass: string }>;
  for (const side of SIDES) {
    // A side's outward normal is SIDE_BEARING from project north, and project north is trueNorth
    // clockwise of true north (trueNorth runs counter-clockwise from project north to true north).
    const bearing = (((SIDE_BEARING[side] + Math.round(trueNorth / 1_000_000)) % 360) + 360) % 360;
    facing[side] = { bearing, compass: COMPASS[Math.round(bearing / 22.5) % 16]! };
  }
  return {
    trueNorth,
    facing,
    ...(site.location !== undefined && { latitude: site.location.latitude / 1_000_000, longitude: site.location.longitude / 1_000_000 }),
  };
}

/** What the circulation lints say (14.4), narrowed to a room or level when asked; undefined when nothing. */
function circulationSummary(doc: FloorspecDocument, analysis: Analysis, options: DescribeOptions): CirculationSummary | undefined {
  const { derived, buildings } = analyseCirculation(doc, analysis);
  const keep = (rid: string): boolean =>
    (options.room === undefined || rid === options.room) && (options.level === undefined || doc.rooms![rid]!.level === options.level);
  const noEntry: string[] = [];
  const unreachable: string[] = [];
  const throughSleeping: string[] = [];
  for (const [bid, b] of buildings) {
    if (!b.evaluated || !b.rooms.length) continue;
    if (!b.entries.length) {
      if (b.rooms.some(keep)) noEntry.push(bid);
      continue;
    }
    for (const rid of b.rooms.filter(keep)) {
      if (!derived[rid]!.reachable) unreachable.push(rid);
      else if (derived[rid]!.throughSleeping) throughSleeping.push(rid);
    }
  }
  return noEntry.length || unreachable.length || throughSleeping.length ? { noEntry, unreachable, throughSleeping } : undefined;
}
