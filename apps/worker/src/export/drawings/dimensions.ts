/**
 * A level's dimensions and annotation on the drawings (FLR-T-9.3, FLR-T-18.11): render2d's one
 * layout (`@floorspec/render2d` annotate), which the editor's canvas and render2d's SVG draw too.
 *
 * The exterior strings — openings located, major jogs, overall — are read off the building's outer
 * boundary, sub-6" spans merged and arcs measured to their ends and their furthest point, and sit
 * beyond everything the sheet draws. Room strings, the person's own strings (FS_annotation) and
 * notes join them on the sheet, where the scale is known.
 */
import { annoSourceOf, customString, exteriorStrings, roomStrings, type AnnoSource, type CustomDimension, type DimString, type LabelClear, type Note, type AnnoRoom } from '@floorspec/render2d';
import type { LevelPlan } from './plan.js';

export type { DimString } from '@floorspec/render2d';

/** A plan as dimensioning reads it: its rooms labelled where the sheet labels them. */
export function annoSource(plan: LevelPlan): AnnoSource {
  return annoSourceOf(plan.scene, new Map(plan.rooms.map((r) => [r.id, { title: r.title, label: r.label }])));
}

/** The exterior dimension strings of one level's plan: per side, nearest the building first. */
export function dimensionStrings(plan: LevelPlan): DimString[] {
  if (plan.extent === undefined || plan.outline.length === 0) return [];
  return exteriorStrings(annoSource(plan), plan.extent);
}

/** What a level's sheet annotates beyond its exterior strings: the person's own strings and notes. */
export interface PlanNotes {
  readonly custom: readonly CustomDimension[];
  readonly notes: readonly Note[];
}

export const NO_NOTES: PlanNotes = { custom: [], notes: [] };

/** The room strings at a scale (`k`: paper per base unit), clear of labels of the given size. */
export function roomDimensionStrings(plan: LevelPlan, k: number, clear: (room: AnnoRoom) => LabelClear, gap: number): DimString[] {
  return roomStrings(annoSource(plan), k, clear, gap);
}

/** The person's own strings, as strings. */
export function customStrings(notes: PlanNotes): DimString[] {
  return notes.custom.map(customString).filter((s): s is DimString => s !== null);
}
