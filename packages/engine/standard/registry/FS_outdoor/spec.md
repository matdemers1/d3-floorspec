# FS_outdoor 0.1.0

> [!warning] Draft
> FS_outdoor 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_outdoor describes the rooms a house has outdoors: **pools** — a pool, a plunge pool, a spa — with
their coping and their water; **fences** — a fence or a garden wall drawn along a line, with its
**gates**; **shelters** — a pergola, a covered porch, a shade sail — on posts; **outdoor kitchens**;
and **fire features**. Every one is an extension element (Core §12.5) with a box, so a reader without
FS_outdoor still shows that something stands there, and every one is described by a few parameters —
a coping's width, a gate's place along its fence, a pergola's greatest post spacing — from which a
reader that implements FS_outdoor draws it.

What is derived is never stored. A pergola's posts are derived from its box and its greatest post
spacing, so a pergola stretched to cover a longer terrace gets more posts, spaced again, and never
wider ones. A pool's water is derived from its box, its coping and its water line.

This extension describes a design. It never says that a pool is fenced as a code asks, or that a
fence is high enough: a finding about a code is a rule's, in a Floorspec Rules pack, and is advice
(FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Elements | pools, fences and gates, shelters, kitchens, fires |
| 3. Placement and geometry | the ground, hosts, the box, lines |
| 4. Drawing | informative: what a reader that implements FS_outdoor draws |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | pools, fences, shelters, kitchens, fires |
| 7. The starter library | informative |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-OUTD-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_outdoor/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_outdoor` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_outdoor/extension.json` |
| Schema | `registry/FS_outdoor/outdoor.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_outdoor/0.1.0/outdoor.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `pools`, `fences`, `shelters`, `kitchens`, `fires` (none requires an asset or a symbol, 4.1) |
| Statement IDs | `FS-OUTD-` |
| Diagnostic codes | `FS-OUTD-SCH-`, `FS-OUTD-INV-`, `FS-OUTD-LINT-` |

## 1.2 Conformance

FS_outdoor places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_outdoor 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_outdoor (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_outdoor 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_outdoor at a version at which FS_outdoor is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-OUTD-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_outdoor's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-OUTD-INV-`) when it reported `FS-OUTD-SCH-001`, and MUST NOT evaluate its lints (`FS-OUTD-LINT-`) unless the document is valid. {#FS-OUTD-1.2.2 MUST NOT}
FS_outdoor's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-OUTD-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own: a garden that uses FS_landscape and
FS_outdoor is evaluated by each. A document with design options (Core chapter 19) is evaluated in
each of its checked designs, as Core's own invariants are.

A validator that implements FS_outdoor MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-OUTD-1.2.3 MUST}

