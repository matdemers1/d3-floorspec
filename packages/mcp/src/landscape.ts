import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import index from './library/fs-landscape-0.1.0.json' with { type: 'json' };
import type { Op } from './client.js';

/**
 * FS_landscape through MCP (FLR-T-13.5): an agent plants a starter size by name — a placeElement of
 * `plants` whose element is `{"catalogue":"tree-medium"}` — and draws a bed, a lawn or a hardscape
 * line by its geometry alone; the tools fill in what the agent left out:
 *
 *   - a plant named by a starter size (FS_landscape chapter 7) gets its form, name, a tree's clear
 *     height and its box, planted at grade (members the agent gave are kept);
 *   - a bed, a lawn or a hardscape element with no box gets the box that bounds its geometry in plan
 *     (FS_landscape 3.3) — a line's grown by half its width — from a little below the ground to its
 *     surface: a lawn's turf, a bed's edging, a path's stones, a wall's 900 mm;
 *   - FS_landscape is declared when neither the plan nor the batch declares it.
 *
 * No asset is involved: FS_landscape's kinds need no model or symbol (FS_landscape 4.1). Every
 * operation is still a plain Floorspec Op (FLR-ADR-008). The copy of library.json here is the
 * standard's, byte for byte (test/landscape.test.ts).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Item {
  readonly kind: 'plants';
  readonly size: string;
  readonly element: Json & { readonly fallback: { readonly box: unknown } };
}

const LIBRARY = index as unknown as { library: string; version: string; license: string; items: Record<string, Item> };
const ITEMS = LIBRARY.items;

export const LANDSCAPE = 'FS_landscape';
export const FS_LANDSCAPE = { library: LIBRARY.library, version: LIBRARY.version, license: LIBRARY.license };
const EXTENSION_VERSION = OFFICIAL_EXTENSIONS.find((e) => e.name === LANDSCAPE)?.version ?? '0.1.0';

const MM = 1280;
/** The vertical of a box the tools fill in, by kind (and a hardscape element's form), in mm from the ground: [bottom, top]. */
const VERTICAL: Readonly<Record<string, readonly [number, number]>> = {
  lawns: [-100, 0],
  beds: [-150, 25],
  path: [-50, 15],
  steppingStones: [-50, 15],
  curb: [-150, 150],
  wall: [0, 900],
};

/** The starter sizes' IDs. */
export function landscapeItems(): string[] {
  return Object.keys(ITEMS);
}

/** One line naming the starter sizes, for a tool result. */
export function landscapeText(): string {
  return `Landscape: placeElement FS_landscape "plants" with element {"catalogue":"<size>"} — ${landscapeItems().join(', ')}; beds, lawns and hardscape take their outline or line alone.`;
}

/** The library's copy, for the test that keeps it in step with the standard's. */
export function vendoredLandscape(): unknown {
  return LIBRARY;
}

/** An FS_landscape element being added: a placeElement or an addElement of the extension. */
function landscapeOp(op: Op): { collection: string; element: Json } | null {
  if ((op.op !== 'placeElement' && op.op !== 'addElement') || op['extension'] !== LANDSCAPE || !isObject(op['element'])) return null;
  return typeof op['collection'] === 'string' ? { collection: op['collection'], element: op['element'] } : null;
}

const hasBox = (element: Json): boolean => isObject(element['fallback']) && element['fallback']['box'] !== undefined;

/** True when a batch adds an FS_landscape element the tools would complete. */
export function namesLandscape(batch: readonly Op[]): boolean {
  return batch.some((op) => {
    const x = landscapeOp(op);
    return x !== null && (!hasBox(x.element) || !isDeclaredIn(batch));
  });
}

/** An item the agent named that the starter sizes do not have, or geometry the tools cannot bound: what to say. */
export class LandscapeError extends Error {}

const points = (v: unknown): [number, number][] | null =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1])) ? (v as [number, number][]) : null;

