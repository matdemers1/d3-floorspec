import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import index from './library/fs-outdoor-0.1.0.json' with { type: 'json' };
import type { Op } from './client.js';

/**
 * FS_outdoor through MCP (FLR-T-15.2): outdoor rooms are placed as furniture is — one placeElement
 * whose element names a starter item, `{"catalogue":"plunge-pool-8x14"}` — and a fence or a garden
 * wall is drawn as a line, naming a style item for its members and height; the tools fill in what
 * the agent left out:
 *
 *   - a pool, shelter, kitchen or fire named by a starter item (FS_outdoor chapter 7) gets the item's
 *     members, name and box, at grade (members the agent gave are kept);
 *   - a fence with `points` and no box gets the box that bounds its line grown by half its width
 *     (FS_outdoor 3.3), from the ground to its style's height (or 6' with no style item);
 *   - FS_outdoor is declared when neither the plan nor the batch declares it.
 *
 * Gates are a fence's openings, `gates: [{offset, width}]` along its line. A shelter's posts are never
 * written: resizeElement changes its box and its posts re-space (6.4). Nothing here checks a pool
 * barrier or a fence's height — a rule pack's finding, advisory (FLR-ADR-011). The copy of
 * library.json here is the standard's, byte for byte (test/outdoor.test.ts).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Item {
  readonly kind: string;
  readonly element: Json & { readonly fallback: { readonly box: { readonly min: number[]; readonly max: number[] } } };
}

const LIBRARY = index as unknown as { library: string; version: string; license: string; items: Record<string, Item> };
const ITEMS = LIBRARY.items;

export const OUTDOOR = 'FS_outdoor';
export const FS_OUTDOOR = { library: LIBRARY.library, version: LIBRARY.version, license: LIBRARY.license };
const EXTENSION_VERSION = OFFICIAL_EXTENSIONS.find((e) => e.name === OUTDOOR)?.version ?? '0.1.0';

const MM = 1280;
/** A fence's height when no style item gives one: 6'. */
const FENCE_HEIGHT = 6 * 390144;

/** The starter items' IDs. */
export function outdoorItems(): string[] {
  return Object.keys(ITEMS);
}

/** One line naming the starter items by kind, for a tool result. */
export function outdoorText(): string {
  const by = new Map<string, string[]>();
  for (const [id, it] of Object.entries(ITEMS)) by.set(it.kind, [...(by.get(it.kind) ?? []), id]);
  return `Outdoor: placeElement FS_outdoor <kind> with element {"catalogue":"<item>"} — ${[...by].map(([k, ids]) => `${k}: ${ids.join(', ')}`).join('; ')}. A fence takes points (and a fences item for its style), gates [{offset, width}].`;
}

/** The library's copy, for the test that keeps it in step with the standard's. */
export function vendoredOutdoor(): unknown {
  return LIBRARY;
}

/** An FS_outdoor element being added: a placeElement or an addElement of the extension. */
function outdoorOp(op: Op): { collection: string; element: Json } | null {
  if ((op.op !== 'placeElement' && op.op !== 'addElement') || op['extension'] !== OUTDOOR || !isObject(op['element'])) return null;
  return typeof op['collection'] === 'string' ? { collection: op['collection'], element: op['element'] } : null;
}

const hasBox = (element: Json): boolean => isObject(element['fallback']) && element['fallback']['box'] !== undefined;

/** True when a batch adds an FS_outdoor element the tools would complete or declare. */
export function namesOutdoor(batch: readonly Op[]): boolean {
  return batch.some((op) => {
    const x = outdoorOp(op);
    return x !== null && (!hasBox(x.element) || !isDeclaredIn(batch));
  });
}

/** An item the agent named that the library does not have, or one of another kind: what to say. */
export class OutdoorError extends Error {}

const points = (v: unknown): [number, number][] | null =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1])) ? (v as [number, number][]) : null;