A deriver that implements FS_outdoor MUST derive the values of chapter 6 for every valid document for which FS_outdoor was evaluated, and MUST NOT derive them for any other document. {#FS-OUTD-1.2.4 MUST}

A reader that does not implement FS_outdoor, or does not know this version, reads its elements as
Core §1.6.9 says — their fallbacks, placements and clearances, and nothing of chapters 2 to 6. It
draws each as its box: a pool as the block from its floor to its coping, a fence as the block that
bounds its line.

## 1.3 Data

FS_outdoor's top-level data, `extensions.FS_outdoor`, is an object with one member, optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |

FS_outdoor's top-level data MUST match the schema `outdoor.schema.json` of this version. {#FS-OUTD-1.3.1 MUST}

FS_outdoor 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and an
implementation of this version does not read it.

## 1.4 Units

Every coordinate, width, spacing and height is a Core length (Core §2.1): an integer number of
1/1280 mm. A point is two lengths, `[x, y]` (Core §2.6), in the element's frame (3.1). An area is in
square base units and a volume in cubic base units, always derived, never stored, and written as
decimal strings of integers, because they exceed the range where a JSON number is exact (Core §2.5).

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which
Floorspec Core checks.

## 2.1 Members of every element

| Member | Type | Default | Meaning |
|---|---|---|---|
| `catalogue` | string, 1–200 characters | absent | where it came from: a starter item (chapter 7), a maker's model |

`catalogue` is a label: no implementation reads it, and it never changes what an element means.

The **extents** of an element with a box are its box's: `X`, the extent along x (`max.x − min.x`),
`Y` along y and `Z` along z — its depth, its width and its height, as Floorspec Ops names them
(Ops §4.11).

## 2.2 Pools

A **pool** (`pools`) is a basin of water in a coping: a swimming pool, a plunge pool or a spa. Its box
is the pool's whole: horizontally, the **coping's outer edge**; vertically, from the basin's **floor**
— its box's bottom — to the **top of the coping**, its box's top. The **basin** is the box less the
coping on every side; the **water** fills the basin from its floor to the **water line**, `waterLine`
below the top of the coping.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `form` | `"pool"`, `"plunge"` or `"spa"` | — (always present) | what it is: a swimming pool, a plunge pool, a spa |
| `coping` | length, at least 0 | `384000` (300 mm) | the coping's width, on every side of the basin |
| `waterLine` | length, at least 0 | `192000` (150 mm) | the water's surface below the top of the coping |
| `copingMaterial` | `"stone"`, `"concrete"`, `"brick"`, `"tile"` or `"timber"` | absent: not stated | what the coping is made of |
| `interior` | `"plaster"`, `"tile"`, `"pebble"`, `"vinyl"` or `"fibreglass"` | absent: not stated | the basin's finish |
| `heated` | boolean | absent: not stated | whether its water is heated |

A pool of FS_outdoor 0.1 is a rectangle in plan, with a level floor: a freeform pool, a sloped floor
and a pool's steps are a later version's.

A pool's coping MUST leave a basin: twice its `coping` MUST be less than its box's extents `X` and `Y`. {#FS-OUTD-2.2.1 MUST}

A pool's `waterLine` MUST be less than its box's extent `Z`: its water has a depth. {#FS-OUTD-2.2.2 MUST}

A pool set into the ground has its top at or near `0`, the ground (3.1); a raised spa has its top
above it. Nothing in this version asks either.

## 2.3 Fences and gates

A **fence** (`fences`) is a fence or a garden wall: a **line** — a polyline through its `points` —
swept to its `width`, centred on the line, from its box's bottom to its box's top. It is drawn as a
wall is drawn, point to point, and its **gates** are its openings.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `form` | `"fence"` or `"wall"` | — (always present) | a fence, of boards, rails or panels between posts; or a garden wall, of masonry, between piers |
| `points` | array of at least two points | — (always present) | its line, in its frame (3.4) |
| `width` | length, at least 1,280 (1 mm) | — (always present) | its thickness across the line |
| `style` | `"privacy"`, `"picket"`, `"rail"`, `"panel"`, `"mesh"` or `"solid"` | absent: not stated | what fills it between posts |
| `material` | `"timber"`, `"metal"`, `"vinyl"`, `"stone"`, `"brick"`, `"concrete"` or `"glass"` | absent: not stated | what it is made of |
| `postSpacing` | length, at least 1,280 | `3072000` (2,400 mm) | the greatest distance between two posts' centres along the line: a wall's piers |
| `onSlope` | `"racked"` or `"stepped"` | `"racked"` | how it follows falling ground: its top parallel to the ground, or level between posts |
| `gates` | array of gates | `[]` | its gates, in any order |

A **gate** is an object:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `offset` | length, at least 0 | — (always present) | from the line's start along the line to the gate's near edge |
| `width` | length, at least 1,280 | — (always present) | its clear width along the line |
| `leaves` | `1` or `2` | `1` | a single gate or a double one |
| `swing` | `"left"`, `"right"` or `"slide"` | `"left"` | the side of the line it opens to, walking from the line's start, or along the line |
| `selfClosing` | boolean | absent: not stated | whether it closes itself |
| `name` | string, 1–200 characters | absent | a label |

A gate is to its fence what an opening is to a wall (Core §7.1): along the line, it occupies the
interval from `offset` to `offset + width`, measured along the line's segments from its start.

Every gate of a fence MUST lie within its line: its `offset + width` MUST NOT exceed the line's length (6.3). {#FS-OUTD-2.3.1 MUST}

Two gates of one fence MUST NOT overlap: their intervals along the line MUST NOT share more than a point. {#FS-OUTD-2.3.2 MUST NOT}

A gate may turn a corner of its line: the interval is along the line, wherever its segments go.

## 2.4 Shelters

A **shelter** (`shelters`) is a roof or a shade on posts over an outdoor room: a pergola, a covered
porch or a shade sail, by its `top`. Its box is its whole: horizontally, the outer faces of its posts;
vertically, from the posts' feet — its box's bottom — to the top of its roof, its box's top.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `top` | `"slats"`, `"solid"` or `"sail"` | `"slats"` | a pergola's open beams, rafters and slats; a porch's solid roof; a fabric sail between its posts |
| `material` | `"timber"`, `"steel"`, `"aluminium"` or `"vinyl"` | absent: not stated | what its frame is made of |
| `postSize` | length, at least 1,280 | `192000` (150 mm) | the width of a post, square |
| `postSpacing` | length, at least 1,280 | `3072000` (2,400 mm) | the greatest distance between two posts' centres along a side |
| `rafterSpacing` | length, at least 1,280 | `768000` (600 mm) | the distance between rafters' centres; informative (4.2) |
| `clearHeight` | length, at least 0 | absent: not stated | the underside of its beams above its box's bottom: the headroom under it |
| `attached` | boolean | `false` | whether its back — the side of its box at `min.x` — is carried by a ledger on a wall, with no posts |

A shelter's posts are never stored. They stand at the corners of its box, inset by half a post, and
along each side between the corners, as few as keep every space between two centres at most
`postSpacing` (6.4) — so a shelter made longer gets more posts, spaced again.

A shelter's `postSize` MUST be less than its box's extents `X` and `Y`. {#FS-OUTD-2.4.1 MUST}

A shelter's `postSpacing` MUST be greater than its `postSize`: posts closer than they are wide touch. {#FS-OUTD-2.4.2 MUST}

A shelter's `clearHeight`, when it has one, MUST be less than its box's extent `Z`. {#FS-OUTD-2.4.3 MUST}

## 2.5 Kitchens

A **kitchen** (`kitchens`) is an outdoor kitchen: a counter run with its appliances built in. Its run
is its box's width, along y; its depth is along x, its front at `max.x` (Core §13.2).

| Member | Type | Default | Meaning |
|---|---|---|---|
| `appliances` | array of unique `"grill"`, `"sideBurner"`, `"sink"`, `"refrigerator"`, `"iceMaker"`, `"pizzaOven"`, `"smoker"` or `"warmingDrawer"` | `[]` | what is built into it, in order along the run from its right end (`min.y`) to its left |
| `counter` | `"stone"`, `"concrete"`, `"tile"`, `"steel"` or `"timber"` | absent: not stated | its counter top |
| `fuel` | `"gas"`, `"propane"`, `"charcoal"`, `"wood"` or `"electric"` | absent: not stated | what its grill burns |

## 2.6 Fires

A **fire** (`fires`) is a fire feature: a fire pit, a fire bowl, a fire table or an outdoor fireplace.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `form` | `"pit"`, `"bowl"`, `"table"` or `"fireplace"` | — (always present) | what it is |
| `fuel` | `"wood"`, `"gas"`, `"propane"` or `"ethanol"` | absent: not stated | what it burns |

A fireplace's front is at `max.x`. A pit, a bowl or a table is drawn round when its box is square
(4.2).

# 3. Placement and geometry

## 3.1 The ground and the frame

The **ground** an element stands on is its frame's origin's elevation (Core §13.1), as for FS_landscape
(FS_landscape §3.1): its level's elevation for a `free` host or for no host, and the top of a room's
floor for a `surface` host — a terrace, a roof deck, a courtyard. Every coordinate an element gives —
its box, a fence's `points` — is in the element's frame (Core §12.6): its host's frame, or its
level's when it has no host. A hosted element moves and turns with its host.

FS_outdoor has no terrain. Where a document also uses FS_site, the ground of FS_site's surface is
FS_site's; a pool or a shelter is set into it, as a slab is, by a pad (FS_site §4.1) or a slab a
writer records.

## 3.2 Hosts

A pool, a shelter, a kitchen and a fire MUST have a host: a `free` host on its level, or a `surface` host on a room's floor. {#FS-OUTD-3.2.1 MUST}
Its host's position is the middle of the element in plan, by the convention of 3.3. A fence may have
such a host, or none.

An element of FS_outdoor MUST NOT be hosted on a wall face or on a ceiling: its host, when it has one, MUST be a `free` host or a `surface` host whose surface is `"floor"`. {#FS-OUTD-3.2.2 MUST NOT}

## 3.3 The box

An element's **box** is its fallback's `box` (Core §12.6), in its frame. FS_outdoor writes the
vertical in the box, once, measured from the ground (3.1): a pool from its floor, below the ground, to
its coping's top; a shelter from its posts' feet to its roof's top; a fence from its foot to its top.

A writer SHOULD give a pool, a shelter, a kitchen and a fire a box centred on its frame's origin horizontally — `min.x = −⌊X / 2⌋` and `min.y = −⌊Y / 2⌋` — so that its host's position is its middle and it turns about it. {#FS-OUTD-3.3.1 SHOULD}

A writer SHOULD give a fence the box that bounds its line grown by half its width, so that a reader without FS_outdoor draws it where it is. {#FS-OUTD-3.3.2 SHOULD}
A fence whose line, grown by `⌊width / 2⌋` on every side, is not inside its box horizontally — tested
exactly, in its frame, as FS_landscape §3.5 tests a hardscape line — gets the lint `FS-OUTD-LINT-001`.

## 3.4 Lines

A fence's `points` are local points in its frame; its **line in plan** is each taken to the plan by
the frame (Core §13.1), exactly, and rounded once. A line may turn back on itself — a fence round a
pool ends where it starts — but every segment has a length.

Two consecutive points of a fence's `points` MUST NOT be equal. {#FS-OUTD-3.4.1 MUST NOT}

# 4. Drawing

This chapter is informative, but for its two statements.

## 4.1 No required model or symbol

FS_outdoor's kinds require neither a model nor a symbol (Core §12.4.2): what one looks like is its
parameters — a pool's coping and water, a fence's line and gates, a pergola's posts — so no fixed
model could draw it.

A writer MAY give an element of FS_outdoor a model and a symbol (Core §12.6), which a reader without FS_outdoor then draws in place of its box. {#FS-OUTD-4.1.1 MAY}

## 4.2 What a reader draws

A reader that implements FS_outdoor draws, in plan and in 3D:

- a **pool** as its coping, a frame of its width, round its water; in 3D the basin's walls and floor
  in its interior, and the water — clear, its surface at the water line;
- a **fence** as its line swept to its width, its posts on the line at the spacing derived (6.3), and
  each gate as an opening with its swing — a leaf and an arc, as a door is drawn — or, sliding, a
  leaf along the line; in 3D its boards, rails or panels between posts, racked or stepped on falling
  ground;
- a **shelter** as its posts (6.4) and, over them, its top: in plan dashed, since it is overhead — its
  beams along x on the posts at `min.y` and `max.y`, its rafters across them at `rafterSpacing`;
  in 3D its posts, beams, rafters and slats, its solid roof or its sail;
- a **kitchen** as its counter, its appliances along its run in their order;
- a **fire** as its bowl, pit, table or fireplace, with its flame.

Each reader chooses its own colours and textures — water, coping stone, wood — and its own detail.

A reader that draws an element of FS_outdoor SHOULD draw it inside its box. {#FS-OUTD-4.2.1 SHOULD}

# 5. Diagnostics

## 5.1 Codes

FS_outdoor's diagnostic codes are `FS-OUTD-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-OUTD-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-OUTD-INV-001` | error | an element hosted on a wall face or a ceiling | the element | 3.2.2 |
| `FS-OUTD-INV-002` | error | a pool, a shelter, a kitchen or a fire without a host | the element | 3.2.1 |
| `FS-OUTD-INV-003` | error | a pool whose coping leaves no basin | the pool | 2.2.1 |
| `FS-OUTD-INV-004` | error | a pool whose `waterLine` is not less than its box's extent `Z` | the pool | 2.2.2 |
| `FS-OUTD-INV-005` | error | a fence with two equal consecutive points | the fence | 3.4.1 |
| `FS-OUTD-INV-006` | error | a gate beyond the end of its fence's line | the fence | 2.3.1 |
| `FS-OUTD-INV-007` | error | two gates of one fence that overlap | the fence | 2.3.2 |
| `FS-OUTD-INV-008` | error | a shelter whose `postSize` is not less than its box's extents | the shelter | 2.4.1 |
| `FS-OUTD-INV-009` | error | a shelter whose `postSpacing` is not greater than its `postSize` | the shelter | 2.4.2 |
| `FS-OUTD-INV-010` | error | a shelter whose `clearHeight` is not less than its box's extent `Z` | the shelter | 2.4.3 |

`FS-OUTD-INV-006` is reported once for each fence with a gate beyond its line, and `FS-OUTD-INV-007`
once for each fence with gates that overlap, however many gates do. A fence with two equal consecutive
points is not tested for its gates: its length is not derived. Every other invariant is reported once
for each element that breaks it.

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-OUTD-LINT-001` | warning | a fence whose line, grown by half its width, is not inside its box (3.3) | the fence |
| `FS-OUTD-LINT-002` | info | an outdoor room indoors: a pool, a shelter, a kitchen or a fire in a room (6.1) whose `function` is not `"exterior"` | the element and the room |

Lints never make a document invalid. A spa in a sunroom and a fireplace in a screened porch are
sometimes meant; the lint says where to look.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_outdoor was evaluated, a deriver derives the object below as the
member `FS_outdoor` of the derived values' `extensions` (the conformance suite's `derived.extensions`).
Every object's members are in ID order. The example is the conformance suite's back terrace
(`examples/…-p15-back-terrace`).

```json
{
  "pools": {
    "X1": { "form": "plunge", "basin": [2340864, 4681728], "depth": 1950720,
            "area": "10959288532992", "volume": "21378503327078154240" }
  },
  "fences": {
    "X6": { "form": "fence", "length": 21067776, "posts": 9, "gates": [[15605760, 17166336]] }
  },
  "shelters": {
    "X3": { "top": "slats", "bays": [2, 2], "spacing": [2243328, 1853184], "posts": 8 }
  },
  "kitchens": { "X4": { "run": 3901440, "appliances": ["grill", "sink", "refrigerator"] } },
  "fires": { "X5": { "form": "pit" } }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-OUTD-6.1.1 MUST}

**The room of an element** is as FS_electrical §6.1 defines it: the host's room for a `surface`
host; the room anchored in the bounded face containing a `free` host's position, unless the position
is on a location line; and no room otherwise. A pool, a shelter, a kitchen or a fire in a room has
that room as its `room`; a fence has none.

## 6.2 Pools

`pools` has a member for every pool: its `form`; its `basin`, `[X − 2 · coping, Y − 2 · coping]`;
its `depth`, the water's depth, `Z − waterLine`; its `area`, the water's surface, the product of the
basin's two extents; its `volume`, the water's, `area · depth`; and `room`, when it is in one. A
writer that wants the volume in litres or gallons divides: a litre is 1,280³ cubic base units.

## 6.3 Fences

`fences` has a member for every fence: its `form`; its `length`, the sum over its line's segments of
each segment's length in its frame, each rounded once to an integer, as FS_landscape §6.4 defines a
hardscape line's; its `posts`; and its `gates`, each gate's interval `[offset, offset + width]`,
sorted.

A fence's **posts** are counted segment by segment: a segment of length `l` (rounded once) has
`⌈l / postSpacing⌉` spaces, and the fence has one post more than the sum of its segments' spaces — or
as many as that sum, when its last point equals its first and the line closes. A gate hangs from
the posts the count gives; it adds none.

## 6.4 Shelters

`shelters` has a member for every shelter: its `top`; its `bays`, `[bx, by]`; its `spacing`,
`[sx, sy]`; its `posts`; and `room`, when it is in one.

The posts' centres along x span `Lx = X − postSize`, and along y, `Ly = Y − postSize`. The **bays**
along x are the fewest that keep the spacing at most `postSpacing`, `bx = ⌈Lx / postSpacing⌉`, and
along y, `by = ⌈Ly / postSpacing⌉`. The **spacing** along each is `Lx / bx` and `Ly / by`, each
rounded once (Core §2.2). The **posts** are those round the box's perimeter, `2 · (bx + by)`; an
`attached` shelter has none along its back, `by + 1` fewer.

These are the numbers a pergola's cut list starts from, and what changes, and only what changes,
when a pergola is stretched: its box grows, and its bays, spacing and posts follow.

## 6.5 Kitchens and fires

`kitchens` has a member for every kitchen: its `run`, its box's extent `Y`; its `appliances`, as it
lists them; and `room`, when it is in one.

`fires` has a member for every fire: its `form`, and `room`, when it is in one.

# 7. The starter library

This chapter is informative.

`registry/FS_outdoor/library.json` lists starter items, ready to place, by an ID such as
`plunge-pool-8x14`. Each item is `kind`, the collection it goes in, and `element`: its members, its
`catalogue` (the item's ID), its `name`, and its box in the convention of 3.3 at grade. A fence's item
is its style, ready to be drawn: its members and its height, with no `points`, which a writer gives it.
A writer that places one copies the element, sets its `fallback.level` and gives it a host — with
Floorspec Ops, one `placeElement` (Ops §4.10) — and changes its box with `resizeElement` (Ops §4.11)
when it knows its own size.

| Item | Kind | What it is |
|---|---|---|
| `plunge-pool-8x14` | pools | a plunge pool, 8′ × 14′, 5′ 6″ deep, 12″ travertine coping |
| `pool-16x32` | pools | a pool, 16′ × 32′, 6′ deep |
| `spa-7x7` | pools | a spa, 7′ × 7′, raised 18″, heated |
| `pergola-12x16` | shelters | a timber pergola, 12′ × 16′, 9′ 6″ high, open slats |
| `porch-10x16` | shelters | a covered porch, 10′ × 16′, attached, a solid roof |
| `shade-sail-12x12` | shelters | a shade sail on four posts, 12′ × 12′ |
| `kitchen-10` | kitchens | an outdoor kitchen, a 10′ run: grill, sink, refrigerator |
| `kitchen-6` | kitchens | a grill station, a 6′ run: grill, side burner |
| `fire-pit-4` | fires | a fire pit, 4′ across, gas |
| `fire-table-5` | fires | a fire table, 5′ × 2′ 6″, propane |
| `fireplace-6` | fires | an outdoor fireplace, 6′ wide, wood |
| `fence-privacy-6` | fences | a 6′ privacy fence, timber board on board |
| `fence-picket-4` | fences | a 4′ picket fence, timber |
| `wall-garden-3` | fences | a 3′ garden wall, brick |

They are Floorspec's own round numbers, no maker's. The file is generated, never edited by hand:
`tools/outdoor-library.ts` writes it from one table, the same bytes every time (`pnpm
library:outdoor`; its test fails if anything differs). It is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

# 8. Related

## 8.1 Related

FLR-T-15.2 (outdoor rooms: pools and spas, fences and gates, pergolas and shade sails, outdoor
kitchens and fire features), FLR-ADR-063 (FS_outdoor: a new official extension, placed like
furniture, with fences drawn and posts derived), FLR-ADR-041 (FS_landscape stands on a level's ground;
the vertical in the box), FLR-ADR-011 (advisory, never "compliant"), FLR-ADR-001 (a tiny core; what
surrounds a house is an `FS_` extension), FLR-ADR-007 (the extension model), FLR-ADR-025 (the
conventions of the official extensions), FLR-REQ-092 (Release Candidate until a second independent
implementation). Floorspec Core 0.2, 0.3 and 0.4 chapters 2, 7 (openings), 12, 13 and 19 (design
options); FS_landscape §3.5 and §6.4; FS_site §4.1; Ops §4.10 (`placeElement`, `moveElement`) and
§4.11 (`resizeElement`).
