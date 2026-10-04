import { canonicalize, contentHash, type Diagnostic } from '@floorspec/engine';
import type { Applier, ApplyRequest, ApplyResult, Op } from '../../src/ops/applier.js';

/**
 * A small stand-in for `@floorspec/ops`, enough to exercise the store, changesets and the MCP
 * plumbing: `addElement`, `removeElement` (no cascade), `setProperty`, `unsetProperty` and
 * `moveJunction`, with IDs minted and refused exactly as Ops 1.5 says and the inverse computed as
 * Ops 1.6 defines it. No references, no composites, no normalization, no validation — the real
 * applier does those, and replaces this when it is merged.
 */

const PREFIX: Record<string, string> = {
  buildings: 'B', levels: 'L', junctions: 'J', walls: 'W', separators: 'S', openings: 'O', rooms: 'R', slabs: 'SL', types: 'T', materials: 'M', assets: 'A',
};
/** The collection order of Ops 1.6, step 1. */
const ORDER = ['openings', 'rooms', 'slabs', 'separators', 'walls', 'junctions', 'levels', 'buildings', 'types', 'materials', 'assets'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Doc = Record<string, Json>;

class Fail extends Error {
  constructor(readonly code: string, message: string, readonly elements: string[] = [], readonly pointer = '') {
    super(message);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => canonicalize({ v: a } as never) === canonicalize({ v: b } as never);
const sorted = (ids: Iterable<string>) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const escape = (member: string) => member.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (token: string) => token.replace(/~1/g, '/').replace(/~0/g, '~');

function collectionOf(doc: Doc, id: string): string | null {
  for (const name of Object.keys(PREFIX)) {
    const c = doc[name];
    if (c !== undefined && c !== null && typeof c === 'object' && !Array.isArray(c) && Object.hasOwn(c, id)) return name;
  }
  return null;
}

function allIds(doc: Doc): string[] {
  return Object.keys(PREFIX).flatMap((name) => Object.keys((doc[name] as Record<string, Json> | undefined) ?? {}));
}

function mint(doc: Doc, collection: string, minted: string[], retired: readonly string[]): string {
  const prefix = PREFIX[collection] ?? 'X';
  const pattern = new RegExp(`^${prefix}([0-9]+)$`);
  let max = 0;
  for (const id of [...allIds(doc), ...minted, ...retired]) {
    const m = pattern.exec(id);
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1)}`;
}

function target(doc: Doc, id: string, index: number): Record<string, Json> {
  if (id === '$project') return doc['project'] as Record<string, Json>;
  if (id === '$site') return (doc['site'] ??= {}) as Record<string, Json>;
  if (id === '$document') return doc as Record<string, Json>;
  const collection = collectionOf(doc, id);
  if (collection === null) throw new Fail('FS-OPS-003', `${id} does not exist.`, [], `/batch/${String(index)}/id`);
  return (doc[collection] as Record<string, Record<string, Json>>)[id] as Record<string, Json>;
}

function applyOp(doc: Doc, op: Op, index: number, minted: string[], retired: readonly string[]): Op {
  const used = (id: string) => collectionOf(doc, id) !== null || retired.includes(id) || minted.includes(id);
  switch (op.op) {
    case 'addElement': {
      const collection = op['collection'];
      if (typeof collection !== 'string' || !(collection in PREFIX)) throw new Fail('FS-OPS-001', 'addElement needs a collection.', [], `/batch/${String(index)}/collection`);
      let id = op['id'];
      if (id === undefined) {
        id = mint(doc, collection, minted, retired);
        minted.push(id as string);
      } else if (typeof id !== 'string' || used(id)) {
        throw new Fail('FS-OPS-005', `${String(id)} is already in use or retired.`, [], `/batch/${String(index)}/id`);
      }
      const c = (doc[collection] ??= {}) as Record<string, Json>;
      c[id as string] = clone(op['element'] as Json);
      return { op: 'addElement', collection, id, element: op['element'] };
    }
    case 'removeElement': {
      const id = String(op['id']);
      const collection = collectionOf(doc, id);
      if (collection === null) throw new Fail('FS-OPS-003', `${id} does not exist.`, [], `/batch/${String(index)}/id`);
      const c = doc[collection] as Record<string, Json>;
      delete c[id];
      if (Object.keys(c).length === 0) delete doc[collection];
      return { op: 'removeElement', id };
    }
    case 'moveJunction':
      return applyOp(doc, { op: 'setProperty', id: op['id'], path: '/position', value: op['to'] }, index, minted, retired);
    case 'setProperty':
    case 'unsetProperty': {
      const id = String(op['id']);
      const path = String(op['path'] ?? '');
      if (!path.startsWith('/') || path.length < 2) throw new Fail('FS-OPS-003', 'path is empty.', [id], `/batch/${String(index)}/path`);
      const tokens = path.slice(1).split('/').map(unescape);
      let node = target(doc, id, index);
      for (const token of tokens.slice(0, -1)) {
        const next = node[token];
        if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
          if (op.op === 'unsetProperty') throw new Fail('FS-OPS-003', `${id} has no ${path}.`, [id], `/batch/${String(index)}/path`);
          node[token] = {};
        }
        node = node[token] as Record<string, Json>;
      }
      const last = tokens.at(-1) ?? '';
      if (op.op === 'setProperty') node[last] = clone(op['value'] as Json);
      else {
        if (!Object.hasOwn(node, last)) throw new Fail('FS-OPS-003', `${id} has no ${path}.`, [id], `/batch/${String(index)}/path`);
        delete node[last];
      }
      return op.op === 'setProperty' ? { op: 'setProperty', id, path, value: op['value'] } : { op: 'unsetProperty', id, path };
    }
    default:
      throw new Fail('FS-OPS-001', `${op.op} is not an operation this applier knows.`, [], `/batch/${String(index)}/op`);
  }
}

function memberDiff(id: string, a: Record<string, Json>, b: Record<string, Json>, skip: ReadonlySet<string> = new Set()): Op[] {
  const ops: Op[] = [];
  for (const member of sorted(new Set([...Object.keys(a), ...Object.keys(b)]))) {
    if (skip.has(member)) continue;
    if (Object.hasOwn(a, member) && (!Object.hasOwn(b, member) || !same(a[member], b[member]))) {
      ops.push({ op: 'setProperty', id, path: `/${escape(member)}`, value: a[member] });
    } else if (!Object.hasOwn(a, member) && Object.hasOwn(b, member)) {
      ops.push({ op: 'unsetProperty', id, path: `/${escape(member)}` });
    }
  }
  return ops;
}

/** Ops 1.6: the structural difference from B back to A. */
export function inverseOf(a: Doc, b: Doc): Op[] {
  const get = (doc: Doc, c: string) => (doc[c] ?? {}) as Record<string, Record<string, Json>>;
  const ops: Op[] = [];
  for (const c of ORDER) for (const id of sorted(Object.keys(get(b, c)))) if (!Object.hasOwn(get(a, c), id)) ops.push({ op: 'removeElement', id });
  for (const c of [...ORDER].reverse())
    for (const id of sorted(Object.keys(get(a, c)))) if (!Object.hasOwn(get(b, c), id)) ops.push({ op: 'addElement', collection: c, id, element: get(a, c)[id] });
  for (const c of ORDER)
    for (const id of sorted(Object.keys(get(a, c)))) {
      const before = get(a, c)[id];
      const after = get(b, c)[id];
      if (before !== undefined && after !== undefined && !same(before, after)) ops.push(...memberDiff(id, before, after));
    }
  ops.push(...memberDiff('$project', (a['project'] ?? {}) as Record<string, Json>, (b['project'] ?? {}) as Record<string, Json>));
  if (a['site'] !== undefined || b['site'] !== undefined) ops.push(...memberDiff('$site', (a['site'] ?? {}) as Record<string, Json>, (b['site'] ?? {}) as Record<string, Json>));
  const top = new Set([...Object.keys(PREFIX), 'project', 'site']);
  ops.push(...memberDiff('$document', a as Record<string, Json>, b as Record<string, Json>, top));
  return ops;
}

export class FakeApplier implements Applier {
  /** Every request it was handed, for tests that check what the store sent. */
  readonly requests: ApplyRequest[] = [];

  apply(document: unknown, request: ApplyRequest): ApplyResult {
    this.requests.push(request);
    const a = document as Doc;
    const working = clone(a);
    const minted: string[] = [];
    const resolved: Op[] = [];
    const retired = request.context?.retired ?? [];
    try {
      if (!Array.isArray(request.batch) || request.batch.length === 0) throw new Fail('FS-OPS-001', 'A batch needs at least one operation.');
      for (const [index, op] of request.batch.entries()) resolved.push(applyOp(working, op, index, minted, retired));
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      const diagnostic: Diagnostic = {
        code: error.code,
        severity: 'error',
        message: error.message,
        elements: error.elements,
        location: error.pointer === '' ? {} : { pointer: error.pointer },
      };
      return { status: 'rejected', diagnostics: [diagnostic] };
    }
    const before = new Set(allIds(a));
    const after = new Set(allIds(working));
    return {
      status: 'committed',
      document: canonicalize(working as never),
      hash: contentHash(working as never),
      resolved,
      created: sorted([...after].filter((id) => !before.has(id))),
      removed: sorted([...before].filter((id) => !after.has(id))),
      inverse: inverseOf(a, working),
    };
  }
}

/** A batch that builds the conformance suite's one-room plan (4 m × 3 m), the room named Kitchen. */
export const ONE_ROOM_HOUSE: Op[] = [
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', elevation: 0, height: 3456000 } },
  { op: 'addElement', collection: 'types', id: 'WT', element: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
  { op: 'addElement', collection: 'junctions', id: 'J1', element: { level: 'L1', position: [0, 0] } },
  { op: 'addElement', collection: 'junctions', id: 'J2', element: { level: 'L1', position: [0, 3840000] } },
  { op: 'addElement', collection: 'junctions', id: 'J3', element: { level: 'L1', position: [5120000, 3840000] } },
  { op: 'addElement', collection: 'junctions', id: 'J4', element: { level: 'L1', position: [5120000, 0] } },
  { op: 'addElement', collection: 'walls', id: 'W1', element: { level: 'L1', start: 'J1', end: 'J2', type: 'WT' } },
  { op: 'addElement', collection: 'walls', id: 'W2', element: { level: 'L1', start: 'J2', end: 'J3', type: 'WT' } },
  { op: 'addElement', collection: 'walls', id: 'W3', element: { level: 'L1', start: 'J3', end: 'J4', type: 'WT' } },
  { op: 'addElement', collection: 'walls', id: 'W4', element: { level: 'L1', start: 'J4', end: 'J1', type: 'WT' } },
  { op: 'addElement', collection: 'rooms', id: 'R1', element: { level: 'L1', anchor: [2560000, 1920000], name: 'Kitchen' } },
];
