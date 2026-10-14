import type { Batch } from '../ops';
import type { EditorModel, Point } from '../model';
import type { DraftAnchor } from './state';

/**
 * The person's own strings and notes as Ops (FLR-T-18.11): FS_annotation 0.1.0's records on
 * `$document` (FLR-ADR-047) — setProperty to add, change or move one, unsetProperty to remove it. Ops
 * mints no annotation IDs; the editor takes the next free `DM<n>` or `NT<n>`.
 */

/** The version of FS_annotation the editor writes. */
export const FS_ANNOTATION_VERSION = '0.1.0';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The anchor as FS_annotation writes it. */
export type Anchor = { junction: string } | { wall: string; face: 'left' | 'right' | 'axis' } | { opening: string } | { point: [number, number] };

export interface DimensionRecord {
  level: string;
  direction: [number, number];
  through: [number, number];
  anchors: Anchor[];
  name?: string;
}

export interface NoteRecord {
  level: string;
  text: string;
  at: [number, number];
  leader?: [number, number];
  about?: string;
}

const P = (id: string, member: 'dimensions' | 'notes'): string => `/extensions/FS_annotation/${member}/${id}`;
const round = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];

/** The op that declares FS_annotation when the document does not yet. */
function declaration(model: EditorModel): Batch {
  const used = isObject(model.document.extensionsUsed) ? (model.document.extensionsUsed as Json) : {};
  return Object.hasOwn(used, 'FS_annotation') ? [] : ([{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_annotation', value: FS_ANNOTATION_VERSION }] as Batch);
}

/** Every ID the document uses — elements, items, extension elements, records, scenes, views, annotation. */
function usedIds(model: EditorModel): Set<string> {
  const ids = new Set<string>([...model.index.keys(), ...model.ext.keys(), ...model.records.keys()]);
  const ext = isObject(model.document.extensions) ? (model.document.extensions as Json) : {};
  for (const [name, member] of [['FS_lighting', 'scenes'], ['FS_views', 'views'], ['FS_annotation', 'dimensions'], ['FS_annotation', 'notes']] as const) {
    const data = ext[name];
    const rec = isObject(data) ? data[member] : undefined;
    if (isObject(rec)) for (const id of Object.keys(rec)) ids.add(id);
  }
  return ids;
}

/** The next free ID with a prefix (`DM`, `NT`), `skip` past it on a retry. */
export function nextAnnotationId(model: EditorModel, prefix: 'DM' | 'NT', skip = 0): string {
  const used = usedIds(model);
  let n = 0;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  let k = n + 1 + skip;
  while (used.has(`${prefix}${String(k)}`)) k++;
  return `${prefix}${String(k)}`;
}

/** A draft anchor as the document holds it. */
export function anchorOf(a: DraftAnchor): Anchor {
  switch (a.kind) {
    case 'junction':
      return { junction: a.id };
    case 'wall':
      return { wall: a.id, face: a.face };
    case 'opening':
      return { opening: a.id };
    case 'point':
      return { point: round(a.point) };
  }
}

/** A direction as small integers: an axis, or the anchors' own line reduced. */
export function directionOf(d: Point): [number, number] {
  const x = Math.round(d[0]);
  const y = Math.round(d[1]);
  if (x === 0 && y === 0) return [1, 0];
  if (y === 0) return [1, 0];
  if (x === 0) return [0, 1];
  const g = gcd(Math.abs(x), Math.abs(y));
  return [x / g, y / g];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Add a string: `id` and its batch, which declares FS_annotation first when it must. */
export function addDimension(model: EditorModel, record: DimensionRecord, attempt = 0): { id: string; batch: Batch } {
  const id = nextAnnotationId(model, 'DM', attempt);
  return { id, batch: [...declaration(model), { op: 'setProperty', id: '$document', path: P(id, 'dimensions'), value: record }] as Batch };
}

export function addNote(model: EditorModel, record: NoteRecord, attempt = 0): { id: string; batch: Batch } {
  const id = nextAnnotationId(model, 'NT', attempt);
  return { id, batch: [...declaration(model), { op: 'setProperty', id: '$document', path: P(id, 'notes'), value: record }] as Batch };
}

/** Which collection an annotation ID is in. */
export function memberOf(model: EditorModel, id: string): 'dimensions' | 'notes' | null {
  const data = (isObject(model.document.extensions) ? (model.document.extensions as Json)['FS_annotation'] : undefined) as Json | undefined;
  if (isObject(data?.['dimensions']) && Object.hasOwn(data['dimensions'], id)) return 'dimensions';
  if (isObject(data?.['notes']) && Object.hasOwn(data['notes'], id)) return 'notes';
  return null;
}

/** The record as the document holds it. */
export function recordOf(model: EditorModel, id: string): Json | undefined {
  const member = memberOf(model, id);
  if (member === null) return undefined;
  const rec = ((model.document.extensions as Json)['FS_annotation'] as Json)[member] as Json;
  return rec[id] as Json | undefined;
}

export function removeAnnotation(model: EditorModel, id: string): Batch {
  const member = memberOf(model, id);
  return member === null ? [] : ([{ op: 'unsetProperty', id: '$document', path: P(id, member) }] as Batch);
}

export function setNoteText(id: string, text: string): Batch {
  return [{ op: 'setProperty', id: '$document', path: `${P(id, 'notes')}/text`, value: text }] as Batch;
}

/** Move a string's line: where it is drawn, its anchors as they were. */
export function moveDimension(id: string, through: Point): Batch {
  return [{ op: 'setProperty', id: '$document', path: `${P(id, 'dimensions')}/through`, value: round(through) }] as Batch;
}

/** What removing these elements takes with it that a string can measure to: a wall's openings too. */
export function removedWith(model: EditorModel, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  for (const [oid, o] of Object.entries((model.document.openings ?? {}) as Record<string, Json | undefined>)) if (typeof o?.['wall'] === 'string' && ids.has(o['wall'])) out.add(oid);
  return out;
}

/**
 * The strings that measure to something a batch removes: removed with it, so nothing is left that
 * cannot be drawn (FS-ANNO-LINT-001 still names any another writer leaves behind).
 */
export function orphaned(model: EditorModel, removed: ReadonlySet<string>): Batch {
  const data = (isObject(model.document.extensions) ? (model.document.extensions as Json)['FS_annotation'] : undefined) as Json | undefined;
  const dims = isObject(data?.['dimensions']) ? (data['dimensions'] as Record<string, Json>) : {};
  const out: Batch = [];
  for (const [id, d] of Object.entries(dims)) {
    const anchors = Array.isArray(d['anchors']) ? (d['anchors'] as Json[]) : [];
    const gone = anchors.some((a) => [a['junction'], a['wall'], a['opening']].some((ref) => typeof ref === 'string' && removed.has(ref)));
    if (gone) out.push({ op: 'unsetProperty', id: '$document', path: P(id, 'dimensions') });
  }
  return out;
}
