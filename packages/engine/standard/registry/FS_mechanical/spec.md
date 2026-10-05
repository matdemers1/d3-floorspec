# FS_mechanical 0.1.0

> [!warning] Release Candidate
> FS_mechanical 0.1.0 is a **Release Candidate** (`registry/README.md`): specified, with a schema
> and a conformance suite, and frozen unless implementations find a problem. It becomes Ratified
> only when a second, independent implementation passes its conformance suite (FLR-REQ-092). It
> builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_mechanical describes a house's heating, cooling, ventilation and fuel gas: the **equipment** —
furnaces, air handlers, heat pumps, boilers, mini-splits, ventilators — the **terminals** it
serves, the **exhaust** fans and hoods, the **gas appliances**, and the **gas sources** — a meter or
a tank — they draw from. Every fuel-burning element says what it burns and where its **combustion
air** comes from. Ducts and gas piping are not routed in this version: a terminal names the
equipment that serves it, and an appliance the gas source it draws from.

This extension describes a design. It never says that a design meets a code: what a code asks is a
rule's, in a Floorspec Rules pack, and a rule advises (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Elements | equipment, terminals, exhaust, gas appliances; fallbacks and clearances |
| 3. Connections | gas sources; terminals and their equipment |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | the room of an element, gas sources, equipment, rooms |
| 6. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-MECH-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_mechanical/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_mechanical` |
| Version | `0.1.0` |
| Status | Release Candidate |
| Registry entry | `registry/FS_mechanical/extension.json` |
| Schema | `registry/FS_mechanical/mechanical.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_mechanical/0.1.0/mechanical.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `equipment`, `terminals`, `exhaust`, `gasAppliances` (none requires an asset or a symbol) |
| Statement IDs | `FS-MECH-` |
| Diagnostic codes | `FS-MECH-SCH-`, `FS-MECH-INV-`, `FS-MECH-LINT-` |

## 1.2 Conformance

FS_mechanical places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_mechanical 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_mechanical (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_mechanical 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_mechanical at a version at which FS_mechanical is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-MECH-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_mechanical's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-MECH-INV-`) when it reported `FS-MECH-SCH-001`, and MUST NOT evaluate its lints (`FS-MECH-LINT-`) unless the document is valid. {#FS-MECH-1.2.2 MUST NOT}
FS_mechanical's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-MECH-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own.

A validator that implements FS_mechanical MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-MECH-1.2.3 MUST}

