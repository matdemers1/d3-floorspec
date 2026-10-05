/**
 * The named-measure library (Rules chapters 4 to 8): every measure, by name and target kind, and
 * the deferred measures of 4.8.
 */
import type { TargetKind } from '../types.js';
import type { Measure } from './measure.js';
import { ROOM_MEASURES } from './rooms.js';
import { OPENING_MEASURES } from './openings.js';
import { ELEMENT_MEASURES } from './elements.js';
import { WALL_LINE_MEASURES } from './walllines.js';

/** Every measure the library defines, in chapter order. */
export const MEASURES: readonly Measure[] = [...ROOM_MEASURES, ...OPENING_MEASURES, ...ELEMENT_MEASURES, ...WALL_LINE_MEASURES];

const BY_KIND = new Map<string, Measure>();
for (const m of MEASURES) for (const k of m.kinds) BY_KIND.set(`${m.name}\u0000${k}`, m);

/** The measure `name` defined for targets of `kind`, if there is one. */
export function measureFor(name: string, kind: TargetKind): Measure | undefined {
  return BY_KIND.get(`${name}\u0000${kind}`);
}

/**
 * 4.8: the reserved measures. Each needs something Core 0.2 does not yet describe; a rule that uses
 * one is not evaluated (FS-RULES-008). A measure leaves this list only when a later Rules draft
 * defines it — then it is added to its chapter's module like any other.
 */
export const DEFERRED: ReadonlySet<string> = new Set([
  'ceilingHeight',
  'roomNarrowestDimension',
  'openingNetClearArea',
  'openingNetClearWidth',
  'openingNetClearHeight',
  'doorClearWidth',
  'stairRiserHeight',
  'stairTreadDepth',
  'stairWidth',
  'stairHeadroom',
  'stairHandrailHeight',
  'countertopReceptacleReach',
  'countertopWallRunBetweenReceptacles',
  'travelDistance',
  'floorElevationDifference',
]);
