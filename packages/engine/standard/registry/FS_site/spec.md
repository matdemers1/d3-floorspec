# FS_site 0.1.0

> [!warning] Draft
> FS_site 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_site describes the ground a house stands on. Floorspec Core already knows the **lot**: the site's
`boundary`, the lot line (Core §1.8). FS_site adds what a survey and a plat add to it — the
**setbacks** drawn in from the lot's edges, and the **terrain**: spot elevations and contour lines,
whose points make one triangulated surface — and the **grading** that sets a house into that ground:
the patios, walks and drives laid on it, and the pads a house and a terrace are built on, each of
which cuts the ground where it is higher and fills it where it is lower.

The ground moves; the house does not. A slab or a pad says where the finished ground must be, and
FS_site derives how much earth that takes away and how much it brings, exactly, every time the
document is read — so moving a patio down a step, or a spot elevation a survey corrected, changes the
numbers with it.

This extension describes a design. Its volumes are estimates for a person planning a house, never an
engineered grading plan; its setbacks are numbers a person types, drawn and advised on, never checked
against a code. It never says that a site meets a code or a standard: a finding about a code is a
rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. The lot and its setbacks | the lot's edges, setbacks, clear of the setbacks |
| 3. The terrain | survey points, the surface, elevation on it |
| 4. Grading | what grades the ground, cut and fill |
| 5. Drawing | informative: contours, cut and fill, setbacks, the ground in 3D |
| 6. Diagnostics | codes, the catalogue, lints |
| 7. Derived values | the lot, the surface, grading |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-SITE-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_site/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_site` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_site/extension.json` |
| Schema | `registry/FS_site/site.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_site/0.1.0/site.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: FS_site adds no kind of element |
| Statement IDs | `FS-SITE-` |
| Diagnostic codes | `FS-SITE-SCH-`, `FS-SITE-INV-`, `FS-SITE-LINT-` |

## 1.2 Conformance

FS_site places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_site 0.1.0 when it does what this specification
says; it is then also a reader that implements FS_site (Core §1.6.4). Its rules apply when the
validator knows the version the document targets (Core §12.2) — normally because it is configured
with this specification's registry entry.

A validator that implements FS_site 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_site at a version at which FS_site is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-SITE-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_site's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-SITE-INV-`) when it reported `FS-SITE-SCH-001`, and MUST NOT evaluate its lints (`FS-SITE-LINT-`) unless the document is valid. {#FS-SITE-1.2.2 MUST NOT}
FS_site's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-SITE-` error
makes a document invalid, and a document with one reports no lint, Core's included. Each extension a
validator implements is evaluated on its own. A document with design options (Core chapter 19) is
evaluated in each of its checked designs, as Core's own invariants are: a patio of one option grades
the ground in the designs that have it.

FS_site requires no other extension. It reads the scenes of FS_lighting, the views of FS_views and
the dimension strings and notes of FS_annotation as data, to check an ID (1.3), without implementing
or knowing any of them.

A validator that implements FS_site MUST report each condition of chapter 6 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-SITE-1.2.3 MUST}

A deriver that implements FS_site MUST derive the values of chapter 7 for every valid document for which FS_site was evaluated, and MUST NOT derive them for any other document. {#FS-SITE-1.2.4 MUST}

A reader that does not implement FS_site, or does not know this version, reads a document that uses
it as Core §1.6.9 says. FS_site has no elements, so it finds nothing of FS_site's to draw: it draws the
lot from Core's site, if it draws one, on flat ground. A writer keeps FS_site's data as it is (Core
§1.6.6).

## 1.3 Data

FS_site's top-level data, `extensions.FS_site`, is an object with five members, each optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `benchmark` | length | `0` | the survey's elevation of project zero (1.4) |
| `spots` | object: ID → spot | `{}` | the spot elevations of the survey (3.1) |
| `contours` | object: ID → contour line | `{}` | the contour lines of the survey (3.1) |
| `setbacks` | setbacks | absent: none | the setbacks from the lot's edges (2.2) |
| `pads` | object: ID → pad | `{}` | the grading pads (4.1) |

```json
"FS_site": {
  "benchmark": 316867072,
  "spots": {
    "SP1": { "at": [3901440, 47603712], "elevation": 663552, "name": "NW corner" }
  },
  "contours": {
    "CT1": { "elevation": 0, "points": [[0, 33163008], [23408640, 33553152], [46427136, 34333440]] }
  },
  "setbacks": { "street": [0], "front": 11704320, "side": 3901440, "rear": 9753600 },
  "pads": {
    "GP1": { "name": "House", "elevation": -256000,
             "boundary": [[11704320, 15605760], [35113000, 15605760], [35113000, 39014400], [11704320, 39014400]] }
  }
}
```

FS_site's top-level data MUST match the schema `site.schema.json` of this version. {#FS-SITE-1.3.1 MUST}

A spot, a contour line and a pad — together, FS_site's **records** — are not elements: they have no
fallback and no place in a building. But their IDs are in the document's one space of IDs (Core
§3.1.3), as an FS_lighting scene's, an FS_views view's and an FS_annotation dimension string's are, so
that a diagnostic can name one among its elements without ambiguity.

