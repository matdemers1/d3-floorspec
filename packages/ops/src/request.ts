/**
 * The shape of an apply request (1.1): a batch of at least one operation the draft defines, each
 * with exactly the members its definition lists, and an optional context of locks and retired IDs.
 * Anything else is FS-OPS-001 (Ops 0.1: 1.1.1; Ops 0.2: 1.1.2) — including an operation with none,
 * or more than one, of a group of members of which it takes exactly one (moveOpening's `at` and
 * `by`, addLevel's `elevation`, `above` and `below`, a wall-face host's `side` and `toward`), or
 * with `toward` but no `by` on moveOpening.
 *
 * Ops 0.1 is the table as published (schema/ops/0.1 at 3bf4f35): moveOpening takes `at` only and
 * there is no addLevel. Ops 0.2 (schema/ops/0.2) adds moveOpening's `by` and `toward`, addLevel,
 * addElement into `items` or an extension's collection, the adjacency primitives, addRoom's
 * `brief`, setRoomBrief, addProgramItem, placeElement and moveElement.
 *
 * Members that become element content (inside addElement's element, the shorthands' and
 * drawWall's wall members) are not checked here: addElement does not check content (2.1.1),
 * validation does. The shapes match the vendored schemas, and a test holds them to them.
 */
import { fail } from './diagnostics.js';
import { COLLECTIONS, isCollection, ITEMS, type OpsVersion } from './model/working.js';
import { isObject, toPointer } from './lib/json.js';
import type { ApplyRequest, OperationName } from './types.js';

type MemberType =
  | 'string' // an ID, a selector, a reference
  | 'length' // JSON integer or string
  | 'pair' // a point or vector: [length, length] or a string
  | 'boolean'
  | 'object'
  | 'any'
  | 'collection'
  | 'side'
  | 'surface'
  | 'toward' // moveOpening's: start, end or a side
  | 'kind' // an adjacency's: required, preferred or forbidden
  | 'host'; // 4.10: a host reference, checked by its mode

interface OpShape {
  readonly required: Readonly<Record<string, MemberType>>;
  readonly optional: Readonly<Record<string, MemberType>>;
  /** Groups of optional members of which exactly one must be present (4.5, 4.8). */
  readonly oneOf?: readonly (readonly string[])[];
  /** Optional members allowed only beside another member. */
  readonly needs?: Readonly<Record<string, string>>;
}

/** The members every created element may carry (2.1, Core §1.4), passed into it as given. */
const COMMON: Record<string, MemberType> = { name: 'any', extensions: 'any', extras: 'any' };

/** The members of a wall that addWall and drawWall carry through to the element (Core §5.2). */
const WALL_MEMBERS: Record<string, MemberType> = { type: 'any', layers: 'any', justification: 'any', base: 'any', top: 'any', ...COMMON };

/** Ops 0.1, as published at 3bf4f35. */
const SHAPES_01: Readonly<Partial<Record<OperationName, OpShape>>> = {
  addElement: { required: { collection: 'collection', element: 'object' }, optional: { id: 'string' } },
  addJunction: { required: { level: 'string', position: 'pair' }, optional: { id: 'string', join: 'any', ...COMMON } },
  addWall: { required: { level: 'string', start: 'string', end: 'string' }, optional: { id: 'string', ...WALL_MEMBERS } },
  addSeparator: { required: { level: 'string', start: 'string', end: 'string' }, optional: { id: 'string', ...COMMON } },
  removeElement: { required: { id: 'string' }, optional: { cascade: 'boolean' } },
  setProperty: { required: { id: 'string', path: 'string', value: 'any' }, optional: {} },
  unsetProperty: { required: { id: 'string', path: 'string' }, optional: {} },
  moveJunction: { required: { id: 'string', to: 'pair' }, optional: {} },
  drawWall: { required: { level: 'string', from: 'pair', to: 'pair' }, optional: { id: 'string', ...WALL_MEMBERS } },
  drawSeparator: { required: { level: 'string', from: 'pair', to: 'pair' }, optional: { id: 'string', ...COMMON } },
  moveWall: { required: { wall: 'string', by: 'length' }, optional: { toward: 'string' } },
  moveRoom: { required: { room: 'string', by: 'pair' }, optional: {} },
  resizeRoom: { required: { room: 'string', side: 'side', by: 'length' }, optional: {} },
  addOpening: {
    required: { wall: 'string', at: 'length' },
    optional: { id: 'string', fill: 'string', width: 'length', height: 'length', sill: 'length', hinge: 'any', swing: 'any', ...COMMON },
  },
  moveOpening: { required: { opening: 'string', at: 'length' }, optional: {} },
  addRoom: {
    required: { level: 'string', at: 'pair' },
    optional: { id: 'string', function: 'any', wallFinish: 'any', floorFinish: 'any', ceilingFinish: 'any', ...COMMON },
  },
  setRoomFinish: { required: { room: 'string', surface: 'surface', material: 'string' }, optional: {} },
  removeWall: { required: { wall: 'string' }, optional: { keep: 'string' } },
};

