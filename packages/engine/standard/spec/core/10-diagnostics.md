# 10. Validation and diagnostics

## 10.1 Validity

Validation runs in tiers:

0. **Configuration** — are the known extensions the validator is configured with a valid
   registry (12.2)? (`FS-CFG-`)
1. **Parsing** — is it JSON, as 9.1 requires? (`FS-JSON-`)
2. **Document** — can this reader read it at all: its version and its required extensions? (`FS-DOC-`)
3. **Schema** — does it match the JSON Schema of the draft it declares? (`FS-SCH-`)
4. **Invariants** — the rules no schema can express: references resolve, the wall graph is planar,
   rooms, openings, hosted elements, floors, ceilings and roofs fit, the program is consistent, the
   extensions known to the validator are used as their registry entries say, and stairs rise
   between two levels of a building; a texture's maps are images and a wall's finish regions fit
   its faces; and, for a package validator, every packaged asset's file is there and is the file
   its asset names (18.4) — and, in a document with design options, no reference crosses
   options and every checked design is valid (19.5). (`FS-INV-`)
5. **Lints** — conditions that make a valid document worse. (`FS-LINT-`)

The schema is applied to the parsed document, in which a number written with a fraction or an
exponent is not an integer: `1.0` is not a length. A document that declares `"0.1"`, `"0.2"` or
`"0.3"` is checked against that draft's schema (1.2.8); every other document reaching the schema tier,
against this draft's.

A document is **valid** when the first five tiers, 0 to 4, report no error. Lints never make a document
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
| `design` | an option's ID | present only for a diagnostic found in that option's design, and not in the primary design (19.5) |

