# FS_electrical 0.1.0

> [!warning] Release Candidate
> FS_electrical 0.1.0 is a **Release Candidate** (`registry/README.md`): specified, with a schema
> and a conformance suite, and frozen unless implementations find a problem. It becomes Ratified
> only when a second, independent implementation passes its conformance suite (FLR-REQ-092). It
> builds on Floorspec Core 0.2 and 0.3, which are Drafts.

FS_electrical describes a house's electrical system: the **panels** that distribute power, the
**circuits** that leave them, and what those circuits feed — **receptacles**, **lights**, **smoke
and carbon monoxide alarms**, **EV chargers** — together with the **switches** that control
lights and receptacles. Every device is an extension element (Core 12.5): it has a fallback box,
so a reader without FS_electrical still shows it, and it is usually hosted on a wall face or a
ceiling (Core 13), so it follows the wall when the wall moves.

This extension describes a design. It never says that a design meets a code: a finding about a
code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Elements | panels, receptacles, switches, lights, alarms, EV chargers; fallbacks and clearances |
| 3. Circuits | circuits, loads, panel spaces, feeders |
| 4. Control | switches and what they control |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | the room of an element, circuits, panels, control, rooms |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-ELEC-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_electrical/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_electrical` |
| Version | `0.1.0` |
| Status | Release Candidate |
| Registry entry | `registry/FS_electrical/extension.json` |
| Schema | `registry/FS_electrical/electrical.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_electrical/0.1.0/electrical.schema.json` |
| Requires | nothing |
| Core drafts | `0.2` and `0.3`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `panels`, `receptacles`, `switches`, `lights`, `alarms`, `evChargers` (none requires an asset or a symbol) |
| Statement IDs | `FS-ELEC-` |
| Diagnostic codes | `FS-ELEC-SCH-`, `FS-ELEC-INV-`, `FS-ELEC-LINT-` |

## 1.2 Conformance

FS_electrical places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_electrical 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_electrical (Core §1.6.4), so a
document may list FS_electrical in `extensionsRequired` and still be read.

A validator's known extensions (Core §12.2) say which extensions it can judge a document against.
FS_electrical uses them the same way: its rules apply when the validator knows the version the
document targets — normally because the validator is configured with this specification's registry
entry.

A validator that implements FS_electrical 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"` or `"0.3"` — a Core draft this version lists (1.1) — and uses FS_electrical at a version at which FS_electrical is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-ELEC-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_electrical's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-ELEC-INV-`) when it reported `FS-ELEC-SCH-001`, and MUST NOT evaluate its lints (`FS-ELEC-LINT-`) unless the document is valid. {#FS-ELEC-1.2.2 MUST NOT}
FS_electrical's diagnostics are therefore part of tier 4 (Core §10.1) when they are errors, and of
tier 5 when they are lints: an `FS-ELEC-` error makes a document invalid, and a document with one
reports no lint, Core's included. Each extension a validator implements is evaluated on its own;
an error of one does not stop another's invariants from being evaluated.

A validator that implements FS_electrical MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-ELEC-1.2.3 MUST}

