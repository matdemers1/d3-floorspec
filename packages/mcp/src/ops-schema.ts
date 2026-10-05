import { z } from 'zod';

/**
 * The Floorspec Ops 0.1 vocabulary as typed input schemas (Ops chapters 2–4), so `floorspec_apply`
 * and `floorspec_propose` advertise exactly the operations the standard defines — a discriminated
 * union on `op`, each with exactly its members (Ops 1.1.1).
 *
 * Hand-written from the spec until the standard's `schema/ops/0.1` is vendored; then this file
 * imports that schema instead. The shapes are deliberately loose where the reference grammar is
 * (a length may be an integer of base units or a string such as `2' 6"`), and the applier is the
 * judge of every value: a schema that resolved references would be a second applier.
 */

const describe = <T extends z.ZodType>(schema: T, text: string) => schema.describe(text);

/** A length: an integer of base units (1/1280 mm), or a string such as `12' 6"`, `6 1/2"`, `3810mm`. */
export const Length = describe(
  z.union([z.int(), z.string().min(1).max(64)]),
  'A length: an integer in base units (1/1280 mm; 1 ft = 390144, 1 in = 32512) or a string like "12\' 6\\"", "6 1/2\\"", "3810mm", "-2\'".',
);

/** A point: `[x, y]` of lengths, a junction ID, or `"<length> <direction> of <junction>"`, `"<length> from J1 toward J2"`. */
export const Point = describe(
  z.union([z.tuple([Length, Length]), z.string().min(1).max(200)]),
  'A point: [x, y] lengths; a junction ID; "12\' east of J4"; or "3\' from J1 toward J2".',
);

/** A vector: `[dx, dy]` of lengths, or `"<length> <direction>"`. */
export const Vector = describe(
  z.union([z.tuple([Length, Length]), z.string().min(1).max(100)]),
  'A vector: [dx, dy] lengths, or "<length> north|south|east|west" like "1\' 6\\" west".',
);

/** An element: an ID or a selector — a room name, `north wall of Kitchen`, `wall between R2 and R5`, `start of W3`. */
export const Element = describe(
  z.string().min(1).max(200),
  'An element ID (W12, R5) or a selector: a room name, "north wall of Kitchen", "wall between R2 and R5", "start of W3".',
);

/** A position along a wall: `centered`, `"<length> from start"`, `"<length> from end"`, or an offset. */
export const Position = describe(
  z.union([z.int(), z.string().min(1).max(100)]),
  'A position along a wall: "centered", "2\' from start", "18\\" from end", or an offset length.',
);

const Id = describe(z.string().min(1).max(64), 'The ID to create the element under; omitted, the applier mints the next one (W13).');
const Side = z.enum(['north', 'south', 'east', 'west']);
/** Any JSON value — present: a missing `value` is not `null`. */
const Json = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);
const Obj = z.record(z.string(), z.unknown());

export const COLLECTIONS = [
  'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'types', 'materials', 'assets',
] as const;
export const Collection = z.enum(COLLECTIONS);

const Justification = z.enum(['center', 'exteriorFace', 'interiorFace', 'coreFace']);

/** The members every element may carry, accepted on the operations that create one (Ops 0.1). */
const elementMembers = {
  name: z.string().max(200).optional(),
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
  collection: Collection,
  id: Id.optional(),
  element: describe(Obj, 'The element, exactly as Floorspec Core defines it for the collection.'),
}).describe('Add an element to a collection (Ops 2.1).');

export const AddJunction = z.strictObject({
  op: z.literal('addJunction'),
  id: Id.optional(),
  level: Element,
  position: Point,
  join: Obj.optional(),
  ...elementMembers,
}).describe('Add a junction: addElement into junctions (Ops 2.1).');

export const AddWall = z.strictObject({
  op: z.literal('addWall'),
  id: Id.optional(),
  level: Element,
  start: Element,
  end: Element,
  ...wallMembers,
}).describe('Add a wall between two existing junctions: addElement into walls (Ops 2.1). Prefer drawWall.');

export const AddSeparator = z.strictObject({
  op: z.literal('addSeparator'),
  id: Id.optional(),
  level: Element,
  start: Element,
  end: Element,
  ...elementMembers,
}).describe('Add a zero-thickness room separator between two junctions (Ops 2.1).');

export const RemoveElement = z.strictObject({
  op: z.literal('removeElement'),
  id: Element,
  cascade: z.boolean().optional(),
}).describe('Remove an element; cascade: true also removes what depends on it (Ops 2.2).');