A validator MUST report each condition the catalogue lists as a diagnostic with the catalogued code, severity and elements. {#FS-CORE-10.2.1 MUST}

A condition that occurs several times is reported once for each occurrence: once for each
unresolved reference, each undeclared extension name, each pair of crossing edges, each pair of
coincident junctions, each missing or out-of-range dependency, each missing fallback part. A validator reports diagnostics sorted by code and then by `elements`, compared as sequences of
strings, and then by `design`, a diagnostic without one first. For schema violations the catalogue lists a single code, `FS-SCH-001`; validators differ
in how they break a schema violation into parts, so what is compared is only that at least one
`FS-SCH-001` is reported.

## 10.3 Order of evaluation

A tier only makes sense when the one before it passed: a dangling reference makes "is this wall
graph planar?" unanswerable. Each tier is evaluated only when every earlier tier reported no
error, with these refinements inside tier 4:

- **Configuration** (`FS-CFG-001`) is evaluated before every tier, parsing included. If it is
  reported, nothing else is evaluated.
- **Reference invariants** (`FS-INV-001` to `FS-INV-009`) are evaluated first. If any is reported,
  no other invariant is evaluated.
- **Option invariants** (`FS-INV-1101`, `FS-INV-1102`) are evaluated next, of the document as a
  whole. If any is reported, no other invariant is evaluated. Every invariant below is evaluated
  for the view of each checked design (19.5), as this section orders it; a document with no option
  set has one, the document itself.
- **Program invariants** (`FS-INV-401` to `FS-INV-403`) are evaluated for every adjacency, except
  that `FS-INV-402` and `FS-INV-403` are not evaluated for an adjacency that has `FS-INV-401`.
- **Extension invariants** (`FS-INV-601` to `FS-INV-605`) are evaluated for every extension the
  document uses at a version at which it is known (12.2).
- **Hosting invariants** (`FS-INV-501` to `FS-INV-506`) are evaluated for every extension element
  and every type, except that `FS-INV-502` is not evaluated for a host wall that has `FS-INV-112`,
  and `FS-INV-503` is evaluated only for a `surface` host whose room is on a level where room
  invariants are evaluated and has none of `FS-INV-201` to `FS-INV-204`.
- **Graph invariants** (`FS-INV-101` to `FS-INV-108` and `FS-INV-111` to `FS-INV-113`) are evaluated
  for every level and wall, except that `FS-INV-111` is not evaluated for a junction with a wall
  that has `FS-INV-107` or `FS-INV-108`: without layers there are no face lines to compare. An arc
  edge whose arc does not fit (`FS-INV-113`, evaluated for every arc edge without `FS-INV-102`) has no
  polyline (21.2), so `FS-INV-104` to `FS-INV-106` are not evaluated for it, and `FS-INV-111` is not
  evaluated for a junction it ends at.
- **Join invariants** (`FS-INV-109`, `FS-INV-110`) and **room invariants** (`FS-INV-201` to
  `FS-INV-204`) are evaluated only for levels on which no graph invariant other than
  `FS-INV-112` was reported.
- **Opening and type invariants** (`FS-INV-301` to `FS-INV-308`) are evaluated for every opening
  and every door or window type, except that `FS-INV-303` is not evaluated for an opening whose
  wall has `FS-INV-112`, and `FS-INV-302` not for one on an arc wall with `FS-INV-102` or
  `FS-INV-113`, which has no length (21.6); nor are `FS-INV-501` and `FS-INV-1002` for such a wall.
- **Floor and ceiling invariants** (`FS-INV-701` to `FS-INV-703`) are evaluated only for a room on
  a level where room invariants are evaluated, and that has none of `FS-INV-201` to `FS-INV-204`:
  they are tested on its room polygon. `FS-INV-701` is not evaluated for a room that has
  `FS-INV-702`: a vault without a ridge line has no elevation.
- **Roof invariants** (`FS-INV-801` to `FS-INV-805`) are evaluated for every roof, except that
  `FS-INV-805` is not evaluated for a roof that has `FS-INV-804`: its moved lines need not meet.
- **Stair invariants** (`FS-INV-901` to `FS-INV-906`) are evaluated for every stair, except that
  `FS-INV-902`, `FS-INV-903` and `FS-INV-906` are evaluated only for a stair without `FS-INV-901`
  whose two levels are levels where room invariants are evaluated and have no room with any of
  `FS-INV-201` to `FS-INV-204` — its rise, and so its riser count, is measured from its rooms'
  floors (17.4) — `FS-INV-903` is not evaluated for a stair that has `FS-INV-902`, and `FS-INV-906`
  is not evaluated for a stair that has `FS-INV-902` or `FS-INV-903`: the angles of its treads
  divide its turn or its sweep among the treads its riser count gives it (17.7).
- **Material and finish invariants** (`FS-INV-1001` to `FS-INV-1004`) are evaluated for every
  material and every region of every wall's finishes, except that `FS-INV-1002` and `FS-INV-1003`
  are not evaluated for a region that has `FS-INV-1001`, and `FS-INV-1002` does not test a
  region's `top` on a wall that has `FS-INV-112`.
- **Package invariants** (`FS-INV-1005` to `FS-INV-1007`) are evaluated only by a package validator
  (18.4), for every asset located by `path`, except that `FS-INV-1006` and `FS-INV-1007` are not
  evaluated for an asset that has `FS-INV-1005`.
- **Lints** are evaluated only for a valid document: `FS-LINT-006`, `FS-LINT-007` and `FS-LINT-017`
  of the document as a whole, and every other lint for the view of each checked design. The circulation lints (`FS-LINT-012` to
  `FS-LINT-014`) are evaluated only for a building that is evaluated (14.4), and `FS-LINT-012` and
  `FS-LINT-013` only for a building that has an entry (14.2).

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-CORE-10.3.1 MUST NOT}

## 10.4 Catalogue