/** Ops 0.2: the 0.1 table, with these operations added or changed. */
const SHAPES_02: Readonly<Record<OperationName, OpShape>> = {
  ...(SHAPES_01 as Record<OperationName, OpShape>),
  // 2.1: the eleven collections, `items`, or — with `extension` — an extension's collection.
  addElement: { required: { collection: 'string', element: 'object' }, optional: { id: 'string', extension: 'string' } },
  setAdjacency: { required: { a: 'string', b: 'string', kind: 'kind' }, optional: { weight: 'any' } },
  removeAdjacency: { required: { a: 'string', b: 'string', kind: 'kind' }, optional: {} },
  moveOpening: { required: { opening: 'string' }, optional: { at: 'length', by: 'length', toward: 'toward' }, oneOf: [['at', 'by']], needs: { toward: 'by' } },
  addRoom: {
    required: { level: 'string', at: 'pair' },
    optional: { id: 'string', function: 'any', wallFinish: 'any', floorFinish: 'any', ceilingFinish: 'any', brief: 'string', ...COMMON },
  },
  setRoomBrief: { required: { room: 'string', item: 'string' }, optional: {} },
  addLevel: {
    required: { building: 'string', height: 'length' },
    optional: { elevation: 'length', above: 'string', below: 'string', id: 'string', ...COMMON },
    oneOf: [['elevation', 'above', 'below']],
  },
  addProgramItem: { required: { function: 'any' }, optional: { id: 'string', count: 'any', targetArea: 'length', minArea: 'length', level: 'string', ...COMMON } },
  placeElement: { required: { extension: 'string', collection: 'string', host: 'host', element: 'object' }, optional: { id: 'string' } },
  moveElement: { required: { element: 'string', host: 'host' }, optional: {} },
};

/** The operations of each draft and their members. */
export const OP_SHAPES_BY_VERSION: Readonly<Record<OpsVersion, Readonly<Partial<Record<OperationName, OpShape>>>>> = { '0.1': SHAPES_01, '0.2': SHAPES_02 };
/** The operations of Ops 0.2, the current draft, and their members. */
export const OP_SHAPES: Readonly<Record<OperationName, OpShape>> = SHAPES_02;

/** 4.10: the members of a host reference, by mode. */
export const HOST_SHAPES: Readonly<Record<'wallFace' | 'surface' | 'free', OpShape>> = {
  wallFace: { required: { wall: 'string', at: 'length', height: 'length' }, optional: { side: 'any', toward: 'string' }, oneOf: [['side', 'toward']] },
  surface: { required: { room: 'string', surface: 'any', at: 'pair' }, optional: { rotation: 'any' } },
  free: { required: { level: 'string', at: 'pair' }, optional: { rotation: 'any' } },
};

const isLength = (v: unknown, nonInteger: ReadonlySet<string>, ptr: string): boolean =>
  typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v) && !nonInteger.has(ptr));

