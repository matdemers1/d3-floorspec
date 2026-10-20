# FS_context 0.1.0

> [!warning] Draft
> FS_context 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_context describes what surrounds a house and is not part of it: the **street** in front of the
lot, with its curbs, planting strips and sidewalks; the **neighbours** on the lots beside and behind
it, as simple massing — a footprint, an eave height and a roof; and the **trees** beyond the lot.
A design is judged against its context — how close the neighbour's wall is, what the street sees,
where the afternoon shade falls — and never includes it.

Context is never part of the design. Its records are not elements: nothing Core derives counts them —
no quantity, no schedule, no area, no circulation — no rule evaluates them, and a reader draws them
in a style of their own, so that a street and a neighbour never read as something to be built.

This extension describes a design's surroundings as its writer saw them: a neighbour's height and
roof are a sketch, never a survey, and nothing here says that a house is far enough from them. A
finding about a code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units, never the design |
| 2. Streets | the centreline, the carriageway, curbs, strips and sidewalks |
| 3. Neighbours | the footprint, the eaves and the roof |
| 4. Trees | |
| 5. Beyond the lot | the lot, a lint |
| 6. Drawing and generating | informative: the context style, shade, generating context from a street side |
| 7. Diagnostics | codes, the catalogue, lints |
| 8. Derived values | streets, neighbours, trees |
| 9. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-CTXT-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_context/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_context` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_context/extension.json` |
| Schema | `registry/FS_context/context.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_context/0.1.0/context.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: FS_context adds no kind of element |
| Statement IDs | `FS-CTXT-` |
| Diagnostic codes | `FS-CTXT-SCH-`, `FS-CTXT-INV-`, `FS-CTXT-LINT-` |

## 1.2 Conformance

FS_context places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_context 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_context (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_context 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_context at a version at which FS_context is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-CTXT-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_context's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-CTXT-INV-`) when it reported `FS-CTXT-SCH-001`, and MUST NOT evaluate its lints (`FS-CTXT-LINT-`) unless the document is valid. {#FS-CTXT-1.2.2 MUST NOT}
FS_context's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-CTXT-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. Context belongs to the document, not to a
design: a document with design options (Core chapter 19) has the same context in every design.

FS_context requires no other extension. It reads FS_site's survey and pads, FS_lighting's scenes,
FS_views's views and FS_annotation's dimension strings and notes as data, to check an ID (1.3),
without implementing or knowing any of them.

A validator that implements FS_context MUST report each condition of chapter 7 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-CTXT-1.2.3 MUST}

