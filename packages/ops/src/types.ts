/**
 * The TypeScript types of Floorspec Ops requests, operations and results (chapters 1–7), written to
 * match the specification's member tables and schema/ops/0.2. Ops 0.1 is a subset: it has no
 * adjacency primitives, no addLevel, addProgramItem, setRoomBrief, placeElement or moveElement,
 * no `by`/`toward` on moveOpening, no `brief` on addRoom, and no `extension` on addElement.
 *
 * A `Length` is a JSON integer of base units or a length string (3.1); a `PointRef` a point (3.2);
 * an `ElementRef` an ID or a selector (3.3). Resolved operations — the `resolved` echo and the
 * `inverse` — carry only integers, points and IDs.
 */
import type { Diagnostic } from '@floorspec/engine';
import type { CollectionName, OpsVersion, ReservedTarget } from './model/working.js';

export type { CollectionName, OpsVersion, ReservedTarget };

/** An area (3.6, Ops 0.2): square base units, or a string such as `11 m2`, `120 sq ft`. */
export type Area = number | string;

/** A length: base units, or a string such as `12' 6 1/2"`, `3/4 in`, `3810 mm` (3.1). */
export type Length = number | string;
/** A point: `[x, y]` of lengths, a junction, or a point string (3.2). */
export type PointRef = [Length, Length] | string;
/** A vector: `[dx, dy]` of lengths, or `"<length> <direction>"` (3.2). */
export type VectorRef = [Length, Length] | string;
/** An element: an ID or a selector such as `north wall of Kitchen` (3.3). */
export type ElementRef = string;
/** A position along a wall: `centered`, `<length> from start`, `<length> from end`, or an offset (3.5). */
export type Position = Length;
export type Side = 'north' | 'south' | 'east' | 'west';
export type Point = [number, number];

/** The members every created element may carry (2.1, Core §1.4), passed into it as given. */
export interface CommonMembers {
  name?: string;
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}

// ── primitives (chapter 2) ─────────────────────────────────────────────────────

/**
 * 2.1: into one of the eleven collections, or (Ops 0.2) `"items"` — the program's items — or, with
 * `extension`, one of that extension's collections.
 */
export interface AddElement {
  op: 'addElement';
  collection: CollectionName | 'items' | (string & {});
  extension?: string;
  id?: string;
  element: Record<string, unknown>;
}
export interface AddJunction extends CommonMembers {
  op: 'addJunction';
  id?: string;
  level: ElementRef;
  position: PointRef;
  join?: unknown;
}
/** The members of a wall other than its level and junctions (Core §5.2). */
export interface WallMembers {
  type?: string;
  layers?: unknown[];
  justification?: 'center' | 'exteriorFace' | 'interiorFace' | 'coreFace';
  base?: Record<string, unknown>;
  top?: Record<string, unknown>;
  name?: string;
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}
export interface AddWall extends WallMembers {
  op: 'addWall';
  id?: string;
  level: ElementRef;
  start: ElementRef;
  end: ElementRef;
}
export interface AddSeparator extends CommonMembers {
  op: 'addSeparator';
  id?: string;
  level: ElementRef;
  start: ElementRef;
  end: ElementRef;
}
export interface RemoveElement {
  op: 'removeElement';
  id: ElementRef;
  cascade?: boolean;
}
export interface SetProperty {
  op: 'setProperty';
  /** An element (ID or selector), or one of the reserved targets $project, $site, $document. */
  id: ElementRef;
  path: string;
  value: unknown;
}
export interface UnsetProperty {
  op: 'unsetProperty';
  /** An element (ID or selector), or one of the reserved targets $project, $site, $document. */
  id: ElementRef;
  path: string;
}
export interface MoveJunction {
  op: 'moveJunction';
  id: ElementRef;
  to: PointRef;
}

export type AdjacencyKind = 'required' | 'preferred' | 'forbidden';
/** 2.6 (Ops 0.2): write the adjacency of an unordered pair of program items and a kind. */
export interface SetAdjacency {
  op: 'setAdjacency';
  a: ElementRef;
  b: ElementRef;
  kind: AdjacencyKind;
  weight?: unknown;
}
/** 2.6 (Ops 0.2): remove every adjacency of that pair and kind. */
export interface RemoveAdjacency {
  op: 'removeAdjacency';
  a: ElementRef;
  b: ElementRef;
  kind: AdjacencyKind;
}