A deriver that implements FS_electrical MUST derive the values of chapter 6 for every valid document for which FS_electrical was evaluated, and MUST NOT derive them for any other document. {#FS-ELEC-1.2.4 MUST}

A reader that does not implement FS_electrical, or that does not know this version, reads a
document that uses it as Core §1.6.9 says: it finds the extension's elements, checks their core
members, and derives their fallbacks, placements and clearances — and nothing of chapters 3 to 6.

## 1.3 Data

FS_electrical's top-level data, `extensions.FS_electrical`, is an object with two members, both
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |
| `circuits` | object: ID → circuit | `{}` | the circuits of chapter 3 |

FS_electrical's top-level data MUST match the schema `electrical.schema.json` of this version. {#FS-ELEC-1.3.1 MUST}

A circuit is not an element: it has no fallback and no place in the building. But its ID is in the
document's one space of IDs (Core §3.1.3), so that a diagnostic can name it among its elements and
nothing else can be mistaken for it.

A circuit's ID MUST NOT be the ID of an element, a program item or an extension element. {#FS-ELEC-1.3.2 MUST NOT}
Ops 0.2 does not mint circuit IDs. `C1`, `C2` … are a good choice: `C` is no prefix Ops mints with
(Ops §1.5).

FS_electrical 0.1 defines no data on core elements (`extensions.FS_electrical` on a wall, a room
…). A writer preserves such data (Core §1.6.6), and an implementation of this version does not
read it.

## 1.4 Units

Electrical quantities are JSON integers: **volts** for a nominal voltage, **amperes** for a
rating, **watts** for a connected load (taken as volt-amperes). Lengths are Core lengths (Core §2.1).
Nothing in FS_electrical is a fraction.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which Floorspec Core
checks. A member with a default may be omitted; canonicalization never omits it for you (Core
§12.5).

## 2.1 Panels

A **panel** (`panels`) is a panelboard or load centre: the main panel or a subpanel.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `volts` | array of distinct integers, at least one | — (always present) | the nominal voltages it supplies, such as `[120, 240]` or `[230]` |
| `rating` | integer ≥ 1 | — (always present) | its bus rating, in amperes |
| `mainBreaker` | integer ≥ 1 | absent: a main-lug panel | its main breaker, in amperes |
| `spaces` | integer ≥ 1 | — (always present) | the breaker spaces it has, one per pole |
| `fedBy` | ID of a circuit | absent: fed by the service | the circuit that feeds it, for a subpanel (3.4) |

## 2.2 Receptacles

A **receptacle** (`receptacles`) is a receptacle outlet: a duplex receptacle, a USB receptacle,
a 240 V range or dryer receptacle.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `volts` | integer | `120` | its nominal voltage |
| `amps` | integer ≥ 1 | `15` | its rating, in amperes |
| `outlets` | integer 1–16 | `2` | the sockets it has |
| `features` | array of distinct `"gfci"`, `"afci"`, `"usb"`, `"tamperResistant"`, `"weatherResistant"` | `[]` | what it is besides a plain receptacle: ground-fault or arc-fault protection at the device, USB charging ports, shutters, a weather-resistant body |
| `watts` | integer ≥ 0 | absent | the load connected to it, when it serves a known appliance |

## 2.3 Switches

A **switch** (`switches`) is a wall switch or another control: a dimmer, a timer, an occupancy
sensor.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `control` | `"single"`, `"threeWay"`, `"fourWay"`, `"dimmer"`, `"timer"`, `"occupancy"` or `"smart"` | `"single"` | how it switches |
| `controls` | array of distinct IDs | `[]` | what it switches (4.1) |

A switch is never a load (3.2): it sits on a circuit's wiring, but draws nothing a schedule counts.

## 2.4 Lights

A **light** (`lights`) is a luminaire.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `fixture` | `"ceiling"`, `"recessed"`, `"pendant"`, `"wall"`, `"track"`, `"underCabinet"`, `"fan"` or `"exterior"` | `"ceiling"` | what kind of luminaire; `"fan"` is a ceiling fan with a light |
| `volts` | integer | `120` | its nominal voltage |
| `watts` | integer ≥ 0 | absent | its connected load |

## 2.5 Alarms

An **alarm** (`alarms`) is a smoke alarm, a carbon monoxide alarm, a heat alarm, or one that is
several of them.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `detects` | array of distinct `"smoke"`, `"carbonMonoxide"`, `"heat"`, at least one | — (always present) | what it detects |
| `power` | `"battery"`, `"mains"` or `"mainsWithBattery"` | `"mainsWithBattery"` | how it is powered |
| `volts` | integer | `120` | its nominal voltage, when mains-powered |
| `interconnect` | string, 1–64 characters | absent | a label: alarms with the same label sound together |
| `watts` | integer ≥ 0 | absent | its connected load |

## 2.6 EV chargers

An **EV charger** (`evChargers`) is electric vehicle supply equipment.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `volts` | integer | `240` | its nominal voltage |
| `amps` | integer ≥ 1 | — (always present) | its charging current, in amperes |
| `connector` | `"j1772"`, `"nacs"`, `"ccs1"`, `"ccs2"` or `"type2"` | absent | its vehicle connector |
| `watts` | integer ≥ 0 | absent | its connected load |

## 2.7 Fallbacks and clearances

No kind of FS_electrical requires an asset or a symbol in its fallback (Core §12.4.2): a box is
enough to show where a device is.

A writer that adds an element of FS_electrical SHOULD give its fallback a 2D `symbol`, so that a reader without the extension draws it as a plan symbol rather than a box. {#FS-ELEC-2.7.1 SHOULD}

A panel needs space kept clear in front of it to be worked on. Floorspec's **default envelope** for
a panel is named `working`, with the purpose `workingSpace` (Core §13.5), in the panel's frame:

| | x (forward) | y (left) | z (up) |
|---|---|---|---|
| `min` | `0` | the lesser of `box.min.y` and −400 mm | `−h` |
| `max` | 1,000 mm | the greater of `box.max.y` and 400 mm | 2,000 mm − `h` |

where `box` is the panel's fallback box and `h` is the height of its frame's origin above the floor
it stands over: a `wallFace` host's `height`, and `0` for any other host. So the envelope runs from
the face the panel is on, 1,000 mm into the room, at least 800 mm wide and centred on the panel,
from the floor to 2,000 mm above it.

These dimensions are Floorspec's own round defaults, chosen so that every panel has a working space
a rule can test. They are not taken from any code, and they are not a code's requirement: what a
jurisdiction asks is a rule's to say, in a Floorspec Rules pack, which cites its source.

A writer that adds a panel SHOULD give it the default envelope `working`, or an envelope with the purpose `workingSpace` that it has better information for. {#FS-ELEC-2.7.2 SHOULD}
A panel without one gets the lint `FS-ELEC-LINT-006`.

# 3. Circuits

## 3.1 Circuits

A **circuit**, in `circuits`, is a branch circuit or a feeder leaving a panel.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `panel` | ID of a panel | — (always present) | the panel it is on |
| `breaker` | integer ≥ 1 | — (always present) | its overcurrent device, in amperes |
| `poles` | `1`, `2` or `3` | `1` | the poles of its breaker: the spaces it takes |
| `volts` | integer | — (always present) | its nominal voltage |
| `rating` | integer ≥ 1 | absent | its conductors' rating (ampacity), in amperes |
| `protection` | array of distinct `"gfci"`, `"afci"` | `[]` | protection at the breaker |
| `space` | integer ≥ 1 | absent: not assigned | the first panel space it takes (3.3) |
| `loads` | array of distinct IDs | `[]` | the elements it feeds (3.2) |
| `name` | string, 1–200 characters | absent | a label: "Kitchen counter 1" |
| `extras` | object | `{}` | Core §1.7 |

```json
"circuits": {
  "C1": { "panel": "X1", "breaker": 20, "volts": 120, "rating": 20, "space": 1,
          "protection": ["afci"], "loads": ["X2", "X3"], "name": "Kitchen counter 1" }
}
```

A circuit's `panel` MUST be the ID of a panel of FS_electrical. {#FS-ELEC-3.1.1 MUST}

A circuit's `volts` MUST be one of its panel's `volts`. {#FS-ELEC-3.1.2 MUST}

## 3.2 Loads

A circuit's `loads` are what it feeds. A load is an element of FS_electrical that draws power — a
receptacle, a light, an alarm or an EV charger — or an element of another extension: a water
heater of FS_plumbing, a furnace of FS_mechanical. FS_electrical reads only its own elements'
members; of another extension's element it knows only that it exists.

Every load of a circuit MUST be the ID of an extension element of the document. {#FS-ELEC-3.2.1 MUST}

A load MUST NOT be a panel or a switch of FS_electrical. {#FS-ELEC-3.2.2 MUST NOT}
A subpanel is fed through its `fedBy` (3.4), and a switch draws nothing.

An element MUST NOT be a load of circuits on two different panels. {#FS-ELEC-3.2.3 MUST NOT}
An element may be a load of two circuits of one panel: a split-wired kitchen receptacle, fed by
both circuits of a multiwire branch circuit, is.

A receptacle, light, alarm or EV charger that is a load of a circuit MUST have that circuit's `volts` as its own `volts`. {#FS-ELEC-3.2.4 MUST}
A 240 V EV charger on a 120 V circuit is a contradiction in the design, not a question for a rule.

An alarm whose `power` is `"battery"` MUST NOT be a load. {#FS-ELEC-3.2.5 MUST NOT}

The **connected load** of a circuit is the sum of the `watts` of its loads that are elements of
FS_electrical and have `watts`. Its **capacity** is its `breaker` times its `volts`. A circuit whose
connected load exceeds its capacity gets a lint (5.3); neither value says anything about what a
code allows.

> [!note] Removing a load
> Floorspec Ops 0.2 does not follow references inside an extension's own members (Ops §0.5). An
> applier that implements FS_electrical and knows it rejects a batch that removes a receptacle a
> circuit still lists: the result breaks 3.2.1. Remove the ID from the circuit's `loads` in the
> same batch — `setProperty` of `$document`, `/extensions/FS_electrical/circuits/C1/loads`.

## 3.3 Panel spaces

A circuit with a `space` takes the panel spaces `space` to `space + poles − 1`.

The spaces a circuit takes MUST all be spaces of its panel: `space + poles − 1` MUST NOT exceed the panel's `spaces`. {#FS-ELEC-3.3.1 MUST}

Two circuits of one panel MUST NOT take the same space. {#FS-ELEC-3.3.2 MUST NOT}

## 3.4 Feeders

A subpanel's `fedBy` names the circuit that feeds it: a circuit of another panel, whose loads are
the subpanel's own circuits' loads, one level down.

A panel's `fedBy` MUST be the ID of a circuit. {#FS-ELEC-3.4.1 MUST}

A panel MUST NOT be fed by a circuit of itself, directly or through the panels that feed it. {#FS-ELEC-3.4.2 MUST NOT}
That is: following `fedBy` to a circuit, then that circuit's `panel`, and so on, never leads back
to the panel. The chain stops at a panel without `fedBy`, at a `fedBy` that is not a circuit, and
at a circuit whose `panel` is not a panel.

# 4. Control

## 4.1 Switch control

A switch's `controls` lists what it switches: lights, switched receptacles, and elements of other
extensions — an exhaust fan of FS_mechanical. Two switches that list the same light are a three-way
pair; there is no other link between them.

Every ID in a switch's `controls` MUST be a light or a receptacle of FS_electrical, or an extension element of another extension. {#FS-ELEC-4.1.1 MUST}

A light that no switch controls gets the lint `FS-ELEC-LINT-002`, an `info`: a pull-chain light or
one controlled from somewhere this version cannot describe is fine.

# 5. Diagnostics

## 5.1 Codes

FS_electrical's diagnostic codes are `FS-ELEC-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH` for the extension's schema, `INV` for its invariants, `LINT` for its lints. A
diagnostic is a Core diagnostic (Core §10.2) in every other way: `elements` lists IDs, sorted; a
circuit is named by its ID.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-ELEC-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-ELEC-INV-001` | error | a circuit's ID is the ID of an element, a program item or an extension element | the ID | 1.3.2 |
| `FS-ELEC-INV-002` | error | a circuit's `panel` is not a panel of FS_electrical | the circuit | 3.1.1 |
| `FS-ELEC-INV-003` | error | a load is not an extension element; once for each such load | the circuit | 3.2.1 |
| `FS-ELEC-INV-004` | error | a load is a panel or a switch | the circuit and the load | 3.2.2 |
| `FS-ELEC-INV-005` | error | an element is a load of circuits on two different panels | the element | 3.2.3 |
| `FS-ELEC-INV-006` | error | a receptacle, light, alarm or EV charger is a load of a circuit of another voltage | the circuit and the load | 3.2.4 |
| `FS-ELEC-INV-007` | error | a circuit's `volts` is not one of its panel's | the circuit and the panel | 3.1.2 |
| `FS-ELEC-INV-008` | error | a circuit takes a space its panel does not have | the circuit and the panel | 3.3.1 |
| `FS-ELEC-INV-009` | error | two circuits of one panel take the same space; once for each pair | both circuits | 3.3.2 |
| `FS-ELEC-INV-010` | error | a switch controls something that is neither a light or receptacle of FS_electrical nor an element of another extension; once for each | the switch | 4.1.1 |
| `FS-ELEC-INV-011` | error | a panel's `fedBy` is not a circuit | the panel | 3.4.1 |
| `FS-ELEC-INV-012` | error | a panel is fed by a circuit of itself, directly or not; once for each panel on such a loop | the panel | 3.4.2 |
| `FS-ELEC-INV-013` | error | a battery-powered alarm is a load | the circuit and the alarm | 3.2.5 |

Not every invariant is evaluated for every element:

- `FS-ELEC-INV-007`, `FS-ELEC-INV-008` and `FS-ELEC-INV-009` are evaluated only for circuits
  without `FS-ELEC-INV-002`; `FS-ELEC-INV-008` and `FS-ELEC-INV-009` only for circuits with a
  `space`.
- `FS-ELEC-INV-004`, `FS-ELEC-INV-006` and `FS-ELEC-INV-013` are evaluated only for a load that is
  an extension element; `FS-ELEC-INV-006` and `FS-ELEC-INV-013` only for one without
  `FS-ELEC-INV-004`, and `FS-ELEC-INV-006` only for one without `FS-ELEC-INV-013`.
- `FS-ELEC-INV-005` counts only the circuits that list the element as a load without
  `FS-ELEC-INV-003` or `FS-ELEC-INV-004`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-ELEC-5.2.1 MUST NOT}

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-ELEC-LINT-001` | warning | a receptacle, light, EV charger, or alarm not powered by battery alone, that is a load of no circuit | the element |
| `FS-ELEC-LINT-002` | info | a light that no switch controls | the light |
| `FS-ELEC-LINT-003` | warning | a circuit whose `breaker` exceeds its `rating` | the circuit |
| `FS-ELEC-LINT-004` | warning | a circuit whose connected load exceeds its capacity (3.2) | the circuit |
| `FS-ELEC-LINT-005` | info | a circuit with no loads | the circuit |
| `FS-ELEC-LINT-006` | warning | a panel with no clearance envelope whose purpose is `workingSpace` (2.7) | the panel |
| `FS-ELEC-LINT-007` | warning | an EV charger whose `amps` exceeds the `breaker` of a circuit it is a load of; once for each such circuit | the circuit and the charger |

Lints never make a document invalid. They say that a design is incomplete or looks wrong; none
says that it does or does not meet a code.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_electrical was evaluated, a deriver derives the object below as
the member `FS_electrical` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every list of IDs is sorted; every object's members are in ID order.

```json
{
  "circuits": { "C1": { "panel": "X1", "loads": ["X2", "X3"], "connectedLoad": 1500, "capacity": 2400 } },
  "panels": { "X1": { "circuits": ["C1", "C2"], "spacesUsed": 2, "connectedLoad": 1500 } },
  "controls": { "X22": ["X21"] },
  "rooms": { "R1": ["X2", "X3", "X21", "X22"] }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-ELEC-6.1.1 MUST}

**The room of an element.** Every extension element is in at most one room:

- an element with a `surface` host is in the host's room;
- an element with a `wallFace` host is in the room whose face (Core §6.1) is on the host's side of
  the wall: on side `"left"`, the face to the left of the wall's location line walked from its start
  to its end; on side `"right"`, the face to its right — or in no room when no room is anchored in
  that face;
- an element with a `free` host is in the room anchored in the bounded face that contains the
  host's `position`, or in no room when the position is on a location line or in no bounded face
  with a room;
- an element without a host is in no room.

## 6.2 Circuits

`circuits` has a member for every circuit: its `panel`, its `loads`, its connected load
`connectedLoad` and its `capacity` (3.2), in watts.

## 6.3 Panels

`panels` has a member for every panel: the `circuits` whose `panel` it is, `spacesUsed` — the sum
of their `poles`, whether or not they have a `space` — and `connectedLoad`, the sum of their
connected loads.

## 6.4 Control and rooms

`controls` has a member for every ID that some switch's `controls` lists: the switches that list
it. `rooms` has a member for every room that holds an element of FS_electrical (6.1): those
elements.

These are the values a panel schedule, a circuit directory and a device count by room are built
from.

# 7. Related

## 7.1 Related

FLR-REQ-086 (what FS_electrical models), FLR-REQ-092 (Release Candidate until a second independent
implementation), FLR-ADR-001 (building systems are `FS_` extensions), FLR-ADR-007 (the extension
model), FLR-ADR-011 (rules advise; findings never say a design meets a code). Floorspec Core 0.2 and 0.3
chapters 12 (extensions) and 13 (hosting and clearances); Floorspec Ops 0.2 §2.7 (hosted elements
follow their hosts).
