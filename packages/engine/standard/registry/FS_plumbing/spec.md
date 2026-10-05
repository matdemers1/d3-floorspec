# FS_plumbing 0.1.0

> [!warning] Release Candidate
> FS_plumbing 0.1.0 is a **Release Candidate** (`registry/README.md`): specified, with a schema and
> a conformance suite, and frozen unless implementations find a problem. It becomes Ratified only
> when a second, independent implementation passes its conformance suite (FLR-REQ-092). It builds
> on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_plumbing describes a house's plumbing as a designer draws it: the **fixtures** — water closets,
lavatories, sinks, tubs, showers, appliance connections — the **water heaters** that feed them hot
water, the **drains** and **cleanouts** in the floor and the walls, and the **stacks** they all
connect to. A stack here is **logical**: it says what drains where and which levels a stack passes
through, not where the pipe runs. Pipe routing is not in this version.

This extension describes a design. It never says that a design meets a code: what a code asks —
clearances, fixture units, venting — is a rule's, in a Floorspec Rules pack, and a rule advises
(FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Elements | fixtures, water heaters, drains, cleanouts; fallbacks and clearances |
| 3. Connections | stacks and what drains to them; hot water |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | the room of an element, stacks, water heaters, rooms |
| 6. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-PLMB-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_plumbing/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_plumbing` |
| Version | `0.1.0` |
| Status | Release Candidate |
| Registry entry | `registry/FS_plumbing/extension.json` |
| Schema | `registry/FS_plumbing/plumbing.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_plumbing/0.1.0/plumbing.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `fixtures`, `waterHeaters`, `drains`, `cleanouts` (none requires an asset or a symbol) |
| Statement IDs | `FS-PLMB-` |
| Diagnostic codes | `FS-PLMB-SCH-`, `FS-PLMB-INV-`, `FS-PLMB-LINT-` |

## 1.2 Conformance

FS_plumbing places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_plumbing 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_plumbing (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_plumbing 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_plumbing at a version at which FS_plumbing is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-PLMB-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_plumbing's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-PLMB-INV-`) when it reported `FS-PLMB-SCH-001`, and MUST NOT evaluate its lints (`FS-PLMB-LINT-`) unless the document is valid. {#FS-PLMB-1.2.2 MUST NOT}
FS_plumbing's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-PLMB-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own.

A validator that implements FS_plumbing MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-PLMB-1.2.3 MUST}

A deriver that implements FS_plumbing MUST derive the values of chapter 5 for every valid document for which FS_plumbing was evaluated, and MUST NOT derive them for any other document. {#FS-PLMB-1.2.4 MUST}

A reader that does not implement FS_plumbing, or does not know this version, reads its elements as
Core §1.6.9 says — fallbacks, placements and clearances, and nothing of chapters 3 to 5.

## 1.3 Data

FS_plumbing's top-level data, `extensions.FS_plumbing`, is an object with two members, both
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |
| `stacks` | object: ID → stack | `{}` | the logical stacks of chapter 3 |

FS_plumbing's top-level data MUST match the schema `plumbing.schema.json` of this version. {#FS-PLMB-1.3.1 MUST}

A stack is not an element: it has no fallback and no place in plan. Its ID is in the document's one
space of IDs (Core §3.1.3), so that a diagnostic can name it.

A stack's ID MUST NOT be the ID of an element, a program item or an extension element. {#FS-PLMB-1.3.2 MUST NOT}
Ops 0.2 does not mint stack IDs; `K1`, `K2` … are a good choice, since `K` is no prefix Ops mints
with (Ops §1.5).

FS_plumbing 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and an
implementation of this version does not read it.

## 1.4 Units

A **volume** is a JSON integer number of millilitres; a **power** an integer number of watts; a
pipe size a Core length (Core §2.1). Nothing in FS_plumbing is a fraction.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which Floorspec Core checks.

A fixture standing on a floor is usually hosted on the room's floor (a `surface` host); a wall-hung
lavatory, a hose bibb or a cleanout on a wall face (a `wallFace` host). For a fixture against a wall,
the convention is that its frame's origin is the middle of its back, facing out of the wall — so
that forward (+x) is the side a person uses it from, and its clearances (2.5) are in front of it.

## 2.1 Fixtures

A **fixture** (`fixtures`) is a plumbing fixture, or the connection of an appliance that uses water.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `fixture` | `"waterCloset"`, `"lavatory"`, `"kitchenSink"`, `"barSink"`, `"laundryTub"`, `"mopSink"`, `"bathtub"`, `"shower"`, `"bathtubShower"`, `"bidet"`, `"urinal"`, `"clothesWasher"`, `"dishwasher"`, `"hoseBibb"` or `"iceMaker"` | — (always present) | what it is |
| `supply` | array of distinct `"cold"`, `"hot"` | absent: not stated | the water it is supplied with |
| `hotFrom` | ID of a water heater | absent | the water heater its hot water comes from (3.2) |
| `drain` | ID of a stack or a drain | absent | what it drains to (3.1) |

## 2.2 Water heaters

A **water heater** (`waterHeaters`) heats and, for a storage heater, stores the house's hot water.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `heater` | `"storage"`, `"tankless"`, `"heatPump"` or `"indirect"` | — (always present) | how it heats |
| `energy` | `"electric"`, `"naturalGas"`, `"propane"`, `"oil"` or `"solar"` | — (always present) | what it runs on; a heat pump runs on `"electric"` |
| `capacity` | integer ≥ 1 | absent | what it stores, in millilitres |
| `input` | integer ≥ 1 | absent | its input rating, in watts |
| `combustionAir` | `"indoor"`, `"outdoor"` or `"direct"` | absent | for a heater that burns fuel: where its combustion air comes from — the space it stands in, outdoors through a duct or an opening, or a sealed connection to outdoors |
| `drain` | ID of a stack or a drain | absent | what its relief valve and pan discharge to (3.1) |

A water heater that burns fuel — `energy` `"naturalGas"`, `"propane"` or `"oil"` — states where
its combustion air comes from in `combustionAir`; one that burns nothing has no combustion air.

A water heater whose `energy` is `"electric"` or `"solar"` MUST NOT have `combustionAir`. {#FS-PLMB-2.2.1 MUST NOT}

## 2.3 Drains

A **drain** (`drains`) is a receptor in the floor or a wall: a floor drain, a trench or area drain,
a standpipe, a floor sink. Fixtures and water heaters may drain to it — the indirect waste of a
water heater's relief valve, a washer's standpipe.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `receptor` | `"floor"`, `"trench"`, `"area"`, `"standpipe"` or `"floorSink"` | — (always present) | what kind of receptor |
| `drain` | ID of a stack | absent | the stack it drains to (3.1) |

## 2.4 Cleanouts

A **cleanout** (`cleanouts`) is an access point to a drain line, on a floor or a wall.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `stack` | ID of a stack | — (always present) | the stack it opens (3.1) |

## 2.5 Fallbacks and clearances

No kind of FS_plumbing requires an asset or a symbol in its fallback (Core §12.4.2).

A writer that adds an element of FS_plumbing SHOULD give its fallback a 2D `symbol`, so that a reader without the extension draws a fixture rather than a box. {#FS-PLMB-2.5.1 SHOULD}

Floorspec's **default envelopes**, in the element's frame, with `box` its fallback box:

| Kind | Name | Purpose | `min` | `max` |
|---|---|---|---|---|
| water closet | `front` | `fixtureClearance` | `[box.max.x, −400 mm, box.min.z]` | `[box.max.x + 600 mm, 400 mm, box.min.z + 2,000 mm]` |
| lavatory, kitchen sink, bar sink, laundry tub | `front` | `fixtureClearance` | `[box.max.x, box.min.y, box.min.z]` | `[box.max.x + 600 mm, box.max.y, box.min.z + 2,000 mm]` |
| water heater | `service` | `access` | `[box.max.x, box.min.y, box.min.z]` | `[box.max.x + 600 mm, box.max.y, box.max.z]` |
| cleanout | `access` | `access` | `[box.max.x, −225 mm, box.min.z]` | `[box.max.x + 450 mm, 225 mm, box.min.z + 450 mm]` |

So a water closet's `front` is 600 mm deep in front of it and 800 mm wide centred on it — which also
keeps 400 mm clear either side of its centreline in front of it — and a water heater's `service` is
600 mm in front of it, as wide and as tall as it is. These are Floorspec's own round defaults, not a
code's numbers; what a jurisdiction asks is a rule's to say, in a Floorspec Rules pack that cites
its source.

A writer that adds a water closet, a lavatory, a sink, a laundry tub, a water heater or a cleanout SHOULD give it the default envelope of the table, or an envelope of the same purpose that it has better information for. {#FS-PLMB-2.5.2 SHOULD}
A water closet without a `fixtureClearance` envelope, and a water heater or cleanout without an
`access` envelope, get the lint `FS-PLMB-LINT-004`.

# 3. Connections

## 3.1 Stacks and drainage

A **stack**, in `stacks`, is a logical drain, waste or vent stack: a name for "everything that
drains to the same riser", and the levels that riser passes through.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `stack` | `"drainWasteVent"`, `"drain"` or `"vent"` | `"drainWasteVent"` | what it carries: drainage and venting, drainage only, or venting only |
| `levels` | array of distinct IDs, at least one | — (always present) | the levels it passes through |
| `size` | length | absent | its nominal diameter |
| `outlet` | `"sewer"`, `"septic"` or `"other"` | absent | where it ends |
| `name` | string, 1–200 characters | absent | a label |
| `extras` | object | `{}` | Core §1.7 |

Every ID in a stack's `levels` MUST be the ID of a level. {#FS-PLMB-3.1.1 MUST}

A fixture's or a water heater's `drain` MUST be the ID of a stack or of a drain of FS_plumbing, and a drain's `drain` the ID of a stack. {#FS-PLMB-3.1.2 MUST}

An element MUST NOT drain to a stack whose `stack` is `"vent"`. {#FS-PLMB-3.1.3 MUST NOT}

An element that drains to a stack, and a cleanout, MUST be on a level the stack passes through: its fallback's `level` MUST be in the stack's `levels`. {#FS-PLMB-3.1.4 MUST}

A cleanout's `stack` MUST be the ID of a stack. {#FS-PLMB-3.1.5 MUST}

An element that drains to a drain is connected to the stack that drain drains to. A fixture with no
`drain` gets the lint `FS-PLMB-LINT-001`, except a hose bibb and an ice maker, which drain nowhere.

## 3.2 Hot water

A fixture's `hotFrom` names the water heater its hot water comes from.

A fixture's `hotFrom` MUST be the ID of a water heater of FS_plumbing. {#FS-PLMB-3.2.1 MUST}

A fixture with a `supply` and a `hotFrom` MUST have `"hot"` in its `supply`. {#FS-PLMB-3.2.2 MUST}

> [!note] Removing what something drains to
> Floorspec Ops 0.2 does not follow references inside an extension's own members (Ops §0.5). An
> applier that implements FS_plumbing and knows it rejects a batch that removes a drain or a water
> heater an element still names: the result breaks 3.1.2 or 3.2.1. Change or unset the reference
> in the same batch.

# 4. Diagnostics

## 4.1 Codes

FS_plumbing's diagnostic codes are `FS-PLMB-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way; a
stack is named by its ID.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-PLMB-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-PLMB-INV-001` | error | a stack's ID is the ID of an element, a program item or an extension element | the ID | 1.3.2 |
| `FS-PLMB-INV-002` | error | a `drain` names neither a stack nor, where allowed, a drain | the element | 3.1.2 |
| `FS-PLMB-INV-003` | error | an element drains to a vent stack | the element and the stack | 3.1.3 |
| `FS-PLMB-INV-004` | error | an element that drains to a stack, or a cleanout, is on a level the stack does not pass through | the element and the stack | 3.1.4 |
| `FS-PLMB-INV-005` | error | a fixture's `hotFrom` is not a water heater | the fixture | 3.2.1 |
| `FS-PLMB-INV-006` | error | a stack's `levels` names something that is not a level | the stack | 3.1.1 |
| `FS-PLMB-INV-007` | error | a cleanout's `stack` is not a stack | the cleanout | 3.1.5 |
| `FS-PLMB-INV-008` | error | a fixture has a `hotFrom` but no `"hot"` in its `supply` | the fixture | 3.2.2 |
| `FS-PLMB-INV-009` | error | a water heater that burns no fuel has `combustionAir` | the water heater | 2.2.1 |

`FS-PLMB-INV-004` is evaluated only for an element whose `drain` is a stack that is not a vent
stack, and for a cleanout without `FS-PLMB-INV-007`; `FS-PLMB-INV-008` only for a fixture without
`FS-PLMB-INV-005`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-PLMB-4.2.1 MUST NOT}

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-PLMB-LINT-001` | warning | a fixture other than a hose bibb or an ice maker that drains to nothing | the fixture |
| `FS-PLMB-LINT-002` | warning | a water heater that burns fuel and has no `combustionAir` | the water heater |
| `FS-PLMB-LINT-003` | info | a stack nothing drains to directly | the stack |
| `FS-PLMB-LINT-004` | warning | a water closet with no `fixtureClearance` envelope, or a water heater or cleanout with no `access` envelope (2.5) | the element |
| `FS-PLMB-LINT-005` | info | a fixture with `"hot"` in its `supply` and no `hotFrom` | the fixture |

Lints never make a document invalid, and none says whether a design meets a code.

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_plumbing was evaluated, a deriver derives the object below as the
member `FS_plumbing` of the derived values' `extensions`. Every list of IDs is sorted.

```json
{
  "stacks": { "K1": { "connected": ["X6", "X7", "X9"], "cleanouts": ["X10"] } },
  "waterHeaters": { "X8": { "fixtures": ["X7"] } },
  "rooms": { "R2": ["X6", "X7"], "R3": ["X8", "X9"] }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-PLMB-5.1.1 MUST}

**The room of an element** is as FS_electrical §6.1 defines it: the host's room for a `surface`
host; the room anchored in the face on the host's side of the wall for a `wallFace` host (the face
left of the wall's location line, walked from start to end, for `"left"`, and right of it for
`"right"`); the room anchored in the bounded face containing a `free` host's position, unless the
position is on a location line; and no room otherwise.

## 5.2 Stacks, water heaters and rooms

- `stacks` has a member for every stack: `connected`, every fixture, water heater and drain whose
  `drain` is the stack, and every fixture and water heater whose `drain` is a drain whose `drain` is
  the stack; and `cleanouts`, the cleanouts whose `stack` it is.
- `waterHeaters` has a member for every water heater: `fixtures`, the fixtures whose `hotFrom` it is.
- `rooms` has a member for every room that holds an element of FS_plumbing (5.1): those elements.

These are what a fixture schedule by room, a riser diagram's list of connections and a hot-water
distribution check are built from.

# 6. Related

## 6.1 Related

FLR-T-5.4, FLR-REQ-092 (Release Candidate until a second independent implementation), FLR-ADR-001
(building systems are `FS_` extensions), FLR-ADR-007 (the extension model), FLR-ADR-011 (rules
advise). Floorspec Core 0.2, 0.3 and 0.4 chapters 12 and 13; FS_electrical (whose circuits may feed an electric
water heater); FS_mechanical (fuel-burning appliances and their combustion air).
