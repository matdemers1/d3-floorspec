# FS_furniture 0.1.0

> [!warning] Release Candidate
> FS_furniture 0.1.0 is a **Release Candidate** (`registry/README.md`): specified, with a schema
> and a conformance suite, and frozen unless implementations find a problem. It becomes Ratified
> only when a second, independent implementation passes its conformance suite (FLR-REQ-092). It
> builds on Floorspec Core 0.2 and 0.3, which are Drafts.

FS_furniture describes what is put into a house rather than built into its systems: **furniture**
— sofas, tables, beds, wardrobes — **appliances** — a refrigerator, a range, a dishwasher, a washer
— and **casework** — kitchen cabinets, an island, a vanity. Every item is an extension element
(Core §12.5) with a glTF model, a plan symbol and a box, so a reader without FS_furniture still
draws it in plan and in 3D; it stands on a floor or against a wall, or hangs on one (Core §13.3),
so it moves with the wall it is placed against; and it carries the space it needs kept clear — a
refrigerator's door swing, the access beside a bed — as clearance envelopes (Core §13.5).

An appliance here is the object — its size, its door, what it looks like. Where it connects to the
house's systems is the other extensions' to describe: a dishwasher's water and drain are an
FS_plumbing fixture, a gas range's fuel an FS_mechanical gas appliance, its receptacle an
FS_electrical receptacle. An appliance names them (4.4).

This extension describes a design. It never says that a design meets a code: a finding about a
code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data |
| 2. Elements | pieces, appliances, casework; their categories and how each is mounted |
| 3. Models and symbols | the box; the model and the plan symbol, placed as Core §12.6 says; the package |
| 4. Placement, groups and clearances | hosts, default envelopes, groups, connections, interference |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | the room of an element, items, rooms, groups |
| 7. The starter library | informative |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-FURN-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_furniture/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_furniture` |
| Version | `0.1.0` |
| Status | Release Candidate |
| Registry entry | `registry/FS_furniture/extension.json` |
| Schema | `registry/FS_furniture/furniture.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_furniture/0.1.0/furniture.schema.json` |
| Requires | nothing |
| Core drafts | `0.2` and `0.3`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `pieces`, `appliances`, `casework` (each requires an asset and a symbol, Core §12.4.2) |
| Statement IDs | `FS-FURN-` |
| Diagnostic codes | `FS-FURN-SCH-`, `FS-FURN-INV-`, `FS-FURN-LINT-` |

## 1.2 Conformance

FS_furniture places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_furniture 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_furniture (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_furniture 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"` or `"0.3"` — a Core draft this version lists (1.1) — and uses FS_furniture at a version at which FS_furniture is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-FURN-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_furniture's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-FURN-INV-`) when it reported `FS-FURN-SCH-001`, and MUST NOT evaluate its lints (`FS-FURN-LINT-`) unless the document is valid. {#FS-FURN-1.2.2 MUST NOT}
FS_furniture's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-FURN-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are.

A validator that implements FS_furniture MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-FURN-1.2.3 MUST}

