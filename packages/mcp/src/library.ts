import index from './library/us-starter-0.1.0.json' with { type: 'json' };
import type { Op } from './client.js';

/**
 * The Floorspec US starter type library 0.1.0 (CC0-1.0), as the editor's library panel offers it
 * (apps/web/src/editor/library; a test keeps the two copies byte for byte the same). Through MCP an
 * agent names a library type — `"fill": "door-interior-swing-30x80"`, `"type": "wall-2x4-interior"`
 * — and the tools embed it, with the materials its layers use, the first time a batch does: a new
 * house starts with no types, and copying them in by hand cost the first live session a 15 KB batch.
 *
 * Embedding is plain `addElement` operations put ahead of the agent's own, so the batch is still
 * nothing but Floorspec Ops (FLR-ADR-008) and the echo shows exactly what was added.
 */

interface Item {
  readonly kind: 'wallType' | 'doorType' | 'windowType' | 'material';
  readonly name: string;
  readonly embed: readonly Op[];
}

const ITEMS = (index as unknown as { items: Record<string, Item> }).items;

export const US_STARTER = { library: index.library, version: index.version, license: index.license };

/** The library's types by kind, for telling an agent what it can name. */
export function libraryTypes(): Record<'wallType' | 'doorType' | 'windowType', string[]> {
  const out = { wallType: [] as string[], doorType: [] as string[], windowType: [] as string[] };
  for (const [id, item] of Object.entries(ITEMS)) if (item.kind !== 'material') out[item.kind].push(id);
  for (const ids of Object.values(out)) ids.sort();
  return out;
}

/** One line naming every library type, for a tool result. */
export function libraryText(): string {
  const t = libraryTypes();
  return (
    `Types from the US starter library are embedded the first time a batch names one — walls: ${t.wallType.join(', ')}; ` +
    `doors: ${t.doorType.join(', ')}; windows: ${t.windowType.join(', ')}.`
  );
}

/** The members that name a type or a material, wherever an op carries them. */
const REFERENCE_MEMBERS = new Set(['fill', 'type', 'material', 'wallFinish', 'floorFinish', 'ceilingFinish']);

/** Every string a batch gives a type- or material-naming member, at any depth (an element's layers included). */
function references(batch: readonly Op[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === 'string') {
      if (key !== null && REFERENCE_MEMBERS.has(key)) found.add(value);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  for (const op of batch) {
    walk(op, null);
    // setProperty /fill, /type or /material: the value is the reference.
    if (op.op === 'setProperty' && typeof op['path'] === 'string' && typeof op['value'] === 'string' && /\/(fill|type|material)$/.test(op['path'])) found.add(op['value']);
  }
  return found;
}

/** The IDs a batch adds itself, so an agent that embeds a type by hand gets no second copy. */
function added(batch: readonly Op[]): Set<string> {
  return new Set(batch.flatMap((op) => (op.op === 'addElement' && typeof op['id'] === 'string' ? [op['id']] : [])));
}

/** True when the document holds this ID in any collection. */
function holds(document: unknown, id: string): boolean {
  if (document === null || typeof document !== 'object') return false;
  return Object.values(document as Record<string, unknown>).some((c) => c !== null && typeof c === 'object' && !Array.isArray(c) && Object.hasOwn(c, id));
}

/** The library types a batch names that neither the document nor the batch has: what to embed. */
export function missingLibraryTypes(document: unknown, batch: readonly Op[]): string[] {
  const own = added(batch);
  return [...references(batch)].filter((id) => Object.hasOwn(ITEMS, id) && !own.has(id) && !holds(document, id)).sort();
}

/** True when a batch names any library type at all: only then is the document worth reading. */
export function namesLibraryTypes(batch: readonly Op[]): boolean {
  return [...references(batch)].some((id) => Object.hasOwn(ITEMS, id));
}

/**
 * The operations that embed these items, each material once, less any ID the document or the batch
 * already holds — in library order, so a wall type's materials come before it.
 */
export function embedOps(document: unknown, batch: readonly Op[], ids: readonly string[]): Op[] {
  const skip = added(batch);
  const out: Op[] = [];
  for (const id of ids) {
    for (const op of ITEMS[id]?.embed ?? []) {
      const target = op['id'];
      if (typeof target === 'string' && (skip.has(target) || holds(document, target))) continue;
      if (typeof target === 'string') skip.add(target);
      out.push(op);
    }
  }
  return out;
}