**Parsing and document.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-CFG-001` | error | the validator's known extensions are not a valid registry: an entry does not match the registry entry schema, two entries have the same name and version, or `requires` forms a cycle | — | 12.2.1, 12.2.2 |
| `FS-JSON-001` | error | not a well-formed UTF-8 JSON text, or begins with a byte order mark | — | 9.1.1 |
| `FS-JSON-002` | error | an object has a duplicate member name | — | 9.1.2 |
| `FS-JSON-003` | error | a string has an unpaired surrogate | — | 9.1.3 |
| `FS-DOC-001` | error | the root is an object whose `floorspec` member is a string naming a version this reader does not implement | — | 1.2.2 |
| `FS-DOC-002` | error | `extensionsRequired` is an array of distinct extension names, each a member of `extensionsUsed`, and one of them names an extension this reader does not implement; one diagnostic for each such name. Any other `extensionsRequired` is left to the schema tier and `FS-INV-004` | — | 1.6.4 |
| `FS-SCH-001` | error | the document does not match the schema of the draft it declares (1.2.8) | — | 1.1, 1.2.7, 1.2.8, 1.3, 1.4, 1.6.1, 1.6.7, 1.6.8, 1.8, 2.1, 2.4, 2.6 (shape), 3.1.1, 3.1.3 (pattern), 3.2.3, 4.1.1, 4.2 (syntax), 4.3.1, 5.1, 5.2, 5.8.5, 5.9.1, 6.5, 6.7.1, 6.7.2, 7.1.1, 7.1.2, 8.1, 8.3, 8.4.1–8.4.3, 8.5, 8.6, 11.1.1, 11.1.2 (term), 12.1.1, 12.1.2, 12.5.1, 12.5.2, 13.2.1, 13.3.1, 13.5.1, 15.1.1, 15.2.1, 16.1.1, 17.1.1, 17.1.3, 17.2.1, 17.2.3, 18.1.1, 18.2.1, 18.4.1, 18.5.1, 19.1.1, 19.2.1, 21.1.1 |

**Reference invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-001` | error | an ID is used in more than one collection — counting program items and every extension collection | the ID | 3.1.2, 3.1.3 |
| `FS-INV-002` | error | a reference does not resolve to an element of the right collection | the referring element, program item or extension element; none for an adjacency | 3.2.1 |
| `FS-INV-003` | error | a type reference resolves to a type of the wrong kind | the referring element | 3.2.2 |
| `FS-INV-004` | error | an `extensionsRequired` name is not in `extensionsUsed` | — | 1.6.2 |
| `FS-INV-005` | error | extension data names an extension not in `extensionsUsed` | the element, or none at top level | 1.6.3 |
| `FS-INV-006` | error | a room's or a program item's function names an extension not in `extensionsUsed` | the room or item | 4.2.1, 11.1.2 |
| `FS-INV-007` | error | an edge's junction is on another level | the edge and the junction | 3.3.1 |
| `FS-INV-008` | error | a wall's base or top level is in another building | the wall and the level | 3.3.2 |
| `FS-INV-009` | error | an authored polygon is not simple or has no area | the slab or roof, or none for the site boundary | 2.6.1 |

**Graph and join invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-101` | error | two junctions on a level share a position | both junctions | 5.1.1 |
| `FS-INV-102` | error | an edge starts and ends at the same junction | the edge | 5.2.1 |
| `FS-INV-103` | error | two edges connect the same two junctions | both edges | 5.2.2 |
| `FS-INV-104` | error | two edges cross — or, where one is an arc edge, their location lines meet at a point interior to both | both edges | 5.3.1, 21.3.1 |
| `FS-INV-105` | error | a junction lies inside an edge — for an arc edge, in the interior of its polyline, at a vertex included | the junction and the edge | 5.3.2, 21.3.1 |
| `FS-INV-106` | error | two edges overlap along a segment (and are not `FS-INV-103`); an overlap of two straight edges always also leaves a junction inside an edge, so `FS-INV-105` accompanies it | both edges | 5.3.3, 21.3.1 |
| `FS-INV-107` | error | a wall has no effective layers | the wall | 5.4.1 |
| `FS-INV-108` | error | a `coreFace` wall has no core layer, or its core layers are not consecutive | the wall | 5.4.2 |
| `FS-INV-109` | error | a wall's outline is not simple, has no area, or is clockwise | the wall | 5.7.2, 21.4.3 |
| `FS-INV-110` | error | a junction fill is not simple or is clockwise | the junction | 5.7.4 |
| `FS-INV-111` | error | a join override does not apply to its junction | the junction | 5.8.1–5.8.3 |
| `FS-INV-112` | error | a wall's top is not above its base | the wall | 5.9.2 |
| `FS-INV-113` | error | an arc edge's arc is more than a semicircle: four times the square of its sagitta exceeds the square of its chord | the edge | 21.1.2 |

**Room invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-201` | error | a room's anchor is not in a bounded face | the room | 6.3.1 |
| `FS-INV-202` | error | two or more anchors are in one face | all those rooms | 6.3.2 |
| `FS-INV-203` | error | a room's face has a degenerate room polygon | the room | 6.3.3 |
| `FS-INV-204` | error | a room's anchor is not strictly inside its room polygon | the room | 6.3.4 |

`FS-INV-203` and `FS-INV-204` are evaluated only for rooms with neither `FS-INV-201` nor
`FS-INV-202`; `FS-INV-204` only for a room without `FS-INV-203`.

