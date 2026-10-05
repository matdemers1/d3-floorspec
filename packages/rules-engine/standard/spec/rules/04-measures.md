# 4. Measures

A **measure** is a named, exact function of a valid document and one **target** in it, returning a
value of one **type**. Measures are the only way a rule looks at a design: a requirement compares
measures with thresholds (3.8), so every rule that uses `roomNetArea` measures the same area, and
two evaluators that implement this library find the same things. Chapters 5 to 8 define each
measure; this chapter defines what they share.

## 4.1 Targets

| Kind | A target is | Named in a report as |
|---|---|---|
| room | a room (Core §6.5) | `{ "kind": "room", "id": "R2" }` |
| opening | an opening (Core §7.1) | `{ "kind": "opening", "id": "O3" }` |
| element | an extension element (Core §12.5) | `{ "kind": "element", "id": "X1" }` |
| envelope | one clearance envelope (Core §13.5) of an opening or an extension element, its **owner** | `{ "kind": "envelope", "id": "X1", "envelope": "working" }` |
| level | a level (Core §1.8) | `{ "kind": "level", "id": "L1" }` |

The **level** of a target is the room's `level`; the opening's wall's `level`; the extension
element's fallback `level` (Core §12.6); an envelope's owner's level; and the level itself. Its
**floor** is that level's `elevation`: a height **above the floor** is an elevation minus it.

Targets are ordered by `id`, comparing IDs as Core §10.2 compares them, and then, for envelopes of
one owner, by envelope name.

## 4.2 Types and values

| Type | A value is | In a report (4.7) |
|---|---|---|
| length | an integer number of base units (Core §2.1) | a JSON integer |
| area | an exact area in square base units: an integer or an integer and a half (Core §6.4) | a decimal string, as Core's derived areas: `"9757040640000"`, `"12.5"` |
| count | a non-negative integer | a JSON integer |
| integer | an integer, with a unit — `V` (volts), `A` (amperes), `W` (watts) — or none | a JSON integer |
| boolean | true or false | `true` or `false` |
| term | a string from a closed list the measure gives, or an extension's | a JSON string |
| terms | a set of strings | a JSON array of strings, sorted |

A measure's type is fixed by its definition, except `elementMember`'s, which its arguments fix
(7.1). Only `elementMember` can have **no value** — when the element has no such member and its
extension gives it no default — and a measure with no value is reported as `null`.

## 4.3 Exactness

Every measure is defined as an exact value of Core's exact geometry (Core §2.2) and rounded at most
once, to an integer, with `round()`, where its definition says so — never in between. Where a
measure starts from a value Core itself rounds — a room polygon's vertices (Core §6.2), a fallback's
or an envelope's footprint (Core §13.2), a wall's outline (Core §5.7) — it starts from the rounded
value, as Core reports it.

An evaluator MUST compute every measure exactly as its definition states, rounding only where and as the definition says. {#FS-RULES-4.3.1 MUST}

## 4.4 The room of an element

An extension element is in at most one room, decided from its core members alone, as the official
extensions decide it (FS_electrical §6.1):

- an element with a `surface` host is in the host's room;
- an element with a `wallFace` host is in the room anchored in the face (Core §6.1) on the host's
  side of the wall: on side `"left"`, the face to the left of the wall's location line walked from
  its start to its end; on side `"right"`, the face to its right — or in no room, when no room is
  anchored in that face;
- an element with a `free` host is in the room anchored in the bounded face that contains the host's
  `position`, or in no room when the position is on a location line or in no bounded face with a
  room;
- an element without a host is in no room.

An evaluator MUST decide the room of every extension element exactly as this section defines it. {#FS-RULES-4.4.1 MUST}

## 4.5 Members of extension elements and records

Some measures and arguments read an extension's own members — an element's, or a record's such as
a circuit (FS_electrical §3.1). A member is read **with its default**: the member's value when the
element or record has it, and otherwise the default the extension's specification gives that
member, when it gives one.

A **match** is an object mapping member names (each matching `^[a-z][A-Za-z0-9]*$`) to JSON
strings, integers or booleans, with at least one member. An element or record **matches** it when, for every member of the match, the
element's or record's member, read with its default, is equal to the match's value or is an array
that contains it. A member that is absent and has no default matches nothing.

Reading a member of an extension's element or record is **reading the extension** (3.10). A match
reads the extension of the elements or records it is tested on.

## 4.6 What each measure reads

Each measure's definition says what it reads besides Core: "reads FS_electrical" means that every
use of the measure reads that extension, and "with a match, reads the extension" means that only a
use with a `match` argument does. A measure that says neither reads only Core and the core members
of extension elements (Core §1.6.9), and is evaluated for every valid document.

## 4.7 Measure results

A measure computed on a target gives a **measure result**:

| Member | Type | Meaning |
|---|---|---|
| `type` | the measure's type (4.2) | `"length"`, `"area"`, `"count"`, `"integer"`, `"boolean"`, `"term"` or `"terms"` |
| `value` | as 4.2 gives for the type, or `null` (no value) | the value |
| `display` | string | the value as a person reads it (9.6) |
| `involved` | array of IDs, sorted | for a measure whose definition names what it found — the walls that obstruct an envelope, the circuits it counted — those IDs; absent for every other measure |

An evaluator MUST give, for every measure it computes, the measure result this section defines. {#FS-RULES-4.7.1 MUST}

The conformance suite tests measures directly, by giving an evaluator a document and a list of
measure calls — a target, a measure and its arguments — and comparing the results
(`conformance/README.md`).

## 4.8 Deferred measures

These measures are reserved. Each needs something Core 0.2 does not yet describe, and is defined
when it does. A rule may name one; it is not evaluated (3.9), so a pack can be written ahead of
the library without a finding that measures the wrong thing.

| Measure | Target | Needs |
|---|---|---|
| `ceilingHeight` | room | ceilings: Core derives no floors or ceilings (Core §0.5); a level's height is floor to floor |
| `roomNarrowestDimension` | room | the dimension at every point of a room that is not convex — `roomLeastWidth` (5.3) measures the whole room |
| `openingNetClearArea`, `openingNetClearWidth`, `openingNetClearHeight` | opening | operation, sash and frame of door and window types (Core §8.4: "defined in a later draft") |
| `doorClearWidth` | opening | a door's leaf and stops |
| `stairRiserHeight`, `stairTreadDepth`, `stairWidth`, `stairHeadroom`, `stairHandrailHeight` | stair | stairs (Core §0.5) |
| `countertopReceptacleReach`, `countertopWallRunBetweenReceptacles` | room | countertops, which no extension yet describes |
| `travelDistance` | room | a path through the door graph measured in length: Core's door graph (Core §14.1) has no geometry along its links |
| `floorElevationDifference` | room | floors, and so a room's own floor elevation |

An evaluator MUST treat every measure of this table as deferred. {#FS-RULES-4.8.1 MUST}
