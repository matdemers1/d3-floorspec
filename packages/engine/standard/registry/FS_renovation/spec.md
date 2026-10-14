# FS_renovation 0.1.0

> [!warning] Draft
> FS_renovation 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a
> conformance suite, and still changing. It becomes a Release Candidate when an implementation other
> than the suite's own oracle passes its suite, and Ratified only when a second, independent
> implementation does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_renovation describes a **remodel**: which parts of a house stand today and stay, which are to be
demolished, and which are new. Each element has a **renovation status** — `existing`, `demolish` or
`new` — and the document holds the house before and after at once: the **existing state**, the house
as it stands, and the **proposed state**, the house when the work is done. A contractor's and a permit
office's drawings — the existing plan, the demolition plan and the proposed plan — are four
**filters** of one document, drawn from the status alone.

FS_renovation adds no kind of element and requires no other extension. Its data lives on the core
elements it describes — a wall's own `extensions.FS_renovation`, an opening's, a room's (Core §12.7) —
and, for extension elements, which have no `extensions` of their own, in its top-level data. A reader
that does not implement it reads the **combined** document: every element, demolished and new alike,
which is itself a valid Core document.

This extension describes a design. It never says that a design meets a code or a standard: a
finding about a code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Statuses and states | the three statuses, the existing and proposed states, their views, references across states |
| 3. Filters | Existing, Demolition, Proposed and Combined; drafting conventions; 3D and exports |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | statuses, quantities by status, the rooms and area of each state |
| 6. Editing | Ops, and what an editor does when it marks an element |
| 7. What this version does not define | |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-RENO-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_renovation/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_renovation` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_renovation/extension.json` |
| Schema | `registry/FS_renovation/renovation.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_renovation/0.1.0/renovation.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: its data is on core elements and, for extension elements, in its top-level data (1.3) |
| Statement IDs | `FS-RENO-` |
| Diagnostic codes | `FS-RENO-SCH-`, `FS-RENO-INV-`, `FS-RENO-LINT-` |

## 1.2 Conformance

FS_renovation places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_renovation 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_renovation (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_renovation 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_renovation at a version at which FS_renovation is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-RENO-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_renovation's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-RENO-INV-`) when it reported `FS-RENO-SCH-001`, and MUST NOT evaluate its lints (`FS-RENO-LINT-`) unless the document is valid. {#FS-RENO-1.2.2 MUST NOT}
FS_renovation's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-RENO-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are: statuses and
design options are independent, and each design has its own existing and proposed states.

A validator that implements FS_renovation MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-RENO-1.2.3 MUST}