**Opening and type invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-301` | error | an opening's width or height does not resolve | the opening | 7.2.1 |
| `FS-INV-302` | error | an opening extends beyond its wall's length | the opening | 7.3.1, 21.6.2 |
| `FS-INV-303` | error | an opening extends above its wall's height | the opening | 7.3.2 |
| `FS-INV-304` | error | two openings on one wall overlap | both openings | 7.3.3 |
| `FS-INV-305` | error | an opening's effective clear opening is wider or taller than the opening | the opening | 7.2.2 |
| `FS-INV-306` | error | a clear opening's area exceeds its width times its height; once for each such clear opening, on a type or on an opening | the type or the opening | 8.4.4 |
| `FS-INV-307` | error | a door or window type's clear opening is wider or taller than the type | the type | 8.4.5 |
| `FS-INV-308` | error | an opening's own clear opening has an area, and the opening's fill is not a window type | the opening | 7.1.3 |

`FS-INV-302`, `FS-INV-303`, `FS-INV-304` and `FS-INV-305` are evaluated only for openings without
`FS-INV-301`.

**Program invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-401` | error | an adjacency relates an item to itself | the item | 11.2.1 |
| `FS-INV-402` | error | an adjacency has the pair and kind of an earlier one; once for each such adjacency | both items | 11.2.2 |
| `FS-INV-403` | error | a pair has a `"forbidden"` adjacency and a `"required"` or `"preferred"` one; once for each such pair | both items | 11.2.3 |

**Hosting invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-501` | error | a `wallFace` host's offset exceeds its wall's length | the extension element | 13.3.2, 21.6.2 |
| `FS-INV-502` | error | a `wallFace` host's height exceeds its wall's height | the extension element | 13.3.3 |
| `FS-INV-503` | error | a `surface` host's position is not strictly inside its room's polygon | the extension element | 13.3.4 |
| `FS-INV-504` | error | an extension element's fallback level is not its host's level | the extension element | 13.3.5 |
| `FS-INV-505` | error | a box — a fallback's or a clearance envelope's — has an extent of less than 1,280; once for each such box | the extension element or type | 13.2.2 |
| `FS-INV-506` | error | a fallback's `asset` or `symbol` has a media type 12.6.1 does not allow; once for each | the extension element | 12.6.1 |

**Extension invariants.** These are evaluated only for extensions known to the validator (12.2).

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-601` | error | an extension that a used, known extension requires is not used; once for each such pair | — | 12.3.2 |
| `FS-INV-602` | error | an extension that a used, known extension requires is used at a version outside the range; once for each such pair | — | 12.3.1, 12.3.3 |
| `FS-INV-603` | error | an element of a known extension lacks a fallback part its kind requires; once for each missing part | the extension element | 12.4.2 |
| `FS-INV-604` | error | a known extension's data has a collection its entry does not name; once for each | — | 12.4.1 |
| `FS-INV-605` | error | a function uses a term of a known extension that its entry does not list | the room or item | 12.4.3 |

**Floor and ceiling invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-701` | error | a room's ceiling is not above its floor: its least exact elevation over the room polygon is not greater than its floor's top | the room | 15.2.2 |
| `FS-INV-702` | error | a vaulted ceiling's two ridge points are the same point | the room | 15.3.1 |
| `FS-INV-703` | error | a tray ceiling's border does not fit its room: an edge of the centre runs backwards, or the centre is degenerate | the room | 15.4.1 |

**Roof invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-801` | error | a member name of a roof's `edges` names no edge of its footprint | the roof | 16.1.2 |
| `FS-INV-802` | error | a roof has both level edges and edges that are not level | the roof | 16.2.1 |
| `FS-INV-803` | error | every edge of a roof is a gable | the roof | 16.2.2 |
| `FS-INV-804` | error | two consecutive edges of a roof's footprint are collinear | the roof | 16.2.3 |
| `FS-INV-805` | error | a roof's eave outline does not fit its footprint: an edge of it runs backwards, or it is not simple or runs the other way | the roof | 16.3.1 |