export const SetProperty = z.strictObject({
  op: z.literal('setProperty'),
  id: describe(z.string().min(1).max(200), 'An element ID or selector, or $project, $site, $document.'),
  path: describe(z.string().regex(/^\//).max(200), 'A JSON Pointer relative to the element, e.g. "/justification".'),
  value: Json,
}).describe('Set one member of an element (Ops 2.3).');

export const UnsetProperty = z.strictObject({
  op: z.literal('unsetProperty'),
  id: describe(z.string().min(1).max(200), 'An element ID or selector, or $project, $site, $document.'),
  path: z.string().regex(/^\//).max(200),
}).describe('Remove one member of an element so its default applies (Ops 2.3).');

export const MoveJunction = z.strictObject({
  op: z.literal('moveJunction'),
  id: Element,
  to: Point,
}).describe("Move a junction; walls that meet it follow (Ops 2.4).");

// ─── Composites (chapter 4) ────────────────────────────────────────────────

export const DrawWall = z.strictObject({
  op: z.literal('drawWall'),
  id: Id.optional(),
  level: Element,
  from: Point,
  to: Point,
  ...wallMembers,
}).describe('Draw a wall from a point or junction to another; reuses junctions, splits crossed walls (Ops 4.1).');

export const DrawSeparator = z.strictObject({
  op: z.literal('drawSeparator'),
  id: Id.optional(),
  level: Element,
  from: Point,
  to: Point,
  ...elementMembers,
}).describe('Draw a room separator, like drawWall (Ops 4.1).');

export const MoveWall = z.strictObject({
  op: z.literal('moveWall'),
  wall: Element,
  by: Length,
  toward: Element.optional(),
}).describe('Move a wall sideways by a length; with toward, into that room (Ops 4.2).');

export const MoveRoom = z.strictObject({
  op: z.literal('moveRoom'),
  room: Element,
  by: Vector,
}).describe('Move a room\'s outline and anchor by a vector (Ops 4.3).');

export const ResizeRoom = z.strictObject({
  op: z.literal('resizeRoom'),
  room: Element,
  side: Side,
  by: Length,
}).describe('Move one side of a room outward (inward when negative): "make the kitchen 2\' wider" (Ops 4.4).');

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
}).describe('Put a door, window or cased opening in a wall at a position (Ops 4.5).');

export const MoveOpening = z.strictObject({
  op: z.literal('moveOpening'),
  opening: Element,
  at: Position,
}).describe('Move an opening along its wall (Ops 4.5).');

export const AddRoom = z.strictObject({
  op: z.literal('addRoom'),
  id: Id.optional(),
  level: Element,
  at: Point,
  name: z.string().max(200).optional(),
  function: z.string().max(64).optional(),
  wallFinish: Element.optional(),
  floorFinish: Element.optional(),
  ceilingFinish: Element.optional(),
  extensions: Obj.optional(),
  extras: Obj.optional(),
}).describe('Name the face that contains a point as a room (Ops 4.6).');

export const SetRoomFinish = z.strictObject({
  op: z.literal('setRoomFinish'),
  room: Element,
  surface: z.enum(['wall', 'floor', 'ceiling']),
  material: Element,
}).describe("Set a room's wall, floor or ceiling finish (Ops 4.6).");

export const RemoveWall = z.strictObject({
  op: z.literal('removeWall'),
  wall: Element,
  keep: Element.optional(),
}).describe('Remove a wall and its openings; keep names the room that survives a merge (Ops 4.7).');

/** Every operation Floorspec Ops 0.1 defines. */
export const OpUnion = z.discriminatedUnion('op', [
  AddElement, AddJunction, AddWall, AddSeparator, RemoveElement, SetProperty, UnsetProperty, MoveJunction,
  DrawWall, DrawSeparator, MoveWall, MoveRoom, ResizeRoom, AddOpening, MoveOpening, AddRoom, SetRoomFinish, RemoveWall,
]);
export type OpInput = z.infer<typeof OpUnion>;

export const OP_NAMES = OpUnion.options.map((o) => o.shape.op.value);

export const Batch = z.array(OpUnion).min(1).max(200).describe('A batch: operations applied in order as one transaction — all commit, or none.');

export const Lock = z.union([
  z.strictObject({ element: z.string().min(1) }),
  z.strictObject({ length: z.string().min(1) }),
  z.strictObject({ distance: z.tuple([z.string().min(1), z.string().min(1)]) }),
]).describe('A lock in force (Ops 6): an element, a wall length, or the distance between two parallel walls.');