A deriver that implements FS_renovation MUST derive the values of chapter 5 for every valid document for which FS_renovation was evaluated, and MUST NOT derive them for any other document. {#FS-RENO-1.2.4 MUST}

A reader that does not implement FS_renovation, or does not know this version, ignores its data
(Core §1.6.9) and reads the combined document, and a writer preserves the data (Core §1.6.6).

## 1.3 Data

FS_renovation's **top-level data**, `extensions.FS_renovation`, is an object with one member,
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `elements` | object: ID → status | `{}` | the status of extension elements (2.1), by their IDs |

```json
"FS_renovation": { "elements": { "X1": "demolish", "X2": "new" } }
```

FS_renovation's top-level data MUST match the schema `renovation.schema.json` of this version. {#FS-RENO-1.3.1 MUST}

**Data on an element** is the element's own `extensions.FS_renovation` (Core §1.6): an object with
one member, `status`, always present.

```json
"W8": { "level": "L1", "start": "J6", "end": "J7", "type": "INT",
        "extensions": { "FS_renovation": { "status": "demolish" } } }
```

FS_renovation defines it for seven collections — `walls`, `separators`, `openings`, `rooms`, `slabs`,
and, in Core 0.3 and 0.4, `roofs` and `stairs` — the collections whose elements, with extension
elements, may be in a design option (Core §19.2), except junctions. The schema's
`#/$defs/coreElements` names them: an element of collection `C` carries data that the schema accepts
as the object `{ "C": data }` checked against `#/$defs/coreElements`.

FS_renovation's data on a wall, a separator, an opening, a room, a slab, a roof or a stair MUST match the member of the schema's `#/$defs/coreElements` for that element's collection. {#FS-RENO-1.3.2 MUST}

The `extensions` of any other element — a building, a level, a junction, a type, a material, an asset, an option set or an option — and of a program item MUST NOT have a member `FS_renovation`. {#FS-RENO-1.3.3 MUST NOT}
A junction is where walls meet: it stands when any of them does, and a demolished wall's junctions
are simply left with fewer walls.

A document that breaks 1.3.1, 1.3.2 or 1.3.3 gets `FS-RENO-SCH-001`, once: all three are the
schema tier. An element's data is checked whether or not the document has top-level data.

**Extension elements.** An extension element's members are its extension's (Core §12.5): it has no
`extensions` of its own to carry a status. Its status is the member of `elements` named by its ID.
`elements` is for extension elements alone: a core element's status is on the element.

An ID in `elements` MUST NOT be the ID of an element of a core collection or of a program item. {#FS-RENO-1.3.4 MUST NOT}
An ID in `elements` that names nothing — an extension element removed since, or one in a design
option the design does not choose — means nothing, and is ignored. An editor that removes an
extension element removes its status in the same batch (6.1).

## 1.4 Units

FS_renovation records no lengths. What it derives (chapter 5) is in Core's units: lengths in base
units of 1/1280 mm (Core §2.1), areas in square base units written as Core writes a net area (Core
§6.4), each computed exactly and rounded only where this specification says.

# 2. Statuses and states

## 2.1 Statuses

An element's **renovation status** is one of:

| Status | Meaning | In the existing state | In the proposed state |
|---|---|---|---|
| `"existing"` | it stands today and stays | yes | yes |
| `"demolish"` | it stands today and is to be removed | yes | no |
| `"new"` | it is to be built | no | yes |

An element of the seven collections of 1.3 has the status in its `extensions.FS_renovation`, and
`"existing"` when it has none; an extension element has the status `elements` gives it, and
`"existing"` when `elements` names it not. So an existing house needs no marking at all: a remodel
marks what it takes away and what it adds.

Every other element — a building, a level, a junction, a type, a material, an asset, an option set,
an option and a program item — has no status, and is in both states.

A relocated element — a range moved to the island — is two elements: the range where it stands,
`"demolish"`, and the range where it goes, `"new"`.

## 2.2 States and their views

The **existing state** is every element whose status is not `"new"`, and every element without a
status. The **proposed state** is every element whose status is not `"demolish"`, and every element
without a status. The document itself — every element — is the **combined** document.

The **view** of a state is the document as it is in that state. It is the document with:

1. every element that is not in the state removed, from its collection or from its extension's
   collection; and then
2. the `join` of every junction whose `join.through` names a wall that step 1 removed, removed, so
   that the default join applies (Core §5.8).

A view is a document, and every chapter of Core applies to it as it stands: the existing state's
walls, rooms, openings and floors are the house as it stands, and the proposed state's are the house
when the work is done. A view keeps FS_renovation's data, which means nothing to Core. A view is
never stored.

A room is found from the walls around it (Core chapter 6), so the same room may have one polygon in
the existing state and another in the proposed state: the Kitchen of a house whose wall to the
Utility room is to be demolished is the Kitchen alone in the existing state, and the Kitchen with
the Utility room's floor in the proposed state. Core allows one room to a face (Core §6.3.2), so the
Utility room is marked `"demolish"` with its wall: it is not a room of the proposed state.

## 2.3 References across states

A view removes elements, so an element that remains in a state must not refer to one that went.

A reference (Core §3.2) from an element that has a status, in a state it is in, MUST NOT resolve to an element that has a status and is not in that state. {#FS-RENO-2.3.1 MUST NOT}
An existing door may not be in a wall to be demolished — the door goes with the wall, and is marked
`"demolish"` too — nor in a new wall, which the existing state does not have. A new window may be in
an existing wall, and a new cabinet may stand against one. A demolished element may refer to an
existing one, and a new element to an existing one, but neither to the other. A junction has no
status: its join through a wall that a state does not have is left out of that state's view (2.2).

## 2.4 Valid states

The combined document is a valid Core document, or FS_renovation is not evaluated (1.2.2). Each state
must be one too: the existing state is a house someone lives in, and the proposed state one someone
will.

The view of the existing state MUST satisfy every invariant of Core's tier 4 (Core §10.1) that its draft defines. {#FS-RENO-2.4.1 MUST}

The view of the proposed state MUST satisfy every invariant of Core's tier 4 that its draft defines. {#FS-RENO-2.4.2 MUST}
A state's view is checked as Core checks a document of its draft without design options, and
without known extensions: what a known extension checks of its data is that extension's own
business. Two rooms in one face of the proposed state — a kitchen opened to a dining room that is
still a room — is the usual error, and so is a room whose anchor a new wall's thickness covers.

# 3. Filters

## 3.1 Filters

A **filter** is what a drawing shows of a remodel. FS_renovation defines four:

| Filter | Shows | The rooms and areas it shows |
|---|---|---|
| `existing` | the house as it stands, drawn plainly | the existing state's |
| `demolition` | the house as it stands, with what is to be demolished marked | the existing state's |
| `proposed` | the house when the work is done, with what is new marked | the proposed state's |
| `combined` | everything at once | the combined document's |

Each filter draws each element in one of five **styles**, by its status:

| Status | `existing` | `demolition` | `proposed` | `combined` |
|---|---|---|---|---|
| `"existing"`, or no status | plain | existing | existing | existing |
| `"demolish"` | plain | demolished | hidden | demolished |
| `"new"` | hidden | hidden | new | new |

- **plain**: as a drawing without FS_renovation draws it, in the drawing's own style;
- **existing**: drawn, and subdued — in grey, or lighter than plain — so that what changes stands out;
- **demolished**: drawn with dashed outlines, and no fill or poché;
- **new**: drawn emphasised — a cut wall filled solid (poché), an outline heavier than an existing one;
- **hidden**: not drawn.

The `existing` filter is the as-built plan: it draws everything that stands today as a drawing of
the house would, and nothing of what is to come. The `demolition` filter is the demolition plan: the
same house, what is to come down dashed. The `proposed` filter is the plan of the work: the house
when it is done, what is new in poché against what stays in grey. The `combined` filter is the one
an editor works in, with everything in it.

Software that draws a remodel — a plan, a section, a 3D view, a drawing or a schedule — SHOULD draw each element in the style that this section's table gives for its status and the filter it draws. {#FS-RENO-3.1.1 SHOULD}

## 3.2 Drafting conventions

This section is informative.

The styles are the drafting conventions of renovation drawings, as BIM tools draw them: ArchiCAD's
renovation filters, Revit's phase filters. A demolished wall is drawn with its cut outline dashed and
its poché left out; a demolished door or window with its symbol dashed; a demolished fixture or
cabinet as a dashed outline. A new wall is filled solid, and an existing wall in a drawing that shows
new work is drawn with a lighter or grey fill. Where colour is used, demolished work is commonly
red and new work the drawing's accent colour. A room's area tag shows the area of the filter's
state: the `demolition` filter's Kitchen tag reads the Kitchen as it is, and the `proposed` filter's
the Kitchen as it will be.

In 3D, the `existing` and `demolition` filters show the existing state, the `demolition` filter with
what is to be demolished tinted or ghosted; the `proposed` filter shows the proposed state, with
nothing demolished in it; the `combined` filter shows everything, demolished work ghosted.

## 3.3 Exports

An exported drawing, a schedule or a model of a remodel is of one filter.

An exporter SHOULD record the filter it exported, and SHOULD export the `combined` filter unless it is asked for another. {#FS-RENO-3.3.1 SHOULD}
An exporter of a model — IFC (Core Annex A), glTF — exports the elements a filter draws; an IFC
exporter MAY record each element's status as a property. {#FS-RENO-3.3.2 MAY}

# 4. Diagnostics

## 4.1 Codes

FS_renovation's diagnostic codes are `FS-RENO-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-RENO-SCH-001` | error | the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_renovation data does | — | 1.3.1, 1.3.2, 1.3.3 |
| `FS-RENO-INV-001` | error | an ID in `elements` is the ID of an element of a core collection or of a program item | that ID | 1.3.4 |
| `FS-RENO-INV-002` | error | an element that has a status refers to an element that has a status and is not in a state the first is in; once for each such pair | the referring element and the element it refers to | 2.3.1 |
| `FS-RENO-INV-003` | error | the view of the existing state breaks a Core invariant; once for each error Core reports of the view | the elements of Core's diagnostic | 2.4.1 |
| `FS-RENO-INV-004` | error | the view of the proposed state breaks a Core invariant; once for each error Core reports of the view | the elements of Core's diagnostic | 2.4.2 |

`FS-RENO-INV-003` and `FS-RENO-INV-004` are evaluated only for a document with no `FS-RENO-INV-002`:
a view whose references break would report the same element twice. Core's diagnostic of a view is
the one Core reports of the view as a document (Core §10.2) — its code is not repeated, only its
elements.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-RENO-4.2.1 MUST NOT}

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-RENO-LINT-001` | info | no element has the status `"demolish"` or `"new"`: the document uses FS_renovation and describes no work | — |

Lints never make a document invalid.

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_renovation was evaluated, a deriver derives the object below as
the member `FS_renovation` of the derived values' `extensions`. Every list of IDs is sorted, and
every object's members are in ID order.

```json
{
  "status": {
    "existing": ["O1", "O2", "O3", "R1", "R2", "W1", "W10", "W11", "W13", "W2", "W3", "W4", "W5", "W6", "W7", "W9", "X3"],
    "demolish": ["O4", "R3", "W8", "X1"],
    "new": ["O5", "O6", "R4", "S1", "W12", "X2"]
  },
  "quantities": {
    "existing": { "walls": 11, "wallLength": 30431232, "separators": 0, "openings": 3, "rooms": 2, "slabs": 0, "slabArea": "0", "roofs": 0, "stairs": 0, "elements": 1 },
    "demolish": { "walls": 1, "wallLength": 2340864, "separators": 0, "openings": 1, "rooms": 1, "slabs": 0, "slabArea": "0", "roofs": 0, "stairs": 0, "elements": 1 },
    "new": { "walls": 1, "wallLength": 2340864, "separators": 0, "openings": 2, "rooms": 1, "slabs": 1, "slabArea": "8523891081216", "roofs": 0, "stairs": 0, "elements": 1 }
  },
  "states": {
    "existing": { "rooms": { "R1": "20129817804800", "R2": "6361471664128", "R3": "6361471664128" }, "area": "32852761133056" },
    "proposed": { "rooms": { "R1": "23503858024448", "R2": "6361471664128", "R4": "2987431444480" }, "area": "32852761133056" }
  }
}
```

That is the suite's remodel (`examples/001-kitchen-remodel`): the wall between the Kitchen and the
Utility room comes down with its door, the Utility room and an old counter; the Kitchen takes the
Utility room's west half, 132 ft² as it stands and 154 ft² when the work is done; a new wall with a
new door makes a Laundry of the east half; a new window lights the Kitchen's new floor, an island is
new, and so is an 8' × 7' deck. The house's net area does not change: the floor the old wall stood
on is the floor the new one stands on.

A deriver MUST derive these values exactly as this chapter defines. {#FS-RENO-5.1.1 MUST}

## 5.2 Statuses

`status` has three members, `existing`, `demolish` and `new`: the IDs of every element of the seven
collections of 1.3 and every extension element, each in the list of its status (2.1). An element
without a status — a junction, a level — is in none.

What each filter draws is the table of 3.1 applied to `status`.

## 5.3 Quantities

`quantities` has a member for each status, and each counts the elements of that status:

| Member | What it is |
|---|---|
| `walls`, `separators`, `openings`, `rooms`, `slabs`, `roofs`, `stairs` | how many elements of that collection have the status; `roofs` and `stairs` are `0` in a Core 0.2 document |
| `wallLength` | the sum of the lengths of the walls of that status: a straight wall's length is the exact length of its location line rounded once, with `round()` (Core §2.2); an arc wall's is its length `L` (Core 0.4, §21.5) |
| `slabArea` | the sum of the areas of the slabs of that status: each slab's `boundary` by the shoelace formula, exactly, written as Core writes a net area (Core §6.4) |
| `elements` | how many extension elements have the status |

These are a remodel's take-off: how much wall comes down, how much is built, how many doors and
windows, how much deck. A wall's length is its location line's, the same for every layer: what a
quantity of drywall or studs is, is an estimate's to say.

## 5.4 States

`states` has two members, `existing` and `proposed`, each derived from the view of that state (2.2):

- `rooms`: every room of the view, by ID, with its net area (Core §6.4) in the view, written as Core
  writes a net area;
- `area`: the sum of those net areas, written the same way.

These are the before and after of a remodel's area report: the Kitchen's area as it is and as it
will be, the rooms that go and the rooms that come, and how the house's net area changes.

# 6. Editing

## 6.1 Editing statuses

Floorspec Ops edits FS_renovation's data as it edits any member: `setProperty` and `unsetProperty`
with the path `/extensions/FS_renovation/status` of a core element, creating the element's
`extensions` and its FS_renovation data on the way (Ops §2.3), and with the path
`/extensions/FS_renovation/elements/<ID>` of `$document` for an extension element. An applier that
implements FS_renovation and knows it rejects a batch whose result breaks an invariant of chapter 4
(Ops §1.2.3): marking a wall `"demolish"` while its door stays `"existing"`, or demolishing the wall
between two rooms that are both in the proposed state.

The pieces of a wall that Ops splits copy its members (Ops §5.2), its status among them, so a
demolished wall that a new wall crosses is demolished on both sides of the crossing.

Software that marks a wall `"demolish"` or `"new"` SHOULD mark every opening in it, and every extension element hosted on it, with the same status unless its user says otherwise, and SHOULD say so. {#FS-RENO-6.1.1 SHOULD}

Software that removes an extension element SHOULD remove its member of `elements` in the same batch. {#FS-RENO-6.1.2 SHOULD}

Software that creates an element in a document that uses FS_renovation SHOULD give it the status `"new"` unless its user chooses another. {#FS-RENO-6.1.3 SHOULD}
An existing house is drawn first, with no statuses; the remodel is drawn after, and what is drawn
then is new.

# 7. What this version does not define

- **Phases.** Two states — existing and proposed — and no phase list: a remodel built in stages
  (Revit's phases) is not described by 0.1. A later version may add phases without changing what the
  three statuses mean.
- **A replacement in place.** The combined document is one Core document, so a new wall cannot be
  drawn on top of a demolished one (Core §5.3): a wall rebuilt where it stands is changed, not
  demolished and drawn again.
- **Temporary work** — shoring, protection — and **salvage**: what is demolished is gone.
- **A change to what stays.** A status is of a whole element: a new finish, a new floor or a
  thicker lining on an existing wall is not a status, and the proposed state has the element as the
  document describes it. Junctions, levels, types, materials and assets have no status.

# 8. Related

## 8.1 Related

FLR-T-18.13 (renovation plans), FLR-ADR-048 (renovation status as FS_renovation: three statuses, two
states each a Core view, four filters, no phase list), FLR-REQ-092 (Release Candidate until a second
independent implementation), FLR-ADR-001 (a tiny core; everything else an `FS_` extension),
FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise; findings never say a design meets a
code). Floorspec Core 0.2, 0.3 and 0.4: §1.6 and chapter 12 (extension data on core elements, and
extension elements), §3.2 (references), chapter 6 (rooms, faces, net area), §10.1 and §10.2 (tiers
and diagnostics), chapter 19 (design options and views, which a state's view follows), §21.5 (an arc
wall's length); Ops §2.3 (`setProperty`) and §5.2 (splitting copies members).