function typeOk(t: MemberType, v: unknown, nonInteger: ReadonlySet<string>, ptr: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'length':
      return isLength(v, nonInteger, ptr);
    case 'pair':
      return typeof v === 'string' || (Array.isArray(v) && v.length === 2 && v.every((c, i) => isLength(c, nonInteger, `${ptr}/${i}`)));
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObject(v);
    case 'any':
      return true;
    case 'collection':
      return isCollection(v);
    case 'side':
      return v === 'north' || v === 'south' || v === 'east' || v === 'west';
    case 'surface':
      return v === 'wall' || v === 'floor' || v === 'ceiling';
    case 'toward':
      return v === 'start' || v === 'end' || v === 'north' || v === 'south' || v === 'east' || v === 'west';
    case 'kind':
      return v === 'required' || v === 'preferred' || v === 'forbidden';
    case 'host':
      return isObject(v);
  }
}

/** Check one object's members against a shape (required, then each member in order, then the groups). */
function checkMembers(name: string, obj: Record<string, unknown>, shape: OpShape, base: string, tokens: (string | number)[], nonInteger: ReadonlySet<string>, skip: string): void {
  for (const [m, t] of Object.entries(shape.required)) {
    if (!Object.hasOwn(obj, m)) fail('FS-OPS-001', `${name} needs ${JSON.stringify(m)}`, [], base);
    if (!typeOk(t, obj[m], nonInteger, `${base}/${m}`)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is not ${describe(t)}`, [], `${base}/${m}`);
  }
  for (const m of Object.keys(obj)) {
    if (m === skip || Object.hasOwn(shape.required, m)) continue;
    if (!Object.hasOwn(shape.optional, m)) fail('FS-OPS-001', `${name} has no member ${JSON.stringify(m)}`, [], toPointer([...tokens, m]));
    const t = shape.optional[m]!;
    if (!typeOk(t, obj[m], nonInteger, `${base}/${m}`)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is not ${describe(t)}`, [], `${base}/${m}`);
  }
  for (const group of shape.oneOf ?? [])
    if (group.filter((m) => Object.hasOwn(obj, m)).length !== 1) fail('FS-OPS-001', `${name} takes exactly one of ${group.map((m) => JSON.stringify(m)).join(', ')}`, [], base);
  for (const [m, other] of Object.entries(shape.needs ?? {}))
    if (Object.hasOwn(obj, m) && !Object.hasOwn(obj, other)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is allowed only with ${JSON.stringify(other)}`, [], `${base}/${m}`);
}

const HOST_ENUMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  wallFace: { side: ['left', 'right'] },
  surface: { surface: ['floor', 'ceiling'] },
  free: {},
};

/** 4.10: a host reference has exactly the members of its mode. */
function checkHost(host: Record<string, unknown>, base: string, tokens: (string | number)[], nonInteger: ReadonlySet<string>): void {
  const mode = host.mode;
  if (mode !== 'wallFace' && mode !== 'surface' && mode !== 'free') return fail('FS-OPS-001', `a host's mode is "wallFace", "surface" or "free", not ${JSON.stringify(mode)}`, [], `${base}/mode`);
  checkMembers(`a ${mode} host`, host, HOST_SHAPES[mode], base, tokens, nonInteger, 'mode');
  for (const [m, values] of Object.entries(HOST_ENUMS[mode]!))
    if (Object.hasOwn(host, m) && !values.includes(host[m] as string)) fail('FS-OPS-001', `a ${mode} host's ${JSON.stringify(m)} is ${values.join(' or ')}`, [], `${base}/${m}`);
}

/**
 * Check a request's shape (1.1.1), throwing FS-OPS-001 at the first problem. `nonInteger` holds the
 * pointers of numbers written with a fraction or an exponent, which are not JSON integers.
 */
export function checkRequest(request: unknown, nonInteger: ReadonlySet<string> = new Set(), ops: OpsVersion = '0.2'): ApplyRequest {
  const shapes = OP_SHAPES_BY_VERSION[ops];
  if (!isObject(request)) return fail('FS-OPS-001', 'an apply request is an object { "batch": [...], "context"?: {...} }', [], '');
  for (const k of Object.keys(request))
    if (k !== 'batch' && k !== 'context') fail('FS-OPS-001', `an apply request has no member ${JSON.stringify(k)}`, [], toPointer([k]));
  const batch = request.batch;
  if (!Array.isArray(batch)) return fail('FS-OPS-001', 'the request has no batch: an array of operations', [], '/batch');
  if (batch.length === 0) fail('FS-OPS-001', 'a batch contains at least one operation', [], '/batch');
  batch.forEach((op, i) => {
    const base = `/batch/${i}`;
    if (!isObject(op)) return fail('FS-OPS-001', `operation ${i} is not an object`, [], base);
    const name = op.op;
    const shape = typeof name === 'string' && Object.hasOwn(shapes, name) ? shapes[name as OperationName] : undefined;
    if (!shape) return fail('FS-OPS-001', `${JSON.stringify(name)} is not an operation of Floorspec Ops ${ops}`, [], `${base}/op`);
    checkMembers(name as string, op, shape, base, ['batch', i], nonInteger, 'op');
    if (name === 'addElement' && !Object.hasOwn(op, 'extension') && !isCollection(op.collection) && op.collection !== ITEMS)
      fail('FS-OPS-001', `addElement's collection is one of ${[...COLLECTIONS, ITEMS].join(', ')}, unless it has an extension`, [], `${base}/collection`);
    if ((name === 'placeElement' || name === 'moveElement') && isObject(op.host)) checkHost(op.host, `${base}/host`, ['batch', i, 'host'], nonInteger);
    return undefined;
  });
  if (Object.hasOwn(request, 'context')) {
    const ctx = request.context;
    if (!isObject(ctx)) return fail('FS-OPS-001', 'the context is an object { "locks"?: [...], "retired"?: [...] }', [], '/context');
    for (const k of Object.keys(ctx))
      if (k !== 'locks' && k !== 'retired') fail('FS-OPS-001', `the context has no member ${JSON.stringify(k)}`, [], toPointer(['context', k]));
    if (Object.hasOwn(ctx, 'retired')) {
      const r = ctx.retired;
      if (!Array.isArray(r) || !r.every((x) => typeof x === 'string')) fail('FS-OPS-001', 'context.retired is an array of IDs', [], '/context/retired');
    }
    if (Object.hasOwn(ctx, 'locks')) {
      const locks = ctx.locks;
      if (!Array.isArray(locks)) return fail('FS-OPS-001', 'context.locks is an array of locks', [], '/context/locks');
      locks.forEach((l, i) => {
        const p = `/context/locks/${i}`;
        const keys = isObject(l) ? Object.keys(l) : [];
        const ok =
          isObject(l) &&
          keys.length === 1 &&
          ((keys[0] === 'element' && typeof l.element === 'string') ||
            (keys[0] === 'length' && typeof l.length === 'string') ||
            (keys[0] === 'distance' && Array.isArray(l.distance) && l.distance.length === 2 && l.distance.every((x) => typeof x === 'string')));
        if (!ok) fail('FS-OPS-001', 'a lock is { "element": ID }, { "length": wallID } or { "distance": [wallID, wallID] }', [], p);
      });
    }
  }
  return request as unknown as ApplyRequest;
}

function describe(t: MemberType): string {
  switch (t) {
    case 'string':
      return 'a string';
    case 'length':
      return 'a length (a JSON integer or a length string)';
    case 'pair':
      return 'a point or vector ([x, y] of lengths, or a string)';
    case 'boolean':
      return 'true or false';
    case 'object':
      return 'an object';
    case 'any':
      return 'a value';
    case 'collection':
      return 'one of the collections of Core §1.1';
    case 'side':
      return 'north, south, east or west';
    case 'surface':
      return 'wall, floor or ceiling';
    case 'toward':
      return 'start, end, north, south, east or west';
    case 'kind':
      return 'required, preferred or forbidden';
    case 'host':
      return 'a host reference';
  }
}
