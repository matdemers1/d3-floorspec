/**
 * A whole document as Floorspec Ops (FLR-ADR-008): what a template or an imported file or package
 * becomes. A project that starts from a document is created blank — the empty document, op 1 — and
 * then given the document as one batch: `setProperty $document` for its declaration and top-level
 * members, `setProperty $project` for the project's, an `addElement` for every element, and
 * `setAdjacency` for the bubble diagram. Nothing writes the document directly, and the project's
 * history begins with the import as an op like any other.
 *
 * Moved here from the editor (apps/web/src/projects/fromDocument.ts, FLR-T-3.3) so the server's
 * package import (FLR-T-9.1) builds the same batch the browser does.
 */

export type BatchOp = { readonly op: string } & Readonly<Record<string, unknown>>;

type Json = Record<string, unknown>;

/** The members of `$document` other than the collections, the program and the version (Ops 2.3). */
const DOCUMENT_MEMBERS = ['site', 'extensionsUsed', 'extensionsRequired', 'extras'] as const;

/**
 * Where elements are added from: what is referred to before what refers — the reverse of the
 * inverse's removal order (Ops 0.2, 1.6), program items (`items`) after the levels they may prefer
 * and before the rooms that fulfil them; option sets before their options, and both before the
 * elements in them; roofs and stairs (Core 0.3) after the levels and materials they name.
 * Extension elements follow, on the walls and rooms that host them. Only the batch's end state is
 * judged (Ops 1.2), so the order is for a reader of the log, not for validity.
 */
const ADD_ORDER = ['assets', 'materials', 'types', 'buildings', 'levels', 'items', 'optionSets', 'options', 'junctions', 'walls', 'separators', 'slabs', 'roofs', 'stairs', 'rooms', 'openings'] as const;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const byId = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

export interface BatchOptions {
  /**
   * The Core version the blank project declares (a new project is "0.3"). A document declaring
   * another — an imported Core 0.2 or 0.1 file — keeps its own: the batch opens with
   * `setProperty $document /floorspec`, so an import never upgrades a document by itself.
   */
  readonly from?: string;
}

/** The batch that turns the empty document named `name` into `document` (named `name`). */
export function documentToBatch(document: Json, name: string, options: BatchOptions = {}): BatchOp[] {
  const batch: BatchOp[] = [];
  const declared = document['floorspec'];
  if (typeof declared === 'string' && declared !== (options.from ?? '0.3')) batch.push({ op: 'setProperty', id: '$document', path: '/floorspec', value: declared });
  // Declarations first, so extension data on elements names a used extension (FS-INV-005) — though
  // only the end state is judged, this is the order a reader expects in the log.
  for (const member of DOCUMENT_MEMBERS) {
    const value = document[member];
    if (value !== undefined) batch.push({ op: 'setProperty', id: '$document', path: `/${member}`, value });
  }
  const project = isObject(document['project']) ? document['project'] : undefined;
  for (const [key, value] of Object.entries(project ?? {}).sort(byId)) {
    if (key !== 'name') batch.push({ op: 'setProperty', id: '$project', path: `/${key}`, value });
  }
  if (project?.['name'] !== name) batch.push({ op: 'setProperty', id: '$project', path: '/name', value: name });
  // In a Core 0.1 document top-level extension data is opaque (Core 1.2.6): set as it is, whole.
  const opaque = declared === '0.1';
  if (opaque && document['extensions'] !== undefined) batch.push({ op: 'setProperty', id: '$document', path: '/extensions', value: document['extensions'] });
  // An extension's own data, without its elements: those are added as elements, below.
  const extensions = !opaque && isObject(document['extensions']) ? document['extensions'] : {};
  for (const [extension, data] of Object.entries(extensions).sort(byId)) {
    if (!isObject(data)) continue;
    for (const [member, value] of Object.entries(data).sort(byId)) {
      if (member !== 'collections') batch.push({ op: 'setProperty', id: '$document', path: `/extensions/${extension}/${member}`, value });
    }
  }
  const program = isObject(document['program']) ? document['program'] : {};
  for (const collection of ADD_ORDER) {
    const elements = collection === 'items' ? program['items'] : document[collection];
    for (const [id, element] of Object.entries(isObject(elements) ? elements : {}).sort(byId)) {
      if (element !== undefined) batch.push({ op: 'addElement', collection, id, element });
    }
  }
  // The bubble diagram's lines, in the order the document has them (setAdjacency appends).
  for (const edge of Array.isArray(program['adjacency']) ? (program['adjacency'] as unknown[]) : []) {
    if (!isObject(edge)) continue;
    batch.push({ op: 'setAdjacency', a: String(edge['a']), b: String(edge['b']), kind: edge['kind'], ...(edge['weight'] === undefined ? {} : { weight: edge['weight'] }) });
  }
  // A program member the batch has not set — `{}` with no items, say — is set as it is.
  for (const [member, value] of Object.entries(program).sort(byId)) {
    if (member !== 'items' && member !== 'adjacency') batch.push({ op: 'setProperty', id: '$document', path: `/program/${member}`, value });
  }
  for (const [extension, data] of Object.entries(extensions).sort(byId)) {
    const collections = isObject(data) && isObject(data['collections']) ? data['collections'] : {};
    for (const [collection, elements] of Object.entries(collections).sort(byId)) {
      for (const [id, element] of Object.entries(isObject(elements) ? elements : {}).sort(byId)) {
        if (isObject(element)) batch.push({ op: 'addElement', extension, collection, id, element });
      }
    }
  }
  return batch;
}
