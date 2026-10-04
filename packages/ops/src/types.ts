/**
 * The TypeScript types of Floorspec Ops 0.1 requests, operations and results (chapters 1–7),
 * written to match the specification's member tables (and schema/ops/0.1 when it is vendored).
 *
 * A `Length` is a JSON integer of base units or a length string (3.1); a `PointRef` a point (3.2);
 * an `ElementRef` an ID or a selector (3.3). Resolved operations — the `resolved` echo and the
 * `inverse` — carry only integers, points and IDs.
 */
import type { Diagnostic } from '@floorspec/engine';
import type { CollectionName, ReservedTarget } from './model/working.js';

export type { CollectionName, ReservedTarget };

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

// ── primitives (chapter 2) ─────────────────────────────────────────────────────

export interface AddElement {
  op: 'addElement';
  collection: CollectionName;
  id?: string;
  element: Record<string, unknown>;
}
export interface AddJunction {
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
export interface AddSeparator {
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

export type Primitive = AddElement | AddJunction | AddWall | AddSeparator | RemoveElement | SetProperty | UnsetProperty | MoveJunction;

// ── composites (chapter 4) ─────────────────────────────────────────────────────

export interface DrawWall extends Omit<WallMembers, 'extensions' | 'extras'> {
  op: 'drawWall';
  id?: string;
  level: ElementRef;
  from: PointRef;
  to: PointRef;
}
export interface DrawSeparator {
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
export interface AddOpening {
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
  name?: string;
}
export interface MoveOpening {
  op: 'moveOpening';
  opening: ElementRef;
  at: Position;
}
export interface AddRoom {
  op: 'addRoom';
  level: ElementRef;
  at: PointRef;
  id?: string;
  name?: string;
  function?: string;
  wallFinish?: string;
  floorFinish?: string;
  ceilingFinish?: string;
}
export interface SetRoomFinish {
  op: 'setRoomFinish';
  room: ElementRef;
  surface: 'wall' | 'floor' | 'ceiling';
  material: string;
}
export interface RemoveWall {
  op: 'removeWall';
  wall: ElementRef;
  keep?: ElementRef;
}

export type Composite = DrawWall | DrawSeparator | MoveWall | MoveRoom | ResizeRoom | AddOpening | MoveOpening | AddRoom | SetRoomFinish | RemoveWall;
export type Operation = Primitive | Composite;
export type OperationName = Operation['op'];

// ── locks (chapter 6) and the request (1.1) ────────────────────────────────────

export type Lock = { element: string } | { length: string } | { distance: [string, string] };

export interface ApplyContext {
  locks?: Lock[];
  retired?: string[];
}

export interface ApplyRequest {
  batch: Operation[];
  context?: ApplyContext;
}

// ── resolved primitives (1.4) ─────────────────────────────────────────────────

export type ResolvedPrimitive =
  | { op: 'addElement'; collection: CollectionName; id: string; element: Record<string, unknown> }
  | ({ op: 'addJunction'; id: string; level: string; position: unknown; join?: unknown })
  | ({ op: 'addWall'; id: string; level: string; start: string; end: string } & WallMembers)
  | { op: 'addSeparator'; id: string; level: string; start: string; end: string }
  | { op: 'removeElement'; id: string; cascade?: boolean }
  | { op: 'setProperty'; id: string; path: string; value: unknown }
  | { op: 'unsetProperty'; id: string; path: string }
  | { op: 'moveJunction'; id: string; to: Point };

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