A record's ID MUST NOT be the ID of an element, a program item or an extension element, nor of a scene in `extensions.FS_lighting.scenes`, a view in `extensions.FS_views.views`, or a dimension string or note in `extensions.FS_annotation.dimensions` or `.notes`; and no two of FS_site's records — a spot, a contour line, a pad — may have one ID. {#FS-SITE-1.3.2 MUST NOT}
Those members of the other extensions are read as data, as they are, whether or not their extensions
are used, known or implemented: an object's members are IDs, and anything else names none.

## 1.4 Units

Every coordinate, distance and elevation is a Core length (Core §2.1): an integer number of 1/1280
mm. A point is two lengths, `[x, y]`, in plan coordinates (Core §2.3) — FS_site's data is never in a
frame of an element. An **elevation** is a height above project zero, as a level's `elevation` is
(Core §1.8): a level at elevation 0 has its finished floor at 0, and ground 2′ below it is at
−780,288.

A survey measures heights from its own datum — a benchmark, sea level — and calls the first floor
814.50′. `benchmark` is that datum's elevation of project zero, so that a reader can label every
height as the survey does: the survey's height of an elevation `z` is `benchmark + z`. Nothing FS_site
derives depends on it.

An area is in square base units, written as Core writes a room's area (Core §2.5): a decimal string, an
integer or an integer and a half. A **volume** is in cubic base units — one cubic yard is
1,170,432³ — always derived and never stored (Core §2.5), and written as a decimal string of an
integer, because it exceeds the range where a JSON number is exact.

# 2. The lot and its setbacks

## 2.1 The lot

The **lot** is the site's `boundary` (Core §1.8): a simple polygon in plan coordinates, which Core
checks (`FS-INV-009`). A document without a site, or with a site without a boundary, has no lot.

The lot's **edges** are its boundary's, in the order it is written: edge `i` runs from vertex `i` to
vertex `i + 1`, and the last from the last vertex to the first. A boundary of `n` vertices has `n`
edges, numbered 0 to `n − 1`, whichever way round it is written.

## 2.2 Setbacks

`setbacks` gives the distances a jurisdiction asks a house to keep from the lot's edges:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `street` | array of 1 to 64 distinct integers, each at least 0 | — (always present) | the edges on a street: the front of the lot |
| `front` | length, at least 0 | absent: none | the front setback |
| `side` | length, at least 0 | absent: none | the side setback |
| `rear` | length, at least 0 | absent: none | the rear setback |

Each edge of the lot has a **kind**:

- **front**, an edge whose number is in `street`;
- **side**, an edge that is not front and shares an end with a front edge: edge `i` is a side edge
  when edge `i − 1` or edge `i + 1` (counted round the boundary, modulo `n`) is front;
- **rear**, every other edge.

On a rectangular lot with one street edge, that is the street edge, the two edges running back from
it, and the edge opposite; a corner lot has two front edges. An edge's **setback** is its kind's
distance — `front`, `side` or `rear` — or none when that member is absent.

`setbacks` MUST be present only in a document whose site has a `boundary`, and every number in its `street` MUST be less than the number of the boundary's edges. {#FS-SITE-2.2.1 MUST}

## 2.3 Clear of the setbacks

A point is **clear of the setbacks** when it is inside the lot or on its boundary, and its distance
from every edge with a setback is at least that setback. The distance from a point to an edge is
its distance to the closed segment — to its nearer end, when the point is beyond either end — and the
test is exact, in integers: with `a` and `b` the edge's ends, `v = b − a` and `w = p − a`, the point
is nearer than `d` to the edge when

- `w · v ≤ 0` and `|w|² < d²`, or
- `w · v ≥ |v|²` and `|p − b|² < d²`, or
- otherwise, `(v × w)² < d² · |v|²`.

What is tested is:

- a **junction** (Core §5.1), of any level: its position;
- a **slab** (Core §6.7): every vertex of its `boundary`;
- a **pad** (4.1): every vertex of its `boundary`.

A document SHOULD keep every junction, slab and pad clear of its setbacks. {#FS-SITE-2.3.1 SHOULD}
A thing that is not is reported by `FS-SITE-LINT-003`, an `info` lint: setbacks are drawn and
advised on, never enforced. A rule pack that knows a jurisdiction's own setbacks and what may stand in
them — eaves, a stoop, a patio at grade — makes its own findings (FLR-ADR-011).

# 3. The terrain

## 3.1 Survey points

A **spot** (`spots`) is one elevation a survey measured:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `at` | point | — (always present) | where, in plan |
| `elevation` | length | — (always present) | the ground's elevation there (1.4) |
| `name` | string, 1–200 characters | absent | what it is called: "NW corner", "Top of bank" |
| `extras` | object | `{}` | as Core §1.7 |

A **contour line** (`contours`) is a line a survey drew at one elevation:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `elevation` | length | — (always present) | the elevation of every point of it |
| `points` | array of 2 to 4,096 points | — (always present) | its vertices, in order; a closed contour repeats its first point last |
| `name` | string, 1–200 characters | absent | what it is called |
| `extras` | object | `{}` | as Core §1.7 |

Two consecutive points of a contour line's `points` MUST NOT be equal. {#FS-SITE-3.1.1 MUST NOT}

The **survey points** are the points of the surface: the position and elevation of every spot, and
every vertex of every contour line at that contour's elevation, each a point `(x, y, z)`. A contour
line contributes its vertices and nothing else: its segments are not constraints on the surface (3.2),
so a writer who wants the surface to follow a contour closely gives it vertices close together.

Every survey point at a position MUST have the same elevation: two spots, two vertices of contour lines, or a spot and a vertex, at one position `(x, y)`, MUST NOT have different elevations. {#FS-SITE-3.1.2 MUST}
Survey points at one position with one elevation are one point of the surface.

## 3.2 The surface

The terrain's **surface** is defined when at least three of the survey points' distinct positions are
not on one line; otherwise the document has no surface. The surface spans the **hull**: the convex
hull of the positions, in plan.

The surface is the **Delaunay triangulation** of the positions, made unique:

1. The **Delaunay faces** of the positions are the convex polygons whose vertices are positions that
   lie on one circle with no position strictly inside it, all the positions on that circle being the
   polygon's vertices. They tile the hull, meeting edge to edge, and they are unique: they depend on
   the positions and on nothing else, not on their order or on how they were found.
2. A face of three vertices is a triangle. A face of four or more — positions on one circle, with no
   position inside it — is divided into triangles by the diagonals from its **least vertex**: the
   least `x`, then the least `y`. A face of `k` vertices `v₀ … v₍ₖ₋₁₎` counter-clockwise from its
   least vertex `v₀` gives the triangles `(v₀, vᵢ, vᵢ₊₁)` for `i` from 1 to `k − 2`.

The surface's **triangles** are those triangles, each with the elevation of each of its vertices. Every
test the triangulation needs is exact in integers: three positions turn counter-clockwise when
`(b − a) × (c − a) > 0`, and `d` is strictly inside the circle through `a`, `b` and `c`
(counter-clockwise) when

```text
| ax − dx   ay − dy   (ax − dx)² + (ay − dy)² |
| bx − dx   by − dy   (bx − dx)² + (by − dy)² |  >  0
| cx − dx   cy − dy   (cx − dx)² + (cy − dy)² |
```

A deriver MUST derive the surface's triangles exactly as this section defines them. {#FS-SITE-3.2.1 MUST}

> [!note] One way to find them
> Sort the positions by `x` and then `y`, and triangulate them in that order: start with the first
> position not on the line of those before it, joined to them in a fan; then join each following
> position to every edge of the hull so far that faces it strictly (`(b − a) × (p − a) < 0` for a
> counter-clockwise hull edge `ab`). Then flip, until none is left, every interior edge whose
> opposite vertex lies strictly inside the circle of the triangle across it. The result is a Delaunay
> triangulation; joining the triangles across every edge whose opposite vertices lie exactly on one
> circle gives the Delaunay faces, which step 2 divides again. Any method that gives the same faces
> is as good.

## 3.3 Elevation on the surface

The surface's **elevation** at a position over the hull is the elevation, there, of the plane through
the three points of a triangle that contains it; where two triangles meet, their planes agree. The
surface is not defined outside the hull: FS_site derives nothing there and a reader that draws the
ground beyond it draws it as it chooses (5.4).

The elevation of a position inside a triangle is a rational number, and every value FS_site derives
from it is computed exactly and rounded once (Core §2.2).

The **low** and **high** of the surface are the least and the greatest elevations of the survey points.

# 4. Grading

## 4.1 What grades the ground

Two things set the ground to a level of their own, each over an **outline** in plan at an **elevation**
— the elevation the finished ground under it is cut or filled to:

- a **grading slab**: a slab (Core §6.7) whose `purpose` lays it on the ground — `"patio"`,
  `"walkway"`, `"driveway"`, `"stoop"`, `"garage"` or `"equipmentPad"` — on any level. Its outline is
  its `boundary`, and its elevation is its bottom (Core §15.7): its level's elevation, plus its
  `offset`, minus its `thickness`. A slab with another purpose, or none, does not grade the ground —
  nor does any slab of a document declaring `"0.2"`, since a Core 0.2 slab has no purpose;
- a **pad** (`pads`): the ground a house, a terrace or a shed is built on.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `boundary` | polygon (Core §2.6) | — (always present) | its outline, in plan |
| `elevation` | length | — (always present) | the graded ground's elevation under it |
| `name` | string, 1–200 characters | absent | what it is called: "House", "Shed" |
| `extras` | object | `{}` | as Core §1.7 |

A pad's `boundary` MUST be a simple polygon enclosing a positive area, as Core §2.6 asks of every polygon. {#FS-SITE-4.1.1 MUST}

FS_site 0.1 does not derive a building's footprint. A house is set into the ground by a pad under it,
at the bottom of its lowest floor, which its writer keeps fitted to the house; a patio or a walk that
steps down with the ground is several slabs, each at its own `offset`, each grading the ground under
it.

## 4.2 Cut and fill

Over a graded outline `G` at elevation `e`, with `s(x, y)` the surface's elevation (3.3) and `R` the
part of `G` over the surface — `G` and the hull's common points:

```text
cut  = ∬_R max(s − e, 0) dA          fill = ∬_R max(e − s, 0) dA
```

— the earth above `e` taken away, and the earth below it brought in. Each is a rational number of
cubic base units, since `s` is linear in each triangle and every boundary is made of straight lines;
it is computed exactly and rounded once (Core §2.2), to an integer.

A deriver MUST compute every volume of FS_site as the exact value this section defines and round it once, with `round()` (nearest integer, ties to even). {#FS-SITE-4.2.1 MUST}

The **low** and **high** under a graded outline are the least and the greatest of `s` over `R`, each
rounded once; a graded outline with no point over the surface has neither. The document's **total**
cut and fill are the sums of every graded outline's exact cut and exact fill, each rounded once — not
the sums of the rounded volumes.

Each graded outline is measured on its own against the surface as surveyed: two outlines that overlap
each count the earth they share, and the ground between two outlines is not regraded. The volumes are
the earthwork a person needs to plan a house — how much a pad cuts into the slope, how much a terrace
needs filled under it — not the quantities of an engineered grading plan, which counts topsoil,
compaction, swell and the slopes a contractor grades around every outline.

A reader SHOULD NOT present FS_site's volumes as an engineered grading plan, nor say that a grading meets a code. {#FS-SITE-4.2.2 SHOULD NOT}

> [!note] Computing a volume exactly
> Clip `G` by each triangle `T` and then by the half-plane where the plane of `T` is above `e` (for
> cut) or below it (for fill) — Sutherland–Hodgman clipping by one half-plane at a time keeps the
> winding of every point it keeps, so it serves even for an outline that is not convex — and
> integrate the linear function `s − e` over each piece from its boundary:
> `∬ (α + βx + γy) dA = α·A + β·Mx + γ·My`, with the area `A = ½ Σ (xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)` and the
> moments `Mx = ⅙ Σ (xᵢ + xᵢ₊₁)(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)` and `My = ⅙ Σ (yᵢ + yᵢ₊₁)(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)`,
> all in rational arithmetic.

# 5. Drawing

This chapter is informative, but for its one statement.

## 5.1 Contours

A reader draws the terrain in plan as **contours**: the lines where the surface crosses an elevation,
at a regular **interval** in the survey's datum (1.4) — every 1′ of `benchmark + z`, say, with every
fifth a heavier major contour labelled with its height. The interval is the viewer's, not the
document's. Each triangle crosses an elevation in at most one straight segment, so a contour is a
polyline through the triangles; drawn with floating point it is exact enough to see.

Spot elevations are drawn as a mark at the spot with its height, in the survey's datum; contour lines
of the survey as the lines they are.

## 5.2 Cut and fill

A reader that shows grading tints the part of each graded outline where the ground is cut and the part
where it is filled differently — cut amber and hatched, fill blue and dashed, in D3 Floorspec — and
writes each one's volume as an estimate.

A reader that tells cut from fill SHOULD do so with a pattern or a line as well as a colour, so that colour is never the only cue. {#FS-SITE-5.2.1 SHOULD}

## 5.3 Setbacks

A reader draws the lot's boundary as a lot line, with each edge's bearing and length, and the
setbacks as a dashed line inside the lot at each edge's setback: the edge's line moved in by its
setback, joined where two meet. Where a setback is drawn on a lot that is not convex, a reader may
draw the lines of each edge alone.

## 5.4 The ground in 3D

A reader that draws the terrain in 3D draws the surface's triangles with the ground's material (a
lawn, in D3 Floorspec), the ground under each graded outline at its elevation, and the slopes between:
a pad set into a hill shows the cut face uphill of it and the fill below. Beyond the hull it may carry
the ground on level, or not draw it. A **vertical exaggeration** that stretches heights in a view is
the view's, and changes no elevation, no volume and nothing in the document.

A reader that implements FS_site and FS_landscape may stand a plant or a bed on the surface rather
than on its level's ground; nothing derived by either extension changes.

# 6. Diagnostics

## 6.1 Codes

FS_site's diagnostic codes are `FS-SITE-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted; a record is named by its ID.

## 6.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-SITE-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-SITE-INV-001` | error | a record's ID is the ID of an element, a program item or an extension element, or of a scene, a view, a dimension string or a note (1.3), or of another of FS_site's records | the record | 1.3.2 |
| `FS-SITE-INV-002` | error | survey points at one position with different elevations | every record with a survey point there: the spots, the contour lines | 3.1.2 |
| `FS-SITE-INV-003` | error | a contour line with two equal consecutive points | the contour line | 3.1.1 |
| `FS-SITE-INV-004` | error | a pad's `boundary` that is not a simple polygon enclosing a positive area | the pad | 4.1.1 |
| `FS-SITE-INV-005` | error | `setbacks` in a document whose site has no `boundary`, or a number in `street` not less than the number of the boundary's edges | — | 2.2.1 |

`FS-SITE-INV-001` is reported once for each ID that breaks 1.3.2, however many records have it.
`FS-SITE-INV-002` is reported once for each position. Every other invariant is reported once for each
record that breaks it.

## 6.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-SITE-LINT-001` | info | the document has a surface and a lot, and a vertex of the lot is outside the hull | — |
| `FS-SITE-LINT-002` | warning | the document has a surface, and a vertex of a graded outline — a grading slab's or a pad's — is outside the hull: what it cuts and fills there is not measured | the slab or the pad |
| `FS-SITE-LINT-003` | info | the document has setbacks, and a junction, a slab or a pad is not clear of them (2.3.1) | the junction, the slab or the pad |

Outside the hull means outside it and not on its boundary. Lints never make a document invalid. A
survey that stops short of the lot line is common, and the lint says only where the surface ends.

# 7. Derived values

## 7.1 Derivation

For a valid document for which FS_site was evaluated, a deriver derives the object below as the
member `FS_site` of the derived values' `extensions` (the conformance suite's `derived.extensions`).
Every object's members are in ID order. The example is the conformance suite's garden on its slope
(`examples/…-p15-garden-on-a-slope`), with its surface cut short: about 4.8 cubic yards cut and 0.7
filled under the house's pad, and 2 filled under the patio.

```json
{
  "lot": {
    "area": "745840469606400",
    "edges": [
      { "kind": "front", "length": 27310080, "setback": 9753600 },
      { "kind": "side", "length": 27310080, "setback": 1950720 },
      { "kind": "rear", "length": 27310080, "setback": 3901440 },
      { "kind": "side", "length": 27310080, "setback": 1950720 }
    ]
  },
  "surface": {
    "low": -1950720, "high": 975360,
    "points": [[-11704320, -15605760, -1755648], [-11704320, -3121152, -585216], …],
    "triangles": [[0, 4, 1], [0, 7, 4], [1, 4, 2], …]
  },
  "grading": {
    "GP1": { "kind": "pad", "elevation": -260096, "low": -422656, "high": 119097,
             "cut": "7628227785053637610", "fill": "1151035771547481407" },
    "S1": { "kind": "slab", "elevation": -323072, "low": -745864, "high": -391705,
            "cut": "0", "fill": "3194389232991517993" }
  },
  "cut": "7628227785053637610",
  "fill": "4345425004538999400"
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-SITE-7.1.1 MUST}

## 7.2 The lot

`lot` is `null` for a document with no lot (2.1). Otherwise it has its `area`, the area of its
boundary by the shoelace formula, and `edges`: one member for each edge, in the edges' order (2.1),
with its `kind` (2.2) — `null` when the document has no `setbacks` — its `length`, rounded once, and its
`setback` (2.2), `null` when it has none.

## 7.3 The surface

`surface` is `null` for a document with no surface (3.2). Otherwise it has its `low` and `high` (3.3),
`points` — every distinct survey position with its elevation, `[x, y, z]`, sorted by `x` and then by
`y` — and `triangles`, each a list of three indexes into `points`, counter-clockwise and starting at
its least index, the list sorted.

## 7.4 Grading

`grading` has a member for every grading slab and every pad (4.1), by its ID: its `kind`, `"slab"` or
`"pad"`; its `elevation` (4.1); its `low` and `high` (4.2), each `null` when it has no point over the
surface; and its `cut` and `fill` (4.2), `"0"` when it has no point over the surface. With no surface,
`low`, `high`, `cut` and `fill` are all `null`. `cut` and `fill` are the document's totals (4.2), or
`null` with no surface.

These are the numbers a site plan's earthwork note is written from, and what an agent reads to answer
"how much does the house cut into the hill?" without drawing anything.

# 8. Related

## 8.1 Related

FLR-T-15.1 (terrain and grading: the lot's boundary and topography, the house set into the ground,
and patios that step with it), FLR-ADR-060 (FS_site: an official extension on Core's site boundary,
a normative unique Delaunay surface, exact cut and fill as estimates), FLR-ADR-011 (advisory, never
"compliant"), FLR-ADR-001 (a tiny core; what surrounds a house is an `FS_` extension), FLR-ADR-007
(the extension model), FLR-ADR-025 (the conventions of the official extensions), FLR-ADR-041
(FS_landscape stands on a level's ground), FLR-REQ-092 (Release Candidate until a second independent
implementation). Floorspec Core 0.2, 0.3 and 0.4 chapters 1.8 (the site), 2, 6.7 and 15.7 (slabs), 12
and 19 (design options).
