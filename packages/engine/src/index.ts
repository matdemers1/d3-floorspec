/**
 * @floorspec/engine — the isomorphic Floorspec engine (FLR-ADR-010): the reference Reader,
 * Canonicalizer, Validator and Deriver of Floorspec Core 0.3, which also reads Core 0.2 and 0.1
 * documents (1.2.6) and, configured with `core: '0.2'` or `core: '0.1'`, is a reader of that draft.
 *
 * The same package runs in the browser, the server, the MCP server and the CLI, so nothing in it
 * reaches for a Node-only API. Lengths are integers in 1/1280 mm (FLR-ADR-004); every derived value
 * is computed exactly and rounded once (2.2).
 */
import { canonicalize, contentHash } from './canonical/canonicalize.js';
import { deriveFrom, type Derived } from './derive/derive.js';
import { evaluate, type Evaluation, type ValidateOptions } from './validate/validate.js';
import { deriveExtensions, type ExtensionRun } from './extensions/official.js';
import type { Diagnostic } from './validate/diagnostic.js';
import type { FloorspecDocument } from './model/document.js';
import type { Analysis } from './validate/invariants.js';
import { deriveOptions } from './options/options.js';

export const ENGINE_VERSION = '0.4.0-draft';
/** The newest Floorspec Core draft this engine implements; it reads every draft in IMPLEMENTED_VERSIONS. */
export const CORE_VERSION = '0.4';

export { parseJson, type ParseResult } from './json/parse.js';
export { writeJcs, writePretty } from './json/serialize.js';
export { sha256, sha256Hex, toHex } from './hash/sha256.js';
export { canonicalize, contentHash, omitDefaults } from './canonical/canonicalize.js';
export { validate, evaluate, IMPLEMENTED_VERSIONS, type ValidateOptions, type ValidationResult, type Evaluation, type CheckedDesignEvaluation } from './validate/validate.js';
export {
  hasOptions,
  membership,
  optionsOf,
  primaryDesign,
  checkedDesigns,
  viewOf,
  resolveDesign,
  checkedTagOf,
  affected,
  type Design,
  type CheckedDesign,
  type DerivedOption,
  type DerivedOptionSet,
} from './options/options.js';
export {
  Package,
  MAP_MEDIA_TYPES,
  deriveFinishes,
  faceFinish,
  facingRooms,
  surfaceST,
  type DerivedFinishes,
  type DerivedFaceFinish,
  type DerivedRoomFinish,
  type Side as WallSide,
} from './finishes/finishes.js';
export { references, IN_OPTIONS, type Reference } from './validate/references.js';
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
  type DerivedRoof,
  type DerivedRoofFace,
  type DerivedRoofLine,
  type DerivedStair,
  type EnvelopeRef,
} from './derive/derive.js';
export { surfaceNotDerivedReason } from './roofs/roofs.js';
export { analyseCirculation, type CirculationAnalysis, type BuildingCirculation } from './circulation/circulation.js';
export { loadKnownExtensions, knownEntry, satisfies as versionSatisfies, compareVersions } from './validate/registry.js';
export { facingVector, direction } from './exact/angle.js';
export {
  OFFICIAL_EXTENSIONS,
  OFFICIAL_EXTENSION_NAMES,
  OFFICIAL_EXTENSION_SCHEMAS,
  OFFICIAL_EXTENSION_CORE_VERSIONS,
  officialExtensionsEvaluatedFor,
  officialElementRooms,
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
export * as furniture from './extensions/fs/furniture.js';
export * as structural from './extensions/fs/structural.js';
export { extentsOk, footprintsOverlap, type Frame, type Footprint } from './derive/frames.js';
export {
  extElements,
  declaredVersion,
  effectiveClearOpening,
  openingDimensions,
  hasCore02Members,
  DOOR_OPERATIONS,
  WINDOW_OPERATIONS,
  type ExtElement,
} from './model/document.js';
export { LevelGeometry } from './derive/level.js';
export { exteriorOutline } from './derive/outline.js';
export { z765, Z765_CITATION, FOOT, type Z765Options, type Z765Result, type Z765Building, type Z765Level } from './measures/z765.js';
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

/** The values one design's view derives (its document and analysis), with what its extensions derive. */
function deriveDesign(document: FloorspecDocument, analysis: Analysis, runs: readonly ExtensionRun[] | undefined): Derived {
  const derived = deriveFrom(document, analysis);
  if (runs) derived.extensions = deriveExtensions(runs);
  return derived;
}

/** Everything a valid evaluation derives: Core's values of the derived design, the evaluated extensions', and `options` (19.6.3). */
function derivedOf(ev: Evaluation): Derived {
  const derived = deriveDesign(ev.view!, ev.analysis!, ev.extensions);
  if (ev.designs && ev.design) {
    const by = new Map<string, Derived>();
    for (const d of ev.designs) {
      const same = d.document === ev.view;
      by.set(d.tag ?? '', same ? derived : deriveDesign(d.document, d.analysis, d.extensions));
    }
    derived.options = deriveOptions(ev.document!, ev.design, by as unknown as Parameters<typeof deriveOptions>[2]);
  }
  return derived;
}

/** Nothing is derived for the design asked for (Core 0.3, 19.6.2): it is not one of the document's, or its view is not valid. */
export class DesignNotDerivedError extends Error {
  constructor() {
    super('nothing is derived for this design: it is not a design of the document, or its view is not valid (19.6.2)');
  }
}

/**
 * What an evaluation of a valid document derives — Core's values, and those of the extensions it
 * evaluated — for a caller that evaluated once and wants both the analysis and the derived values.
 * Throws InvalidDocumentError when it is not valid, and DesignNotDerivedError when nothing is
 * derived for the design it was asked for.
 */
export function deriveEvaluation(ev: Evaluation): Derived {
  if (!ev.valid || !ev.document) throw new InvalidDocumentError(ev.diagnostics);
  if (!ev.view || !ev.analysis) throw new DesignNotDerivedError();
  return derivedOf(ev);
}

/**
 * Derive every value of chapters 5–7 and 11–19 from a document — and, for a reader that implements
 * official extensions, what they derive. `options.design` chooses the design (Core 0.3, 19.6).
 * Throws InvalidDocumentError when it is not valid, DesignNotDerivedError when nothing is derived
 * for the design.
 */
export function derive(input: string | Uint8Array | object, options: ValidateOptions = {}): Derived {
  return deriveEvaluation(evaluate(input, options));
}

/** The conformance-shaped result of conformance/README.md: what a conformant implementation reports and derives. */
export interface CheckResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Present when the document is valid: its content hash (9.3). */
  hash?: string;
  /** Present when the document is valid and the design asked for is derived (19.6): everything derived from it. */
  derived?: Derived;
  /** Present when the document is valid: its canonical form (9.2). */
  canonical?: string;
}

/** Validate, and for a valid document also hash, canonicalize and derive. */
export function check(input: string | Uint8Array | object, options: ValidateOptions = {}): CheckResult {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.document) return { valid: ev.valid, diagnostics: ev.diagnostics };
  return {
    valid: true,
    diagnostics: ev.diagnostics,
    hash: contentHash(ev.document),
    ...(ev.view && ev.analysis && { derived: derivedOf(ev) }),
    canonical: canonicalize(ev.document),
  };
}