A deriver that implements FS_mechanical MUST derive the values of chapter 5 for every valid document for which FS_mechanical was evaluated, and MUST NOT derive them for any other document. {#FS-MECH-1.2.4 MUST}

A reader that does not implement FS_mechanical, or does not know this version, reads its elements
as Core §1.6.9 says — fallbacks, placements and clearances, and nothing of chapters 3 to 5.

## 1.3 Data

FS_mechanical's top-level data, `extensions.FS_mechanical`, is an object with two members, both
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |
| `gasSources` | object: ID → gas source | `{}` | the gas sources of chapter 3 |

FS_mechanical's top-level data MUST match the schema `mechanical.schema.json` of this version. {#FS-MECH-1.3.1 MUST}

A gas source is not an element; its ID is in the document's one space of IDs (Core §3.1.3), so
that a diagnostic can name it.

A gas source's ID MUST NOT be the ID of an element, a program item or an extension element. {#FS-MECH-1.3.2 MUST NOT}
Ops 0.2 does not mint gas source IDs; `G1`, `G2` … are a good choice, since `G` is no prefix Ops
mints with (Ops §1.5).

FS_mechanical 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

## 1.4 Units

A **power** — an input, a heating or cooling output — is a JSON integer number of watts. An **air
flow** is an integer number of millilitres per second (a litre per second is 1,000). Nothing in
FS_mechanical is a fraction.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which Floorspec Core checks.

**Fuel and combustion air.** Equipment and gas appliances say what they burn. One that burns fuel
— natural gas, propane or oil — says where its combustion air comes from in `combustionAir`:

| `combustionAir` | Where the air comes from |
|---|---|
| `"indoor"` | the space the appliance is in |
| `"outdoor"` | outdoors, through a duct or an opening into the space |
| `"direct"` | a sealed connection to outdoors (a direct-vent or sealed-combustion appliance) |

and how it vents its combustion products in `vent`. Whether a space holds enough air for an indoor
appliance, or which rooms may hold one, is a rule's question.

## 2.1 Equipment

**Equipment** (`equipment`) heats, cools or ventilates.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `equipment` | `"furnace"`, `"airHandler"`, `"heatPump"`, `"airConditioner"`, `"boiler"`, `"miniSplit"`, `"fanCoil"`, `"erv"`, `"hrv"`, `"dehumidifier"` or `"humidifier"` | — (always present) | what it is |
| `fuel` | `"electric"`, `"naturalGas"`, `"propane"` or `"oil"` | `"electric"` | what it runs on |
| `input` | integer ≥ 1 | absent | its input rating, in watts |
| `heating` | integer ≥ 1 | absent | its heating output, in watts |
| `cooling` | integer ≥ 1 | absent | its cooling output, in watts |
| `airflow` | integer ≥ 1 | absent | its air flow, in millilitres per second |
| `combustionAir` | `"indoor"`, `"outdoor"` or `"direct"` | absent | where its combustion air comes from |
| `vent` | `"natural"`, `"power"` or `"direct"` | absent | how it vents its combustion products |
| `gasFrom` | ID of a gas source | absent | the gas source it draws from (3.1) |

Equipment whose `fuel` is `"electric"` MUST NOT have `combustionAir` or `vent`. {#FS-MECH-2.1.1 MUST NOT}

## 2.2 Terminals

A **terminal** (`terminals`) is where air enters or leaves a room: a supply register or diffuser, a
return grille, a transfer grille between rooms.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `terminal` | `"supply"`, `"return"` or `"transfer"` | — (always present) | what it does |
| `equipment` | ID of equipment | absent | the equipment that serves it (3.2) |
| `airflow` | integer ≥ 1 | absent | its design air flow, in millilitres per second |

## 2.3 Exhaust

An **exhaust** element (`exhaust`) moves air out: a bathroom fan, a range hood, a dryer vent, a
whole-house fan.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `exhaust` | `"bathFan"`, `"rangeHood"`, `"kitchenFan"`, `"dryerVent"` or `"wholeHouse"` | — (always present) | what it is |
| `airflow` | integer ≥ 1 | absent | its air flow, in millilitres per second |
| `discharge` | `"outdoors"` or `"recirculating"` | absent | where it discharges |

A switch of FS_electrical may control an exhaust fan (FS_electrical §4.1).

## 2.4 Gas appliances

A **gas appliance** (`gasAppliances`) burns fuel gas: a range, a cooktop, an oven, a dryer, a
fireplace, a space heater, a grill, a pool heater, a generator, a gas lamp.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `appliance` | `"range"`, `"cooktop"`, `"oven"`, `"dryer"`, `"fireplace"`, `"spaceHeater"`, `"grill"`, `"poolHeater"`, `"generator"` or `"lamp"` | — (always present) | what it is |
| `fuel` | `"naturalGas"` or `"propane"` | — (always present) | the gas it burns |
| `input` | integer ≥ 1 | absent | its input rating, in watts |
| `combustionAir` | `"indoor"`, `"outdoor"` or `"direct"` | absent | where its combustion air comes from |
| `vent` | `"none"`, `"natural"`, `"power"` or `"direct"` | absent | how it vents; `"none"` for an unvented appliance such as a range |
| `gasFrom` | ID of a gas source | absent | the gas source it draws from (3.1) |

A gas water heater is a water heater of FS_plumbing, which states its own energy and combustion air
(FS_plumbing §2.2).

## 2.5 Fallbacks and clearances

No kind of FS_mechanical requires an asset or a symbol in its fallback (Core §12.4.2).

A writer that adds an element of FS_mechanical SHOULD give its fallback a 2D `symbol`, so that a reader without the extension draws it as a plan symbol rather than a box. {#FS-MECH-2.5.1 SHOULD}

Furnaces, air handlers and boilers are serviced from the front. Floorspec's **default envelope**
for them is named `service`, with the purpose `workingSpace`, in the element's frame, with `box`
its fallback box:

| | x (forward) | y (left) | z (up) |
|---|---|---|---|
| `min` | `box.max.x` | the lesser of `box.min.y` and −375 mm | `box.min.z` |
| `max` | `box.max.x` + 750 mm | the greater of `box.max.y` and 375 mm | the greater of `box.max.z` and `box.min.z` + 2,000 mm |

That is, 750 mm in front of the unit, at least 750 mm wide and centred on it, and at least 2,000 mm
tall. These are Floorspec's own round defaults, not a code's numbers; what a jurisdiction or a
manufacturer asks is a rule's to say.

A writer that adds a furnace, an air handler or a boiler SHOULD give it the default envelope `service`, or an envelope with the purpose `workingSpace` that it has better information for. {#FS-MECH-2.5.2 SHOULD}
One without gets the lint `FS-MECH-LINT-004`.

# 3. Connections

## 3.1 Gas sources

A **gas source**, in `gasSources`, is where fuel gas enters the house: a utility meter or a tank.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `fuel` | `"naturalGas"` or `"propane"` | — (always present) | the gas it supplies |
| `source` | `"meter"` or `"tank"` | `"meter"` | what it is |
| `name` | string, 1–200 characters | absent | a label |
| `extras` | object | `{}` | Core §1.7 |

An element's `gasFrom` MUST be the ID of a gas source. {#FS-MECH-3.1.1 MUST}

An element that draws from a gas source MUST burn the gas it supplies: its `fuel` MUST be the gas source's `fuel`. {#FS-MECH-3.1.2 MUST}
A propane range on a natural gas meter, or electric equipment with a `gasFrom`, is a contradiction
in the design.

## 3.2 Terminals and equipment

A terminal's `equipment` MUST be the ID of equipment of FS_mechanical. {#FS-MECH-3.2.1 MUST}

A supply or return terminal that names no equipment gets the lint `FS-MECH-LINT-003`; a transfer
grille is served by none.

# 4. Diagnostics

## 4.1 Codes

FS_mechanical's diagnostic codes are `FS-MECH-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other
way; a gas source is named by its ID.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-MECH-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-MECH-INV-001` | error | a gas source's ID is the ID of an element, a program item or an extension element | the ID | 1.3.2 |
| `FS-MECH-INV-002` | error | a `gasFrom` is not a gas source | the element | 3.1.1 |
| `FS-MECH-INV-003` | error | an element's `fuel` is not its gas source's | the element and the gas source | 3.1.2 |
| `FS-MECH-INV-004` | error | a terminal's `equipment` is not equipment | the terminal | 3.2.1 |
| `FS-MECH-INV-005` | error | electric equipment has `combustionAir` or `vent` | the equipment | 2.1.1 |

`FS-MECH-INV-003` is evaluated only for an element without `FS-MECH-INV-002`. An element's `fuel`
is its own, with equipment's default `"electric"`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-MECH-4.2.1 MUST NOT}

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-MECH-LINT-001` | warning | equipment or a gas appliance that burns fuel and has no `combustionAir` | the element |
| `FS-MECH-LINT-002` | warning | a gas appliance, or equipment burning natural gas or propane, with no `gasFrom` | the element |
| `FS-MECH-LINT-003` | warning | a supply or return terminal that names no equipment | the terminal |
| `FS-MECH-LINT-004` | warning | a furnace, an air handler or a boiler with no clearance envelope whose purpose is `workingSpace` (2.5) | the equipment |
| `FS-MECH-LINT-005` | info | a gas source that nothing draws from | the gas source |

Lints never make a document invalid, and none says whether a design meets a code.

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_mechanical was evaluated, a deriver derives the object below as
the member `FS_mechanical` of the derived values' `extensions`. Every list of IDs is sorted.

```json
{
  "gasSources": { "G1": { "fuel": "naturalGas", "appliances": ["X10", "X14"], "input": 35200 } },
  "equipment": { "X10": { "terminals": ["X11", "X12"], "airflow": 188000 } },
  "rooms": { "R1": ["X11", "X12", "X14"], "R3": ["X10"] }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-MECH-5.1.1 MUST}

**The room of an element** is as FS_electrical §6.1 defines it: the host's room for a `surface`
host; the room anchored in the face on the host's side of the wall for a `wallFace` host (the face
left of the wall's location line, walked from start to end, for `"left"`, and right of it for
`"right"`); the room anchored in the bounded face containing a `free` host's position, unless the
position is on a location line; and no room otherwise.

## 5.2 Gas sources, equipment and rooms

- `gasSources` has a member for every gas source: its `fuel`; `appliances`, the equipment and gas
  appliances whose `gasFrom` it is; and `input`, the sum of their `input`s (an element without one
  adds nothing) — the connected gas load, in watts.
- `equipment` has a member for every equipment element: `terminals`, the terminals whose
  `equipment` it is, and `airflow`, the sum of their `airflow`s.
- `rooms` has a member for every room that holds an element of FS_mechanical (5.1): those elements.

# 6. Related

## 6.1 Related

FLR-T-5.5, FLR-REQ-092 (Release Candidate until a second independent implementation), FLR-ADR-001
(building systems are `FS_` extensions), FLR-ADR-007 (the extension model), FLR-ADR-011 (rules
advise). Floorspec Core 0.2, 0.3 and 0.4 chapters 12 and 13; FS_plumbing §2.2 (gas water heaters);
FS_electrical §4.1 (switches that control exhaust fans).
