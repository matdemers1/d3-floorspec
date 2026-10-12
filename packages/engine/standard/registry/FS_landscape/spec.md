# FS_landscape 0.1.0

> [!warning] Draft
> FS_landscape 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a
> conformance suite, and still changing. It becomes a Release Candidate when an implementation other
> than the suite's own oracle passes its suite, and Ratified only when a second, independent
> implementation does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_landscape describes what is planted and laid around a house: **plants** — trees, shrubs,
ornamental grasses and groundcover, each at a point, by its mature size and never by its species —
**beds** and **lawns**, each an outline on the ground, and **hardscape**: the paths, stepping stones,
curbs and garden walls drawn as a line with a width. Every one is an extension element (Core §12.5)
with a box, so a reader without FS_landscape still shows that something stands there; it is placed
on a level's ground, or on the floor of an outdoor room — a roof deck's planters — and a plant moves
with its host.

A paved area is a Core slab, a patio or a walkway (Core §6.7): FS_landscape never describes one
again. A plant's species, where it has one, is a label: nothing here reads it, and nothing here
judges whether a plant suits a place, a climate or a code.

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Elements | plants and their size classes, beds, lawns, hardscape |
| 3. Placement and geometry | the ground, hosts, the box, outlines and lines in an element's frame |
| 4. Drawing | informative: what a reader that implements FS_landscape draws |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | plants, beds, lawns, hardscape |
| 7. The starter sizes | informative |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-LAND-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_landscape/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_landscape` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_landscape/extension.json` |
| Schema | `registry/FS_landscape/landscape.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_landscape/0.1.0/landscape.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `plants`, `beds`, `lawns`, `hardscape` (none requires an asset or a symbol, 4.1) |
| Statement IDs | `FS-LAND-` |
| Diagnostic codes | `FS-LAND-SCH-`, `FS-LAND-INV-`, `FS-LAND-LINT-` |

## 1.2 Conformance

FS_landscape places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_landscape 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_landscape (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_landscape 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_landscape at a version at which FS_landscape is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-LAND-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_landscape's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-LAND-INV-`) when it reported `FS-LAND-SCH-001`, and MUST NOT evaluate its lints (`FS-LAND-LINT-`) unless the document is valid. {#FS-LAND-1.2.2 MUST NOT}
FS_landscape's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-LAND-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are.

A validator that implements FS_landscape MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-LAND-1.2.3 MUST}

