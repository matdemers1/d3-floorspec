import type { FloorspecDocument } from '@floorspec/engine';
import type { EditorStore } from '../editor/store';
import type { Batch, BatchBuilder } from '../editor/ops';
import { addOpening } from '../editor/ops';
import { labelOf, type EditorModel } from '../editor/model';
import { declarationOps, placeDevice, type HostRef } from '../editor/systems/ops';
import { libraryBytes, uploadAsset, type Uploaded } from '../furniture/api';
import { assetFor, placeFurniture, type StoredFile } from '../furniture/ops';
import type { LibraryItem } from '../furniture/library';
import type { Entry } from './catalog';
import type { Ghost } from './ghost';

/**
 * Placing a ghost (FLR-T-18.7): one batch, so one undo step, whatever was placed —
 *
 * - a furniture item: its model and symbol copied into the project's asset store first (skipped when
 *   the document already holds those bytes: one digest, one asset), then placeFurniture's batch —
 *   FS_furniture declared when it is not yet, the assets when new, and placeElement on the ghost's host;
 * - a device: placeDevice, as the device tool places it, with the draw panel's receptacle options;
 * - a door or a window: addOpening on the ghost's wall, at its offset (or "centered"), with the
 *   type — a starter embedded in the same batch — and the hinge and swing the ghost was turned to;
 * - an FS_landscape plant or bed: FS_landscape declared when it is not yet, then placeElement with a
 *   `free` host on the level (FS_landscape 3.1: a garden is not in a room);
 * - an FS_outdoor pool, shelter, kitchen or fire (FLR-T-15.2): FS_outdoor declared when it is not yet,
 *   then placeElement with a `free` host, as a plant is.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The batch that places a landscape element with a free host. */
export function placeLandscape(document: FloorspecDocument, collection: 'plants' | 'beds', element: Record<string, unknown>, host: HostRef): Batch {
  if (host.mode !== 'free') return [];
  return [
    ...declarationOps(document, 'FS_landscape'),
    {
      op: 'placeElement',
      extension: 'FS_landscape',
      collection,
      host: { mode: 'free', level: host.level, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) },
      element: structuredClone(element),
    },
  ];
}

/** The batch that places an FS_outdoor pool, shelter, kitchen or fire with a free host: one op (the board's "one op each"). */
export function placeOutdoor(document: FloorspecDocument, collection: string, element: Record<string, unknown>, host: HostRef): Batch {
  if (host.mode !== 'free') return [];
  return [
    ...declarationOps(document, 'FS_outdoor'),
    {
      op: 'placeElement',
      extension: 'FS_outdoor',
      collection,
      host: { mode: 'free', level: host.level, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) },
      element: structuredClone(element),
    },
  ];
}

/** A library item's files in the project's store: uploaded unless the document holds those bytes already. */
async function filesFor(store: EditorStore, item: LibraryItem): Promise<{ model: StoredFile; symbol: StoredFile }> {
  const doc = store.get().model?.document;
  const held = (f: LibraryItem['model']): StoredFile | null => (doc !== undefined && assetFor(doc, f.sha256) !== null ? { sha256: f.sha256, mediaType: f.mediaType, byteLength: f.byteLength, path: f.path, name: null } : null);
  const upload = async (f: LibraryItem['model'], as: 'model' | 'symbol'): Promise<Uploaded | StoredFile> => held(f) ?? (await uploadAsset(store.projectId, await libraryBytes(f.url), f.path.split('/').at(-1) ?? (as === 'model' ? 'model.glb' : 'symbol.svg'), as));
  const [model, symbol] = await Promise.all([upload(item.model, 'model'), upload(item.symbol, 'symbol')]);
  return { model, symbol };
}

/** The element a placement made: the last created ID that is an extension element. */
function lastElement(model: EditorModel | null, created: string[]): string | null {
  for (let i = created.length - 1; i >= 0; i--) {
    const id = created[i] as string;
    if (model === null || model.ext.has(id)) return id;
  }
  return created.at(-1) ?? null;
}

/** The batch a ghost of an entry makes, built against the model it is sent to. */
export function batchFor(model: EditorModel, entry: Entry, ghost: Ghost, options: { files?: { model: StoredFile; symbol: StoredFile }; receptacle?: Parameters<typeof placeDevice>[3] } = {}): Batch | BatchBuilder | null {
  const doc = model.document;
  const src = entry.source;
  switch (src.kind) {
    case 'opening': {
      const aim = ghost.opening;
      if (aim === null || !aim.fits) return null;
      return addOpening(doc, { wall: aim.wall, at: aim.centered ? 'centered' : aim.offset, fill: src.type, hinge: aim.nearer, swing: aim.side });
    }
    case 'device':
      return ghost.host === null ? null : placeDevice(doc, src.device, ghost.host, options.receptacle === undefined ? {} : options.receptacle);
    case 'landscape':
      return ghost.host === null ? null : placeLandscape(doc, src.collection, src.element, ghost.host);
    case 'outdoor':
      return ghost.host === null ? null : placeOutdoor(doc, src.collection, src.element, ghost.host);
    case 'furniture': {
      const files = options.files;
      if (ghost.host === null || files === undefined) return null;
      const item = src.item;
      return placeFurniture(model, {
        kind: item.kind,
        category: item.category,
        name: item.name,
        catalogue: item.id,
        ...(item.seats === undefined ? {} : { seats: item.seats }),
        box: item.box,
        clearances: item.clearances,
        model: files.model,
        symbol: files.symbol,
        host: ghost.host,
      });
    }
  }
}

/** What an edit is called in the history: "Place three-seat sofa in Den", "Add window". */
function labelFor(model: EditorModel, entry: Entry, ghost: Ghost): string {
  if (entry.source.kind === 'opening') return `Add ${entry.source.type.kind === 'doorType' ? 'door' : 'window'}`;
  const host = ghost.host;
  const where = host?.mode === 'surface' ? ` in ${labelOf(model, host.room)}` : '';
  return `Place ${entry.name.charAt(0).toLowerCase()}${entry.name.slice(1)}${where}`;
}

/**
 * Place a ghost: one batch, the new element selected. Resolves true when it was committed. A ghost
 * with a problem is not placed; the problem is said instead.
 */
export async function placeGhost(store: EditorStore, entry: Entry, ghost: Ghost): Promise<boolean> {
  if (ghost.problem !== undefined) {
    store.set({ notice: { tone: 'info', text: ghost.problem } });
    return false;
  }
  try {
    const files = entry.source.kind === 'furniture' ? await filesFor(store, entry.source.item) : undefined;
    const model = store.get().model;
    if (model === null) return false;
    const batch = batchFor(model, entry, ghost, { ...(files === undefined ? {} : { files }), receptacle: { receptacle: store.get().draw.receptacle } });
    if (batch === null) {
      store.set({ notice: { tone: 'info', text: entry.placement === 'opening' ? 'Point at a wall to put it in.' : 'Point at where it goes.' } });
      return false;
    }
    const opening = entry.source.kind === 'opening';
    return await store.apply(labelFor(model, entry, ghost), batch, {
      select: (created) => (opening ? (created.find((id) => /^O\d+$/.test(id)) ?? null) : lastElement(store.get().model, created)),
    });
  } catch (e) {
    store.set({ notice: { tone: 'danger', text: `${entry.name} could not be placed: ${messageOf(e)}` } });
    return false;
  }
}
