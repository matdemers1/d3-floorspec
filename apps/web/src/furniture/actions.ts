import type { EditorStore } from '../editor/store';
import { kindOf, labelOf, type EditorModel, type LevelView } from '../editor/model';
import { faceAt } from '../editor/geometry';
import { anchorOf } from '../editor/systems/view';
import { libraryBytes, uploadAsset, type Uploaded } from './api';
import { type Box } from './gltf';
import { mountHeight, mountingOf, type FurnitureKind, type LibraryItem } from './library';
import { placeFurniture, type StoredFile } from './ops';
import { spotIn } from './placement';
import { furnitureOf } from './state';
import type { ClearanceEnvelope } from '@floorspec/engine';

/**
 * Placing furniture from the editor (FLR-T-8.3): the item's files go into the project's asset store
 * first — a library item's from where the editor serves them, an upload's from the person's disk —
 * then one batch places it (ops.ts), so Undo takes the whole placement back in one step.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The room "Place in" means: the room chosen in the library; else the selected room, or the room
 * the selected element is in; else the level's kitchen for an appliance or casework; else the
 * level's first room. Null when the level has no room.
 */
export function targetRoom(store: EditorStore, kind: FurnitureKind | null): string | null {
  const s = store.get();
  const level = store.levelView;
  const model = s.model;
  if (level === undefined || model === null || level.rooms.length === 0) return null;
  const chosen = furnitureOf(store).get().room;
  if (chosen !== null && level.rooms.some((r) => r.id === chosen)) return chosen;
  const sel = s.selection;
  if (sel !== null) {
    if (kindOf(model, sel) === 'room' && level.rooms.some((r) => r.id === sel)) return sel;
    const device = level.devices.find((d) => d.id === sel);
    const room = device === undefined ? null : (faceAt(level, anchorOf(device))?.room ?? null);
    if (room !== null) return room;
  }
  if (kind === 'appliances' || kind === 'casework') {
    const doc = model.document;
    const kitchen = level.rooms.find((r) => (doc.rooms?.[r.id] as { function?: string } | undefined)?.function === 'kitchen');
    if (kitchen !== undefined) return kitchen.id;
  }
  return level.rooms[0]?.id ?? null;
}

export interface Placing {
  kind: FurnitureKind;
  category: string;
  name?: string;
  catalogue?: string;
  seats?: number;
  box: Box;
  clearances: Record<string, ClearanceEnvelope>;
  model: StoredFile;
  symbol?: StoredFile;
}

/** Place an item whose files are in the store, in a room, at the first free spot (placement.ts). */
export async function placeIn(store: EditorStore, room: string, item: Placing): Promise<boolean> {
  const s = store.get();
  const model = s.model;
  const level: LevelView | undefined = model?.levels.find((l) => l.rooms.some((r) => r.id === room));
  if (model === null || level === undefined) return false;
  const mounting = mountingOf(item.category);
  const spot = spotIn(level, room, { box: item.box, mounting, category: item.category, clearances: item.clearances, height: mountHeight(item.category) });
  if (spot === null) return false;
  const name = item.name ?? item.category;
  const ok = await store.apply(`Place ${name.toLowerCase()} in ${labelOf(model, room)}`, placeFurniture(model, { ...item, host: spot.host }), {
    select: (created) => lastElement(store.get().model, created),
  });
  // Its clearances shown, so a door's swing is seen where it was put (the P8 demo's fridge).
  if (ok && Object.keys(item.clearances).length > 0 && !store.get().layers.clearances) store.set({ layers: { ...store.get().layers, clearances: true } });
  if (ok && !spot.free) store.set({ notice: { tone: 'info', text: `${name} is placed, but ${labelOf(model, room)} had no clear spot for it: drag it, or type where it goes.` } });
  return ok;
}

/** The element a placement created: the last created ID that is an extension element. */
function lastElement(model: EditorModel | null, created: string[]): string | null {
  for (let i = created.length - 1; i >= 0; i--) {
    const id = created[i] as string;
    if (model === null || model.ext.has(id)) return id;
  }
  return created.at(-1) ?? null;
}

/** Copy a library item's model and symbol into the project, then place it. */
export async function placeLibraryItem(store: EditorStore, item: LibraryItem, room: string): Promise<boolean> {
  const f = furnitureOf(store);
  f.set({ busy: `Placing ${item.name}` });
  try {
    const [modelBlob, symbolBlob] = await Promise.all([libraryBytes(item.model.url), libraryBytes(item.symbol.url)]);
    const [model, symbol]: [Uploaded, Uploaded] = await Promise.all([
      uploadAsset(store.projectId, modelBlob, item.model.path.split('/').at(-1) ?? 'model.glb', 'model'),
      uploadAsset(store.projectId, symbolBlob, item.symbol.path.split('/').at(-1) ?? 'symbol.svg', 'symbol'),
    ]);
    const ok = await placeIn(store, room, {
      kind: item.kind,
      category: item.category,
      name: item.name,
      catalogue: item.id,
      ...(item.seats === undefined ? {} : { seats: item.seats }),
      box: item.box,
      clearances: item.clearances,
      model,
      symbol,
    });
    if (ok) f.set({ open: false });
    return ok;
  } catch (e) {
    store.set({ notice: { tone: 'danger', text: `${item.name} could not be placed: ${messageOf(e)}` } });
    return false;
  } finally {
    f.set({ busy: null });
  }
}
