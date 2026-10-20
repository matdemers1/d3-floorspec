import { outdoor, type FloorspecDocument } from '@floorspec/engine';
import outdoorLibrary from '../../../../../packages/engine/standard/registry/FS_outdoor/library.json';
import type { Batch } from '../ops';
import type { Point } from '../model';
import { declarationOps } from '../systems/ops';

/**
 * FS_outdoor's fences and gates as Ops (FLR-T-15.2): a fence is drawn as a wall is, point to point,
 * and added in one op with the style it was drawn in (a fence item of the starter library: its form,
 * thickness, style, material, post spacing and height); its gates are openings along its line
 * (FS_outdoor 2.3), set as its `gates` member. Pools, shelters, kitchens and fires are placed from
 * the library (placing/place.ts).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface FenceStyle {
  id: string;
  name: string;
  /** The item's members: form, width, style, material, postSpacing. */
  members: Json;
  /** Its height: the item's box's top. */
  height: number;
}

interface RawItem {
  kind: string;
  element: Json & { name: string; fallback: { box: { min: number[]; max: number[] } } };
}

/** The fence and wall styles of the starter library (FS_outdoor chapter 7): drawn, not placed. */
const at = (xs: readonly number[], i: number): number => xs[i] ?? 0;

export const FENCE_STYLES: readonly FenceStyle[] = Object.entries((outdoorLibrary as unknown as { items: Record<string, RawItem> }).items)
  .filter(([, it]) => it.kind === 'fences')
  .map(([id, it]) => {
    const { fallback, name, ...members } = it.element;
    return { id, name, members, height: at(fallback.box.max, 2) - at(fallback.box.min, 2) };
  });

/** A style by its ID, else the first: a privacy fence. */
export function fenceStyle(id: string): FenceStyle {
  const found = FENCE_STYLES.find((s) => s.id === id) ?? FENCE_STYLES[0];
  if (found === undefined) throw new Error('the FS_outdoor starter library has no fence styles');
  return found;
}

/** A fence's element: the style's members, its line in plan (no host: its frame is its level's), and the box that bounds the line grown by half its width (3.3). */
export function fenceElement(style: FenceStyle, points: readonly Point[], level: string): Json {
  const pts = points.map((p): [number, number] => [Math.round(p[0]), Math.round(p[1])]);
  const width = Number(style.members['width']);
  const h = Math.floor(width / 2);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    ...structuredClone(style.members),
    name: style.name.replace(/, \d.*$/, ''),
    points: pts,
    fallback: { level, box: { min: [Math.min(...xs) - h, Math.min(...ys) - h, 0], max: [Math.max(...xs) + h, Math.max(...ys) + h, style.height] } },
  };
}

/** Draw a fence: FS_outdoor declared when it is not yet, then one addElement. */
export function drawFence(document: FloorspecDocument, level: string, points: readonly Point[], style: FenceStyle): Batch {
  return [...declarationOps(document, 'FS_outdoor'), { op: 'addElement', extension: 'FS_outdoor', collection: 'fences', element: fenceElement(style, points, level) }];
}

/** The gates of a fence element, as written. */
export function gatesOf(element: Json): outdoor.Gate[] {
  const g = element['gates'];
  return Array.isArray(g) ? (g.filter(isObject) as unknown as outdoor.Gate[]) : [];
}

const linePoints = (element: Json): [number, number][] => {
  const p = element['points'];
  return Array.isArray(p) ? (p as [number, number][]) : [];
};

/** Where two segments cross, as a fraction along the first, or null. */
function crossing(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]): number | null {
  const [rx, ry] = [b[0] - a[0], b[1] - a[1]];
  const [sx, sy] = [d[0] - c[0], d[1] - c[1]];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** A gate's default width: 4′ (the board's G1). */
export const GATE_WIDTH = 4 * 12 * 32_512;

/**
 * Where a new gate goes on a fence (the board's 15.2 frame): centred where a path or stepping stones
 * (FS_landscape hardscape drawn in plan) cross its line, else in the middle of its longest segment —
 * clear of the gates it has, and within its line.
 */
export function gateAt(document: FloorspecDocument, element: Json, width = GATE_WIDTH): { offset: number; width: number } | null {
  const pts = linePoints(element);
  if (pts.length < 2) return null;
  const lengths = outdoor.segmentLengths(pts);
  const total = lengths.reduce((a, b) => a + b, 0);
  const w = Math.min(width, total);
  const taken = outdoor.gateIntervals(gatesOf(element));
  const free = (o: number) => o >= 0 && o + w <= total && taken.every(([a, b]) => o + w <= a || o >= b);
  const centres: number[] = [];
  const land = (document.extensions as Record<string, { collections?: Record<string, Record<string, Json>> }> | undefined)?.['FS_landscape']?.collections?.['hardscape'] ?? {};
  for (const el of Object.values(land)) {
    if (el['host'] !== undefined || (el['form'] !== 'path' && el['form'] !== 'steppingStones')) continue;
    const path = linePoints(el);
    let before = 0;
    pts.slice(1).forEach((b, i) => {
      const a = pts[i] ?? b;
      const l = at(lengths, i);
      path.slice(1).forEach((d, j) => {
        const t = crossing(a, b, path[j] ?? d, d);
        if (t !== null) centres.push(before + t * l);
      });
      before += l;
    });
  }
  let longest = 0;
  lengths.forEach((l, i) => { if (l > at(lengths, longest)) longest = i; });
  centres.push(lengths.slice(0, longest).reduce((a, b) => a + b, 0) + at(lengths, longest) / 2);
  for (const c of centres) {
    const o = Math.round(c - w / 2);
    if (free(o)) return { offset: o, width: w };
  }
  // anywhere along the line it fits, from the start
  for (let o = 0; o + w <= total; o += Math.max(1, Math.round(w / 4))) if (free(o)) return { offset: o, width: w };
  return null;
}

/** The fence's gates replaced (one op: its `gates` member, FS_outdoor 2.3), or unset when there are none. */
export function setGates(id: string, element: Json, gates: readonly outdoor.Gate[]): Batch {
  if (gates.length === 0) return element['gates'] === undefined ? [] : [{ op: 'unsetProperty', id, path: '/gates' }];
  return [{ op: 'setProperty', id, path: '/gates', value: gates.map((g) => ({ ...g })) }];
}
