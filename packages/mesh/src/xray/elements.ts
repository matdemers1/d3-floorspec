/**
 * What X-ray reads of the building systems' elements (FLR-T-14.5): where each is (its placement,
 * 13.4, else the middle of its fallback box, 12.6), on which level, and the levels' heights.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from '../own.js';
import { INCH, type V2 } from './frames.js';
import type { P3 } from './types.js';

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** An extension's top-level data. */
export const extension = (doc: FloorspecDocument, name: string): Json | undefined => obj(obj(doc.extensions)?.[name]);

/** An extension's collection, its elements sorted by ID. */
export function collection(doc: FloorspecDocument, ext: string, name: string): [string, Json][] {
  const c = obj(obj(extension(doc, ext)?.['collections'])?.[name]);
  return c === undefined ? [] : Object.keys(c).sort().flatMap((id) => {
    const e = obj(c[id]);
    return e === undefined ? [] : [[id, e] as [string, Json]];
  });
}

/** Where an element is: its placement's point, else its box's middle at its bottom; its level, its box's bottom and top. */
export interface Located {
  readonly id: string;
  readonly level: string;
  readonly point: P3;
  readonly bottom: number;
  readonly top: number;
}

export function locate(derived: Derived, id: string): Located | null {
  const f = derived.fallbacks?.[id];
  if (f === undefined) return null;
  const p = derived.placements?.[id]?.point;
  if (p !== undefined) return { id, level: f.level, point: [p[0], p[1], p[2]], bottom: f.bottom, top: f.top };
  const fp = f.footprint;
  const cx = fp.reduce((s, q) => s + q[0], 0) / fp.length;
  const cy = fp.reduce((s, q) => s + q[1], 0) / fp.length;
  return { id, level: f.level, point: [cx, cy, f.bottom], bottom: f.bottom, top: f.top };
}

export const plan = (p: P3): V2 => [p[0], p[1]];

/** A level's elevation and the height of its ceiling above it (15: `ceilingHeight`, else the level's height). */
export function levelOf(doc: FloorspecDocument, id: string): { elevation: number; ceiling: number; height: number } {
  const l = get(doc.levels, id);
  const height = l?.height ?? 96 * INCH;
  return { elevation: l?.elevation ?? 0, ceiling: l?.ceilingHeight ?? height, height };
}

/** The levels, lowest first (by elevation, then ID). */
export function levelsUp(doc: FloorspecDocument): string[] {
  return Object.keys(doc.levels ?? {}).sort((a, b) => levelOf(doc, a).elevation - levelOf(doc, b).elevation || (a < b ? -1 : 1));
}
