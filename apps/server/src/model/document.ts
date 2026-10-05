/** A JSON value, as stored in a version's JSONB document. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * The Floorspec Core version a new project starts at: Core 0.4, so a new project can hold a program,
 * extension elements, its doors' and windows' operation and declared net clear openings, and winder
 * stairs with a newel and stairs designed for a headroom, from its first edit.
 *
 * A project stored as Core 0.3, 0.2 or 0.1 keeps working and keeps its version: the engine reads
 * every draft, and Ops 0.4 applies to those documents exactly as Ops 0.3 did. An edit never
 * upgrades a document by itself — Ops writes no declaration implicitly — so a document becomes 0.4
 * only through an op that says so (`setProperty` of `$document` `/floorspec` to `"0.4"`, the whole of
 * Core 20.7's step), which the history records like any other edit and its inverse undoes. A batch
 * that adds a member a later draft defines without that op is rejected by validation (FS-SCH-001).
 *
 * The official extensions at 0.1.0 are evaluated only for documents that declare "0.2" (each one's
 * 1.2; `officialExtensionsEvaluatedFor`), so in a 0.3 project their devices are placed and drawn
 * (Core derives placements and fallbacks) but their checks and derived values wait for their specs
 * to take Core 0.3.
 */
export const FLOORSPEC_VERSION = '0.4';

/**
 * Version 0 of every project: the empty Floorspec document. What later phases add to it arrives as
 * Floorspec Ops, never by rewriting this (FLR-ADR-008).
 */
export function emptyDocument(name: string): { [key: string]: Json } {
  return { floorspec: FLOORSPEC_VERSION, project: { name } };
}
