/** A JSON value, as stored in a version's JSONB document. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** The Floorspec version a new project starts at. */
export const FLOORSPEC_VERSION = '0.1';

/**
 * Version 0 of every project: the empty Floorspec document. What later phases add to it arrives as
 * Floorspec Ops, never by rewriting this (FLR-ADR-008).
 */
export function emptyDocument(name: string): { [key: string]: Json } {
  return { floorspec: FLOORSPEC_VERSION, project: { name } };
}
