/**
 * The diagnostic catalogue of Floorspec Core 0.3 (10.4) — a superset of 0.2's and 0.1's — the single table of codes. A test checks
 * it against the copy of spec/core/10-diagnostics.md vendored with the conformance suite.
 */
import type { Severity } from './diagnostic.js';

export type Tier = 'configuration' | 'parse' | 'document' | 'schema' | 'invariant' | 'lint';

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
  e('FS-CFG-001', 'error', 'configuration', "the validator's known extensions are not a valid registry: an entry does not match the registry entry schema, two entries have the same name and version, or `requires` forms a cycle", '—', '12.2.1, 12.2.2'),
  e('FS-JSON-001', 'error', 'parse', 'not a well-formed UTF-8 JSON text, or begins with a byte order mark', '—', '9.1.1'),
  e('FS-JSON-002', 'error', 'parse', 'an object has a duplicate member name', '—', '9.1.2'),
  e('FS-JSON-003', 'error', 'parse', 'a string has an unpaired surrogate', '—', '9.1.3'),
  e('FS-DOC-001', 'error', 'document', 'the root is an object whose `floorspec` member is a string naming a version this reader does not implement', '—', '1.2.2'),
  e('FS-DOC-002', 'error', 'document', '`extensionsRequired` names an extension this reader does not implement', '—', '1.6.4'),
  e('FS-SCH-001', 'error', 'schema', 'the document does not match the schema of the draft it declares (1.2.6)', '—', '1.1, 1.2.5, 1.2.6, 1.3, 1.4, 1.6.1, 1.6.7, 1.6.8, 1.8, 2.1, 2.4, 2.6 (shape), 3.1.1, 3.1.3 (pattern), 3.2.3, 4.1.1, 4.2 (syntax), 4.3.1, 5.1, 5.2, 5.8.5, 5.9.1, 6.5, 6.7.1, 6.7.2, 7.1.1, 7.1.2, 8.1, 8.3, 8.4.1–8.4.3, 8.5, 8.6, 11.1.1, 11.1.2 (term), 12.1.1, 12.1.2, 12.5.1, 12.5.2, 13.2.1, 13.3.1, 13.5.1, 15.1.1, 15.2.1, 16.1.1, 17.1.1, 17.2.1, 18.1.1, 18.2.1, 18.4.1, 18.5.1, 19.1.1, 19.2.1'),
  e('FS-INV-001', 'error', 'invariant', 'an ID is used in more than one collection — counting program items and every extension collection', 'the ID', '3.1.2, 3.1.3'),
  e('FS-INV-002', 'error', 'invariant', 'a reference does not resolve to an element of the right collection', 'the referring element, program item or extension element; none for an adjacency', '3.2.1'),
  e('FS-INV-003', 'error', 'invariant', 'a type reference resolves to a type of the wrong kind', 'the referring element', '3.2.2'),
  e('FS-INV-004', 'error', 'invariant', 'an `extensionsRequired` name is not in `extensionsUsed`', '—', '1.6.2'),
  e('FS-INV-005', 'error', 'invariant', 'extension data names an extension not in `extensionsUsed`', 'the element, or none at top level', '1.6.3'),
  e('FS-INV-006', 'error', 'invariant', "a room's or a program item's function names an extension not in `extensionsUsed`", 'the room or item', '4.2.1, 11.1.2'),
  e('FS-INV-007', 'error', 'invariant', "an edge's junction is on another level", 'the edge and the junction', '3.3.1'),
  e('FS-INV-008', 'error', 'invariant', "a wall's base or top level is in another building", 'the wall and the level', '3.3.2'),
  e('FS-INV-009', 'error', 'invariant', 'an authored polygon is not simple or has no area', 'the slab or roof, or none for the site boundary', '2.6.1'),
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
  e('FS-INV-305', 'error', 'invariant', "an opening's effective clear opening is wider or taller than the opening", 'the opening', '7.2.2'),
  e('FS-INV-306', 'error', 'invariant', "a clear opening's area exceeds its width times its height; once for each such clear opening, on a type or on an opening", 'the type or the opening', '8.4.4'),
  e('FS-INV-307', 'error', 'invariant', "a door or window type's clear opening is wider or taller than the type", 'the type', '8.4.5'),
  e('FS-INV-308', 'error', 'invariant', "an opening's own clear opening has an area, and the opening's fill is not a window type", 'the opening', '7.1.3'),
  e('FS-INV-401', 'error', 'invariant', 'an adjacency relates an item to itself', 'the item', '11.2.1'),
  e('FS-INV-402', 'error', 'invariant', 'an adjacency has the pair and kind of an earlier one; once for each such adjacency', 'both items', '11.2.2'),
  e('FS-INV-403', 'error', 'invariant', 'a pair has a `"forbidden"` adjacency and a `"required"` or `"preferred"` one; once for each such pair', 'both items', '11.2.3'),
  e('FS-INV-501', 'error', 'invariant', "a `wallFace` host's offset exceeds its wall's length", 'the extension element', '13.3.2'),
  e('FS-INV-502', 'error', 'invariant', "a `wallFace` host's height exceeds its wall's height", 'the extension element', '13.3.3'),
  e('FS-INV-503', 'error', 'invariant', "a `surface` host's position is not strictly inside its room's polygon", 'the extension element', '13.3.4'),
  e('FS-INV-504', 'error', 'invariant', "an extension element's fallback level is not its host's level", 'the extension element', '13.3.5'),
  e('FS-INV-505', 'error', 'invariant', "a box — a fallback's or a clearance envelope's — has an extent of less than 1,280; once for each such box", 'the extension element or type', '13.2.2'),
  e('FS-INV-506', 'error', 'invariant', "a fallback's `asset` or `symbol` has a media type 12.6.1 does not allow; once for each", 'the extension element', '12.6.1'),
  e('FS-INV-601', 'error', 'invariant', 'an extension that a used, known extension requires is not used; once for each such pair', '—', '12.3.2'),
  e('FS-INV-602', 'error', 'invariant', 'an extension that a used, known extension requires is used at a version outside the range; once for each such pair', '—', '12.3.1, 12.3.3'),
  e('FS-INV-603', 'error', 'invariant', 'an element of a known extension lacks a fallback part its kind requires; once for each missing part', 'the extension element', '12.4.2'),
  e('FS-INV-604', 'error', 'invariant', "a known extension's data has a collection its entry does not name; once for each", '—', '12.4.1'),
  e('FS-INV-605', 'error', 'invariant', "a function uses a term of a known extension that its entry does not list", 'the room or item', '12.4.3'),
  e('FS-INV-701', 'error', 'invariant', "a room's ceiling is not above its floor: its least exact elevation over the room polygon is not greater than its floor's top", 'the room', '15.2.2'),
  e('FS-INV-702', 'error', 'invariant', "a vaulted ceiling's two ridge points are the same point", 'the room', '15.3.1'),
  e('FS-INV-703', 'error', 'invariant', "a tray ceiling's border does not fit its room: an edge of the centre runs backwards, or the centre is degenerate", 'the room', '15.4.1'),
  e('FS-INV-801', 'error', 'invariant', "a member name of a roof's `edges` names no edge of its footprint", 'the roof', '16.1.2'),
  e('FS-INV-802', 'error', 'invariant', 'a roof has both level edges and edges that are not level', 'the roof', '16.2.1'),
  e('FS-INV-803', 'error', 'invariant', 'every edge of a roof is a gable', 'the roof', '16.2.2'),
  e('FS-INV-804', 'error', 'invariant', "two consecutive edges of a roof's footprint are collinear", 'the roof', '16.2.3'),
  e('FS-INV-805', 'error', 'invariant', "a roof's eave outline does not fit its footprint: an edge of it runs backwards, or it is not simple or runs the other way", 'the roof', '16.3.1'),
  e('FS-INV-901', 'error', 'invariant', "a stair's `to` is its own `level`, or a level of another building", 'the stair', '17.1.2'),
  e('FS-INV-902', 'error', 'invariant', "a stair's rise is not greater than zero", 'the stair', '17.4.1'),
  e('FS-INV-903', 'error', 'invariant', "a stair's riser count does not fit its form", 'the stair', '17.4.2'),
  e('FS-INV-904', 'error', 'invariant', "a spiral stair's width is more than half its diameter", 'the stair', '17.2.2'),
  e('FS-INV-1001', 'error', 'invariant', "a region of a wall's finishes is empty: its `to` is not greater than its `from`, or its `top` not greater than its `bottom`; once for each such region", 'the wall', '18.5.2'),
  e('FS-INV-1002', 'error', 'invariant', "a region extends past its wall's length or above its wall's height; once for each such region", 'the wall', '18.5.3'),
  e('FS-INV-1003', 'error', 'invariant', 'two regions of one face overlap; once for each such pair', 'the wall', '18.5.4'),
  e('FS-INV-1004', 'error', 'invariant', "a texture's map is an asset whose media type 18.2.2 does not allow; once for each such map", 'the material and the asset', '18.2.2'),
  e('FS-INV-1005', 'error', 'invariant', "the package has no file at an asset's `path`", 'the asset', '18.4.2'),
  e('FS-INV-1006', 'error', 'invariant', "the SHA-256 digest of an asset's file is not its `sha256`", 'the asset', '18.4.3'),
  e('FS-INV-1007', 'error', 'invariant', "the length of an asset's file in bytes is not its `byteLength`", 'the asset', '18.4.3'),
  e('FS-INV-1101', 'error', 'invariant', "an option set's `primary` is an option of another set", 'the option set and the option', '19.1.2'),
  e('FS-INV-1102', 'error', 'invariant', 'an element refers to an element that is in an option, and is not in that option itself; once for each pair of an element and an element it refers to', 'both elements', '19.4.1'),
  e('FS-LINT-001', 'warning', 'lint', 'an acute join', 'the junction and both walls', '5.10'),
  e('FS-LINT-002', 'warning', 'lint', 'a junction no edge uses', 'the junction', '5.10'),
  e('FS-LINT-003', 'info', 'lint', 'a bounded face with no anchor', '— (location: its level and a point of it)', '6.6'),
  e('FS-LINT-004', 'warning', 'lint', 'a bounded face with no anchor whose room polygon is degenerate', '— (location: its level)', '6.6'),
  e('FS-LINT-005', 'warning', 'lint', 'an opening reaches into a join', 'the opening', '7.5'),
  e('FS-LINT-006', 'info', 'lint', "a type, material or asset nothing refers to — a fallback's `asset` and `symbol` refer to theirs", 'it', '8.7'),
  e('FS-LINT-007', 'warning', 'lint', 'an asset located by `uri`', 'the asset', '8.7'),
  e('FS-LINT-008', 'warning', 'lint', 'a program item with fewer rooms than its `count`', 'the item', '11.5'),
  e('FS-LINT-009', 'warning', 'lint', "a room whose net area is less than its item's `minArea`", 'the item and the room', '11.5'),
  e('FS-LINT-010', 'warning', 'lint', "a `\"required\"` adjacency whose items' rooms are not adjacent; once for each adjacency", 'both items', '11.5'),
  e('FS-LINT-011', 'warning', 'lint', "a `\"forbidden\"` adjacency whose items' rooms are adjacent; once for each adjacency", 'both items', '11.5'),
  e('FS-LINT-012', 'warning', 'lint', 'a room not reachable from an entry of its building', 'the room', '14.4'),
  e('FS-LINT-013', 'warning', 'lint', 'a sleeping room reachable only through another sleeping room', 'the room', '14.4'),
  e('FS-LINT-014', 'warning', 'lint', 'an evaluated building (14.4) that has rooms but no entry', 'the building', '14.4'),
  e('FS-LINT-015', 'info', 'lint', 'a roof whose surface this draft does not derive (16.4.4)', 'the roof', '16.4.1'),
  e('FS-LINT-016', 'info', 'lint', 'a winder or a spiral stair, whose steps, run, walkline and headroom this draft does not derive', 'the stair', '17.7'),
  e('FS-LINT-017', 'info', 'lint', 'an option set with exactly one option', 'the option set', '19.8'),
];

const BY_CODE = new Map(CATALOGUE.map((c) => [c.code, c]));

export type Code = (typeof CATALOGUE)[number]['code'];

export function entry(code: string): CatalogueEntry {
  const c = BY_CODE.get(code);
  if (!c) throw new Error(`unknown diagnostic code ${code}`);
  return c;
}