A deriver that implements FS_furniture MUST derive the values of chapter 6 for every valid document for which FS_furniture was evaluated, and MUST NOT derive them for any other document. {#FS-FURN-1.2.4 MUST}

A reader that does not implement FS_furniture, or does not know this version, reads its elements
as Core §1.6.9 says — fallbacks, placements and clearances, and nothing of chapters 4 to 6. Because
every element carries a model and a symbol (1.1), such a reader still draws each item as it looks.

## 1.3 Data

FS_furniture's top-level data, `extensions.FS_furniture`, is an object with one member, optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |

FS_furniture's top-level data MUST match the schema `furniture.schema.json` of this version. {#FS-FURN-1.3.1 MUST}

FS_furniture 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which
Floorspec Core checks. Every kind requires its fallback to carry an `asset` and a `symbol`
(chapter 3): FS_furniture is what a house's rooms look like furnished, so every item has a model
and a plan symbol, even when they are only a generated proxy of its box.

## 2.1 Members of every element

| Member | Type | Default | Meaning |
|---|---|---|---|
| `category` | a category of its kind (2.5) | — (always present) | what it is |
| `catalogue` | string, 1–200 characters | absent | where it came from: a library item (chapter 7), a maker's model number |
| `with` | ID of an element of FS_furniture | absent | the element it belongs with or is set into: a chair with its table, a nightstand with its bed, a wall oven with its tall cabinet (4.3) |

`catalogue` is a label: no implementation reads it, and it never changes what an element means.

## 2.2 Pieces

A **piece** (`pieces`) is a piece of furniture.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `seats` | integer 1–100 | absent: not stated | how many people it seats: a sofa's seats, a dining table's places |

## 2.3 Appliances

An **appliance** (`appliances`) is a domestic appliance.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `connections` | array of distinct IDs, at least one | absent: not stated | the elements of other extensions that serve it: the FS_plumbing fixture of a dishwasher, the FS_mechanical gas appliance of a gas range, an FS_electrical receptacle (4.4) |

## 2.4 Casework

**Casework** (`casework`) is built-in cabinetry: base, wall and tall cabinets, islands, vanities and
built-in shelving. A cabinet run is several elements, one for each cabinet, placed side by side.

Casework has no member of its own beyond those of 2.1.

## 2.5 Categories

Each category belongs to one kind, and is **mounted** in one of three ways:

- `floor` — it stands on a floor, or against a wall on the floor;
- `wall` — it hangs on a wall, clear of the floor;
- `builtIn` — it is set on or into other casework: a cooktop in a counter, a wall oven in a tall
  cabinet.

| Kind | Category | Mounted | What it is |
|---|---|---|---|
| `pieces` | `sofa` | `floor` | a sofa or sectional |
| | `armchair` | `floor` | an armchair or lounge chair |
| | `chair` | `floor` | a dining, desk or side chair |
| | `bench` | `floor` | a bench |
| | `stool` | `floor` | a stool |
| | `diningTable` | `floor` | a dining or kitchen table |
| | `coffeeTable` | `floor` | a coffee table |
| | `sideTable` | `floor` | a side or end table |
| | `desk` | `floor` | a desk |
| | `bed` | `floor` | a bed |
| | `crib` | `floor` | a crib |
| | `nightstand` | `floor` | a nightstand |
| | `dresser` | `floor` | a dresser or chest of drawers |
| | `wardrobe` | `floor` | a free-standing wardrobe |
| | `bookcase` | `floor` | a bookcase |
| | `sideboard` | `floor` | a sideboard or buffet |
| | `mediaUnit` | `floor` | a media or TV unit |
| | `shelf` | `wall` | a wall shelf |
| | `other` | `floor` | any other piece |
| `appliances` | `refrigerator` | `floor` | a refrigerator |
| | `freezer` | `floor` | a freezer |
| | `range` | `floor` | a range: a cooktop over an oven |
| | `wallOven` | `builtIn` | a wall oven |
| | `cooktop` | `builtIn` | a cooktop |
| | `microwave` | `builtIn` | a microwave |
| | `dishwasher` | `floor` | a dishwasher |
| | `washer` | `floor` | a clothes washer |
| | `dryer` | `floor` | a clothes dryer |
| | `other` | `floor` | any other appliance |
| `casework` | `baseCabinet` | `floor` | a base cabinet, with its counter |
| | `wallCabinet` | `wall` | a wall cabinet |
| | `tallCabinet` | `floor` | a tall or pantry cabinet |
| | `island` | `floor` | a kitchen island |
| | `vanity` | `floor` | a bathroom vanity cabinet |
| | `shelving` | `wall` | built-in shelving |
| | `other` | `floor` | any other casework |

# 3. Models and symbols

## 3.1 The box

An element's **box** is its fallback's `box` (Core §12.6), in its frame (Core §13.1): the space it
occupies. Its **depth** is the box's extent along x, its **width** its extent along y, and its
**height** its extent along z — so an item's dimensions are written once, in its box, and a writer
that resizes an item changes its box.

An item's frame has its origin at the middle of the item's back at its bottom, and faces forward:
+x is the side the item is used from — a refrigerator's door, a sofa's seat, a bed's foot — +y its
left, as a person facing it from the front sees its right, and +z up. Hosted against a wall face
(Core §13.3), the frame faces out of the wall, so the item stands in front of the face. A box of an
item `w` wide, `d` deep and `h` tall in this convention is:

```text
min = [0, −⌊w / 2⌋, 0]        max = [d, w − ⌊w / 2⌋, h]
```

A writer SHOULD give an element the box of this convention for its width, depth and height, so that its front, its back and its middle are where its frame says. {#FS-FURN-3.1.1 SHOULD}

Its clearances (4.2) are then in front of it, and its model and symbol (3.2, 3.3) need no offset.

## 3.2 The model

An element's **model** is its fallback's `asset`: a glTF 2.0 model (Core §12.6), `model/gltf-binary`
or `model/gltf+json`, in metres, placed in the element's frame as Core §12.6 says for every
fallback model — its origin at the frame's origin, its +X the element's front, +Y up and −Z the
element's left. With the box of 3.1, the model's origin is the middle of the item's back at its
bottom, and a model made facing glTF's +Z is used as Core §12.6's note says.

A writer SHOULD give an element a model whose bounding box, placed as Core §12.6 says, is the element's box. {#FS-FURN-3.2.1 SHOULD}
The box is what Core and the rules measure, and a model larger than its box is drawn larger than
the space the item is said to take.

## 3.3 The plan symbol

An element's **symbol** is its fallback's `symbol`: an image, `image/svg+xml` or `image/png`
(Core §12.6), drawn on the footprint of the element's box with the item's front along the bottom
edge of the image, as Core §12.6 says for every fallback symbol: a headboard is at the top of a
bed's symbol, burners and a door line at the bottom of a range's.

A writer SHOULD give an SVG symbol of an item `w` mm wide and `d` mm deep the `viewBox` `0 0 w d`, in millimetres, so that it is drawn at its own scale and its strokes keep their width. {#FS-FURN-3.3.1 SHOULD}

## 3.4 The package

An element's model and symbol are assets (Core §8.6) and travel with the document in its package
(Core §18.4): a writer adds each file under a `path`, with its `sha256` and, for a Core 0.3
document, its `byteLength`, so a package validator can check that each arrived intact. A model by
`uri` gets Core's warning `FS-LINT-007`, and a reader never fetches it.

A writer SHOULD locate an element's model and symbol by `path` in the document's package, not by `uri`. {#FS-FURN-3.4.1 SHOULD}

Two elements of one item — four chairs of one design — refer to the same two assets.

# 4. Placement, groups and clearances

## 4.1 Hosts

An item mounted on the `floor` (2.5) is placed with a `surface` host on its room's floor, a `free`
host on its level, or a `wallFace` host at height `0` on the face it stands against — a
refrigerator against a kitchen wall, which then moves with the wall. An item mounted on a `wall` is
placed with a `wallFace` host at the height of its bottom. A `builtIn` item is placed as the
casework it is set on or into is, at the height it is set at, and may name that casework with
`with` (4.3), so that the two are grouped.

An element of FS_furniture MUST NOT be hosted on a ceiling: a `surface` host of an element of FS_furniture MUST have the surface `"floor"`. {#FS-FURN-4.1.1 MUST NOT}
No category of FS_furniture 0.1 hangs from a ceiling.

An element whose box reaches behind the face it is hosted on — a `wallFace` host and a box whose
`min.x` is less than `0` — is inside the wall, and gets the lint `FS-FURN-LINT-002`. An element of
a category mounted on a `wall` that has no `wallFace` host gets the lint `FS-FURN-LINT-003`.

## 4.2 Default envelopes

An item needs space kept clear to be used: a refrigerator's door swings out in front of it, a bed
is made from its sides, a dining table's chairs are pulled out around it. Floorspec's **default
envelopes** are in the element's frame, with `box` its fallback box and `top` the greater of
`box.max.z` and `box.min.z` + 2,000 mm:

| Form | `min` | `max` |
|---|---|---|
| **front** `D` | `[box.max.x, box.min.y, box.min.z]` | `[box.max.x + D, box.max.y, box.max.z]` |
| **front, standing** `D` | `[box.max.x, box.min.y, box.min.z]` | `[box.max.x + D, box.max.y, top]` |
| **left** `D` | `[box.min.x, box.max.y, box.min.z]` | `[box.max.x, box.max.y + D, top]` |
| **right** `D` | `[box.min.x, box.min.y − D, box.min.z]` | `[box.max.x, box.min.y, top]` |
| **around** `D` | `[box.min.x − D, box.min.y − D, box.min.z]` | `[box.max.x + D, box.max.y + D, top]` |

| Category | Envelope | Purpose | Form |
|---|---|---|---|
| `refrigerator`, `freezer` | `door` | `swing` | front 900 mm |
| `range`, `wallOven` | `door` | `swing` | front 600 mm |
| `dishwasher`, `washer`, `dryer` | `door` | `swing` | front 700 mm |
| `sofa`, `armchair` | `front` | `access` | front, standing 600 mm |
| `desk` | `front` | `access` | front, standing 750 mm |
| `diningTable` | `around` | `access` | around 750 mm |
| `bed` | `left` and `right` | `access` | left 600 mm and right 600 mm |
| `dresser`, `sideboard` | `front` | `swing` | front 500 mm |
| `wardrobe` | `front` | `swing` | front 600 mm |
| `baseCabinet`, `tallCabinet` | `front` | `swing` | front 600 mm |
| `wallCabinet` | `front` | `swing` | front 400 mm |
| `vanity` | `front` | `swing` | front 500 mm |
| `island` | `front` | `workingSpace` | front, standing 1,000 mm |

So a refrigerator's `door` is 900 mm in front of it, as wide and as tall as it is: the swing of a
door as wide as the refrigerator, as a door type's swing is a box (Core §13.5). A door that swings
down — a dishwasher's, an oven's — is a `swing` too. These are Floorspec's own round defaults, not a
code's numbers and not a maker's: what a jurisdiction asks is a rule's to say, in a Floorspec Rules
pack that cites its source, and what a maker asks is the writer's to put in place of the default.

A writer that adds an element of a category in this table SHOULD give it the category's default envelopes, or envelopes of the same purpose that it has better information for. {#FS-FURN-4.2.1 SHOULD}
An element of such a category with no clearance envelope of the category's purpose gets the lint
`FS-FURN-LINT-001`. The other categories have no default envelope.

## 4.3 Groups

An element's `with` names the element it belongs with: the chairs of a table, the nightstands of a
bed, an oven set into a tall cabinet, a cooktop into a base cabinet. Grouping is one level deep: an
element is with an element that is with nothing.

An element's `with` MUST be the ID of another element of FS_furniture, and that element MUST NOT have a `with` of its own. {#FS-FURN-4.3.1 MUST}

Two elements are **grouped** when one is `with` the other, or both are `with` the same element. A
group is drawn and moved by an editor as one, and its members may stand in each other's space
(4.5): a chair in its table's `around` envelope is where it belongs.

## 4.4 Connections

An appliance's `connections` name the elements of other extensions that serve it — where its
water, drain, gas or power come from. They are references, not geometry: a connection is not
required to be near the appliance, and a rule that cares how near measures it.

Each of an appliance's `connections` MUST be the ID of an extension element (Core §12.5) of an extension other than FS_furniture. {#FS-FURN-4.4.1 MUST}
The other extension need not be known or implemented: the ID is checked against the document's
extension elements, which every reader finds (Core §1.6.9).

## 4.5 Interference

Two lints report items in each other's way. Both use the test of Core §13.6 — the interiors of two
footprints intersect, tested on the rounded footprints with exact integer arithmetic, and their
vertical ranges overlap by a positive length — applied to an element's **footprint**: the footprint,
bottom and top of its box in its frame (Core §13.2), as Core derives its fallback.

- A clearance envelope (Core §13.5) — of an opening's door or window type, or of any extension
  element, of any extension — **runs into** an element of FS_furniture when they overlap by that
  test, the element is not the envelope's owner, and the two are not grouped (4.3). It gets the
  lint `FS-FURN-LINT-004`: a door that cannot open because a dresser is in front of it, a
  refrigerator door against an island, a panel's working space with a wardrobe in it.
- Two elements of FS_furniture **collide** when their footprints overlap by that test and they are
  not grouped. They get the lint `FS-FURN-LINT-005`: a sofa through a table. A wall cabinet above a
  base cabinet does not collide with it, and nor does a microwave standing on a counter, whose
  bottom only touches the counter's top.

Overlaps are not errors. A plan is drawn through states where things are in each other's way, and
an overlap of two envelopes, without an item in either, is Core's measure (Core §13.6) for the
rules to read. A wall in an item's way — an envelope or a box that crosses a wall's outline — is not
tested by this version: walls and their outlines are Core's, and the test is left to Floorspec Rules
packs, which read both.

# 5. Diagnostics

## 5.1 Codes

FS_furniture's diagnostic codes are `FS-FURN-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-FURN-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-FURN-INV-001` | error | an appliance's connection is not an extension element of another extension; once for each such connection | the appliance | 4.4.1 |
| `FS-FURN-INV-002` | error | a `with` is not another element of FS_furniture, or names one that has a `with` | the element | 4.3.1 |
| `FS-FURN-INV-003` | error | an element hosted on a ceiling | the element | 4.1.1 |

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-FURN-LINT-001` | warning | an element of a category with default envelopes (4.2) that has no clearance envelope of the category's purpose | the element |
| `FS-FURN-LINT-002` | warning | an element with a `wallFace` host whose box's `min.x` is less than `0` (4.1) | the element |
| `FS-FURN-LINT-003` | info | an element of a category mounted on a `wall` (2.5) without a `wallFace` host | the element |
| `FS-FURN-LINT-004` | warning | a clearance envelope runs into an element of FS_furniture (4.5); once for each envelope and element | the envelope's owner and the element |
| `FS-FURN-LINT-005` | warning | two elements of FS_furniture collide (4.5); once for each pair | the two elements |

Lints never make a document invalid.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_furniture was evaluated, a deriver derives the object below as
the member `FS_furniture` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every list of IDs is sorted; every object's members are in ID order.

```json
{
  "items": {
    "X1": { "kind": "appliances", "category": "refrigerator", "width": 1152000, "depth": 896000, "height": 2278400, "room": "R1" },
    "X7": { "kind": "pieces", "category": "diningTable", "width": 1920000, "depth": 1152000, "height": 960000, "room": "R1" },
    "X8": { "kind": "pieces", "category": "chair", "width": 576000, "depth": 640000, "height": 1088000, "room": "R1" }
  },
  "rooms": { "R1": { "items": ["X1", "X7", "X8"], "floorArea": "3612672000000" } },
  "groups": { "X7": ["X8"] }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-FURN-6.1.1 MUST}

**The room of an element** is as FS_electrical §6.1 defines it: the host's room for a `surface`
host; the room anchored in the face on the host's side of the wall for a `wallFace` host (the face
left of the wall's location line, walked from start to end, for `"left"`, and right of it for
`"right"`); the room anchored in the bounded face containing a `free` host's position, unless the
position is on a location line; and no room otherwise.

## 6.2 Items, rooms and groups

- `items` has a member for every element of FS_furniture: its `kind` (the collection it is in), its
  `category`, its `width`, `depth` and `height` (3.1), and `room`, the room it is in (6.1), when it
  is in one.
- `rooms` has a member for every room that holds an element of FS_furniture: `items`, those
  elements; and `floorArea`, the sum of the areas of the footprints (4.5) of those of them whose
  category is mounted on the `floor` (2.5) — the floor they stand on, counted once for each item
  even where two overlap. Each footprint's area is computed with the shoelace formula from its
  rounded vertices, so the sum is a multiple of one half, in square base units; the suite writes it
  as it writes every area, as a decimal string.
- `groups` has a member for every element that another element is `with` (4.3): those elements.

# 7. The starter library

This chapter is informative.

`registry/FS_furniture/library/` holds a starter library: generic furniture, appliances and
casework, each an FS_furniture element ready to place. `library.json` lists each item by an ID such
as `refrigerator-900`, with its kind, how its category is mounted (2.5), and `element` — its
`category`, its `catalogue` (the item's ID), its `name`, `seats` where it has them, its box in the
convention of 3.1 and its default envelopes (4.2), all in base units — and the `path`, `mediaType`,
`sha256` and `byteLength` of its model (`models/<item>.glb`, a binary glTF of a few boxes, facing
+X as Core §12.6 places it) and its symbol (`symbols/<item>.svg`, drawn as Core §12.6 and 3.3 say,
in millimetres).

A writer that places an item copies its model and symbol into the document's package, adds two
assets for them, sets the element's `fallback.asset`, `fallback.symbol` and `fallback.level`, and
places it with a host — with Floorspec Ops, one `placeElement` (Ops §4.10).

The library is generated, never edited by hand: `tools/furniture-library.ts` writes every file
from one table, the same bytes every time (`pnpm library`; `pnpm library:check` fails if anything
differs). Its models and symbols are made for Floorspec and use no third-party asset. The library
— its catalogue, models and symbols — is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so a house that uses an item owes no
attribution for it.

# 8. Related

## 8.1 Related

FLR-T-8.3, FLR-REQ-119 (furniture and appliances with a glTF model, a plan symbol and clearance
envelopes), FLR-REQ-092 (Release Candidate until a second independent implementation), FLR-ADR-001
(building systems and furniture are `FS_` extensions), FLR-ADR-007 (the extension model),
FLR-ADR-025 (the conventions of the official extensions). Floorspec Core 0.2 and 0.3 chapters 12
and 13, and Core 0.3 chapters 18 (assets and the package) and 19 (design options).
