# FS_structural 0.1.0

> [!warning] Draft
> FS_structural 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a
> conformance suite, and still changing. It becomes a Release Candidate when an implementation other
> than the suite's own oracle passes its suite, and Ratified only when a second, independent
> implementation does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

> [!danger] Attributes for handoff, never a structural design
> FS_structural records what someone says about a house's structure — which walls bear, how a wall
> or a floor is framed, which way a floor spans, what header is over an opening, what needs an
> engineer — so that it reaches the person who designs or checks the structure. It is **not** a
> structural design and **not** a check of one. Nothing in it sizes a member, compares a member with
> a load, a span table or a code, or says that anything is adequate (1.4). A document that is valid
> under FS_structural may describe a structure that would fail.

FS_structural adds no kind of element. Its data lives on the core elements it describes — a wall's
own `extensions.FS_structural`, an opening's, a slab's, a room's for the room's floor, a roof's
(Core §12.7, "add members to core elements"). A reader that does not implement it loses nothing
of the house: every wall, opening, slab, floor and roof is still there, as Core describes it.

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, what FS_structural is not, units |
| 2. Data on elements | members, framing, walls, openings and headers, slabs, floors and roofs, flags for a professional |
| 3. Spans | the direction a floor spans, its extent and its span |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | levels, spans, what needs a professional |
| 6. Editing | Ops, and what an editor does before it removes a bearing wall |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-STRC-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_structural/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_structural` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_structural/extension.json` |
| Schema | `registry/FS_structural/structural.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_structural/0.1.0/structural.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: its data is on core elements (1.3) |
| Statement IDs | `FS-STRC-` |
| Diagnostic codes | `FS-STRC-SCH-`, `FS-STRC-INV-`, `FS-STRC-LINT-` |

## 1.2 Conformance

FS_structural places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_structural 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_structural (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_structural 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_structural at a version at which FS_structural is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-STRC-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_structural's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-STRC-INV-`) when it reported `FS-STRC-SCH-001`, and MUST NOT evaluate its lints (`FS-STRC-LINT-`) unless the document is valid. {#FS-STRC-1.2.2 MUST NOT}
FS_structural's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-STRC-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are.

A validator that implements FS_structural MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-STRC-1.2.3 MUST}