/** FS_outdoor 3.3: the box bounding a fence's line grown by half its width, from z0 to z1. */
function fenceBox(line: [number, number][], width: number, z0: number, z1: number): Json {
  const grow = Math.floor(width / 2);
  const span = (vs: number[]): [number, number] => {
    const [a, b] = [Math.min(...vs) - grow, Math.max(...vs) + grow];
    return b - a < MM ? [a - MM, b + MM] : [a, b];
  };
  const [x0, x1] = span(line.map((p) => p[0]));
  const [y0, y1] = span(line.map((p) => p[1]));
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

function isDeclared(document: unknown): boolean {
  const used = isObject(document) ? document['extensionsUsed'] : undefined;
  return isObject(used) && Object.hasOwn(used, OUTDOOR);
}

function isDeclaredIn(batch: readonly Op[]): boolean {
  return batch.some(
    (op) =>
      op.op === 'setProperty' &&
      op['id'] === '$document' &&
      (op['path'] === `/extensionsUsed/${OUTDOOR}` || (op['path'] === '/extensionsUsed' && isObject(op['value']) && Object.hasOwn(op['value'], OUTDOOR))),
  );
}

export interface OutdoorFill {
  /** The operations to put first: the extension's declaration, when it is needed. */
  readonly prefix: readonly Op[];
  /** The agent's batch with each FS_outdoor element completed (same length, same order). */
  readonly batch: readonly Op[];
  /** The starter items placed, once each. */
  readonly items: readonly string[];
  /** The fences whose box the tools drew round their line. */
  readonly boxed: readonly string[];
}

/** Complete every FS_outdoor element of a batch, and declare the extension when it is not. */
export function fillOutdoor(document: unknown, batch: readonly Op[]): OutdoorFill {
  const items: string[] = [];
  const boxed: string[] = [];
  const any = batch.some((op) => outdoorOp(op) !== null);
  const out = batch.map((op, i) => {
    const x = outdoorOp(op);
    if (x === null) return op;
    const given = x.element;
    const fallback = isObject(given['fallback']) ? given['fallback'] : {};
    if (fallback['box'] !== undefined) return op;
    const label = typeof op['id'] === 'string' ? op['id'] : `op ${String(i)}`;
    const catalogue = given['catalogue'];
    let item: Item | undefined;
    if (typeof catalogue === 'string') {
      item = Object.hasOwn(ITEMS, catalogue) ? ITEMS[catalogue] : undefined;
      if (item === undefined) throw new OutdoorError(`No FS_outdoor starter item is "${catalogue}", and ${label} has no fallback.box of its own. ${outdoorText()}`);
      if (item.kind !== x.collection) throw new OutdoorError(`"${catalogue}" is an FS_outdoor ${item.kind} item: put ${label} in collection "${item.kind}", not "${x.collection}".`);
      if (!items.includes(catalogue)) items.push(catalogue);
    }
    if (x.collection === 'fences') {
      const line = points(given['points']);
      if (line === null || line.length === 0) {
        if (item !== undefined) throw new OutdoorError(`${label}: a fence is drawn — give its "points" (at least two, base units) with the "${String(catalogue)}" style.`);
        return op;
      }
      const { fallback: itemFallback, ...members } = item?.element ?? { fallback: { box: { min: [0, 0, 0], max: [0, 0, FENCE_HEIGHT] } } };
      const merged: Json = { ...structuredClone(members), ...given };
      const width = typeof merged['width'] === 'number' ? merged['width'] : 100 * MM;
      if (merged['width'] === undefined) merged['width'] = width;
      if (merged['form'] === undefined) merged['form'] = 'fence';
      boxed.push(label);
      return { ...op, element: { ...merged, fallback: { ...fallback, box: fenceBox(line, width, itemFallback.box.min[2] ?? 0, itemFallback.box.max[2] ?? FENCE_HEIGHT) } } };
    }
    if (item === undefined) return op;
    const { fallback: itemFallback, ...members } = item.element;
    return { ...op, element: { ...structuredClone(members), ...given, fallback: { box: structuredClone(itemFallback.box), ...fallback } } };
  });
  const prefix: Op[] = any && !isDeclared(document) && !isDeclaredIn(batch) ? [{ op: 'setProperty', id: '$document', path: `/extensionsUsed/${OUTDOOR}`, value: EXTENSION_VERSION }] : [];
  return { prefix, batch: out, items, boxed };
}
