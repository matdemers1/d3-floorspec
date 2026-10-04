# 10. Validation and diagnostics

## 10.1 Validity

Validation runs in tiers:

1. **Parsing** — is it JSON, as 9.1 requires? (`FS-JSON-`)
2. **Document** — can this reader read it at all: its version and its required extensions? (`FS-DOC-`)
3. **Schema** — does it match the JSON Schema of this draft? (`FS-SCH-`)
4. **Invariants** — the rules no schema can express: references resolve, the wall graph is planar,
   rooms and openings fit. (`FS-INV-`)
5. **Lints** — conditions that make a valid document worse. (`FS-LINT-`)

The schema is applied to the parsed document, in which a number written with a fraction or an
exponent is not an integer: `1.0` is not a length.

A document is **valid** when the first four tiers report no error. Lints never make a document
invalid.

A validator MUST report a document as valid if, and only if, it reports no diagnostic with severity `error`. {#FS-CORE-10.1.1 MUST}

A model that violates any invariant is invalid; an edit that would produce one is rejected, and
the document is left unchanged (Floorspec Ops).

## 10.2 Diagnostics

A **diagnostic** is a JSON object:

| Member | Type | Meaning |
|---|---|---|
| `code` | string | the stable code from the catalogue (10.4) |
| `severity` | `"error"`, `"warning"` or `"info"` | as the catalogue gives it |
| `message` | string | a human-readable explanation; its wording is not normative |
| `elements` | array of IDs, sorted | the elements involved, as the catalogue lists them |
| `location` | object | where: any of `pointer` (a JSON Pointer, RFC 6901, into the document), `level` (an ID) and `point` (a point on that level) |
| `fix` | array of fix operations | optional: a change that would clear the diagnostic (10.5) |

A validator MUST report each condition the catalogue lists as a diagnostic with the catalogued code, severity and elements. {#FS-CORE-10.2.1 MUST}

A condition that occurs several times is reported once for each occurrence: once for each
unresolved reference, each undeclared extension name, each pair of crossing edges, each pair of
coincident junctions. A validator reports diagnostics sorted by code and then by `elements`, compared as sequences of
strings. For schema violations the catalogue lists a single code, `FS-SCH-001`; validators differ
in how they break a schema violation into parts, so what is compared is only that at least one
`FS-SCH-001` is reported.

## 10.3 Order of evaluation

A tier only makes sense when the one before it passed: a dangling reference makes "is this wall
graph planar?" unanswerable. Each tier is evaluated only when every earlier tier reported no
error, with these refinements inside tier 4:

- **Reference invariants** (`FS-INV-001` to `FS-INV-009`) are evaluated first. If any is reported,
  no other invariant is evaluated.
- **Graph invariants** (`FS-INV-101` to `FS-INV-108`, `FS-INV-111` and `FS-INV-112`) are evaluated
  for every level and wall, except that `FS-INV-111` is not evaluated for a junction with a wall
  that has `FS-INV-107` or `FS-INV-108`: without layers there are no face lines to compare.
- **Join invariants** (`FS-INV-109`, `FS-INV-110`) and **room invariants** (`FS-INV-201` to
  `FS-INV-204`) are evaluated only for levels on which no graph invariant other than
  `FS-INV-112` was reported.
- **Opening invariants** (`FS-INV-301` to `FS-INV-304`) are evaluated for every opening, except
  that `FS-INV-303` is not evaluated for an opening whose wall has `FS-INV-112`.
- **Lints** are evaluated only for a valid document.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-CORE-10.3.1 MUST NOT}

## 10.4 Catalogue

**Parsing and document.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-JSON-001` | error | not a well-formed UTF-8 JSON text, or begins with a byte order mark | — | 9.1.1 |
| `FS-JSON-002` | error | an object has a duplicate member name | — | 9.1.2 |
| `FS-JSON-003` | error | a string has an unpaired surrogate | — | 9.1.3 |
| `FS-DOC-001` | error | the root is an object whose `floorspec` member is a string naming a version this reader does not implement | — | 1.2.2 |
| `FS-DOC-002` | error | `extensionsRequired` is an array of distinct extension names, each a member of `extensionsUsed`, and one of them names an extension this reader does not implement; one diagnostic for each such name. Any other `extensionsRequired` is left to the schema tier and `FS-INV-004` | — | 1.6.4 |
| `FS-SCH-001` | error | the document does not match the schema of this draft | — | 1.1, 1.2.1, 1.3, 1.4, 1.6.1, 1.6.7, 1.6.8, 1.8, 2.1, 2.4, 2.6 (shape), 3.1.1, 3.2.3, 4.1.1, 4.2 (syntax), 4.3.1, 5.1, 5.2, 5.8.5, 5.9.1, 6.5, 6.7.1, 7.1, 8.1, 8.3–8.6 |

**Reference invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-001` | error | an ID is used in more than one collection | the ID | 3.1.2 |
| `FS-INV-002` | error | a reference does not resolve to an element of the right collection | the referring element | 3.2.1 |
| `FS-INV-003` | error | a type reference resolves to a type of the wrong kind | the referring element | 3.2.2 |
| `FS-INV-004` | error | an `extensionsRequired` name is not in `extensionsUsed` | — | 1.6.2 |
| `FS-INV-005` | error | extension data names an extension not in `extensionsUsed` | the element, or none at top level | 1.6.3 |
| `FS-INV-006` | error | a room function names an extension not in `extensionsUsed` | the room | 4.2.1 |
| `FS-INV-007` | error | an edge's junction is on another level | the edge and the junction | 3.3.1 |
| `FS-INV-008` | error | a wall's base or top level is in another building | the wall and the level | 3.3.2 |
| `FS-INV-009` | error | an authored polygon is not simple or has no area | the slab, or none for the site boundary | 2.6.1 |

**Graph and join invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-101` | error | two junctions on a level share a position | both junctions | 5.1.1 |
| `FS-INV-102` | error | an edge starts and ends at the same junction | the edge | 5.2.1 |
| `FS-INV-103` | error | two edges connect the same two junctions | both edges | 5.2.2 |
| `FS-INV-104` | error | two edges cross | both edges | 5.3.1 |
| `FS-INV-105` | error | a junction lies inside an edge | the junction and the edge | 5.3.2 |
| `FS-INV-106` | error | two edges overlap along a segment (and are not `FS-INV-103`); an overlap always also leaves a junction inside an edge, so `FS-INV-105` accompanies it | both edges | 5.3.3 |
| `FS-INV-107` | error | a wall has no effective layers | the wall | 5.4.1 |
| `FS-INV-108` | error | a `coreFace` wall has no core layer, or its core layers are not consecutive | the wall | 5.4.2 |
| `FS-INV-109` | error | a wall's outline is not simple, has no area, or is clockwise | the wall | 5.7.2 |
| `FS-INV-110` | error | a junction fill is not simple or is clockwise | the junction | 5.7.4 |
| `FS-INV-111` | error | a join override does not apply to its junction | the junction | 5.8.1–5.8.3 |
| `FS-INV-112` | error | a wall's top is not above its base | the wall | 5.9.2 |

**Room invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-201` | error | a room's anchor is not in a bounded face | the room | 6.3.1 |
| `FS-INV-202` | error | two or more anchors are in one face | all those rooms | 6.3.2 |
| `FS-INV-203` | error | a room's face has a degenerate room polygon | the room | 6.3.3 |
| `FS-INV-204` | error | a room's anchor is not strictly inside its room polygon | the room | 6.3.4 |

`FS-INV-203` and `FS-INV-204` are evaluated only for rooms with neither `FS-INV-201` nor
`FS-INV-202`; `FS-INV-204` only for a room without `FS-INV-203`.

**Opening invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-301` | error | an opening's width or height does not resolve | the opening | 7.2.1 |
| `FS-INV-302` | error | an opening extends beyond its wall's length | the opening | 7.3.1 |
| `FS-INV-303` | error | an opening extends above its wall's height | the opening | 7.3.2 |
| `FS-INV-304` | error | two openings on one wall overlap | both openings | 7.3.3 |

`FS-INV-302`, `FS-INV-303` and `FS-INV-304` are evaluated only for openings without `FS-INV-301`.

**Lints.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-LINT-001` | warning | an acute join | the junction and both walls | 5.10 |
| `FS-LINT-002` | warning | a junction no edge uses | the junction | 5.10 |
| `FS-LINT-003` | info | a bounded face with no anchor | — (location: its level and a point of it) | 6.6 |
| `FS-LINT-004` | warning | a bounded face with no anchor whose room polygon is degenerate | — (location: its level) | 6.6 |
| `FS-LINT-005` | warning | an opening reaches into a join | the opening | 7.5 |
| `FS-LINT-006` | info | a type, material or asset nothing refers to | it | 8.7 |
| `FS-LINT-007` | warning | an asset located by `uri` | the asset | 8.7 |

## 10.5 Fix operations

A diagnostic may carry a **fix**: a list of operations that would clear it. The operations are a
provisional subset of Floorspec Ops:

| Operation | Meaning |
|---|---|
| `{ "op": "remove", "id": ID }` | remove the element |
| `{ "op": "set", "id": ID, "member": pointer, "value": v }` | set a member of the element, addressed by a JSON Pointer relative to the element |
| `{ "op": "unset", "id": ID, "member": pointer }` | remove a member of the element, so its default applies |

The reference implementation offers these fixes:

| Code | Fix |
|---|---|
| `FS-INV-108` | set `justification` to `"center"` |
| `FS-INV-111` | unset `join` |
| `FS-INV-202` | remove every room in the face except the one whose ID sorts first |
| `FS-INV-302` | set `offset` so the opening ends at the wall's end, when that offset is not negative |
| `FS-LINT-002` | remove the junction |
| `FS-LINT-006` | remove the element |

A fix is advice. A validator MAY offer a fix for any diagnostic, and an editor applies a fix only
when a person or an agent chooses to. {#FS-CORE-10.5.1 MAY}