**Stair invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-901` | error | a stair's `to` is its own `level`, or a level of another building | the stair | 17.1.2 |
| `FS-INV-902` | error | a stair's rise is not greater than zero | the stair | 17.4.1 |
| `FS-INV-903` | error | a stair's riser count does not fit its form | the stair | 17.4.2 |
| `FS-INV-904` | error | a spiral stair's width is more than half its diameter | the stair | 17.2.2 |
| `FS-INV-905` | error | a winder stair's newel is not inside the circle of its walkline, or a half-turn winder stair's gap is wider than the stair | the stair | 17.7.4 |
| `FS-INV-906` | error | a winder turns through no angle, or a spiral stair's tread through none or through 180° or more | the stair | 17.7.5 |

**Material and finish invariants.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-1001` | error | a region of a wall's finishes is empty: its `to` is not greater than its `from`, or its `top` not greater than its `bottom`; once for each such region | the wall | 18.5.2 |
| `FS-INV-1002` | error | a region extends past its wall's length or above its wall's height; once for each such region | the wall | 18.5.3, 21.6.2 |
| `FS-INV-1003` | error | two regions of one face overlap; once for each such pair | the wall | 18.5.4 |
| `FS-INV-1004` | error | a texture's map is an asset whose media type 18.2.2 does not allow; once for each such map | the material and the asset | 18.2.2 |

**Package invariants.** These are evaluated only by a package validator (18.4).

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-1005` | error | the package has no file at an asset's `path` | the asset | 18.4.2 |
| `FS-INV-1006` | error | the SHA-256 digest of an asset's file is not its `sha256` | the asset | 18.4.3 |
| `FS-INV-1007` | error | the length of an asset's file in bytes is not its `byteLength` | the asset | 18.4.3 |

**Option invariants.** Of the document as a whole, every option included (19.5).

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-INV-1101` | error | an option set's `primary` is an option of another set | the option set and the option | 19.1.2 |
| `FS-INV-1102` | error | an element refers to an element that is in an option, and is not in that option itself; once for each pair of an element and an element it refers to | both elements | 19.4.1 |

**Lints.**

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-LINT-001` | warning | an acute join | the junction and both walls | 5.10 |
| `FS-LINT-002` | warning | a junction no edge uses | the junction | 5.10 |
| `FS-LINT-003` | info | a bounded face with no anchor | — (location: its level and a point of it) | 6.6 |
| `FS-LINT-004` | warning | a bounded face with no anchor whose room polygon is degenerate | — (location: its level) | 6.6 |
| `FS-LINT-005` | warning | an opening reaches into a join | the opening | 7.5 |
| `FS-LINT-006` | info | a type, material or asset nothing refers to — a fallback's `asset` and `symbol` refer to theirs | it | 8.7 |
| `FS-LINT-007` | warning | an asset located by `uri` | the asset | 8.7 |
| `FS-LINT-008` | warning | a program item with fewer rooms than its `count` | the item | 11.5 |
| `FS-LINT-009` | warning | a room whose net area is less than its item's `minArea` | the item and the room | 11.5 |
| `FS-LINT-010` | warning | a `"required"` adjacency whose items' rooms are not adjacent; once for each adjacency | both items | 11.5 |
| `FS-LINT-011` | warning | a `"forbidden"` adjacency whose items' rooms are adjacent; once for each adjacency | both items | 11.5 |
| `FS-LINT-012` | warning | a room not reachable from an entry of its building | the room | 14.4 |
| `FS-LINT-013` | warning | a sleeping room reachable only through another sleeping room | the room | 14.4 |
| `FS-LINT-014` | warning | an evaluated building (14.4) that has rooms but no entry | the building | 14.4 |
| `FS-LINT-015` | info | a roof whose surface this draft does not derive (16.4.6) | the roof | 16.4.2 |
| `FS-LINT-016` | info | Core 0.3 only: a winder or a spiral stair, whose steps 0.3 did not derive. A reader of 0.4 does not report it | the stair | — |
| `FS-LINT-017` | info | an option set with exactly one option | the option set | 19.8 |
| `FS-LINT-018` | warning | a winder stair without a newel, or a spiral stair whose width is half its diameter: its tapered treads narrow to a point | the stair | 17.7.6 |
| `FS-LINT-019` | warning | a stair whose headroom is less than its `minHeadroom` | the stair | 17.6.4 |
| `FS-LINT-020` | info | an arc edge whose sagitta is at most 1,280: it is derived as its chord | the edge | 21.8 |

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
