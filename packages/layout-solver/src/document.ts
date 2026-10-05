/**
 * The document the solver lays out into, and the Core 0.1 view of it the Ops applier needs.
 *
 * @floorspec/ops implements Ops 0.1, which applies to Core 0.1 documents only (packages/ops
 * apply.ts reads with `core: '0.1'`). A program lives in Core 0.2. So the solver keeps two views:
 * the document as given (0.1 or 0.2), and a **0.1 base** — the same document with the members 0.2
 * adds taken out (the program, rooms' `brief`, types' `clearances`) — which every candidate batch
 * is applied to. When Ops 0.2 is ported, `applyBase` is the document itself and `toBase` goes.
 */
import { evaluate, parseJson } from '@floorspec/engine';

export type Json = Record<string, unknown>;

export class SolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolverError';
  }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The collections of a Core document, in the order they are listed (Core §1.1). */
export const COLLECTIONS = ['buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'types', 'materials', 'assets'] as const;

export function parseDocument(input: string | Uint8Array | object): Json {
  const value: unknown = typeof input === 'string' || input instanceof Uint8Array ? parseJson(input).value : structuredClone(input);
  if (!isObject(value)) throw new SolverError('the document is not a JSON object');
  const ev = evaluate(value);
  if (!ev.valid) {
    const codes = [...new Set(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))];
    throw new SolverError(`the document is not a valid Floorspec Core document (${codes.join(', ')})`);
  }
  return value;
}

export const collection = (doc: Json, name: string): Record<string, Json> => (isObject(doc[name]) ? (doc[name] as Record<string, Json>) : {});

/** The Core 0.1 base: the document without the members Core 0.2 adds. Throws when that is not a valid 0.1 document. */
export function toBase(doc: Json): Json {
  const base = structuredClone(doc);
  base['floorspec'] = '0.1';
  delete base['program'];
  for (const room of Object.values(collection(base, 'rooms'))) delete room['brief'];
  for (const type of Object.values(collection(base, 'types'))) delete type['clearances'];
  const ev = evaluate(base, { core: '0.1' });
  if (!ev.valid) {
    const codes = [...new Set(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))];
    throw new SolverError(
      `the document uses Core 0.2 members the Ops 0.1 applier cannot carry (${codes.join(', ')}); the solver can lay it out once Ops 0.2 is ported`,
    );
  }
  return base;
}

/** Every ID in the document's single space of IDs (Core §3.1.2): elements and program items. */
export function idsOf(doc: Json): Set<string> {
  const out = new Set<string>();
  for (const c of COLLECTIONS) for (const id of Object.keys(collection(doc, c))) out.add(id);
  const program = doc['program'];
  if (isObject(program) && isObject(program['items'])) for (const id of Object.keys(program['items'])) out.add(id);
  return out;
}

/** Whether a level has nothing drawn on it yet. */
export function levelIsEmpty(doc: Json, level: string): boolean {
  for (const c of ['junctions', 'walls', 'separators', 'rooms', 'slabs'])
    for (const e of Object.values(collection(doc, c))) if (e['level'] === level) return false;
  return true;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Levels in order of elevation, then ID. */
export function levelsByElevation(doc: Json): string[] {
  const levels = collection(doc, 'levels');
  return Object.keys(levels).sort((a, b) => Number(levels[a]!['elevation']) - Number(levels[b]!['elevation']) || cmp(a, b));
}
