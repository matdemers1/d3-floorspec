/**
 * @floorspec/ops — the reference applier of Floorspec Ops 0.1: the edit operations of a Floorspec
 * Core document, as one atomic, deterministic transaction (FLR-ADR-008).
 *
 * Isomorphic like @floorspec/engine (FLR-ADR-010): the same package applies edits in the editor,
 * the server, the MCP server and the CLI, and produces the same bytes in each.
 */
export const PACKAGE_NAME = '@floorspec/ops';
/** The Floorspec Ops draft this applier implements. */
export const OPS_VERSION = '0.1';

export { apply, resolveBatch, type JsonInput } from './apply.js';
export { checkRequest, OP_SHAPES } from './request.js';
export { parseLength, formatLength, describeRounding, UNITS, MAX_LENGTH, type LengthParse, type FormatLengthOptions } from './references/length.js';
export { OPS_CATALOGUE, opsDiagnostic, OpsFailure, type OpsCode } from './diagnostics.js';
export { COLLECTIONS, PREFIX, RESERVED_TARGETS } from './model/working.js';
export { sideOf, SIDES } from './model/faces.js';
export { INVERSE_ORDER } from './inverse.js';
export type * from './types.js';
export type { Rational } from './lib/rational.js';
