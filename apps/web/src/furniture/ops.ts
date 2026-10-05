import type { FloorspecDocument } from '@floorspec/engine';
import { upgradeAtLeast } from '../editor/openings';
import type { Operation } from '@floorspec/ops';
import type { EditorModel } from '../editor/model';
import type { Batch, BatchBuilder } from '../editor/ops';
import { nextIds } from '../editor/optionOps';
import { extensionVersion } from '../editor/systems/catalog';
import type { HostRef } from '../editor/systems/ops';
import type { Box } from './gltf';
import type { FurnitureKind } from './library';

/**
 * Placing furniture (FLR-T-8.3, FS_furniture 7): one Ops batch, so one undo step —
 *
 *   1. the document at Core 0.3, which an element's assets need (`byteLength`, Core 18.4) — a 0.1 or
 *      0.2 plan is made to declare "0.3" in the same batch, which changes nothing else (Core 1.2.6);
 *   2. FS_furniture in `extensionsUsed`, when it is not yet (Ops 2.1 never declares one for you);
 *   3. an asset for the model and one for the symbol, unless the document has those files already
 *      (one digest, one asset: four chairs of one design refer to the same two, FS_furniture 3.4);
 *   4. `placeElement` with the item: its category, catalogue and name, its box and default
 *      envelopes, its fallback's asset and symbol, and its host (Ops 0.2 4.10).
 *
 * Like editor/ops.ts this only builds JSON; the server applies and judges every batch.
 */

export const EXTENSION = 'FS_furniture';

/** An uploaded file as the asset route answers it (apps/server/src/routes/assets.ts). */
export interface StoredFile {
  sha256: string;
  mediaType: string;
  byteLength: number;
  path: string;
  name: string | null;
}

export interface NewItem {
  kind: FurnitureKind;
  category: string;
  name?: string;
  /** A library item's ID, or a maker's model number (FS_furniture 2.1): a label no reader reads. */
  catalogue?: string;
  seats?: number;
  box: Box;
  clearances: Record<string, unknown>;
  model: StoredFile;
  symbol?: StoredFile;
  host: HostRef;
}

/** Core 0.3 and FS_furniture declared, as the batch that adds the first item needs them. */
export function declarationOps(document: FloorspecDocument): Batch {
  const ops: Batch = [];
  ops.push(...upgradeAtLeast(document, '0.3')); // Core chapter 20: nothing when it is 0.3 or later already
  const used = (document as { extensionsUsed?: Record<string, unknown> }).extensionsUsed;
  if (used === undefined || !Object.hasOwn(used, EXTENSION)) ops.push({ op: 'setProperty', id: '$document', path: `/extensionsUsed/${EXTENSION}`, value: extensionVersion(EXTENSION) });
  return ops;
}

type Json = Record<string, unknown>;

/** The ID of the document's asset for these bytes, when it has one: one digest, one asset. */
export function assetFor(document: FloorspecDocument, sha256: string): string | null {
  for (const [id, a] of Object.entries((document.assets ?? {}) as Record<string, Json | undefined>)) if (a?.['sha256'] === sha256 && typeof a['path'] === 'string') return id;
  return null;
}

const assetEntry = (f: StoredFile): Json => ({
  path: f.path,
  sha256: f.sha256,
  mediaType: f.mediaType,
  byteLength: f.byteLength,
  ...(f.name === null || f.name === '' ? {} : { name: f.name.slice(0, 200) }),
});

function hostOp(host: HostRef): Json {
  switch (host.mode) {
    case 'wallFace':
      return { mode: 'wallFace', wall: host.wall, ...(host.toward !== undefined ? { toward: host.toward } : { side: host.side ?? 'right' }), at: host.at, height: host.height };
    case 'surface':
      return { mode: 'surface', room: host.room, surface: host.surface, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) };
    case 'free':
      return { mode: 'free', level: host.level, at: host.at, ...(host.rotation === undefined || host.rotation === 0 ? {} : { rotation: host.rotation }) };
  }
}

/** The element `placeElement` adds: FS_furniture's members, then Core's (Core 12.5). */
export function newElement(item: Omit<NewItem, 'model' | 'symbol' | 'host'>, asset: string, symbol: string | undefined): Json {
  return {
    category: item.category,
    ...(item.catalogue === undefined || item.catalogue === '' ? {} : { catalogue: item.catalogue.slice(0, 200) }),
    ...(item.seats === undefined ? {} : { seats: item.seats }),
    ...(item.name === undefined || item.name === '' ? {} : { name: item.name.slice(0, 200) }),
    ...(Object.keys(item.clearances).length > 0 ? { clearances: structuredClone(item.clearances) } : {}),
    fallback: { box: structuredClone(item.box), asset, ...(symbol === undefined ? {} : { symbol }) },
  };
}

/** One batch that places an item: declarations, its assets when new, and placeElement. */
export function placeFurniture(model: EditorModel, item: NewItem): BatchBuilder {
  return (attempt) => {
    const doc = model.document;
    const ops: Batch = [...declarationOps(doc)];
    const fresh: StoredFile[] = [];
    let modelId = assetFor(doc, item.model.sha256);
    let symbolId = item.symbol === undefined ? undefined : (assetFor(doc, item.symbol.sha256) ?? undefined);
    if (modelId === null) fresh.push(item.model);
    if (item.symbol !== undefined && symbolId === undefined && item.symbol.sha256 !== item.model.sha256) fresh.push(item.symbol);
    const ids = nextIds(model, 'FA', fresh.length, attempt);
    fresh.forEach((f, i) => {
      const id = ids[i] as string;
      ops.push({ op: 'addElement', collection: 'assets', id, element: assetEntry(f) });
      if (f === item.model) modelId = id;
      else symbolId = id;
    });
    ops.push({ op: 'placeElement', extension: EXTENSION, collection: item.kind, host: hostOp(item.host), element: newElement(item, modelId as string, symbolId) } as Operation);
    return ops;
  };
}

/** Re-host an item (Ops 0.2 4.10): another spot, another wall, a new height. */
export function moveFurniture(id: string, host: HostRef): Batch {
  return [{ op: 'moveElement', element: id, host: hostOp(host) } as Operation];
}

/** Normalise an angle to (−180°, 180°], in microdegrees. */
export function normalAngle(rotation: number): number {
  const v = ((((Math.round(rotation) % 360_000_000) + 540_000_000) % 360_000_000) - 180_000_000);
  return v === -180_000_000 ? 180_000_000 : v;
}

/**
 * Turn an item by `delta` microdegrees: a `surface` or `free` host's rotation (Core 13.3). An item
 * on a wall face faces out of the wall and does not turn; null then.
 */
export function turnFurniture(id: string, host: Json | null, delta: number): Batch | null {
  if (host === null || (host['mode'] !== 'surface' && host['mode'] !== 'free')) return null;
  const now = typeof host['rotation'] === 'number' ? host['rotation'] : 0;
  const value = normalAngle(now + delta);
  return value === 0 ? (now === 0 ? [] : [{ op: 'unsetProperty', id, path: '/host/rotation' }]) : [{ op: 'setProperty', id, path: '/host/rotation', value }];
}

/** Set or unset one of the element's own members (Ops 2.3: a path relative to the element). */
export function setMember(id: string, member: string, value: unknown, present: boolean): Batch {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return present ? [{ op: 'unsetProperty', id, path: `/${member}` }] : [];
  return [{ op: 'setProperty', id, path: `/${member}`, value }];
}
