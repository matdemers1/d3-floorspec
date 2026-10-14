# FS_annotation 0.1.0

> [!warning] Draft
> FS_annotation 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a
> conformance suite, and still changing. It becomes a Release Candidate when an implementation other
> than the suite's own oracle passes its suite, and Ratified only when a second, independent
> implementation does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are
> Drafts.

FS_annotation keeps the **annotation** a house's owner draws on its plans: **dimension strings** —
the lengths someone chose to write down, from the outside face of the west wall to the middle of the
kitchen window to the corner — and **notes**, text with a leader pointing at what it is about. "Verify
the rough opening on site", "Keep the panel's working space clear": every exporter that draws the plan
and every agent that reads the document finds the same dimensions and the same notes, where the owner
put them.

A dimension string measures the house, it does not record a measurement. It is **associated** with
what it measures — junctions, the faces of walls, the centres of openings — and its lengths are
derived from them, exactly, every time the document is read: move a wall and the string follows it,
and its numbers change with it. Nothing an edit does to a wall, a junction or an opening is an error
of FS_annotation: a string whose wall is removed is not drawn, and a lint says so, but the document
stays valid and the string is kept for its owner to mend or delete.

What a reader can work out for itself is not stored. The automatic dimension strings a drawing puts
round a plan, the tags of doors and windows, a room's area written in it — every reader derives these
from the document as it draws, and keeps none of them here (FLR-ADR-047). And which annotation a viewer
shows, on which sheet, at what size, is the state of a view, not data of the house. FS_annotation adds
no kind of element and requires no other extension; it reads the scenes of FS_lighting and the views of
FS_views as data, without implementing either (1.3).

This extension describes a design. It never says that a design meets a code or a standard: a
finding about a code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Dimension strings | the string, its anchors, measuring |
| 3. Notes | text, where it stands, its leader and what it is about |
| 4. Drawing | informative: how a reader is meant to draw annotation |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | dimensions, notes |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-ANNO-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_annotation/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_annotation` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_annotation/extension.json` |
| Schema | `registry/FS_annotation/annotation.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_annotation/0.1.0/annotation.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: FS_annotation adds no kind of element |
| Statement IDs | `FS-ANNO-` |
| Diagnostic codes | `FS-ANNO-SCH-`, `FS-ANNO-INV-`, `FS-ANNO-LINT-` |

## 1.2 Conformance

FS_annotation places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_annotation 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_annotation (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_annotation 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_annotation at a version at which FS_annotation is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-ANNO-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_annotation's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-ANNO-INV-`) when it reported `FS-ANNO-SCH-001`, and MUST NOT evaluate its lints (`FS-ANNO-LINT-`) unless the document is valid. {#FS-ANNO-1.2.2 MUST NOT}
FS_annotation's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-ANNO-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are: a dimension
string that measures a wall of one option is resolved in the designs that have the wall, and lints in
those that do not.

FS_annotation requires no other extension. A validator that implements FS_annotation need not
implement FS_lighting or FS_views, nor know them, to check an annotation's ID (1.3).

A validator that implements FS_annotation MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-ANNO-1.2.3 MUST}

