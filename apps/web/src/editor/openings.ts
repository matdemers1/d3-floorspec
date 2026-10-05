import { DOOR_OPERATIONS, effectiveClearOpening, WINDOW_OPERATIONS, type FloorspecDocument, type Opening } from '@floorspec/engine';
import { parseArea } from '@floorspec/ops';
import type { Batch } from './ops';
import { formatLen, type UnitSystem } from './units';

/**
 * A door's or window's operation and its declared net clear opening (Floorspec Core 0.3, 7.1, 7.2,
 * 8.4), as the inspector, the schedules and the upgrade offer read and write them. A clear opening
 * is what the maker declares — width, height and, for a window only, area — on the type, and on an
 * opening that differs; it is never computed here or anywhere (Core 7.4).
 */

/** The newest Core draft the editor writes, and the one a 0.2 or 0.1 plan is offered. */
export const CURRENT_CORE = '0.3';

/** Does this plan hold operations and clear openings — does it declare Core 0.3 or later? */
export const holdsClearOpenings = (document: { floorspec: string }): boolean => document.floorspec !== '0.1' && document.floorspec !== '0.2';

/** Ops 0.3, 2.3: what makes a 0.2 (or 0.1) plan a Core 0.3 one. Changes nothing else, and Undo takes it back. */
export function upgradeTo03(): Batch {
  return [{ op: 'setProperty', id: '$document', path: '/floorspec', value: CURRENT_CORE }];
}

export const DOOR_OPERATION_LABELS: Readonly<Record<(typeof DOOR_OPERATIONS)[number], string>> = {
  swing: 'Swing',
  doubleSwing: 'Pair, swinging',
  doubleActing: 'Double-acting',
  bypassSlide: 'Bypass sliding',
  pocket: 'Pocket',
  surfaceSlide: 'Surface sliding (barn)',
  bifold: 'Bifold',
  overhead: 'Overhead',
  cased: 'Cased (no leaf)',
};

export const WINDOW_OPERATION_LABELS: Readonly<Record<(typeof WINDOW_OPERATIONS)[number], string>> = {
  fixed: 'Fixed',
  casement: 'Casement',
  awning: 'Awning',
  hopper: 'Hopper',
  singleHung: 'Single-hung',
  doubleHung: 'Double-hung',
  horizontalSlider: 'Horizontal slider',
  tiltTurn: 'Tilt-turn',
  pivot: 'Pivot',
};

/** The choices of an operation select: "not declared", then the kind's operations in the table's order. */
export function operationOptions(kind: 'doorType' | 'windowType'): { value: string; label: string }[] {
  const labels: Record<string, string> = kind === 'doorType' ? DOOR_OPERATION_LABELS : WINDOW_OPERATION_LABELS;
  const ops: readonly string[] = kind === 'doorType' ? DOOR_OPERATIONS : WINDOW_OPERATIONS;
  return [{ value: '', label: 'Not declared' }, ...ops.map((o) => ({ value: o, label: labels[o] ?? o }))];
}

/** An operation in words: `Pocket`, or the term itself for one this editor does not know. */
export function operationLabel(operation: string | undefined): string | undefined {
  if (operation === undefined) return undefined;
  return (DOOR_OPERATION_LABELS as Record<string, string>)[operation] ?? (WINDOW_OPERATION_LABELS as Record<string, string>)[operation] ?? operation;
}

/** Core 7.1: hinge means something for a single swinging leaf, swing for a door whose leaves swing one way. */
export const hingeApplies = (operation: string | undefined): boolean => operation === undefined || operation === 'swing';
export const swingApplies = (operation: string | undefined): boolean => operation === undefined || operation === 'swing' || operation === 'doubleSwing';

export interface ClearOpening {
  width: number;
  height: number;
  area?: number;
}

const SQ_FT = 152_212_340_736;
const SQ_M = 1_638_400_000_000;

/** A declared clear area, as the inspector and the schedules show it: `5.70 ft²` or `0.530 m²`. */
export function formatClearArea(area: number, units: UnitSystem): string {
  if (units === 'metric') return `${(area / SQ_M).toFixed(3)} m²`;
  return `${(area / SQ_FT).toFixed(2)} ft²`;
}

/** The same, as an input's value that parses back: `5.7 sq ft`, `0.53 m2`. */
export function clearAreaText(area: number, units: UnitSystem): string {
  if (units === 'metric') return `${String(Math.round((area / SQ_M) * 1000) / 1000)} m2`;
  return `${String(Math.round((area / SQ_FT) * 100) / 100)} sq ft`;
}

export type ClearAreaInput = { ok: true; value: number } | { ok: false; reason: string };

/** A clear area as typed, in the Ops area grammar (3.6); a bare number is in ft² or m². */
export function parseClearArea(text: string, units: UnitSystem): ClearAreaInput {
  const trimmed = text.trim().replace(/\s*(ft²|ft2|sf)$/i, ' sq ft').replace(/\s*m²$/i, ' m2');
  if (trimmed === '') return { ok: false, reason: 'Type an area' };
  const withUnit = /^(\d+(\.\d+)?|\.\d+)$/.test(trimmed) ? `${trimmed} ${units === 'metric' ? 'm2' : 'sq ft'}` : trimmed;
  const parsed = parseArea(withUnit);
  if (!parsed.ok) return { ok: false, reason: `Not an area: ${parsed.reason}` };
  if (parsed.value <= 0n) return { ok: false, reason: 'A clear area is more than zero' };
  if (parsed.value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'That area is larger than Floorspec allows' };
  return { ok: true, value: Number(parsed.value) };
}

/** A clear opening in words: `2' 8" × 6' 7"`, and its area when one is declared. */
export function clearOpeningText(c: ClearOpening, units: UnitSystem): string {
  return `${formatLen(c.width, units)} × ${formatLen(c.height, units)}${c.area === undefined ? '' : ` · ${formatClearArea(c.area, units)}`}`;
}

/** An opening's effective clear opening (Core 7.2: its own, whole, else its type's), or undefined. */
export function clearOpeningOf(document: FloorspecDocument, opening: Opening): ClearOpening | undefined {
  const c = effectiveClearOpening(document, opening);
  return c === undefined ? undefined : { width: c.width, height: c.height, ...(c.area === undefined ? {} : { area: c.area }) };
}

/** Set `id`'s whole clear opening, or unset it when `next` is undefined (Core 8.2: it is resolved whole). */
export function setClearOpening(id: string, next: ClearOpening | undefined, present: boolean): Batch {
  if (next === undefined) return present ? [{ op: 'unsetProperty', id, path: '/clearOpening' }] : [];
  return [{ op: 'setProperty', id, path: '/clearOpening', value: { width: next.width, height: next.height, ...(next.area === undefined ? {} : { area: next.area }) } }];
}

/** Set or unset a type's operation. */
export function setOperation(id: string, operation: string, present: boolean): Batch {
  if (operation === '') return present ? [{ op: 'unsetProperty', id, path: '/operation' }] : [];
  return [{ op: 'setProperty', id, path: '/operation', value: operation }];
}