/** FS_landscape 3.3: the box bounding an outline or a line (grown by half its width), with the kind's vertical. */
function boxOf(collection: string, element: Json): Json | null {
  const geometry = points(collection === 'hardscape' ? element['points'] : element['boundary']);
  if (geometry === null || geometry.length === 0) return null;
  const grow = collection === 'hardscape' && typeof element['width'] === 'number' ? Math.floor(element['width'] / 2) : 0;
  const key = collection === 'hardscape' ? (typeof element['form'] === 'string' ? element['form'] : 'path') : collection;
  const [z0, z1] = VERTICAL[key] ?? [-50, 15];
  const xs = geometry.map((p) => p[0]);
  const ys = geometry.map((p) => p[1]);
  // a line along an axis, and no width to grow it by, still needs a box at least 1 mm across (Core 13.2.2)
  const span = (vs: number[]): [number, number] => {
    const [a, b] = [Math.min(...vs) - grow, Math.max(...vs) + grow];
    return b - a < MM ? [a - MM, b + MM] : [a, b];
  };
  const [x0, x1] = span(xs);
  const [y0, y1] = span(ys);
  return { min: [x0, y0, z0 * MM], max: [x1, y1, z1 * MM] };
}

function isDeclared(document: unknown): boolean {
  const used = isObject(document) ? document['extensionsUsed'] : undefined;
  return isObject(used) && Object.hasOwn(used, LANDSCAPE);
}

function isDeclaredIn(batch: readonly Op[]): boolean {
  return batch.some(
    (op) =>
      op.op === 'setProperty' &&
      op['id'] === '$document' &&
      (op['path'] === `/extensionsUsed/${LANDSCAPE}` || (op['path'] === '/extensionsUsed' && isObject(op['value']) && Object.hasOwn(op['value'], LANDSCAPE))),
  );
}

export interface LandscapeFill {
  /** The operations to put first: the extension's declaration, when it is needed. */
  readonly prefix: readonly Op[];
  /** The agent's batch with each FS_landscape element completed (same length, same order). */
  readonly batch: readonly Op[];
  /** The starter sizes planted, once each. */
  readonly items: readonly string[];
  /** The elements whose box the tools drew round their geometry. */
  readonly boxed: readonly string[];
}

/** Complete every FS_landscape element of a batch, and declare the extension when it is not. */
export function fillLandscape(document: unknown, batch: readonly Op[]): LandscapeFill {
  const items: string[] = [];
  const boxed: string[] = [];
  const any = batch.some((op) => landscapeOp(op) !== null);
  const out = batch.map((op, i) => {
    const x = landscapeOp(op);
    if (x === null) return op;
    const given = x.element;
    const fallback = isObject(given['fallback']) ? given['fallback'] : {};
    if (fallback['box'] !== undefined) return op;
    const label = typeof op['id'] === 'string' ? op['id'] : `op ${String(i)}`;
    if (x.collection === 'plants') {
      const catalogue = given['catalogue'];
      if (typeof catalogue !== 'string') return op;
      const item = Object.hasOwn(ITEMS, catalogue) ? ITEMS[catalogue] : undefined;
      if (item === undefined) throw new LandscapeError(`No FS_landscape starter size is "${catalogue}", and ${label} has no fallback.box of its own. ${landscapeText()}`);
      if (!items.includes(catalogue)) items.push(catalogue);
      const { fallback: itemFallback, ...members } = item.element;
      return { ...op, element: { ...structuredClone(members), ...given, fallback: { box: structuredClone(itemFallback.box), ...fallback } } };
    }
    const box = boxOf(x.collection, given);
    if (box === null) return op;
    boxed.push(label);
    return { ...op, element: { ...given, fallback: { ...fallback, box } } };
  });
  const prefix: Op[] = any && !isDeclared(document) && !isDeclaredIn(batch) ? [{ op: 'setProperty', id: '$document', path: `/extensionsUsed/${LANDSCAPE}`, value: EXTENSION_VERSION }] : [];
  return { prefix, batch: out, items, boxed };
}