A deriver that implements FS_structural MUST derive the values of chapter 5 for every valid document for which FS_structural was evaluated, and MUST NOT derive them for any other document. {#FS-STRC-1.2.4 MUST}

A reader that does not implement FS_structural, or does not know this version, ignores its data
(Core §1.6.9), and a writer preserves it (Core §1.6.6).

## 1.3 Data

FS_structural's **top-level data**, `extensions.FS_structural`, is an object with no members in
this version. A document that uses FS_structural usually has none: what FS_structural says is on
the elements it says it about.

FS_structural's top-level data MUST match the schema `structural.schema.json` of this version. {#FS-STRC-1.3.1 MUST}

**Data on an element** is the element's own `extensions.FS_structural` (Core §1.6). FS_structural
defines it for five collections, and the schema's `#/$defs/coreElements` names them: an element of
collection `C` carries data that the schema accepts as the object `{ "C": data }` checked against
`#/$defs/coreElements`.

| Collection | Its data | Section |
|---|---|---|
| `walls` | bearing and shear flags, framing | 2.3 |
| `openings` | a header | 2.4 |
| `slabs` | framing and a span | 2.5 |
| `rooms` | the framing and span of the room's floor | 2.5 |
| `roofs` (Core 0.3) | framing | 2.5 |

Every one of them may also carry the flags of 2.6.

FS_structural's data on a wall, an opening, a slab, a room or a roof MUST match the member of the schema's `#/$defs/coreElements` for that element's collection. {#FS-STRC-1.3.2 MUST}

The `extensions` of any other element — a level, a junction, a separator, a type, a material, an asset, a stair, a program item, an option set or an option — MUST NOT have a member `FS_structural`. {#FS-STRC-1.3.3 MUST NOT}

A document that breaks 1.3.1, 1.3.2 or 1.3.3 gets `FS-STRC-SCH-001`, once: all three are the
schema tier. An element's data is checked whether or not the document has top-level data.

## 1.4 What FS_structural is not

FS_structural is the record that a house's structure needs a person to design or confirm it, and
what that person needs to know. Sizing a joist, a header or a beam needs loads, species and grades,
deflection limits, a span table or a calculation, and the judgement of someone licensed to make
it. None of that is here, and none of it is implied by anything that is.

A validator that implements FS_structural MUST NOT report a diagnostic that depends on a load, on a member's strength or stiffness, on a span table or on a code: whether a member could carry what is on it is no condition of chapter 4, and a document is valid or invalid under FS_structural regardless of it. {#FS-STRC-1.4.1 MUST NOT}

Software that implements FS_structural MUST NOT present its data, a value it derives from it, or the absence of a diagnostic as a statement that a structure, a member, a header or a span is adequate, safe, correctly sized, compliant with a code, or approved by an engineer. {#FS-STRC-1.4.2 MUST NOT}
The suite can test what a validator reports and what a deriver derives, and it does: a house
framed with members no engineer would accept is valid and derives only chapter 5's values. What an
application shows its user around them is a review matter.

What a jurisdiction asks of a structure is a rule's to state, in a Floorspec Rules pack that cites
its source, and a rule advises (FLR-ADR-011). The lints of 4.3 are geometric: a header that does not
fit in its wall, a span longer than the floor it spans. They say that the record is inconsistent
with the house, never that the structure is wrong.

## 1.5 Units

Every dimension is a Core length (Core §2.1): an integer number of 1/1280 mm. A spacing is a length
measured on centre. A direction is a vector of two integers in its level's plan coordinates (Core
§2.3). Nothing in FS_structural is a fraction, and the one value it derives that is not an exact
integer, a span's extent (3.2), is rounded once.

# 2. Data on elements

## 2.1 Members

A **member** describes one piece of a framing or a header: its section.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `designation` | string, 1–40 characters | absent | what the trade calls it: `"2x6"`, `"1-3/4 x 11-7/8 LVL"`, `"W8x10"` |
| `width` | length, 1 to 1,280,000 (1 m) | — (always present) | its actual dimension across its narrow face |
| `depth` | length, 1 to 1,280,000 (1 m) | — (always present) | its actual dimension in the direction it carries load: across the wall for a stud, vertical for a joist, a rafter or a header |

A `designation` is a label: no implementation reads a dimension from it, and it never changes what
a member means. A nominal 2x6 is written with its actual dimensions — 1½" by 5½", `width` 48768 and
`depth` 178816 — and its designation:

```json
{ "designation": "2x6", "width": 48768, "depth": 178816 }
```

## 2.2 Framing

A **framing** says how an assembly is built.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `material` | `"wood"`, `"engineeredWood"`, `"coldFormedSteel"`, `"structuralSteel"`, `"concrete"`, `"concreteMasonry"`, `"masonry"` or `"other"` | — (always present) | what its members, or the solid assembly, are made of |
| `system` | a system of the table below | — (always present) | how it is built |
| `member` | member (2.1) | absent: not stated | the section of each of its members |
| `spacing` | length, 1 to 6,400,000 (5 m) | absent: not stated | the distance from one member's centre to the next |

| Where | Systems |
|---|---|
| a wall | `"studs"`, `"solid"`, `"panels"` |
| a floor — a slab's, or a room's | `"joists"`, `"trusses"`, `"solid"`, `"panels"` |
| a roof | `"rafters"`, `"trusses"`, `"solid"`, `"panels"` |

Studs, joists, rafters and trusses are **member systems**: repeated members at a spacing. A
`"solid"` assembly — a concrete wall or slab, a masonry wall — and `"panels"` — structural
insulated panels, cross-laminated timber — have no repeated members.

A framing whose `system` is `"solid"` or `"panels"` MUST NOT have a `member` or a `spacing`. {#FS-STRC-2.2.1 MUST NOT}

A framing's `spacing` MUST NOT be less than its `member`'s `width`: members on centres closer than they are wide would overlap. {#FS-STRC-2.2.2 MUST NOT}
A spacing equal to the width — members side by side — is a solid, built-up assembly, and is allowed.

A framing whose `material` is `"concrete"`, `"concreteMasonry"` or `"masonry"` MUST NOT have a member system. {#FS-STRC-2.2.3 MUST NOT}

## 2.3 Walls

FS_structural's data on a wall:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `bearing` | boolean | absent: not stated | `true` when the wall carries vertical load from above — a floor, a roof, a wall — besides its own weight; `false` when it does not |
| `shear` | boolean | absent: not stated | `true` when the wall is part of the lateral system that resists wind and earthquakes; `false` when it is not |
| `framing` | framing (2.2) | absent: not stated | how the wall is built |
| `needsEngineer`, `note` | 2.6 | absent | |

```json
"W1": {
  "level": "L1", "start": "J1", "end": "J2", "type": "EXT",
  "extensions": { "FS_structural": {
    "bearing": true, "shear": true,
    "framing": { "material": "wood", "system": "studs",
                 "member": { "designation": "2x6", "width": 48768, "depth": 178816 }, "spacing": 520192 }
  } }
}
```

Absent and `false` are different statements: absent says nothing, `false` says the wall carries no
load. Whoever reads the record — an engineer, a needs-a-professional report — treats a wall whose
`bearing` is absent as unknown, never as non-bearing.

A writer that records `bearing` for any wall of a level SHOULD record it for every wall of that level. {#FS-STRC-2.3.1 SHOULD}

## 2.4 Openings and headers

A **header** is the member over an opening that carries what is above it to the wall on either
side. FS_structural's data on an opening:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `header` | header | absent: not stated | the opening's header |
| `needsEngineer`, `note` | 2.6 | absent | |

A **header**:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `material` | as a framing's (2.2) | — (always present) | what it is made of |
| `member` | member (2.1) | — (always present) | the section of each ply |
| `plies` | integer, 1 to 8 | `1` | how many members, side by side, make it |

A header's **width** is `plies` times its member's `width`; its depth is its member's `depth`. It
sits in the wall, directly above the opening's head (Core §7.4).

A writer SHOULD record a header for every opening in a wall whose `bearing` is `true`. {#FS-STRC-2.4.1 SHOULD}
An opening in a bearing wall with no header gets the lint `FS-STRC-LINT-001`.

## 2.5 Slabs, floors and roofs

FS_structural's data on a slab, and on a room for the room's floor (Core §15.1):

| On | Member | Type | Default | Meaning |
|---|---|---|---|---|
| a slab | `framing` | framing (2.2) | absent: not stated | how the slab or deck is built |
| a slab | `span` | span (3.1) | absent: not stated | the direction its members span |
| a room | `floor` | `{ "framing"?: framing, "span"?: span }` | absent: not stated | the framing and span of the room's floor |

A room's floor framing is the structure under that room: the joists of an upper floor, or a
slab-on-grade (`"concrete"`, `"solid"`). A slab here is Core's (§6.7, §15.7): a deck, a porch, a
landing, an equipment pad.

FS_structural's data on a roof (Core 0.3, chapter 16) is its `framing`, of the roof systems of
2.2: rafters, trusses, a solid roof or panels.

## 2.6 Flags for a professional

Every element that carries FS_structural data may also carry:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `needsEngineer` | boolean | absent: not stated | `true` when the writer flags the element for a licensed professional — an engineer or an architect — to design or confirm |
| `note` | string, 1–2000 characters | absent | a note for whoever designs or checks it |

A needs-a-professional report (FLR-REQ-103) is built from these flags, from the bearing walls and
from the openings in them (chapter 5). The flag is a request for a professional's judgement, never
a record of one: FS_structural has no member that says an engineer approved anything.

# 3. Spans

## 3.1 The direction a floor spans

A **span** says which way a floor's members run between their supports.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `[x, y]`, two integers | — (always present) | a vector in the level's plan coordinates along which the members span; its length does not matter |
| `length` | length | absent | the clear span between supports, when the writer records it |

A span's `direction` MUST NOT be `[0, 0]`. {#FS-STRC-3.1.1 MUST NOT}

## 3.2 Extent and span

The **extent** of a span is how far the floor it belongs to reaches along its direction: for every
vertex `p` of the floor's outline, the projection `p · d` on the direction `d`, and the extent is

```text
extent = (max p·d − min p·d) / |d|
```

where `|d|` is `√(x² + y²)`. The outline is a slab's `boundary`, and a room's room polygon as Core
derives it, its rounded vertices (Core §6.2) — its outer ring. For a rectangular room spanned from
wall to wall, the extent is the clear distance between the faces of the two walls: the span of its
joists, if those walls are what bears them.

A deriver MUST compute a span's extent exactly and round it once, with `round()` (nearest integer, ties to even, Core §2.2). {#FS-STRC-3.2.1 MUST}

A span's **span** is its `length` when the writer recorded one, and otherwise its extent. A
recorded `length` longer than the extent cannot be a clear span of that floor along that direction,
and gets the lint `FS-STRC-LINT-005`.

FS_structural 0.1 does not model supports — beams, posts, girders — so the extent of a floor that
has a beam across it is the whole floor's. Recording the `length` says what it really is.

# 4. Diagnostics

## 4.1 Codes

FS_structural's diagnostic codes are `FS-STRC-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other
way. A framing's diagnostic names the element that carries it — the room, for a room's floor.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-STRC-SCH-001` | error | the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_structural data does | — | 1.3.1, 1.3.2, 1.3.3 |
| `FS-STRC-INV-001` | error | a solid or panel framing has a member or a spacing | the element | 2.2.1 |
| `FS-STRC-INV-002` | error | a framing's spacing is less than its member's width | the element | 2.2.2 |
| `FS-STRC-INV-003` | error | a framing of concrete, concrete masonry or masonry has a member system | the element | 2.2.3 |
| `FS-STRC-INV-004` | error | a span's direction is `[0, 0]` | the element | 3.1.1 |

`FS-STRC-INV-002` is evaluated only for a framing without `FS-STRC-INV-001` or `FS-STRC-INV-003`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-STRC-4.2.1 MUST NOT}

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-STRC-LINT-001` | warning | an opening in a wall whose `bearing` is `true` has no header (2.4) | the opening and the wall |
| `FS-STRC-LINT-002` | warning | a header is wider than its wall is thick (2.4) | the opening and the wall |
| `FS-STRC-LINT-003` | warning | a wall's studs are deeper than the wall is thick | the wall |
| `FS-STRC-LINT-004` | warning | a header does not fit between its opening's head and its wall's top: its depth is more than the wall's top elevation minus its opening's head elevation (Core §5.9, §7.4) | the opening and the wall |
| `FS-STRC-LINT-005` | warning | a span's recorded `length` is longer than its extent (3.2) | the element |
| `FS-STRC-LINT-006` | info | a wall whose `bearing` is `true` has no framing | the wall |

A wall's thickness is Core's: the sum of its effective layers' thicknesses (Core §5.2, §8.3). Lints
never make a document invalid, and none says whether a structure is adequate or meets a code
(1.4).

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_structural was evaluated, a deriver derives the object below as
the member `FS_structural` of the derived values' `extensions`. Every list of IDs is sorted.

```json
{
  "levels": {
    "L1": { "bearing": ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"], "shear": ["W1", "W2", "W4"],
            "openings": ["O1", "O2", "O4"] }
  },
  "spans": {
    "R1": { "direction": [1, 0], "extent": 4502912, "span": 4502912 },
    "S1": { "direction": [0, 1], "extent": 2731008, "span": 2340864 }
  },
  "needsEngineer": ["O2"]
}
```

That is the suite's framed house (`examples/001-p10-framed-house`): the Kitchen's joists span the
clear 3517.9 mm between its west wall and the interior bearing line, and the deck's recorded 6'
stands for its 7' extent.

A deriver MUST derive these values exactly as this chapter defines. {#FS-STRC-5.1.1 MUST}

- `levels` has a member for every level: `bearing`, the walls on it whose `bearing` is `true`;
  `shear`, those whose `shear` is `true`; and `openings`, the openings in its walls whose `bearing`
  is `true`, with a header or without.
- `spans` has a member for every slab that has a `span` and every room whose `floor` has one:
  its `direction` as recorded, its `extent` (3.2), and its `span` — its `length`, or its extent.
- `needsEngineer` is every element whose FS_structural data has `needsEngineer` `true`.

These are what a needs-a-professional report (FLR-T-6.10), a framing schedule, and an engineer's
first look at a house are built from. None of them is a verdict (1.4).

# 6. Editing

## 6.1 Editing FS_structural's data

Floorspec Ops edits FS_structural's data as it edits any member of an element: `setProperty` and
`unsetProperty` with a path under `/extensions/FS_structural/` (Ops §2.3). An applier that
implements FS_structural and knows it rejects a batch whose result breaks an invariant of chapter 4
(Ops §1.2.3).

Ops never judges a structure: removing a bearing wall, moving one, or cutting an opening into one
commits like any other edit. That is the moment the record exists for.

Software that removes or moves a wall whose `bearing` is `true`, or adds an opening to one, SHOULD warn its user that the change needs a professional, or flag what it changed with `needsEngineer`. {#FS-STRC-6.1.1 SHOULD}

# 7. Related

## 7.1 Related

FLR-T-10.6, FLR-REQ-141 (bearing flags, framing and spans on core elements), FLR-REQ-092 (Release
Candidate until a second independent implementation), FLR-REQ-103 and FLR-T-6.10 (the
needs-a-professional report, which reads chapter 5), FLR-ADR-001 (building systems are `FS_`
extensions), FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise; findings never say
"compliant"), FLR-ADR-025 (the conventions every official extension follows). Floorspec Core 0.2
and 0.3: §1.6 and chapter 12 (extension data on core elements), §5.2 and §5.9 (walls), chapter 7
(openings), §6.2 (room polygons), chapter 15 (floors and slabs), chapter 16 (roofs).