export type Primitive = AddElement | AddJunction | AddWall | AddSeparator | RemoveElement | SetProperty | UnsetProperty | MoveJunction | SetAdjacency | RemoveAdjacency;

// ── composites (chapter 4) ─────────────────────────────────────────────────────

export interface DrawWall extends WallMembers {
  op: 'drawWall';
  id?: string;
  level: ElementRef;
  from: PointRef;
  to: PointRef;
}
export interface DrawSeparator extends CommonMembers {
  op: 'drawSeparator';
  id?: string;
  level: ElementRef;
  from: PointRef;
  to: PointRef;
}
export interface MoveWall {
  op: 'moveWall';
  wall: ElementRef;
  by: Length;
  toward?: ElementRef;
}
export interface MoveRoom {
  op: 'moveRoom';
  room: ElementRef;
  by: VectorRef;
}
export interface ResizeRoom {
  op: 'resizeRoom';
  room: ElementRef;
  side: Side;
  by: Length;
}
export interface AddOpening extends CommonMembers {
  op: 'addOpening';
  wall: ElementRef;
  at: Position;
  id?: string;
  fill?: string;
  width?: Length;
  height?: Length;
  sill?: Length;
  hinge?: 'start' | 'end';
  swing?: 'left' | 'right';
}
/**
 * 4.5: exactly one of `at` (absolute) and `by` (relative to the opening's offset); `toward`, only
 * with `by`, chooses its sign — toward the wall's start or end, or along the wall in whichever
 * direction points more that way.
 */
export interface MoveOpening {
  op: 'moveOpening';
  opening: ElementRef;
  at?: Position;
  by?: Length;
  toward?: 'start' | 'end' | Side;
}
export interface AddRoom extends CommonMembers {
  op: 'addRoom';
  level: ElementRef;
  at: PointRef;
  id?: string;
  function?: string;
  wallFinish?: string;
  floorFinish?: string;
  ceilingFinish?: string;
  /** Ops 0.2: the program item the room fulfils (3.3). */
  brief?: ElementRef;
}
export interface SetRoomFinish {
  op: 'setRoomFinish';
  room: ElementRef;
  surface: 'wall' | 'floor' | 'ceiling';
  material: string;
}
/** 4.6 (Ops 0.2): the room now fulfils that program item. */
export interface SetRoomBrief {
  op: 'setRoomBrief';
  room: ElementRef;
  item: ElementRef;
}
export interface RemoveWall {
  op: 'removeWall';
  wall: ElementRef;
  keep?: ElementRef;
}

/** 4.8: exactly one of `elevation`, `above` and `below`. */
export interface AddLevel extends CommonMembers {
  op: 'addLevel';
  id?: string;
  building: ElementRef;
  height: Length;
  elevation?: Length;
  above?: ElementRef;
  below?: ElementRef;
}

/** 4.9 (Ops 0.2): a program item — a bubble of the brief. */
export interface AddProgramItem {
  op: 'addProgramItem';
  function: unknown;
  id?: string;
  name?: unknown;
  count?: unknown;
  targetArea?: Area;
  minArea?: Area;
  level?: ElementRef;
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}

/** 4.10 (Ops 0.2): a host written with the reference grammar. */
export type HostRef =
  | ({ mode: 'wallFace'; wall: ElementRef; at: Position; height: Length } & ({ side: 'left' | 'right'; toward?: never } | { toward: ElementRef; side?: never }))
  | { mode: 'surface'; room: ElementRef; surface: 'floor' | 'ceiling'; at: PointRef; rotation?: unknown }
  | { mode: 'free'; level: ElementRef; at: PointRef; rotation?: unknown };

/** A resolved host (Core §13.3). */
export type Host =
  | { mode: 'wallFace'; wall: string; side: 'left' | 'right'; offset: number; height: number }
  | { mode: 'surface'; room: string; surface: 'floor' | 'ceiling'; position: Point; rotation?: unknown }
  | { mode: 'free'; level: string; position: Point; rotation?: unknown };

/** 4.10 (Ops 0.2): add an extension element placed on a host. */
export interface PlaceElement {
  op: 'placeElement';
  extension: string;
  collection: string;
  host: HostRef;
  element: Record<string, unknown>;
  id?: string;
}
/** 4.10 (Ops 0.2): place an existing extension element on a host. */
export interface MoveElement {
  op: 'moveElement';
  element: ElementRef;
  host: HostRef;
}

