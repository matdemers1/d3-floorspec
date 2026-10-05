/**
 * The document the solver lays out into. Since Ops 0.2, @floorspec/ops applies to Core 0.2
 * documents (and to the Core 0.1 documents stored before), so every candidate batch is applied to
 * the document as given and measured on the document it commits: there is no second view of it.
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
