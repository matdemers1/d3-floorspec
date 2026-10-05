import text from './library/us-starter-0.1.0.json?raw';
import type { Batch } from './ops';

/**
 * The Floorspec US starter type library 0.1.0 (`library/us-starter/0.1.0/` of the standard at
 * 3b8d35a, CC0-1.0; FLR-T-10.4): common US wall, door and window types and the materials their layers
 * use, each with the `embed` batch that copies it — and its materials — into a document, with its
 * `source` (Core 8.1.3). Vendored trimmed to what the editor reads (kind, name, summary, element,
 * embed) from index.json, sha256 3b626390bcc8c14a5495b8c73b91c03d273c0b0ea7b68d744244f5add5789293.
 * A document refers to nothing here by URL: an item is embedded, then it is the document's own.
 */

export interface LibraryItem {
  id: string;
  kind: 'wallType' | 'doorType' | 'windowType' | 'material';
  name: string;
  summary: Record<string, string>;
  element: Record<string, unknown>;
  embed: Batch;
}

interface Index {
  library: string;
  version: string;
  license: string;
  items: Record<string, Omit<LibraryItem, 'id'>>;
}

const index = JSON.parse(text) as Index;

export const US_STARTER = { library: index.library, version: index.version, license: index.license };

export const LIBRARY_ITEMS: readonly LibraryItem[] = Object.entries(index.items)
  .map(([id, item]) => ({ id, ...item }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The library's items of a kind the document does not hold yet (by ID, or by the item its `source` names). */
export function libraryChoices(document: { types?: unknown; materials?: unknown }, kind: LibraryItem['kind']): LibraryItem[] {
  const held = new Set<string>();
  for (const c of [document.types, document.materials])
    for (const [id, e] of Object.entries((c ?? {}) as Record<string, { source?: { item?: string } } | undefined>)) {
      held.add(id);
      if (typeof e?.source?.item === 'string') held.add(e.source.item);
    }
  return LIBRARY_ITEMS.filter((i) => i.kind === kind && !held.has(i.id));
}

/**
 * The batch that embeds an item: its `embed` operations, less any that add an ID the document already
 * holds — a material two library types share is copied once.
 */
export function embedOps(document: Record<string, unknown>, item: LibraryItem): Batch {
  const has = (id: string): boolean => Object.values(document).some((c) => c !== null && typeof c === 'object' && Object.hasOwn(c, id));
  return item.embed.filter((op) => !(op.op === 'addElement' && typeof (op as { id?: unknown }).id === 'string' && has((op as { id: string }).id)));
}
