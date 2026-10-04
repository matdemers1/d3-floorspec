/**
 * The diagnostic catalogue of Floorspec Core 0.1 (10.4) — the single table of codes. A test checks
 * it against the copy of spec/core/10-diagnostics.md vendored with the conformance suite.
 */
import type { Severity } from './diagnostic.js';

export type Tier = 'parse' | 'document' | 'schema' | 'invariant' | 'lint';

export interface CatalogueEntry {
  readonly code: string;
  readonly severity: Severity;
  readonly tier: Tier;
  /** The condition, as the catalogue words it. */
  readonly condition: string;
  /** What `elements` lists. */
  readonly elements: string;
  /** The rules it enforces. */
  readonly rule: string;
}

const e = (code: string, severity: Severity, tier: Tier, condition: string, elements: string, rule: string): CatalogueEntry => ({
  code,
  severity,
  tier,
  condition,
  elements,
  rule,
});

export const CATALOGUE: readonly CatalogueEntry[] = [
  e('FS-JSON-001', 'error', 'parse', 'not a well-formed UTF-8 JSON text, or begins with a byte order mark', '—', '9.1.1'),
  e('FS-JSON-002', 'error', 'parse', 'an object has a duplicate member name', '—', '9.1.2'),
  e('FS-JSON-003', 'error', 'parse', 'a string has an unpaired surrogate', '—', '9.1.3'),
  e('FS-DOC-001', 'error', 'document', 'the root is an object whose `floorspec` member is a string naming a version this reader does not implement', '—', '1.2.2'),
  e('FS-DOC-002', 'error', 'document', '`extensionsRequired` names an extension this reader does not implement', '—', '1.6.4'),
  e('FS-SCH-001', 'error', 'schema', 'the document does not match the schema of this draft', '—', '1.1, 1.2.1, 1.3, 1.4, 1.6.1, 1.6.7, 1.6.8, 1.8, 2.1, 2.4, 2.6 (shape), 3.1.1, 3.2.3, 4.1.1, 4.2 (syntax), 4.3.1, 5.1, 5.2, 5.8.5, 5.9.1, 6.5, 6.7.1, 7.1, 8.1, 8.3–8.6'),
  e('FS-INV-001', 'error', 'invariant', 'an ID is used in more than one collection', 'the ID', '3.1.2'),
  e('FS-INV-002', 'error', 'invariant', 'a reference does not resolve to an element of the right collection', 'the referring element', '3.2.1'),
  e('FS-INV-003', 'error', 'invariant', 'a type reference resolves to a type of the wrong kind', 'the referring element', '3.2.2'),
  e('FS-INV-004', 'error', 'invariant', 'an `extensionsRequired` name is not in `extensionsUsed`', '—', '1.6.2'),
  e('FS-INV-005', 'error', 'invariant', 'extension data names an extension not in `extensionsUsed`', 'the element, or none at top level', '1.6.3'),
  e('FS-INV-006', 'error', 'invariant', 'a room function names an extension not in `extensionsUsed`', 'the room', '4.2.1'),
  e('FS-INV-007', 'error', 'invariant', "an edge's junction is on another level", 'the edge and the junction', '3.3.1'),
  e('FS-INV-008', 'error', 'invariant', "a wall's base or top level is in another building", 'the wall and the level', '3.3.2'),
  e('FS-INV-009', 'error', 'invariant', 'an authored polygon is not simple or has no area', 'the slab, or none for the site boundary', '2.6.1'),
  e('FS-INV-101', 'error', 'invariant', 'two junctions on a level share a position', 'both junctions', '5.1.1'),
  e('FS-INV-102', 'error', 'invariant', 'an edge starts and ends at the same junction', 'the edge', '5.2.1'),
  e('FS-INV-103', 'error', 'invariant', 'two edges connect the same two junctions', 'both edges', '5.2.2'),
  e('FS-INV-104', 'error', 'invariant', 'two edges cross', 'both edges', '5.3.1'),
  e('FS-INV-105', 'error', 'invariant', 'a junction lies inside an edge', 'the junction and the edge', '5.3.2'),
  e('FS-INV-106', 'error', 'invariant', 'two edges overlap along a segment (and are not `FS-INV-103`)', 'both edges', '5.3.3'),
  e('FS-INV-107', 'error', 'invariant', 'a wall has no effective layers', 'the wall', '5.4.1'),
  e('FS-INV-108', 'error', 'invariant', 'a `coreFace` wall has no core layer, or its core layers are not consecutive', 'the wall', '5.4.2'),
  e('FS-INV-109', 'error', 'invariant', "a wall's outline is not simple, has no area, or is clockwise", 'the wall', '5.7.2'),
  e('FS-INV-110', 'error', 'invariant', 'a junction fill is not simple or is clockwise', 'the junction', '5.7.4'),
  e('FS-INV-111', 'error', 'invariant', 'a join override does not apply to its junction', 'the junction', '5.8.1–5.8.3'),
  e('FS-INV-112', 'error', 'invariant', "a wall's top is not above its base", 'the wall', '5.9.2'),
  e('FS-INV-201', 'error', 'invariant', "a room's anchor is not in a bounded face", 'the room', '6.3.1'),
  e('FS-INV-202', 'error', 'invariant', 'two or more anchors are in one face', 'all those rooms', '6.3.2'),
  e('FS-INV-203', 'error', 'invariant', "a room's face has a degenerate room polygon", 'the room', '6.3.3'),
  e('FS-INV-204', 'error', 'invariant', "a room's anchor is not strictly inside its room polygon", 'the room', '6.3.4'),
  e('FS-INV-301', 'error', 'invariant', "an opening's width or height does not resolve", 'the opening', '7.2.1'),
  e('FS-INV-302', 'error', 'invariant', "an opening extends beyond its wall's length", 'the opening', '7.3.1'),
  e('FS-INV-303', 'error', 'invariant', "an opening extends above its wall's height", 'the opening', '7.3.2'),
  e('FS-INV-304', 'error', 'invariant', 'two openings on one wall overlap', 'both openings', '7.3.3'),
  e('FS-LINT-001', 'warning', 'lint', 'an acute join', 'the junction and both walls', '5.10'),
  e('FS-LINT-002', 'warning', 'lint', 'a junction no edge uses', 'the junction', '5.10'),
  e('FS-LINT-003', 'info', 'lint', 'a bounded face with no anchor', '— (location: its level and a point of it)', '6.6'),
  e('FS-LINT-004', 'warning', 'lint', 'a bounded face with no anchor whose room polygon is degenerate', '— (location: its level)', '6.6'),
  e('FS-LINT-005', 'warning', 'lint', 'an opening reaches into a join', 'the opening', '7.5'),
  e('FS-LINT-006', 'info', 'lint', 'a type, material or asset nothing refers to', 'it', '8.7'),
  e('FS-LINT-007', 'warning', 'lint', 'an asset located by `uri`', 'the asset', '8.7'),
];

const BY_CODE = new Map(CATALOGUE.map((c) => [c.code, c]));

export type Code = (typeof CATALOGUE)[number]['code'];

export function entry(code: string): CatalogueEntry {
  const c = BY_CODE.get(code);
  if (!c) throw new Error(`unknown diagnostic code ${code}`);
  return c;
}
