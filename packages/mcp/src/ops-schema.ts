import { z } from 'zod';
import { ROOM_FUNCTIONS } from './vocabulary.js';

/**
 * The Floorspec Ops 0.2 vocabulary as typed input schemas (Ops chapters 2–4), so `floorspec_apply`
 * and `floorspec_propose` advertise exactly the operations the standard defines — a discriminated
 * union on `op`, each with exactly its members (Ops 1.1.2) — the program (items, adjacencies,
 * briefs) and placing extension elements (devices, fixtures, furniture) on hosts included.
 *
 * Hand-written from the spec; a test holds every operation's members to the vendored
 * `schema/ops/0.2`. The shapes are deliberately loose where the reference grammar is (a length may
 * be an integer of base units or a string such as `2' 6"`), and the applier is the judge of every
 * value: a schema that resolved references would be a second applier.
 */

const describe = <T extends z.ZodType>(schema: T, text: string) => schema.describe(text);

/**
 * A shared definition: emitted once under the tool schema's `$defs` and referenced by `$ref`
 * wherever it is used, rather than inlined at every member. Without this the operation union,
 * with its lengths, points and selectors spelled out at each use, made `tools/list` ~57 KB.
 */
const shared = <T extends z.ZodType>(schema: T, id: string, description?: string) =>
  schema.meta(description === undefined ? { id } : { id, description });

/** A length: an integer of base units (1/1280 mm), or a string such as `12' 6"`, `6 1/2"`, `3810mm`. */
export const Length = shared(
  z.union([z.int(), z.string().min(1).max(64)]),
  'Length',
  'An integer in base units (1/1280 mm; 1 ft = 390144, 1 in = 32512) or a string like "12\' 6\\"", "6 1/2\\"", "3810mm", "-2\'".',
);

/** A point: `[x, y]` of lengths, a junction ID, or `"<length> <direction> of <junction>"`, `"<length> from J1 toward J2"`. */
/** `[x, y]` or `[dx, dy]`: two lengths. */
const XY = shared(z.tuple([Length, Length]), 'XY');

export const Point = shared(
  z.union([XY, z.string().min(1).max(200)]),
  'Point',
  '[x, y] lengths; a junction ID; "12\' east of J4"; or "3\' from J1 toward J2".',
);

/** A vector: `[dx, dy]` of lengths, or `"<length> <direction>"`. */
export const Vector = shared(
  z.union([XY, z.string().min(1).max(100)]),
  'Vector',
  '[dx, dy] lengths, or "<length> north|south|east|west" like "1\' 6\\" west".',
);

/** An element: an ID or a selector — a room name, `north wall of Kitchen`, `wall between R2 and R5`, `start of W3`. */
export const Element = shared(
  z.string().min(1).max(200),
  'Element',
  'An element ID (W12, R5) or a selector: a room name, "north wall of Kitchen", "wall between R2 and R5", "start of W3".',
);

/** A position along a wall: `centered`, `"<length> from start"`, `"<length> from end"`, or an offset. */
export const Position = shared(
  z.union([z.int(), z.string().min(1).max(100)]),
  'Position',
  'Along a wall: "centered", "2\' from start", "18\\" from end", or an offset length.',
);

/** An area: an integer of square base units, or a string such as `11 m2`, `120 sq ft`. */
export const Area = shared(z.union([z.int(), z.string().min(1).max(64)]), 'Area', '"11 m2", "120 sq ft", or square base units.');

const Id = shared(z.string().min(1).max(64), 'NewId', 'An ID for the new element; omitted, the next is minted (W13).');
const Side = shared(z.enum(['north', 'south', 'east', 'west']), 'Side');
/** Any JSON value — present: a missing `value` is not `null`. */
const Json = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);
/** A JSON object; emitted inline — `{"type":"object"}` is shorter than a reference to it. */
const Obj = z.record(z.string(), z.unknown());

export const COLLECTIONS = [
  'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'types', 'materials', 'assets',
] as const;
export const Collection = shared(z.enum(COLLECTIONS), 'Collection');
/** Core 4.1's room functions, said once for addRoom and addProgramItem. */
const RoomFunction = shared(z.string().max(64), 'Function', `One of ${ROOM_FUNCTIONS.join(', ')}; or an extension term.`);
/** A program item: its ID or name, or `item <item>`, `brief of <room>`. */
const Item = shared(z.string().min(1).max(200), 'Item', 'A program item: its ID or name, "item Kitchen", or "brief of R2".');
const AdjacencyKind = shared(z.enum(['required', 'preferred', 'forbidden']), 'AdjacencyKind');
/** An extension's name and one of its collections. */
const Extension = shared(z.string().min(1).max(64), 'Extension', 'An extension name: FS_electrical, FS_plumbing, FS_furniture.');
const ExtCollection = z.string().min(1).max(64).describe('Its collection: devices, fixtures, pieces.');

