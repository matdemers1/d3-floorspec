/**
 * The shape of an apply request (1.1): a batch of at least one operation this specification
 * defines, each with exactly the members its definition lists, and an optional context of locks and
 * retired IDs. Anything else is FS-OPS-001 (1.1.1) — including an operation with none, or more than
 * one, of a group of members of which it takes exactly one (moveOpening's `at` and `by`, addLevel's
 * `elevation`, `above` and `below`), or with `toward` but no `by` on moveOpening.
 *
 * Members that become element content (inside addElement's element, the shorthands' and
 * drawWall's wall members) are not checked here: addElement does not check content (2.1.1),
 * validation does. The shapes match schema/ops/0.1, and a test holds them to it.
 */
import { fail } from './diagnostics.js';
import { isCollection } from './model/working.js';
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
  | 'toward'; // moveOpening's: start, end or a side

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

export const OP_SHAPES: Readonly<Record<OperationName, OpShape>> = {
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
  moveOpening: { required: { opening: 'string' }, optional: { at: 'length', by: 'length', toward: 'toward' }, oneOf: [['at', 'by']], needs: { toward: 'by' } },
  addRoom: {
    required: { level: 'string', at: 'pair' },
    optional: { id: 'string', function: 'any', wallFinish: 'any', floorFinish: 'any', ceilingFinish: 'any', ...COMMON },
  },
  setRoomFinish: { required: { room: 'string', surface: 'surface', material: 'string' }, optional: {} },
  removeWall: { required: { wall: 'string' }, optional: { keep: 'string' } },
  addLevel: {
    required: { building: 'string', height: 'length' },
    optional: { elevation: 'length', above: 'string', below: 'string', id: 'string', ...COMMON },
    oneOf: [['elevation', 'above', 'below']],
  },
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
  }
}

/**
 * Check a request's shape (1.1.1), throwing FS-OPS-001 at the first problem. `nonInteger` holds the
 * pointers of numbers written with a fraction or an exponent, which are not JSON integers.
 */
export function checkRequest(request: unknown, nonInteger: ReadonlySet<string> = new Set()): ApplyRequest {
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
    if (typeof name !== 'string' || !Object.hasOwn(OP_SHAPES, name)) return fail('FS-OPS-001', `${JSON.stringify(name)} is not an operation of Floorspec Ops 0.1`, [], `${base}/op`);
    const shape = OP_SHAPES[name as OperationName];
    for (const [m, t] of Object.entries(shape.required)) {
      if (!Object.hasOwn(op, m)) fail('FS-OPS-001', `${name} needs ${JSON.stringify(m)}`, [], base);
      if (!typeOk(t, op[m], nonInteger, `${base}/${m}`)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is not ${describe(t)}`, [], `${base}/${m}`);
    }
    for (const m of Object.keys(op)) {
      if (m === 'op' || Object.hasOwn(shape.required, m)) continue;
      if (!Object.hasOwn(shape.optional, m)) fail('FS-OPS-001', `${name} has no member ${JSON.stringify(m)}`, [], toPointer(['batch', i, m]));
      const t = shape.optional[m]!;
      if (!typeOk(t, op[m], nonInteger, `${base}/${m}`)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is not ${describe(t)}`, [], `${base}/${m}`);
    }
    for (const group of shape.oneOf ?? [])
      if (group.filter((m) => Object.hasOwn(op, m)).length !== 1) fail('FS-OPS-001', `${name} takes exactly one of ${group.map((m) => JSON.stringify(m)).join(', ')}`, [], base);
    for (const [m, other] of Object.entries(shape.needs ?? {}))
      if (Object.hasOwn(op, m) && !Object.hasOwn(op, other)) fail('FS-OPS-001', `${name}'s ${JSON.stringify(m)} is allowed only with ${JSON.stringify(other)}`, [], `${base}/${m}`);
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
  }
}
