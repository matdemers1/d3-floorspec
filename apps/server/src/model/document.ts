/** A JSON value, as stored in a version's JSONB document. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * The Floorspec Core version a new project starts at: Core 0.2, so a new project can hold a program
 * and extension elements from its first edit.
 *
 * A project stored as Core 0.1 keeps working and stays 0.1: the engine reads both drafts, and Ops
 * 0.2 applies to 0.1 documents exactly as Ops 0.1 did. An edit never upgrades a document by itself
 * — Ops writes no declaration implicitly — so a 0.1 document becomes 0.2 only through an op that
 * says so (`setProperty` of `$document` `/floorspec` to `"0.2"`), which the history records like any
 * other edit and its inverse undoes. A batch that adds a program item or an extension element to a
 * 0.1 document without that op is rejected by validation (a program is not a Core 0.1 member).
 */
export const FLOORSPEC_VERSION = '0.2';

/**
 * Version 0 of every project: the empty Floorspec document. What later phases add to it arrives as
 * Floorspec Ops, never by rewriting this (FLR-ADR-008).
 */
export function emptyDocument(name: string): { [key: string]: Json } {
  return { floorspec: FLOORSPEC_VERSION, project: { name } };
}
