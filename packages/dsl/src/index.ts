/**
 * @floorspec/dsl — a terse, line-oriented relational authoring language for rough plans
 * (FLR-REQ-140): `kitchen 14x12 east-of dining` compiles to Floorspec Ops 0.3, and every change is
 * still an op (FLR-ADR-008).
 *
 * Isomorphic like the engine and the applier it is built on (FLR-ADR-010), deterministic and exact:
 * the same text gives the same batch, byte for byte, and every coordinate is an integer of base units.
 */
export const PACKAGE_NAME = '@floorspec/dsl';

export { compile, halfEven, type CompileOptions, type CompileResult, type Compiled, type CompileFailure } from './compile.js';
export { build, type Built, type BuildResult } from './build.js';
export { toDsl, formatExact, formatArea } from './decompile.js';
export { parse, KEYWORDS, type Program, type Statement, type Placement, type Side, type Direction, type UnitSystem } from './syntax.js';
export { inferFunction, ROOM_FUNCTIONS, type RoomFunction } from './functions.js';
export { DslError, DecompileError, formatDiagnostic, type DslDiagnostic, type Pos } from './diagnostics.js';
