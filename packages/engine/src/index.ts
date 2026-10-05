/**
 * @floorspec/engine — the isomorphic Floorspec engine (FLR-ADR-010): the reference Reader,
 * Canonicalizer, Validator and Deriver of Floorspec Core 0.2, which also reads Core 0.1 documents
 * (1.2.4) and, configured with `core: '0.1'`, is a Core 0.1 reader.
 *
 * The same package runs in the browser, the server, the MCP server and the CLI, so nothing in it
 * reaches for a Node-only API. Lengths are integers in 1/1280 mm (FLR-ADR-004); every derived value
 * is computed exactly and rounded once (2.2).
 */
import { canonicalize, contentHash } from './canonical/canonicalize.js';
import { deriveFrom, type Derived } from './derive/derive.js';
import { evaluate, type Evaluation, type ValidateOptions } from './validate/validate.js';
import { deriveExtensions } from './extensions/official.js';
import type { Diagnostic } from './validate/diagnostic.js';

export const ENGINE_VERSION = '0.2.0-draft';
/** The newest Floorspec Core draft this engine implements; it reads every draft in IMPLEMENTED_VERSIONS. */
export const CORE_VERSION = '0.2';

export { parseJson, type ParseResult } from './json/parse.js';
export { writeJcs, writePretty } from './json/serialize.js';
export { sha256, sha256Hex, toHex } from './hash/sha256.js';
export { canonicalize, contentHash, omitDefaults } from './canonical/canonicalize.js';
export { validate, evaluate, IMPLEMENTED_VERSIONS, type ValidateOptions, type ValidationResult, type Evaluation } from './validate/validate.js';
export { CATALOGUE, entry as catalogueEntry, type CatalogueEntry, type Tier } from './validate/catalogue.js';
export type { Diagnostic, DiagnosticLocation, FixOp, Severity } from './validate/diagnostic.js';
export {
  deriveFrom,
  halfString,
  type Derived,
  type DerivedWall,
  type DerivedRoomPolygon,
  type DerivedUnanchored,
  type DerivedOpening,
  type DerivedProgram,
  type DerivedProgramItem,
  type DerivedAdjacency,
  type DerivedFallback,
  type DerivedPlacement,
  type DerivedClearance,
  type DerivedCirculationRoom,
  type EnvelopeRef,
} from './derive/derive.js';
export { analyseCirculation, type CirculationAnalysis, type BuildingCirculation } from './circulation/circulation.js';
export { loadKnownExtensions, knownEntry, satisfies as versionSatisfies, compareVersions } from './validate/registry.js';
export { facingVector, direction } from './exact/angle.js';
export {
  OFFICIAL_EXTENSIONS,
  OFFICIAL_EXTENSION_NAMES,
  OFFICIAL_EXTENSION_SCHEMAS,
  IMPLEMENTATIONS as EXTENSION_IMPLEMENTATIONS,
  type DerivedExtensions,
} from './extensions/official.js';
export type { ExtensionImplementation, ExtensionDiagnostic, ExtensionContext } from './extensions/context.js';
export { OFFICIAL_READER } from './extensions/reader.js';
export { defaultClearances } from './extensions/clearances.js';
export * as electrical from './extensions/fs/electrical.js';
export * as plumbing from './extensions/fs/plumbing.js';
export * as mechanical from './extensions/fs/mechanical.js';
export * as lowvoltage from './extensions/fs/lowvoltage.js';
export { extentsOk, footprintsOverlap, type Frame, type Footprint } from './derive/frames.js';
export { extElements, declaredVersion, type ExtElement } from './model/document.js';
export { LevelGeometry } from './derive/level.js';
export { Surd } from './exact/surd.js';
export { abs, floorDiv, gcd, isqrt, exactSqrt, roundHalfEvenRational, toSafeNumber, big } from './exact/bigint.js';
export { jsonEqual } from './canonical/canonicalize.js';
export { pointer, type JsonPath } from './json/pointer.js';
export { sortDiagnostics, compareStringSeq, cmpStr } from './validate/diagnostic.js';
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

/** Everything a valid evaluation derives: Core's values, and the evaluated extensions' when the reader implements any. */
function derivedOf(ev: Evaluation): Derived {
  const derived = deriveFrom(ev.document!, ev.analysis!);
  if (ev.extensions) derived.extensions = deriveExtensions(ev.extensions);
  return derived;
}

/**
 * What an evaluation of a valid document derives — Core's values, and those of the extensions it
 * evaluated — for a caller that evaluated once and wants both the analysis and the derived values.
 * Throws InvalidDocumentError when it is not valid.
 */
export function deriveEvaluation(ev: Evaluation): Derived {
  if (!ev.valid || !ev.document || !ev.analysis) throw new InvalidDocumentError(ev.diagnostics);
  return derivedOf(ev);
}

/**
 * Derive every value of chapters 5–7 and 11–14 from a document — and, for a reader that implements
 * official extensions, what they derive. Throws InvalidDocumentError when it is not valid.
 */
export function derive(input: string | Uint8Array | object, options: ValidateOptions = {}): Derived {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.document || !ev.analysis) throw new InvalidDocumentError(ev.diagnostics);
  return derivedOf(ev);
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
    derived: derivedOf(ev),
    canonical: canonicalize(ev.document),
  };
}