/**
 * A host reference (Ops 4.10): where a hosted element is placed, written with the reference grammar.
 * A wall face takes exactly one of `side` and `toward`.
 */
export const Host = shared(
  z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('wallFace'),
      wall: Element,
      side: z.enum(['left', 'right']).optional(),
      toward: describe(Element, 'The room the face looks into.').optional(),
      at: describe(Position, '"2\' from start", "centered": a point along the wall.'),
      height: describe(Length, 'Above the wall base.'),
    }),
    z.strictObject({ mode: z.literal('surface'), room: Element, surface: z.enum(['floor', 'ceiling']), at: Point, rotation: z.int().optional() }),
    z.strictObject({ mode: z.literal('free'), level: Element, at: Point, rotation: z.int().optional() }),
  ]),
  'Host',
  'wallFace: exactly one of side and toward. rotation: microdegrees.',
);

const Justification = shared(z.enum(['center', 'exteriorFace', 'interiorFace', 'coreFace']), 'Justification');
const Name = shared(z.string().max(200), 'Name');
/** What setProperty and unsetProperty address: an element, or the document's singletons. */
const Target = shared(z.string().min(1).max(200), 'Target', 'An element ID or selector, or $project, $site, $document.');
const Pointer = shared(z.string().regex(/^\//).max(200), 'Pointer', 'A JSON Pointer into it: "/name".');

/** The members every element may carry, accepted on the operations that create one (Ops 2.1). */
const elementMembers = {
  name: Name.optional(),
  extensions: Obj.optional(),
  extras: Obj.optional(),
};

/** The members a wall may carry beside its endpoints (Core 5.2). */
const wallMembers = {
  type: Element.optional(),
  layers: z.array(Obj).optional(),
  justification: Justification.optional(),
  base: Obj.optional(),
  top: Obj.optional(),
  ...elementMembers,
};

// ─── Primitives (chapter 2) ────────────────────────────────────────────────

export const AddElement = z.strictObject({
  op: z.literal('addElement'),
  collection: describe(z.string().min(1).max(64), 'A Core collection, "items" (the program), or with extension one of its collections.'),
  extension: Extension.optional(),
  id: Id.optional(),
  element: describe(Obj, 'The element, exactly as Floorspec Core defines it for the collection.'),
});

export const AddJunction = z.strictObject({
  op: z.literal('addJunction'),
  id: Id.optional(),
  level: Element,
  position: Point,
  join: Obj.optional(),
  ...elementMembers,
});

export const AddWall = z.strictObject({
  op: z.literal('addWall'),
  id: Id.optional(),
  level: Element,
  start: Element,
  end: Element,
  ...wallMembers,
}).describe('Prefer drawWall.');

export const AddSeparator = z.strictObject({
  op: z.literal('addSeparator'),
  id: Id.optional(),
  level: Element,
  start: Element,
  end: Element,
  ...elementMembers,
});

export const RemoveElement = z.strictObject({
  op: z.literal('removeElement'),
  id: Element,
  cascade: z.boolean().optional(),
}).describe('cascade also removes its dependents.');

export const SetProperty = z.strictObject({
  op: z.literal('setProperty'),
  id: Target,
  path: Pointer,
  value: Json,
});

export const UnsetProperty = z.strictObject({
  op: z.literal('unsetProperty'),
  id: Target,
  path: Pointer,
});

export const MoveJunction = z.strictObject({
  op: z.literal('moveJunction'),
  id: Element,
  to: Point,
});

export const SetAdjacency = z.strictObject({
  op: z.literal('setAdjacency'),
  a: Item,
  b: Item,
  kind: AdjacencyKind,
  weight: z.number().optional(),
}).describe('Adds, or replaces, the line between two program items.');

export const RemoveAdjacency = z.strictObject({
  op: z.literal('removeAdjacency'),
  a: Item,
  b: Item,
  kind: AdjacencyKind,
});

// ─── Composites (chapter 4) ────────────────────────────────────────────────

export const DrawWall = z.strictObject({
  op: z.literal('drawWall'),
  id: Id.optional(),
  level: Element,
  from: Point,
  to: Point,
  ...wallMembers,
}).describe('Reuses junctions; splits walls it crosses.');

export const DrawSeparator = z.strictObject({
  op: z.literal('drawSeparator'),
  id: Id.optional(),
  level: Element,
  from: Point,
  to: Point,
  ...elementMembers,
});

export const MoveWall = z.strictObject({
  op: z.literal('moveWall'),
  wall: Element,
  by: Length,
  toward: Element.optional(),
}).describe('toward: the room it moves into.');

export const MoveRoom = z.strictObject({
  op: z.literal('moveRoom'),
  room: Element,
  by: Vector,
});

export const ResizeRoom = z.strictObject({
  op: z.literal('resizeRoom'),
  room: Element,
  side: Side,
  by: Length,
}).describe('A negative by shrinks the room.');

export const AddOpening = z.strictObject({
  op: z.literal('addOpening'),
  id: Id.optional(),
  wall: Element,
  at: Position,
  fill: Element.optional(),
  width: Length.optional(),
  height: Length.optional(),
  sill: Length.optional(),
  hinge: z.string().max(32).optional(),
  swing: z.string().max(32).optional(),
  ...elementMembers,
}).describe('Without a fill type, give width and height.');

export const MoveOpening = z.strictObject({
  op: z.literal('moveOpening'),
  opening: Element,
  at: Position.optional(),
  by: describe(Length, 'Along the wall: + toward its end, - toward its start.').optional(),
  toward: describe(z.enum(['start', 'end', 'north', 'south', 'east', 'west']), 'Gives the sign of by instead.').optional(),
}).describe('Exactly one of at and by.');

export const AddRoom = z.strictObject({
  op: z.literal('addRoom'),
  id: Id.optional(),
  level: Element,
  at: Point,
  name: Name.optional(),
  function: RoomFunction.optional(),
  wallFinish: Element.optional(),
  floorFinish: Element.optional(),
  ceilingFinish: Element.optional(),
  brief: describe(Item, 'The program item it fulfils.').optional(),
  extensions: Obj.optional(),
  extras: Obj.optional(),
}).describe('Makes the face containing at a room.');

export const SetRoomBrief = z.strictObject({
  op: z.literal('setRoomBrief'),
  room: Element,
  item: Item,
});

export const SetRoomFinish = z.strictObject({
  op: z.literal('setRoomFinish'),
  room: Element,
  surface: z.enum(['wall', 'floor', 'ceiling']),
  material: Element,
});

export const RemoveWall = z.strictObject({
  op: z.literal('removeWall'),
  wall: Element,
  keep: Element.optional(),
}).describe('Removes its openings too; keep: the room that survives a merge.');

export const AddLevel = z.strictObject({
  op: z.literal('addLevel'),
  id: Id.optional(),
  building: Element,
  height: Length,
  elevation: Length.optional(),
  above: Element.optional(),
  below: Element.optional(),
  ...elementMembers,
}).describe('Exactly one of elevation, above and below (a level).');

export const AddProgramItem = z.strictObject({
  op: z.literal('addProgramItem'),
  id: Id.optional(),
  function: RoomFunction,
  name: Name.optional(),
  count: z.int().min(1).optional(),
  targetArea: Area.optional(),
  minArea: Area.optional(),
  level: describe(Element, 'Preferred level.').optional(),
  extensions: Obj.optional(),
  extras: Obj.optional(),
}).describe('A bubble of the brief.');

export const PlaceElement = z.strictObject({
  op: z.literal('placeElement'),
  id: Id.optional(),
  extension: Extension,
  collection: ExtCollection,
  host: Host,
  element: describe(Obj, 'Its members besides host: fallback.box, the extension\'s own.'),
}).describe('Adds an outlet, fixture or piece on a host.');

export const MoveElement = z.strictObject({
  op: z.literal('moveElement'),
  element: describe(Element, 'An extension element: its ID or name.'),
  host: Host,
});

/** Every operation Floorspec Ops 0.2 defines — one `$defs` entry per tool, referenced by the batch. */
export const OpUnion = shared(
  z.discriminatedUnion('op', [
    AddElement, AddJunction, AddWall, AddSeparator, RemoveElement, SetProperty, UnsetProperty, MoveJunction, SetAdjacency, RemoveAdjacency,
    DrawWall, DrawSeparator, MoveWall, MoveRoom, ResizeRoom, AddOpening, MoveOpening, AddRoom, SetRoomFinish, SetRoomBrief, RemoveWall, AddLevel,
    AddProgramItem, PlaceElement, MoveElement,
  ]),
  'Op',
);
export type OpInput = z.infer<typeof OpUnion>;

export const OP_NAMES = OpUnion.options.map((o) => o.shape.op.value);

/**
 * The operation union as `floorspec_propose` advertises it: the op names, with the members left to
 * `floorspec_apply`'s schema, so the 25-way union is spelled out once in `tools/list` rather than
 * twice. Only the advertisement is lighter — propose validates its batch against `OpUnion` exactly
 * as apply does, so a member that apply refuses, propose refuses too.
 */
export const OP_BY_NAME_ONLY = {
  type: 'object',
  properties: { op: { enum: OP_NAMES } },
  required: ['op'],
  description: "An operation: members exactly as floorspec_apply's batch items ($defs/Op there).",
};

export const Batch = z.array(OpUnion).min(1).max(200).describe('Ops applied in order; all commit, or none.');

export const Lock = shared(z.union([
  z.strictObject({ element: z.string().min(1) }),
  z.strictObject({ length: z.string().min(1) }),
  z.strictObject({ distance: z.tuple([z.string().min(1), z.string().min(1)]) }),
]), 'Lock', 'Ops 6: an element, a wall length, or the distance between two parallel walls.');