A deriver that implements FS_landscape MUST derive the values of chapter 6 for every valid document for which FS_landscape was evaluated, and MUST NOT derive them for any other document. {#FS-LAND-1.2.4 MUST}

A reader that does not implement FS_landscape, or does not know this version, reads its elements
as Core §1.6.9 says — their fallbacks, placements and clearances, and nothing of chapters 3 to 6. It
draws each as its box: a tree as the block of its canopy, a lawn as a thin slab over its outline's
bounding rectangle.

## 1.3 Data

FS_landscape's top-level data, `extensions.FS_landscape`, is an object with one member, optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |

FS_landscape's top-level data MUST match the schema `landscape.schema.json` of this version. {#FS-LAND-1.3.1 MUST}

FS_landscape 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

## 1.4 Units

Every coordinate, width and height is a Core length (Core §2.1): an integer number of 1/1280 mm. A
point is two lengths, `[x, y]` (Core §2.6), in the element's frame (3.1). Nothing in FS_landscape is
a fraction; the values it derives are exact integers, or areas written as decimal strings as Core
writes every area.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which
Floorspec Core checks.

## 2.1 Members of every element

| Member | Type | Default | Meaning |
|---|---|---|---|
| `catalogue` | string, 1–200 characters | absent | where it came from: a starter size (chapter 7), a nursery's item |

`catalogue` is a label: no implementation reads it, and it never changes what an element means.

## 2.2 Plants

A **plant** (`plants`) is one plant, standing at a point: its host's position (3.2). Its size is
its box (3.3): its **spread** — the mature canopy's diameter — is the box's greater horizontal
extent, and its **height** — the mature height — the box's vertical extent.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `form` | `"tree"`, `"shrub"`, `"grass"` or `"groundcover"` | — (always present) | what kind of plant it is |
| `habit` | `"rounded"`, `"spreading"`, `"columnar"`, `"conical"` or `"weeping"` | `"rounded"` | the shape of its canopy |
| `foliage` | `"deciduous"` or `"evergreen"` | absent: not stated | whether it keeps its leaves |
| `clearHeight` | length, at least 0 | absent: not stated | the height of the canopy's underside above the plant's bottom: a tree's clear trunk |
| `species` | string, 1–200 characters | absent | its botanical name, as a label |
| `commonName` | string, 1–200 characters | absent | its common name, as a label |

| `form` | What it is |
|---|---|
| `tree` | a tree: a canopy on a trunk |
| `shrub` | a shrub: woody, branching from the ground |
| `grass` | an ornamental grass or a perennial clump |
| `groundcover` | a low plant that spreads over the ground |

A plant's `clearHeight` MUST be less than its height, the vertical extent of its box. {#FS-LAND-2.2.1 MUST}

`species` and `commonName` are labels, as `catalogue` is: two plants of one species may have any
sizes, and a plant with no species is as complete as one with a species.

## 2.3 Size classes

A plant's **size class** is derived from its form and its height `h`, never declared, so that a
plant's size is written once, in its box:

| `form` | `small` | `medium` | `large` |
|---|---|---|---|
| `tree` | `h` < 8,000 mm | 8,000 mm ≤ `h` < 14,000 mm | `h` ≥ 14,000 mm |
| `shrub` | `h` < 900 mm | 900 mm ≤ `h` < 2,000 mm | `h` ≥ 2,000 mm |
| `grass` | `h` < 600 mm | 600 mm ≤ `h` < 1,200 mm | `h` ≥ 1,200 mm |
| `groundcover` | `h` < 150 mm | 150 mm ≤ `h` < 300 mm | `h` ≥ 300 mm |

The bounds are Floorspec's own round numbers, in base units (8,000 mm is 10,240,000), and say
nothing of any species: a small tree is a tree under 8 m tall at maturity, whatever it is.

## 2.4 Beds

A **bed** (`beds`) is a planting bed: an area of soil covered with mulch, bark or gravel, at grade or
raised in a planter. The plants in it are plants of their own, standing in its outline (6.3).

| Member | Type | Default | Meaning |
|---|---|---|---|
| `boundary` | polygon (Core §2.6) | — (always present) | its outline, in its frame (3.4) |
| `cover` | `"mulch"`, `"bark"`, `"gravel"` or `"soil"` | `"mulch"` | what covers its soil |
| `edging` | `"none"`, `"steel"`, `"stone"`, `"brick"`, `"timber"` or `"concrete"` | `"none"` | what edges it: a raised bed's walls are its edging |

## 2.5 Lawns

A **lawn** (`lawns`) is an area of grass.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `boundary` | polygon (Core §2.6) | — (always present) | its outline, in its frame (3.4) |
| `cover` | `"turf"` or `"meadow"` | `"turf"` | mown turf, or long grass left to grow |

A bed or a hardscape element inside a lawn's outline is laid over it: a lawn need not have a hole
for every bed cut into it, and its area (6.4) is its outline's.

## 2.6 Hardscape

A **hardscape** element (`hardscape`) is a built line in the garden: a path, a run of stepping
stones, a curb, a garden or retaining wall. It is a **line** — a polyline through its `points` —
swept to its `width`, centred on the line.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `form` | `"path"`, `"steppingStones"`, `"curb"` or `"wall"` | — (always present) | what it is |
| `points` | array of at least two points | — (always present) | its line, in its frame (3.4) |
| `width` | length, at least 1,280 (1 mm) | — (always present) | its width across the line |
| `material` | `"stone"`, `"gravel"`, `"concrete"`, `"brick"`, `"timber"` or `"steel"` | absent: not stated | what it is made of |

A garden wall's height, a path's thickness and a curb's rise are its box's (3.3). A wall of
FS_landscape is a garden's, never a building's: a wall that bounds a room or carries a roof is a
Core wall.

# 3. Placement and geometry

## 3.1 The ground and the frame

FS_landscape has no terrain. The **ground** an element stands on is its frame's origin's elevation
(Core §13.1): its level's elevation for a `free` host or for no host — a house's lowest level, at
grade — and the top of a room's floor for a `surface` host (Core §15.6), where the room is outdoor
floor area: a roof deck, a balcony, a terrace. Every coordinate an element gives — a plant's box,
a bed's or a lawn's `boundary`, a hardscape element's `points` — is in the element's frame (Core
§12.6): its host's frame, or its level's when it has no host. An element with no host is drawn in
plan coordinates, and a hosted one moves, outline and all, when its host is moved.

Landscape is not placed on a slab. A slab is a paved area with a top (Core §15.7), and a bed or a
planter laid on it says so by its box (3.3): its bottom at the slab's top. The plan relation that
matters — a plant standing in a paved area rather than in a bed — is a lint (5.3).

## 3.2 Hosts

A plant MUST have a host: a `free` host on its level, or a `surface` host on a room's floor. {#FS-LAND-3.2.1 MUST}
Its position is the plant's own: where its stem leaves the ground. A bed, a lawn or a hardscape
element may have such a host or none.

An element of FS_landscape MUST NOT be hosted on a wall face or on a ceiling: its host, when it has one, MUST be a `free` host or a `surface` host whose surface is `"floor"`. {#FS-LAND-3.2.2 MUST NOT}
A climbing plant on a wall stands on the ground at the wall's foot.

## 3.3 The box

An element's **box** is its fallback's `box` (Core §12.6), in its frame. FS_landscape writes the
vertical in the box, once: an element stands from its box's bottom to its box's top, measured from
the ground (3.1).

- A plant's bottom is where it is planted — `0` at grade, the soil of a raised planter above it —
  and its top is its mature height above that.
- A bed's top is its surface: its cover, or the top of its edging; a raised bed or a planter is a
  bed whose box rises above the ground, its edging its walls, from its bottom to its top.
- A lawn's top is its surface.
- A hardscape element's bottom and top are its own: a path's thickness, a curb's rise, a wall's
  height.

A plant's frame has its origin at its position. A plant of spread `s` and height `h` planted `b`
above the ground has, in this convention, the box

```text
min = [−⌊s / 2⌋, −⌊s / 2⌋, b]        max = [s − ⌊s / 2⌋, s − ⌊s / 2⌋, b + h]
```

A writer SHOULD give a plant the box of this convention for its spread, height and planting height, so that its position is the middle of its canopy. {#FS-LAND-3.3.1 SHOULD}

A writer SHOULD give a bed, a lawn or a hardscape element the box that bounds its geometry in plan — the outline's bounding rectangle, or the line's grown by half its width — so that a reader without FS_landscape draws it where it is. {#FS-LAND-3.3.2 SHOULD}
An element whose geometry is not inside its box gets the lint `FS-LAND-LINT-001` (3.5).

## 3.4 Outlines and lines

A bed's and a lawn's `boundary` is a polygon (Core §2.6) of local points, `[p, q]` in its frame;
its **outline in plan** is each vertex taken to the plan by the frame (Core §13.1), exactly, and
rounded once.

A bed's or a lawn's `boundary` MUST be a simple polygon enclosing a positive area, as Core §2.6 asks of every polygon. {#FS-LAND-3.4.1 MUST}

A hardscape element's `points` are local points too; its **line in plan** is each taken to the plan
the same way. A line may cross itself — a path may loop — but every segment has a length.

Two consecutive points of a hardscape element's `points` MUST NOT be equal. {#FS-LAND-3.4.2 MUST NOT}

## 3.5 Geometry inside the box

An element's **geometry** is inside its box when, in its frame:

- for a plant, its position — the frame's origin, `[0, 0]` — is inside the box's horizontal
  extent: `min.x ≤ 0 ≤ max.x` and `min.y ≤ 0 ≤ max.y`;
- for a bed or a lawn, every vertex `[p, q]` of its `boundary` is: `min.x ≤ p ≤ max.x` and
  `min.y ≤ q ≤ max.y`;
- for a hardscape element of width `w`, every point `[p, q]` of its `points`, grown by `⌊w / 2⌋`
  on every side, is: `min.x ≤ p − ⌊w / 2⌋`, `p + ⌊w / 2⌋ ≤ max.x`, and likewise for `q` and y.

The test is horizontal and exact. It says only that the box a reader without FS_landscape draws
covers the element; a box larger than its geometry is no fault.

# 4. Drawing

This chapter is informative, but for its two statements.

## 4.1 No required model or symbol

FS_landscape's kinds require neither a model nor a symbol (Core §12.4.2): a bed's, a lawn's and a
path's shape is its own outline or line, so no fixed model could draw it, and a plant's look is its
form, habit and size.

A writer MAY give an element of FS_landscape a model and a symbol (Core §12.6), which a reader without FS_landscape then draws in place of its box. {#FS-LAND-4.1.1 MAY}

## 4.2 What a reader draws

A reader that implements FS_landscape draws, in plan and in 3D:

- a **plant** as its canopy seen from above — a circle of its spread about its position, a tree's
  trunk at its centre — and in 3D as its form and habit fill its box: a tree's trunk to its
  `clearHeight` and its canopy above, a shrub's mass from the ground, a grass's clump, a
  groundcover's low mat;
- a **bed** as its outline filled with its cover, edged with its edging, at its surface;
- a **lawn** as its outline in grass, at its surface;
- a **hardscape** element as its line swept to its width, of its material, from its box's bottom to
  its top: stepping stones as stones along the line.

Plants are drawn over beds, lawns and hardscape in plan — a canopy over what grows under it — and
hardscape over beds and lawns.

A reader that draws an element of FS_landscape SHOULD draw it inside its box. {#FS-LAND-4.2.1 SHOULD}

# 5. Diagnostics

## 5.1 Codes

FS_landscape's diagnostic codes are `FS-LAND-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-LAND-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-LAND-INV-001` | error | an element hosted on a wall face or a ceiling | the element | 3.2.2 |
| `FS-LAND-INV-002` | error | a plant without a host | the plant | 3.2.1 |
| `FS-LAND-INV-003` | error | a plant whose `clearHeight` is not less than its height | the plant | 2.2.1 |
| `FS-LAND-INV-004` | error | a bed's or a lawn's `boundary` that is not a simple polygon enclosing a positive area | the element | 3.4.1 |
| `FS-LAND-INV-005` | error | a hardscape element with two equal consecutive points | the element | 3.4.2 |

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-LAND-LINT-001` | warning | an element whose geometry is not inside its box (3.5) | the element |
| `FS-LAND-LINT-002` | info | a plant on paving: its position (6.1) strictly inside the boundary of a slab of its level, and strictly inside no bed's outline in plan on its level | the plant and the slab, once for each such slab |
| `FS-LAND-LINT-003` | info | a plant indoors: in a room (6.1) whose `function` is not `"exterior"` | the plant and the room |

Lints never make a document invalid. A tree on a patio is sometimes meant — in a tree grate, in a
pot — and a fig in a sunroom always is; the lints say where to look.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_landscape was evaluated, a deriver derives the object below as
the member `FS_landscape` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every list of IDs is sorted; every object's members are in ID order.

```json
{
  "plants": {
    "X1": { "form": "tree", "size": "medium", "spread": 10240000, "height": 14080000, "position": [-5462016, -2340864] },
    "X6": { "form": "tree", "size": "small", "spread": 5760000, "height": 7680000, "position": [9363456, 2340864], "room": "R4" }
  },
  "beds": { "X12": { "area": "5479644266496", "plants": ["X6"] } },
  "lawns": { "X20": { "area": "189961001238528" } },
  "hardscape": { "X16": { "form": "wall", "length": 3901440 } }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-LAND-6.1.1 MUST}

**A plant's position** is its placement's point (Core §13.4) in plan: its host frame's origin, `x`
and `y` rounded once. **The room of an element** is as FS_electrical §6.1 defines it: the host's room
for a `surface` host; the room anchored in the bounded face containing a `free` host's position,
unless the position is on a location line; and no room otherwise.

## 6.2 Plants

`plants` has a member for every plant: its `form`; its `size` class (2.3); its `spread`, the greater
of its box's extents along x and y; its `height`, its box's extent along z; its `position`; and
`room`, the room it is in (6.1), when it is in one.

## 6.3 Beds

`beds` has a member for every bed: its `area`, the area of its outline in plan (3.4), computed with
the shoelace formula from its rounded vertices — a multiple of one half, in square base units,
written as a decimal string — and `plants`, the plants on its level whose position lies strictly
inside its outline in plan, tested exactly on the rounded vertices.

## 6.4 Lawns and hardscape

`lawns` has a member for every lawn: its `area`, as a bed's.

`hardscape` has a member for every hardscape element: its `form`, and its `length`, the sum over its
line's segments of each segment's length in its frame, each rounded once to an integer. A segment's
length is a square root of an integer, which is never a tie: the length of a line is the same in
every frame, and the same whichever way it is walked.

# 7. The starter sizes

This chapter is informative.

`registry/FS_landscape/library.json` lists starter sizes: a plant of each form in each size class,
ready to place, by an ID such as `tree-medium`. Each item is `element`: its `form`, its `catalogue`
(the item's ID), its `name`, a tree's `clearHeight`, and its box in the convention of 3.3, planted
at grade, all in base units. A writer that places one copies the element, sets its `fallback.level`
and gives it a host — with Floorspec Ops, one `placeElement` (Ops §4.10) — changing its box when it
knows the plant's own size.

| Item | Spread | Height | Clear height |
|---|---|---|---|
| `tree-small` | 4,500 mm | 6,000 mm | 1,500 mm |
| `tree-medium` | 8,000 mm | 11,000 mm | 2,200 mm |
| `tree-large` | 13,000 mm | 18,000 mm | 3,000 mm |
| `shrub-small` | 600 mm | 500 mm | |
| `shrub-medium` | 1,200 mm | 1,200 mm | |
| `shrub-large` | 2,400 mm | 2,700 mm | |
| `grass-small` | 450 mm | 350 mm | |
| `grass-medium` | 900 mm | 900 mm | |
| `grass-large` | 1,500 mm | 1,800 mm | |
| `groundcover-small` | 450 mm | 100 mm | |
| `groundcover-medium` | 900 mm | 200 mm | |
| `groundcover-large` | 1,500 mm | 350 mm | |

Each is in its own size class (2.3). They are Floorspec's own round numbers for a generic plant of
that form and size, not any species' and not any nursery's. The file is generated, never edited by
hand: `tools/landscape-library.ts` writes it from one table, the same bytes every time (`pnpm
library:landscape`; its test fails if anything differs). It is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

# 8. Related

## 8.1 Related

FLR-T-13.5 (landscaping, an official extension drawn in plan and 3D), FLR-ADR-041 (on a level's ground or an
outdoor room's floor, never on a slab; geometry in the element's frame, the vertical in its box),
FLR-ADR-042 (species-agnostic plants: a derived size class, labels for species, no required model or
symbol), FLR-REQ-092 (Release
Candidate until a second independent implementation), FLR-ADR-001 (a tiny core; building systems
and what surrounds a house are `FS_` extensions), FLR-ADR-007 (the extension model), FLR-ADR-025 (the
conventions of the official extensions). Floorspec Core 0.2, 0.3 and 0.4 chapters 2.6, 6.7, 12, 13
and 15, Core 0.3 chapter 19 (design options), and Ops §4.10 (`placeElement`, `moveElement`).
