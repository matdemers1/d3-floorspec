/**
 * @floorspec/engine — the isomorphic Floorspec engine (FLR-ADR-010): the reference Reader,
 * Canonicalizer, Validator and Deriver of Floorspec Core 0.1.
 *
 * The same package runs in the browser, the server, the MCP server and the CLI, so nothing in it
 * reaches for a Node-only API. Lengths are integers in 1/1280 mm (FLR-ADR-004); every derived value
 * is computed exactly and rounded once (2.2).
 */
import { canonicalize, contentHash } from './canonical/canonicalize.js';
import { deriveFrom, type Derived } from './derive/derive.js';
import { evaluate, type ValidateOptions } from './validate/validate.js';
import type { Diagnostic } from './validate/diagnostic.js';

export const ENGINE_VERSION = '0.1.0-draft';
/** The Floorspec Core draft this engine implements. */
export const CORE_VERSION = '0.1';

export { parseJson, type ParseResult } from './json/parse.js';
export { writeJcs, writePretty } from './json/serialize.js';
export { sha256, sha256Hex, toHex } from './hash/sha256.js';
export { canonicalize, contentHash, omitDefaults } from './canonical/canonicalize.js';
export { validate, evaluate, IMPLEMENTED_VERSIONS, type ValidateOptions, type ValidationResult, type Evaluation } from './validate/validate.js';
export { CATALOGUE, entry as catalogueEntry, type CatalogueEntry, type Tier } from './validate/catalogue.js';
export type { Diagnostic, DiagnosticLocation, FixOp, Severity } from './validate/diagnostic.js';
export { deriveFrom, halfString, type Derived, type DerivedWall, type DerivedRoomPolygon, type DerivedUnanchored, type DerivedOpening } from './derive/derive.js';
export { LevelGeometry } from './derive/level.js';
export { Surd } from './exact/surd.js';
export * as predicates from './geometry/predicates.js';
export { HalfEdgeGraph, type Cycle, type Face } from './geometry/halfedge.js';
export { planarize, type PlanarizeInput, type PlanarizeResult } from './geometry/planarize.js';
export type * from './model/document.js';

export class InvalidDocumentError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(`the document is not valid: ${diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(', ')}`);
    this.diagnostics = diagnostics;
  }
}

/** Derive every value of chapters 5–7 from a document. Throws InvalidDocumentError when it is not valid. */
export function derive(input: string | Uint8Array | object, options: ValidateOptions = {}): Derived {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.document || !ev.analysis) throw new InvalidDocumentError(ev.diagnostics);
  return deriveFrom(ev.document, ev.analysis);
}

/** The conformance-shaped result of conformance/README.md: what a conformant implementation reports and derives. */
export interface CheckResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Present when the document is valid: its content hash (9.3). */
  hash?: string;
  /** Present when the document is valid: everything derived from it. */
  derived?: Derived;
  /** Present when the document is valid: its canonical form (9.2). */
  canonical?: string;
}

/** Validate, and for a valid document also hash, canonicalize and derive. */
export function check(input: string | Uint8Array | object, options: ValidateOptions = {}): CheckResult {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.document || !ev.analysis) return { valid: ev.valid, diagnostics: ev.diagnostics };
  return {
    valid: true,
    diagnostics: ev.diagnostics,
    hash: contentHash(ev.document),
    derived: deriveFrom(ev.document, ev.analysis),
    canonical: canonicalize(ev.document),
  };
}