A deriver that implements FS_context MUST derive the values of chapter 8 for every valid document for which FS_context was evaluated, and MUST NOT derive them for any other document. {#FS-CTXT-1.2.4 MUST}

A reader that does not implement FS_context, or does not know this version, reads a document that
uses it as Core §1.6.9 says. FS_context has no elements, so it finds nothing of FS_context's to
draw — which is right for context, since it is never the design. A writer keeps FS_context's data as
it is (Core §1.6.6).

## 1.3 Data

FS_context's top-level data, `extensions.FS_context`, is an object with three members, each
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `streets` | object: ID → street | `{}` | the streets (chapter 2) |
| `neighbours` | object: ID → neighbour | `{}` | the neighbouring buildings, as massing (chapter 3) |
| `trees` | object: ID → tree | `{}` | the trees beyond the lot (chapter 4) |

```json
"FS_context": {
  "streets": {
    "ST1": { "name": "Garden Lane", "points": [[-23408640, -25164288], [27310080, -25164288]],
             "width": 11704320, "strip": 1560576, "sidewalk": 1950720 }
  },
  "neighbours": {
    "NB1": { "name": "Neighbour, west", "elevation": -1560576,
             "boundary": [[-25359360, -5852160], [-13655040, -5852160], [-13655040, 7802880], [-25359360, 7802880]],
             "height": 3901440, "roof": "gable", "rise": 2340864 }
  },
  "trees": {
    "TR1": { "at": [0, 17556480], "height": 15605760, "spread": 11704320 }
  }
}
```

FS_context's top-level data MUST match the schema `context.schema.json` of this version. {#FS-CTXT-1.3.1 MUST}

A street, a neighbour and a tree — together, FS_context's **records** — are not elements: they have
no fallback, no host and no place in a building. But their IDs are in the document's one space of
IDs (Core §3.1.3), as FS_site's survey's are, so that a diagnostic can name one among its elements
without ambiguity.

A record's ID MUST NOT be the ID of an element, a program item or an extension element, nor of a scene in `extensions.FS_lighting.scenes`, a view in `extensions.FS_views.views`, a dimension string or note in `extensions.FS_annotation.dimensions` or `.notes`, or a spot, contour line or pad in `extensions.FS_site.spots`, `.contours` or `.pads`; and no two of FS_context's records — a street, a neighbour, a tree — may have one ID. {#FS-CTXT-1.3.2 MUST NOT}
Those members of the other extensions are read as data, as they are, whether or not their extensions
are used, known or implemented: an object's members are IDs, and anything else names none.

## 1.4 Units

Every coordinate, width and height is a Core length (Core §2.1): an integer number of 1/1280 mm. A
point is two lengths, `[x, y]`, in plan coordinates (Core §2.3) — FS_context's data is never in a
frame of an element. An **elevation** is a height above project zero, as a level's `elevation` is
(Core §1.8): a neighbour standing on ground 2′ below the first floor has an `elevation` of −780,288.
An area is in square base units, written as Core writes a room's area (Core §2.5).

## 1.5 Never the design

Context is what a design is seen against, and never part of it.

A context record MUST NOT be counted in any value Core derives, or any other extension derives — a level's or a room's area, a quantity, a schedule, a circulation, a renovation's states — and a validator MUST NOT evaluate any of Core's invariants or lints, or another extension's, for one. {#FS-CTXT-1.5.1 MUST NOT}
A document's derived values outside `extensions.FS_context` are the same with its context and
without it. A rule of a Floorspec Rules pack reads elements, and so never sees context either: a
neighbour is never too near, and a street is never a finding. A reader that exports quantities, a
bill of materials or a schedule leaves context out of it; a reader that exports a drawing or a model
may include context, on a layer of its own that says it is context (6.1).

# 2. Streets

## 2.1 The street

A **street** (`streets`) is a road and its edges, drawn along its **centreline**, symmetric about it:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `points` | array of 2 to 4,096 points | — (always present) | the centreline's vertices, in order |
| `width` | length, at least 1 | — (always present) | the **carriageway**: the paved road, curb face to curb face |
| `curb` | length, at least 0 | `195072` (6″) | each curb's width, beyond the carriageway on each side |
| `curbHeight` | length, at least 0 | `195072` (6″) | each curb's height above the carriageway |
| `strip` | length, at least 0 | `0` | each planting strip's width — the verge between the curb and the sidewalk |
| `sidewalk` | length, at least 0 | `0` | each sidewalk's width, beyond the strip |
| `elevation` | length | `0` | the carriageway's elevation (1.4) |
| `name` | string, 1–200 characters | absent | what it is called: "Laurel Ridge Drive" |
| `extras` | object | `{}` | as Core §1.7 |

Across the street, from its centreline outwards on each side, are half the carriageway, the curb, the
strip and the sidewalk: the street's **overall width** is `width + 2 × (curb + strip + sidewalk)`. A
street with a strip or a sidewalk of `0` has none. The curb, strip and sidewalk are at the
carriageway's elevation plus `curbHeight`.

Two consecutive points of a street's `points` MUST NOT be equal. {#FS-CTXT-2.1.1 MUST NOT}

A street is drawn with its ends square to its centreline and its corners mitred; it is a band, not an
area that can be measured, and FS_context derives its length and its overall width and nothing else.

# 3. Neighbours

## 3.1 The massing

A **neighbour** (`neighbours`) is a building that is not the design — the house next door, a garage
across the street — as **massing**: a footprint extruded to its eaves and capped by a simple roof.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `boundary` | polygon (Core §2.6) | — (always present) | its footprint, in plan |
| `height` | length, at least 1 | — (always present) | its eaves above its ground |
| `roof` | `"flat"`, `"gable"` or `"hip"` | `"flat"` | the roof's form (3.2) |
| `rise` | length, at least 0 | `0` | the roof's ridge above the eaves |
| `elevation` | length | `0` | its ground: the elevation of the bottom of its walls (1.4) |
| `name` | string, 1–200 characters | absent | what it is called: "No. 12", "Neighbour, east" |
| `extras` | object | `{}` | as Core §1.7 |

A neighbour's `boundary` MUST be a simple polygon enclosing a positive area, as Core §2.6 asks of every polygon. {#FS-CTXT-3.1.1 MUST}

The neighbour's **eaves** are at `elevation + height`, and its **ridge** at `elevation + height +
rise`. Massing is a sketch: a neighbour has no rooms, no openings and no materials.

## 3.2 The roof

A **flat** roof is the footprint at its ridge: flat-roofed massing is a box from its ground to its
ridge, and with a `rise` of `0` its ridge is its eaves. A **gable** roof has one ridge, along the
footprint's longer sides, halfway between them, from one short side to the other, and two planes
from it down to the eaves of the longer sides; the short sides are gable ends. A **hip** roof has the
same ridge shortened at each end by half the shorter side, so that four planes rise at one pitch from
every eave — a square footprint's hip roof is a pyramid. When the sides are equal, the ridge of a
gable runs along the footprint's first edge, from vertex 0 to vertex 1.

A neighbour whose `roof` is `"gable"` or `"hip"` MUST have a `boundary` that is a rectangle: four vertices, each corner a right angle. {#FS-CTXT-3.2.1 MUST}
The corners are tested exactly, in integers: at each vertex, the edges in and out of it have a dot
product of `0`. A building whose roof is not a gable or a hip on a rectangle is drawn as flat-roofed
massing, or as more than one neighbour.

# 4. Trees

A **tree** (`trees`) is a tree beyond the lot, drawn as a trunk and a crown:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `at` | point | — (always present) | where its trunk stands, in plan |
| `height` | length, at least 1 | — (always present) | the top of its crown above its ground |
| `spread` | length, at least 1 | — (always present) | its crown's diameter |
| `form` | `"deciduous"` or `"evergreen"` | `"deciduous"` | whether it loses its leaves in winter |
| `elevation` | length | `0` | its ground (1.4) |
| `name` | string, 1–200 characters | absent | what it is called |
| `extras` | object | `{}` | as Core §1.7 |

A tree of the design — one the design plants or keeps, on the lot — is an FS_landscape plant, not
context. A tree beyond the lot has no species: it is there to be seen past and to cast shade.

# 5. Beyond the lot

## 5.1 The lot

The **lot** is the site's `boundary` (Core §1.8): a simple polygon in plan coordinates. A document
without a site, or with a site without a boundary, has no lot.

## 5.2 Context is beyond the lot

Context is what surrounds a lot. A record **stands in the lot** when one of its points is inside
the lot and not on its boundary: a street's centreline vertex, a neighbour's footprint vertex, a
tree's `at`. The test is exact, in integers (Core §2.6).

A document SHOULD keep every street, neighbour and tree beyond its lot, or on its boundary. {#FS-CTXT-5.2.1 SHOULD}
A record that is not is reported by `FS-CTXT-LINT-001`, an `info` lint: a tree the design keeps
belongs to FS_landscape, and a building on the lot to the design. A street's carriageway, curbs and
sidewalks may still reach over the lot line: only the centreline is tested.

# 6. Drawing and generating

This chapter is informative, but for its one statement.

## 6.1 The context style

A reader draws context in **one neutral style** of its own, distinct from the design's in plan and
in 3D, so that it never reads as something to be built: thin grey outlines, neutral grey massing,
no materials and no colour-plan fills, with a tag that says what it is — in D3 Floorspec, "Context ·
not counted". A viewer lets a person show context, ghost it or hide it; the choice is the viewer's
and is not stored.

A reader that draws context SHOULD draw it in a style that tells it from the design by more than colour alone — a line weight, a dash, a tag — and SHOULD NOT give it the design's materials. {#FS-CTXT-6.1.1 SHOULD}

In plan, a street is drawn as its carriageway between its curb lines, with its strips and sidewalks
beyond, and its name along it; a neighbour as its footprint, hatched or tinted, with its ridge; a tree
as its crown's circle. In 3D, a street's carriageway is at its elevation, its curbs, strips and
sidewalks raised by `curbHeight`; a neighbour is its footprint extruded from its ground to its eaves,
with its roof; a tree is a trunk and a crown, a deciduous one bare in a winter view.

## 6.2 Shade

Context is real in the light. A reader that studies sun and shade — a sun study, a daylight
analysis, a render — lets context cast shade on the design, as the neighbour's house and the street
trees will; a reader may offer to leave it out of a study, and says so when it does.

## 6.3 Generating context

A reader may generate context rather than have a person draw it, and writes what it generates as
FS_context's records, like any other. D3 Floorspec generates it from FS_site's setbacks (FS_site
§2.2): along each street edge of the lot, a street whose centreline is the edge moved out by half
its carriageway and its curb, strip and sidewalk, so that the sidewalk's back is the lot line; on the
lots beside and behind, a neighbour massing at the lot's own side and rear setbacks from their
shared lines, one or two storeys with a gable or a hip roof; and trees beyond the rear and sides.
Its choices are seeded, so the same lot and the same seed generate the same context every time, and
the person can regenerate it, move a record, resize it or delete it.

# 7. Diagnostics

## 7.1 Codes

FS_context's diagnostic codes are `FS-CTXT-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted; a record is named by its ID.

## 7.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-CTXT-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-CTXT-INV-001` | error | a record's ID is the ID of an element, a program item or an extension element, of a scene, a view, a dimension string or a note, or of a spot, a contour line or a pad (1.3), or of another of FS_context's records | the record | 1.3.2 |
| `FS-CTXT-INV-002` | error | a street with two equal consecutive points | the street | 2.1.1 |
| `FS-CTXT-INV-003` | error | a neighbour's `boundary` that is not a simple polygon enclosing a positive area | the neighbour | 3.1.1 |
| `FS-CTXT-INV-004` | error | a neighbour with a gable or a hip roof whose `boundary` is not a rectangle | the neighbour | 3.2.1 |

`FS-CTXT-INV-001` is reported once for each ID that breaks 1.3.2, however many records have it.
Every other invariant is reported once for each record that breaks it. A neighbour whose `boundary`
breaks 3.1.1 is not also tested for 3.2.1.

## 7.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-CTXT-LINT-001` | info | the document has a lot, and a street, a neighbour or a tree stands in it (5.2.1) | the record |

Lints never make a document invalid.

# 8. Derived values

## 8.1 Derivation

For a valid document for which FS_context was evaluated, a deriver derives the object below as the
member `FS_context` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every object's members are in ID order. The example is the conformance
suite's garden on its street (`examples/…-p15-garden-on-its-street`): a street 130′ long and 49′
overall, a one-storey gabled neighbour on ground 4′ below the floor with its eaves 6′ above it, and a
tree 40′ tall.

```json
{
  "streets": {
    "ST1": { "length": 50718720, "width": 19117056 }
  },
  "neighbours": {
    "NB1": { "roof": "gable", "area": "159822957772800", "eaves": 2340864, "ridge": 4681728 },
    "NB2": { "roof": "hip", "area": "136991106662400", "eaves": 6242304, "ridge": 8193024 },
    "NB3": { "roof": "flat", "area": "121769872588800", "eaves": 2340864, "ridge": 2340864 }
  },
  "trees": {
    "TR1": { "form": "deciduous", "top": 15605760 },
    "TR2": { "form": "evergreen", "top": 12484608 }
  }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-CTXT-8.1.1 MUST}

## 8.2 Streets

`streets` has a member for every street, by its ID: its `length`, the sum of its centreline's
segments' lengths, each rounded once (Core §2.2); and its `width`, the overall width (2.1).

## 8.3 Neighbours

`neighbours` has a member for every neighbour, by its ID: its `roof`, with its default; the `area`
of its footprint by the shoelace formula, written as Core writes an area; and its `eaves` and
`ridge` (3.1), elevations.

## 8.4 Trees

`trees` has a member for every tree, by its ID: its `form`, with its default, and its `top`, the
elevation of its crown's top: `elevation + height`.

These are what an agent reads to answer "how tall is the house next door?" or "how wide is the
street?" without drawing anything — and nothing else derived changes with them (1.5).

# 9. Related

## 9.1 Related

FLR-T-15.3 (context: the street, curb and sidewalk, neighbouring houses as simple massing, and trees
beyond the lot), FLR-ADR-064 (FS_context: records, never elements; generated from FS_site's street
edges and setbacks; one neutral context style that casts shade), FLR-ADR-060 (FS_site: the lot, its
street edges and setbacks), FLR-ADR-011 (advisory, never "compliant"), FLR-ADR-001 (a tiny core;
what surrounds a house is an `FS_` extension), FLR-ADR-007 (the extension model), FLR-ADR-025 (the
conventions of the official extensions), FLR-REQ-092 (Release Candidate until a second independent
implementation). Floorspec Core 0.2, 0.3 and 0.4 chapters 1.8 (the site), 2, 3.1 (the one space of
IDs), 12 and 19 (design options).
