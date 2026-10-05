/**
 * @floorspec/ops — the reference applier of Floorspec Ops 0.2 (and, with `{ ops: '0.1' }`, of Ops
 * 0.1 as published): the edit operations of a Floorspec Core document, as one atomic,
 * deterministic transaction (FLR-ADR-008).
 *
 * Isomorphic like @floorspec/engine (FLR-ADR-010): the same package applies edits in the editor,
 * the server, the MCP server and the CLI, and produces the same bytes in each.
 */
export const PACKAGE_NAME = '@floorspec/ops';
/** The Floorspec Ops draft this applier implements by default. */
export const OPS_VERSION = '0.2';
/** Every Floorspec Ops draft this applier implements (`apply(…, { ops })`). */
export const OPS_VERSIONS = ['0.1', '0.2'] as const;

export { apply, resolveBatch, type JsonInput } from './apply.js';
export { checkRequest, OP_SHAPES, OP_SHAPES_BY_VERSION, HOST_SHAPES } from './request.js';
export { parseLength, parseArea, formatLength, describeRounding, UNITS, SQUARE_UNITS, MAX_LENGTH, type LengthParse, type FormatLengthOptions } from './references/length.js';
export { OPS_CATALOGUE, opsDiagnostic, OpsFailure, type OpsCode } from './diagnostics.js';
export { COLLECTIONS, EXTENSION_PREFIX, ITEMS, PREFIX, RESERVED_TARGETS } from './model/working.js';
export { sideOf, SIDES } from './model/faces.js';
export { INVERSE_ORDER } from './inverse.js';
export type * from './types.js';
export type { Rational } from './lib/rational.js';