export type Composite =
  | DrawWall
  | DrawSeparator
  | MoveWall
  | MoveRoom
  | ResizeRoom
  | AddOpening
  | MoveOpening
  | AddRoom
  | SetRoomFinish
  | SetRoomBrief
  | RemoveWall
  | AddLevel
  | AddProgramItem
  | PlaceElement
  | MoveElement;
export type Operation = Primitive | Composite;
export type OperationName = Operation['op'];

// ── locks (chapter 6) and the request (1.1) ────────────────────────────────────

export type Lock = { element: string } | { length: string } | { distance: [string, string] };

export interface ApplyContext {
  locks?: Lock[];
  retired?: string[];
  /** Ops 0.3, 2.8: the design option the batch edits in. */
  option?: string;
}

export interface ApplyRequest {
  batch: Operation[];
  context?: ApplyContext;
}

// ── resolved primitives (1.4) ─────────────────────────────────────────────────

export type ResolvedPrimitive =
  | { op: 'addElement'; collection: string; extension?: string; id: string; element: Record<string, unknown> }
  | ({ op: 'addJunction'; id: string; level: string; position: unknown; join?: unknown })
  | ({ op: 'addWall'; id: string; level: string; start: string; end: string } & WallMembers)
  | { op: 'addSeparator'; id: string; level: string; start: string; end: string }
  | { op: 'removeElement'; id: string; cascade?: boolean }
  | { op: 'setProperty'; id: string; path: string; value: unknown }
  | { op: 'unsetProperty'; id: string; path: string }
  | { op: 'moveJunction'; id: string; to: Point }
  | { op: 'setAdjacency'; a: string; b: string; kind: AdjacencyKind; weight?: unknown }
  | { op: 'removeAdjacency'; a: string; b: string; kind: AdjacencyKind };

/** How `apply` and `resolveBatch` run. */
export interface ApplyOptions {
  /**
   * The draft of Floorspec Ops to follow. `'0.3'`, the default, applies to Core 0.3 documents (and
   * 0.2 and 0.1 ones) with Ops 0.2's operations; `'0.2'` is Ops 0.2 exactly as published: Core 0.2
   * documents (and 0.1 ones) — a document declaring "0.3" is FS-OPS-002 — with the program and
   * extension elements; `'0.1'` is Ops 0.1 exactly as published: Core 0.1 documents only, and the
   * 0.2 operations and members are FS-OPS-001.
   */
  readonly ops?: OpsVersion;
  /** Ops 0.2: the validator's known extensions (Core §12.2), as the engine takes them. Absent: none. */
  readonly knownExtensions?: string | Uint8Array | readonly unknown[];
  /**
   * Ops 0.2: the extensions the applier implements (Core §1.6.4), as the engine takes them — the
   * official ones it has (`OFFICIAL_EXTENSION_NAMES`). With `knownExtensions`, A and B are judged
   * under each extension's own invariants too (each extension's spec, 1.2): a batch that breaks one
   * is rejected (Ops 1.2.3). Absent: none, a core-only applier.
   */
  readonly extensions?: readonly string[];
}

// ── results (1.3) ─────────────────────────────────────────────────────────────

export interface CommittedResult {
  status: 'committed';
  /** B, as its canonical form (Core §9.2): the exact bytes, as a string ending in a line feed. */
  document: string;
  /** B's content hash (Core §9.3). */
  hash: string;
  /** The primitives the transaction applied, every reference resolved (1.4). */
  resolved: ResolvedPrimitive[];
  /** IDs of elements in B and not in A, sorted. */
  created: string[];
  /** IDs of elements in A and not in B, sorted. */
  removed: string[];
  /** A batch that turns B back into A (1.6). */
  inverse: ResolvedPrimitive[];
}

export interface RejectedResult {
  status: 'rejected';
  /** FS-OPS diagnostics, or the Core error diagnostics of the result (1.2.3). */
  diagnostics: Diagnostic[];
}

export type ApplyResult = CommittedResult | RejectedResult;

/** What resolveBatch returns: the batch resolved and expanded, not normalized, validated or committed. */
export type ResolveResult =
  | {
      status: 'resolved';
      /** Every primitive, in order, as the `resolved` echo of an apply would list it. */
      resolved: ResolvedPrimitive[];
      /** For each operation of the batch, in order: the primitives it expanded to. */
      operations: { index: number; op: string; primitives: ResolvedPrimitive[] }[];
    }
  | RejectedResult;