A deriver that implements FS_annotation MUST derive the values of chapter 6 for every valid document for which FS_annotation was evaluated, and MUST NOT derive them for any other document. {#FS-ANNO-1.2.4 MUST}

A reader that does not implement FS_annotation, or does not know this version, reads a document that
uses it as Core §1.6.9 says. FS_annotation has no elements, so it finds nothing of FS_annotation's to
draw: it draws the plan as it would without it, with whatever dimensions it makes for itself, and
nothing of chapters 2 to 6. A writer keeps FS_annotation's data as it is (Core §1.6.6).

## 1.3 Data

FS_annotation's top-level data, `extensions.FS_annotation`, is an object with two members, each
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `dimensions` | object: ID → dimension string | `{}` | the dimension strings of chapter 2 |
| `notes` | object: ID → note | `{}` | the notes of chapter 3 |

```json
"FS_annotation": {
  "dimensions": {
    "DM2": {
      "name": "Kitchen window",
      "level": "L1",
      "direction": [1, 0],
      "through": [0, 6217728],
      "anchors": [
        { "wall": "W1", "face": "left" },
        { "opening": "O1" },
        { "junction": "J3" }
      ]
    }
  },
  "notes": {
    "NT1": {
      "level": "L1",
      "text": "Verify the rough opening on site\nbefore ordering the window.",
      "at": [780288, 5852160],
      "leader": [2340864, 4681728],
      "about": "O1"
    }
  }
}
```

FS_annotation's top-level data MUST match the schema `annotation.schema.json` of this version. {#FS-ANNO-1.3.1 MUST}

A dimension string and a note — together, the document's **annotations** — are not elements: they
have no fallback and no place in the building. But their IDs are in the document's one space of IDs
(Core §3.1.3), as an FS_lighting scene's and an FS_views view's are, so that a diagnostic can name
one among its elements and a note can be about another annotation without ambiguity.

An annotation's ID MUST NOT be the ID of an element, a program item or an extension element, nor of a scene in `extensions.FS_lighting.scenes` or a view in `extensions.FS_views.views`; and a note's ID MUST NOT be the ID of a dimension string. {#FS-ANNO-1.3.2 MUST NOT}
Ops does not mint annotation IDs. `DM1`, `DM2` … for dimension strings and `NT1`, `NT2` … for notes
are a good choice: neither `DM` nor `NT` is a prefix Ops mints with (Ops §1.5).

FS_annotation reads, of FS_lighting's data and of FS_views's, only the IDs of FS_lighting's scenes —
the members of `extensions.FS_lighting.scenes` — and of FS_views's views — the members of
`extensions.FS_views.views`. It reads them as they are, without checking them and whether or not the
document uses those extensions at a version anyone knows, since it implements neither: an extension's
data that is not an object, or a `scenes` or a `views` that is not an object, holds none, and a
document without that extension's data has none.

Every annotation is drawn on one level, its `level`:

An annotation's `level` MUST be the ID of a level of the document. {#FS-ANNO-1.3.3 MUST}
That is the only reference of an annotation that is an error. Everything else it names — the
junctions, walls and openings a dimension string measures (2.2), the element a note is about (3.1) —
may go away in an ordinary edit, and when it does the annotation lints (chapter 5): it is not drawn,
or not tied to anything, until its owner mends it.

FS_annotation 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

## 1.4 Units

A point of an annotation — a dimension string's `through` and `point` anchors, a note's `at` and
`leader` — is two lengths `[x, y]` in base units of 1/1280 mm (Core §2.1): plan coordinates in Core's
system (Core §2.3: x to project east, y to project north) on the annotation's level. A dimension
string's `direction` is two lengths too, a vector in the same system. Each is a JSON integer, and so is
every length FS_annotation derives (2.3).

# 2. Dimension strings

## 2.1 Dimension strings

A **dimension string**, in `dimensions`, is a line of dimensions drawn on a plan: a run of features
of the house — its **anchors** — and the lengths between them, measured along one direction.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `level` | ID | — (always present) | the level it is drawn on (1.3) |
| `direction` | two lengths `[dx, dy]` | — (always present) | the direction its lengths are measured along |
| `through` | point | — (always present) | a point its **dimension line** passes through: where it is drawn |
| `anchors` | array of 2–64 anchors (2.2) | — (always present) | the features it measures between, in the order it is drawn |
| `name` | string, 1–200 characters | absent | what it is called: "Overall, south" |
| `extras` | object | `{}` | Core §1.7 |

The **dimension line** is the line through `through` in the direction of `direction`: the line the
string is drawn on, with its ticks and its lengths (chapter 4). `direction` gives only a direction:
`[1, 0]` measures east–west, `[0, 1]` north–south, `[3, 4]` along a wall that runs three east for
every four north, and `[2, 0]` and `[-1, 0]` measure exactly what `[1, 0]` does.

A dimension string's `direction` MUST NOT be `[0, 0]`. {#FS-ANNO-2.1.1 MUST NOT}
A string with no direction measures nothing.

> [!note] Writing annotation
> Floorspec Ops mints no annotation IDs and has no operation of its own for an annotation. A writer
> adds, changes or removes one with `setProperty` or `unsetProperty` of `$document` — the path
> `/extensions/FS_annotation/dimensions/DM1` for the dimension string `DM1`,
> `/extensions/FS_annotation/notes/NT1` for the note `NT1`; the first annotation of a document that
> declares FS_annotation without its data creates `extensions.FS_annotation` on the way (Ops §2.3).
> Ops does not follow references inside an extension's own members (Ops §0.5): an applier that
> implements FS_annotation and knows it rejects a batch whose result breaks this specification — a
> string whose direction is `[0, 0]`, or an annotation on a level the batch removes — and commits one
> that removes a wall a string measures, which only lints.

## 2.2 Anchors

An **anchor** is one feature a dimension string measures from or to. It is an object with exactly
one of these forms:

| Anchor | Measures to |
|---|---|
| `{ "junction": ID }` | the junction's `position` |
| `{ "wall": ID, "face": "left" \| "right" \| "location" }` | one of a straight wall's lines: its left or right **face line**, or its **location line** |
| `{ "opening": ID }` | the opening's **centre**: the middle of its width, on its wall |
| `{ "point": [x, y] }` | a point of the plan, associated with nothing |

A wall's face is named as Core names its sides (Core §5.4): `"left"` and `"right"` as seen looking
along the wall from its start junction to its end — the left face being its exterior, for a wall
drawn clockwise round an enclosure — and `"location"` for its location line itself (Core §5.2),
wherever its `justification` puts that in its thickness. With `S` and `E` the positions of the
wall's start and end junctions, `e = E − S`, `|e| = √(e_x² + e_y²)` and `ν = (−e_y, e_x)`, the line
an anchor names is

- `"left"`: `{ P : ν · (P − S) = a · |e| }`, the wall's left face line at its start (Core §5.5);
- `"right"`: `{ P : ν · (P − S) = −b · |e| }`, its right face line;
- `"location"`: `{ P : ν · (P − S) = 0 }`, the line of its location line;

where `a` and `b` are the wall's face offsets (Core §5.4), from its effective layers and its
justification. These are infinite lines: a string measures to where a face line crosses the
dimension line, whether or not the wall's face reaches that far. Face offsets are measured square to
the wall, so a string that crosses a wall obliquely measures the wall's thickness longer than it is.

An opening's centre `C` is the midpoint of its start point and its end point (Core §7.4): on a
straight wall, the point at distance `offset + width / 2` from its start junction along its location
line, `S + e · (offset + width / 2) / |e|`; on an arc wall (Core 0.4 §21.6), the middle of its chord.
A string measures an opening to its centre: to locate a window, a builder sets out its centre line.

An anchor names a feature of the dimension string's level, and the feature may be removed or moved
to another level by an edit. An anchor that does so cannot be measured: it is **unresolved**.

A dimension string's anchors SHOULD each name a junction, a wall or an opening of the document — a junction for `junction`, a wall for `wall`, an opening for `opening` — on the string's level: for a junction or a wall, its `level`; for an opening, its wall's. {#FS-ANNO-2.2.1 SHOULD}

A string can measure only to a line that crosses its dimension line. An arc wall's faces are curves,
and FS_annotation 0.1 measures to none of them; and a face line parallel to `direction` never meets
the dimension line.

A dimension string's wall anchors SHOULD each name a straight wall — one without an `arc` (Core 0.4 §21.1) — whose line the anchor names is not parallel to the string's `direction`: `ν · d ≠ 0`, with `d` its `direction`. {#FS-ANNO-2.2.2 SHOULD}

A string is **resolved** when each of its anchors names what 2.2.1 and 2.2.2 ask of it. A string that
is not resolved is kept as it is, and not measured: its lengths are `null` (chapter 6), and a reader
does not draw it.

## 2.3 Measuring

A resolved dimension string is measured along its dimension line. With `d = direction`,
`|d| = √(d_x² + d_y²)` and `T = through`, each anchor `i` has a **position** `p_i`, its signed distance
from `T` along `d`:

- a junction at `P`, an opening whose centre is `P` (2.2), or a point `P`: `p = (P − T) · d / |d|`,
  the distance along the line to the foot of `P` on it;
- a wall's line `{ P : ν · (P − S) = λ · |e| }` (2.2, with `λ` the anchor's `a`, `−b` or `0`): the
  line crosses the dimension line at `T + t · d`, where `t = (λ · |e| − ν · (T − S)) / (ν · d)`, and
  `p = t · |d|`.

The point on the dimension line at `T + p_i · d / |d|` is the anchor's **point** `Q_i`, where the
string draws its tick (chapter 4). Between consecutive anchors `i` and `i + 1` is a **segment**, of
length `|p_(i+1) − p_i|`; the string's **total** is `|p_last − p_first|`, from its first anchor to its
last. Each is computed exactly and rounded once, with `round()` (Core §2.2), to a length.

A position is a number of the form `(α + β · √m) / |d|`, with `α` and `β` rational and `m` the square
of the length of the wall the anchor measures — `|e|²` — or none; so a segment's length or a total is
a sum of at most two such terms over `|d|`, and three square roots at most: of `|d|²` and of two walls'
`|e|²`. These are compared and rounded exactly, as Core's corner points are (Core §2.2, §5.5). Along
an axis — `direction` `[1, 0]` or `[0, 1]` — and in a house whose walls run along the axes, every
position is a whole number of base units or a half: junctions and points are whole, and the faces of
walls and the centres of openings are whole or a half. Its lengths are then exact before they are
rounded.

The total is measured, not added up: three segments of 10.4 base units are 10 each and total 31. The
lengths of a string are those of the house as it is: when a wall or a junction it measures moves, they
change with it — a string does not keep the lengths it was drawn with.

A position depends on `through` only for a wall's line that crosses the dimension line obliquely: a
junction, an opening or a point is at the same distance along `d` wherever the string is drawn, and so
is a line square to it.

Two consecutive anchors of a resolved dimension string SHOULD NOT be at the same position: `p_(i+1) ≠ p_i`, exactly. {#FS-ANNO-2.3.1 SHOULD NOT}
A segment of no length is a tick drawn twice — two anchors that name the same line, or a junction and
the location line through it. The test is exact, on positions before they are rounded: a segment of
less than half a base unit is not of no length, though it is written as `0`. Whether a string is
resolved is decided first: an unresolved string has no positions, and is not tested.

# 3. Notes

## 3.1 Notes

A **note**, in `notes`, is text written on a plan, with a leader that points at what it is about.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `level` | ID | — (always present) | the level it is drawn on (1.3) |
| `text` | string, 1–500 characters | — (always present) | what it says; a line feed (U+000A) starts a new line |
| `at` | point | — (always present) | where its text is drawn: the start of the baseline of its first line |
| `leader` | point | absent: no leader | the point its leader's arrow points at |
| `about` | ID | absent | what it is about: an element, an extension element, a program item, a scene, a view or a dimension string |
| `extras` | object | `{}` | Core §1.7 |

`at` is the text's **origin**: its first line starts there, on its baseline, and runs towards +x —
project east — with each further line below the one before it, towards −y. FS_annotation 0.1 has no
rotation, size or font for a note's text: a reader draws it at the size and in the face it draws
other text in (chapter 4).

`leader` is the point the leader arrives at, with its arrowhead: the window it is about, the face of a
panel. `about` says what the note is about, for a reader that lists a house's notes by what they are
about, or an agent that is asked what was noted about the kitchen window. The two are independent: a
leader points at a place, and `about` names a thing; a note may have either, both or neither.

A note's `about` SHOULD be the ID of an element, a program item or an extension element, of a scene in `extensions.FS_lighting.scenes` or a view in `extensions.FS_views.views` (1.3), or of a dimension string. {#FS-ANNO-3.1.1 SHOULD}
A note about something an edit removed stays where it is, about nothing; a lint says so.

# 4. Drawing

This chapter is informative.

A reader draws a level's annotations over its plan, at the plan's own scale, in the order of their
IDs: dimension strings, then notes, each on its `level` only.

A reader draws a resolved dimension string as a drafter would:

- the **dimension line**, along `direction` through `through`, from the first anchor's point `Q_first`
  to the last's, and a little beyond each;
- at each anchor's point `Q_i`, a **tick** — an oblique stroke at 45° to the line, as architects draw
  them, or a dot or an arrowhead, as the reader's style has it;
- an **extension line** from each anchor's feature towards its point `Q_i`, stopping short of the
  feature by a small gap and running a little past the line: from a junction's position, from the
  centre of an opening on its wall's location line, from the point of a wall's face nearest to where
  its line crosses the dimension line, or from a point anchor's point;
- each segment's length, written in the document's units of display — feet and inches to a fraction,
  or millimetres, as its reader prefers (Core §2.1) — centred on the segment, above the line, reading
  from the bottom or the right of the drawing;
- and, for a string of more than two anchors, its total, on a second line further out, or after the
  last segment, as the reader's style has it.

A segment too short for its text has it drawn beside it, with a leader. A reader writes the lengths
chapter 6 derives: rounded once, exact, and the same in every reader; how it shows them in feet and
inches, and to what fraction, is its own choice.

A dimension string that is not resolved is not drawn. A reader may list it, with its name, so that its
owner can find and mend it.

A reader draws a note's text with its first line's baseline starting at `at`, its lines below one
another; and, when the note has a `leader`, a **leader line** from the text's nearer end — the start
or the end of the line nearest the leader — to `leader`, ending in an arrowhead there. A leader may
have a short horizontal shoulder at the text, as a drafter's does.

Annotation is drawn in the plan's coordinates, so it scales with the plan: a string drawn 1.2 m
outside a wall stays 1.2 m outside it in every drawing. A reader keeps its text the same size on the
page — or on the screen — at every scale, and may move a note's text, or a segment's length, out of
the way of another's when they overlap; it never moves an anchor or changes a length.

# 5. Diagnostics

## 5.1 Codes

FS_annotation's diagnostic codes are `FS-ANNO-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted; an annotation is named by its ID.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-ANNO-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-ANNO-INV-001` | error | an annotation's ID is the ID of an element, a program item or an extension element, or of a scene in `extensions.FS_lighting.scenes` or a view in `extensions.FS_views.views` (1.3); or a note's ID is a dimension string's | the annotation | 1.3.2 |
| `FS-ANNO-INV-002` | error | an annotation's `level` is not the ID of a level of the document | the annotation | 1.3.3 |
| `FS-ANNO-INV-003` | error | a dimension string's `direction` is `[0, 0]` | the dimension string | 2.1.1 |

Each invariant is evaluated for every annotation, and an annotation that breaks several reports each.
A note and a dimension string of one ID break 1.3.2 once, reported for the note.

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-ANNO-LINT-001` | warning | an anchor of a dimension string names no junction, wall or opening of the document — a `junction` no junction, a `wall` no wall, an `opening` no opening — or one on another level than the string's: a junction's or a wall's `level`, an opening's wall's (2.2.1) | the dimension string |
| `FS-ANNO-LINT-002` | warning | a wall anchor of a dimension string names a wall of the document on the string's level that is an arc wall, or whose line the anchor names is parallel to the string's `direction` (2.2.2) | the dimension string |
| `FS-ANNO-LINT-003` | warning | a resolved dimension string has two consecutive anchors at the same position (2.3.1) | the dimension string |
| `FS-ANNO-LINT-004` | warning | a note's `about` is none of the IDs 3.1.1 lists (3.1.1) | the note |

Each lint is reported once for a dimension string, however many of its anchors meet its condition;
a string with an anchor that meets the condition of `FS-ANNO-LINT-001` and another that meets that of
`FS-ANNO-LINT-002` reports both. `FS-ANNO-LINT-003` is evaluated only for a resolved string: one that
reports neither of the others.

Lints never make a document invalid. A dimension string whose wall was removed is not wrong — it is a
string its owner has not yet mended — and the lint says only that it is not drawn.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_annotation was evaluated, a deriver derives the object below as the
member `FS_annotation` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every object's members are in ID order.

```json
{
  "dimensions": {
    "DM1": { "level": "L1", "lengths": [4745728, 3185152], "total": 7930880 },
    "DM5": { "level": "L1", "lengths": null, "total": null }
  },
  "notes": {
    "NT1": { "level": "L1", "about": "O1" },
    "NT3": { "level": "L1", "about": null }
  }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-ANNO-6.1.1 MUST}

## 6.2 Dimensions

`dimensions` has a member for every dimension string: its `level`; `lengths`, the length of each of
its segments in order (2.3) — one fewer than its anchors — and `total`, its total (2.3), each an
integer number of base units; or `lengths` and `total` `null` when it is not resolved (2.2).

## 6.3 Notes

`notes` has a member for every note: its `level`, and `about`, its `about`, or `null` when it has
none — whether or not it names anything (`FS-ANNO-LINT-004`).

These are the values a schedule of a house's dimensions and notes is built from, and what an agent
reads to answer "how wide is the kitchen, as drawn?" without measuring the plan itself. Everything
else of an annotation — where it is drawn, what a note says — is the annotation itself, read from the
document.

# 7. Related

## 7.1 Related

FLR-T-18.11 (dimensions and annotation in the D3 Floorspec editor), FLR-ADR-047 (drawing annotation
lives in the document as FS_annotation; automatic dimensions, tags and areas are derived by one layout
every drawing shares), FLR-T-13.10 and FS_views 0.1.0 (saved views, which an annotation's ID may not
take, read as data), FLR-T-13.12 and FS_lighting 0.1.0 chapter 3 (named lighting scenes, likewise),
FLR-REQ-092 (Release Candidate until a second independent implementation), FLR-ADR-001 (a tiny core;
everything else an `FS_` extension), FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise;
findings never say a design meets a code). Floorspec Core 0.2, 0.3 and 0.4 chapter 2 (lengths, exact
derivation and rounding, the coordinate system), §3.1.3 (the one space of IDs), chapter 5 (walls:
sides, face offsets, face lines), chapter 7 (openings and their start and end points) and chapter 12
(extensions), Core 0.3 chapter 19 (design options), Core 0.4 chapter 21 (arc walls), and Ops §0.5 and
§2.3 (`setProperty` of `$document`).
