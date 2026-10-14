/**
 * Renovation filters in plan (FLR-T-18.13, FS_renovation 0.1.0 chapter 3): Existing, Demolition,
 * Proposed and Combined. A filter draws a state of the house — the existing state for Existing and
 * Demolition, the proposed state for Proposed, everything for Combined — and each element in the
 * style its status asks for: existing work subdued in grey, what is to be demolished dashed with no
 * poché, new work in solid poché. The same table drives the editor, the SVG, the PDF and DXF exports.
 */
import { renovation as R, type FloorspecDocument } from '@floorspec/engine';
import type { ThemeName } from './theme.js';

export type RenovationFilter = R.RenovationFilter;
export type RenovationStyle = R.RenovationStyle;
export type RenovationStatus = R.RenovationStatus;
export const RENOVATION_FILTERS: readonly RenovationFilter[] = R.RENOVATION_FILTERS;

export const isRenovationFilter = (v: unknown): v is RenovationFilter => typeof v === 'string' && (RENOVATION_FILTERS as readonly string[]).includes(v);

/** A filter's name, as menus and a sheet's title give it. */
export const RENOVATION_FILTER_LABELS: Readonly<Record<RenovationFilter, string>> = {
  existing: 'Existing',
  demolition: 'Demolition',
  proposed: 'Proposed',
  combined: 'Combined',
};

/** What each status is called in a legend and an inspector. */
export const RENOVATION_STATUS_LABELS: Readonly<Record<RenovationStatus, string>> = {
  existing: 'Existing',
  demolish: 'To demolish',
  new: 'New',
};

/** How faint existing work is drawn beside what changes: subdued, so the work stands out. */
export const EXISTING_OPACITY = 0.42;

/** The dash of demolished work, in screen pixels. */
export const DEMOLISH_DASH = '5 3';

/**
 * The renovation inks per theme: demolished work in red, as the history slider's removed items are
 * (Figma 141-48096), and new work in the plan's darkest ink, its poché solid.
 */
export const RENOVATION_INK: Readonly<Record<ThemeName, { readonly demolish: string; readonly new: string; readonly existing: string }>> = {
  light: { demolish: '#c8372d', new: '#101117', existing: '#8a8e9b' },
  dark: { demolish: '#ff7b72', new: '#f0f2f7', existing: '#747888' },
};

/**
 * The style every element with a status is drawn in under `filter` (FS_renovation 3.1), by ID; null
 * for a document that does not use FS_renovation, whose plan every filter draws as it is.
 */
export function renovationStyles(doc: FloorspecDocument, filter: RenovationFilter): Map<string, RenovationStyle> | null {
  if (!R.usesRenovation(doc)) return null;
  const out = new Map<string, RenovationStyle>();
  for (const [id, s] of R.renovationStatuses(doc)) out.set(id, R.filterStyle(filter, s));
  return out;
}

/** The document a filter draws: its state as a plain document, or the document itself for Combined. */
export function filteredDocument(doc: FloorspecDocument, filter: RenovationFilter): FloorspecDocument {
  if (!R.usesRenovation(doc)) return doc;
  const state = R.filterState(filter);
  return state === undefined ? doc : R.stateDocument(doc, state);
}
