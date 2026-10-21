# FS_thermal 0.1.0

> [!warning] Draft
> FS_thermal 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_thermal describes how heat moves through a house's envelope: what each **material** conducts and
stores — its thermal conductivity, density and specific heat, or a resistance stated whole for an
air space or a membrane — how a wall type's **framing** interrupts its insulation, the layers of a
**roof** and of a **floor**, and what a **door** or a **window** lets through, as its maker rates the
whole unit: its U-factor and its solar heat gain coefficient.

From these it derives one thing exactly: the thermal resistance and the heat capacity of every
layer of every assembly, and of each assembly's two paths — through its insulation, and through its
framing. Everything beyond that — the air films, the U-factor of an assembly, the heat a house loses
on a cold night — is a **method**, chosen and named by the software that applies it (3.3). Nothing
here is an energy-code calculation, and nothing here says that a house meets one (1.4).

FS_thermal adds no kind of element. Its data lives on the core elements it describes — a material's
own `extensions.FS_thermal`, a type's, a roof's, a room's for the room's floor (Core §12.7, "add
members to core elements"). A reader that does not implement it loses nothing of the house.

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, what FS_thermal is not, units |
| 2. Data on elements | materials, assemblies and framing, wall types, roofs and floors, doors and windows |
| 3. Resistances | a layer's resistance and heat capacity, an assembly's paths, from resistances to a U-factor |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | every assembly's layers and paths |
| 6. What this version does not define | |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-THRM-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_thermal/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_thermal` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_thermal/extension.json` |
| Schema | `registry/FS_thermal/thermal.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_thermal/0.1.0/thermal.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: its data is on core elements (1.3) |
| Statement IDs | `FS-THRM-` |
| Diagnostic codes | `FS-THRM-SCH-`, `FS-THRM-INV-`, `FS-THRM-LINT-` |

## 1.2 Conformance

FS_thermal places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_thermal 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_thermal (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_thermal 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_thermal at a version at which FS_thermal is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-THRM-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_thermal's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-THRM-INV-`) when it reported `FS-THRM-SCH-001`, and MUST NOT evaluate its lints (`FS-THRM-LINT-`) unless the document is valid. {#FS-THRM-1.2.2 MUST NOT}
FS_thermal's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-THRM-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are.

A validator that implements FS_thermal MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-THRM-1.2.3 MUST}

A deriver that implements FS_thermal MUST derive the values of chapter 5 for every valid document for which FS_thermal was evaluated, and MUST NOT derive them for any other document. {#FS-THRM-1.2.4 MUST}

A reader that does not implement FS_thermal, or does not know this version, ignores its data
(Core §1.6.9), and a writer preserves it (Core §1.6.6).

## 1.3 Data

FS_thermal's **top-level data**, `extensions.FS_thermal`, is an object with no members in this
version. What FS_thermal says is on the elements it says it about.

FS_thermal's top-level data MUST match the schema `thermal.schema.json` of this version. {#FS-THRM-1.3.1 MUST}

**Data on an element** is the element's own `extensions.FS_thermal` (Core §1.6). FS_thermal defines
it for materials, for the three kinds of type, for roofs and for rooms, and the schema's
`#/$defs/coreElements` names each: a material, a roof or a room — an element of collection `C` —
carries data that the schema accepts as the object `{ "C": data }`, and a type of kind `K` data that
it accepts as `{ "K": data }`, each checked against `#/$defs/coreElements`.

| Element | Checked as | Its data | Section |
|---|---|---|---|
| a material | `materials` | conductivity or a stated resistance, density, specific heat, solar reflectance, emittance | 2.1 |
| a wall type | `wallType` | its framing | 2.3 |
| a door type, a window type | `doorType`, `windowType` | the whole unit's U-factor and solar heat gain coefficient | 2.5 |
| a roof (Core 0.3) | `roofs` | its assembly: layers and framing | 2.4 |
| a room | `rooms` | its floor's assembly, and the insulation at its edge | 2.4 |

FS_thermal's data on a material, a type, a roof or a room MUST match the member of the schema's `#/$defs/coreElements` for that element's collection or, for a type, its kind. {#FS-THRM-1.3.2 MUST}

The `extensions` of any other element — a building, a level, a junction, a wall, a separator, an opening, a slab, an asset, a stair, a program item, an option set or an option — MUST NOT have a member `FS_thermal`. {#FS-THRM-1.3.3 MUST NOT}
A wall's assembly is its type's (Core §8.3), and an opening's its fill's (Core §8.4): what a wall or
an opening is made of is said once, on the type, and every wall and opening of the type shares it.

A document that breaks 1.3.1, 1.3.2 or 1.3.3 gets `FS-THRM-SCH-001`, once: all three are the schema
tier. An element's data is checked whether or not the document has top-level data.

## 1.4 What FS_thermal is not

FS_thermal records what a house's envelope is made of, so that its heat loss and gain can be
estimated and its choices compared — two sidings, two roofs, R-13 batts against R-21. It is not an
energy code's calculation, nor a load calculation that sizes equipment, nor a rating. The resistances
it derives are of the layers as written: they say nothing of how well the house is built, how tight
it is, or what a code asks of it.

A validator that implements FS_thermal MUST NOT report a diagnostic that depends on an energy code, a prescriptive or performance requirement, a climate or a load: whether an assembly insulates enough is no condition of chapter 4, and a document is valid or invalid under FS_thermal regardless of it. {#FS-THRM-1.4.1 MUST NOT}

Software that implements FS_thermal MUST NOT present its data, a value it derives from it, or the absence of a diagnostic as a statement that a house, an assembly, a door or a window complies with an energy code, meets a standard or is approved. {#FS-THRM-1.4.2 MUST NOT}
What a jurisdiction asks of an envelope is a rule's to state, in a Floorspec Rules pack that cites
its source, and a rule advises (FLR-ADR-011).

## 1.5 Units

Every value FS_thermal records or derives is an integer, in the unit its table gives — Floorspec
writes no number with a fraction (Core §2.5):

| Quantity | Unit | Example |
|---|---|---|
| a thickness | Core's length: 1/1280 mm (Core §2.1) | 5½" is `178816` |
| thermal conductivity | milliwatts per metre kelvin, mW/(m·K) | mineral wool batts, 0.035 W/(m·K), are `35` |
| a stated thermal resistance | thousandths of a square metre kelvin per watt, (m²·K/W)/1000 | a ventilated rainscreen gap, 0.035 m²·K/W, is `35` |
| density | kilograms per cubic metre, kg/m³ | gypsum board is `800` |
| specific heat | joules per kilogram kelvin, J/(kg·K) | gypsum board is `1090` |
| a U-factor | milliwatts per square metre kelvin, mW/(m²·K) | a double-glazed window of U 1.70 W/(m²·K) is `1700` |
| a fraction, a coefficient, a reflectance, an emittance | thousandths | a solar heat gain coefficient of 0.25 is `250` |
| a derived heat capacity | joules per square metre kelvin, J/(m²·K) | |

A thousandth of a square metre kelvin per watt is about 0.0057 of the inch-pound R-value
(h·ft²·°F/Btu): R-1 is `176`, R-13 is `2289` and R-38 is `6692`. A U-factor of 1 mW/(m²·K) is
about 0.000176 Btu/(h·ft²·°F). The two values derived that are not exact integers — a layer's
resistance and its heat capacity (3.1) — are each rounded once.

# 2. Data on elements

## 2.1 Materials

FS_thermal's data on a material (Core §8.5):

| Member | Type | Default | Meaning |
|---|---|---|---|
| `conductivity` | integer, 1 to 1,000,000, mW/(m·K) | absent: not stated | the material's thermal conductivity — the heat that flows through a metre of it for each kelvin across it |
| `resistance` | integer, 0 to 100,000, thousandths of m²·K/W | absent: not stated | a thermal resistance stated whole, whatever the layer's thickness: an air space, a membrane, a product its maker rates as a whole |
| `density` | integer, 1 to 30,000, kg/m³ | absent: not stated | its density |
| `specificHeat` | integer, 1 to 10,000, J/(kg·K) | absent: not stated | its specific heat capacity |
| `solarReflectance` | integer, 0 to 1000, thousandths | absent: not stated | the share of sunlight its surface reflects |
| `emittance` | integer, 0 to 1000, thousandths | absent: not stated | its surface's thermal emittance |
| `citation` | string, 1 to 400 characters | absent | where the values come from: a library, a datasheet, a test report |

```json
"M-BATT": {
  "name": "Mineral wool batt", "color": "#c9a35a",
  "extensions": { "FS_thermal": { "conductivity": 35, "density": 40, "specificHeat": 840,
                                   "citation": "Floorspec thermal library 0.1.0 (CC0 1.0)" } }
}
```

Conductivity is a property of the stuff, and a layer's resistance follows from its thickness
(3.1). Some layers are not like that: an air space resists heat by its depth, its orientation and its
surfaces, not in proportion to its thickness, and a thin membrane by almost nothing. Their material
states a `resistance` instead, the resistance of the layer whatever its thickness.

A material's FS_thermal data MUST NOT have both a `conductivity` and a `resistance`. {#FS-THRM-2.1.1 MUST NOT}
A material that has both says two things about one layer, and gets `FS-THRM-INV-001`.

`citation` is provenance, a label as a material's `name` is: no derivation reads it. A library that
publishes thermal values cites its sources item by item, and a material copied from it carries the
citation with it.

## 2.2 Assemblies and framing

An **assembly** is a list of layers, from the outside in, as a wall type's (Core §8.3): each layer a
Core layer — its `thickness`, its `function` (Core §4.3) and its `material`. A wall type's assembly is
its `layers`; a roof's and a floor's are FS_thermal's (2.4).

A **framing** says that a share of an assembly's area is framing — studs, joists, rafters, plates and
headers — in place of the layers it interrupts:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `material` | reference to a material | — (always present) | what the framing is made of |
| `fraction` | integer, 1 to 1000, thousandths | — (always present) | the share of the assembly's area that is framing |

```json
"framing": { "material": "M-SPF", "fraction": 230 }
```

Through the framing, every **`core` layer** of the assembly — the layer whose function is `core`
(Core §4.3): the studs and the insulation between them — is the framing's material instead of its
own, at the same thickness. A 2×6 wall at 16″ on centre with batts in its cavity is one assembly
with two **paths** (3.2): through the batts, over the share of its area that is not framing, and
through the studs, over the rest. The fraction is the writer's: about 0.23 for a wall framed at 16″
with its plates and headers counted, 0.16 at 24″ with advanced framing.

A framing's `material`, and the `material` of every layer of FS_thermal's data, MUST name a material of the document. {#FS-THRM-2.2.1 MUST}
A reference that names nothing, or names an element that is not a material, gets `FS-THRM-INV-002`,
naming the element whose data holds it. Core already checks a wall type's own layers' references
(Core §3.2); this rule checks FS_thermal's.

Core reads no extension's data, so to Core a material that only FS_thermal's data names — a framing's
lumber, a floor's oak — is a material nothing refers to, and it reports its information lint
`FS-LINT-006` for it (Core §8.7). That is Core's lint, unchanged: FS_thermal neither adds to it nor
suppresses it.

A framing on an assembly with no `core` layer interrupts nothing, and gets the lint
`FS-THRM-LINT-001`.

## 2.3 Wall types

FS_thermal's data on a wall type (Core §8.3):

| Member | Type | Default | Meaning |
|---|---|---|---|
| `framing` | framing (2.2) | absent: no framing | the framing through the type's `core` layers |

```json
"EW1": {
  "kind": "wallType", "name": "Exterior · 2×6 at 16″",
  "layers": [
    { "thickness": 10160, "function": "finish", "material": "M-FC" },
    { "thickness": 12192, "function": "airGap", "material": "M-GAP" },
    { "thickness": 508, "function": "membrane", "material": "M-WRAP" },
    { "thickness": 48768, "function": "insulation", "material": "M-WFB" },
    { "thickness": 14224, "function": "substrate", "material": "M-OSB" },
    { "thickness": 178816, "function": "core", "material": "M-BATT" },
    { "thickness": 16256, "function": "finish", "material": "M-GYP" }
  ],
  "extensions": { "FS_thermal": { "framing": { "material": "M-SPF", "fraction": 230 } } }
}
```

A wall whose own `layers` override its type's (Core §8.2) has no assembly in this version (6).

## 2.4 Roofs and floors

FS_thermal's data on a roof (Core 0.3, chapter 16) is the roof's assembly, from its outside surface
down to the ceiling of the rooms under it — a vented attic is an `airGap` layer whose material
states its resistance — and its framing:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `layers` | array of at least one layer (2.2) | — (always present) | the roof's assembly, from the outside in |
| `framing` | framing (2.2) | absent: no framing | the framing through its `core` layers: the rafters, or the ceiling joists of an attic |

FS_thermal's data on a room is its floor's:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `floor` | `{ "layers"?, "framing"?, "edgeResistance"? }` | absent | the room's floor |

| Member of `floor` | Type | Default | Meaning |
|---|---|---|---|
| `layers` | array of at least one layer (2.2) | absent: no assembly | the floor's assembly, from the room down |
| `framing` | framing (2.2) | absent: no framing | the framing through its `core` layers: the joists |
| `edgeResistance` | integer, 0 to 100,000, thousandths of m²·K/W | absent: not stated | the resistance of the insulation at the floor's edge, for a floor on the ground: a slab's perimeter insulation |

A roof's data has its `layers` always, and a floor's `framing` needs its `layers`: the schema says so.
Whether a floor is on the ground, over a crawl space or over a room is not FS_thermal's to say; a
method that estimates heat loss decides it from the house (3.3).

A layer's `thickness` is greater than zero and its `function` one of Core's layer functions (Core
§4.3.1), as a wall type's are: the schema says so, and a layer of FS_thermal's is checked by it.

## 2.5 Doors and windows

FS_thermal's data on a door type or a window type (Core §8.4):

| Member | Type | Default | Meaning |
|---|---|---|---|
| `uFactor` | integer, 1 to 20,000, mW/(m²·K) | absent: not stated | the whole unit's U-factor — frame, glazing and edge — over its rough opening, as its maker rates it |
| `shgc` | integer, 0 to 1000, thousandths | absent: not stated | the whole unit's solar heat gain coefficient |

```json
"WT1": { "kind": "windowType", "width": 1219200, "height": 1219200, "operation": "casement",
         "extensions": { "FS_thermal": { "uFactor": 1700, "shgc": 250 } } }
```

A maker rates a window under a standard — NFRC 100 and 200 in North America, EN 14351-1 in Europe —
at that standard's conditions, and the rating is of the whole unit: a reader never computes one
from the glass. An opaque door states its `uFactor` and no `shgc`; a glazed door states both.

# 3. Resistances

## 3.1 A layer's resistance and heat capacity

A layer's **resistance** is, in thousandths of m²·K/W:

- its material's `resistance`, when its material's FS_thermal data states one;
- otherwise, when its material's data states a `conductivity` `k`, its thickness `t` over that
  conductivity: `t / (1,280,000 × k / 1000)` m²·K/W, which is `25 t / (32 k)` thousandths;
- otherwise — a layer with no material, or whose material states neither — `null`: not known.

A layer's **heat capacity** is, in J/(m²·K), its thickness times its material's density and its
specific heat: `t × density × specificHeat / 1,280,000`; and `null` when the layer has no material
or its material does not state both.

A deriver MUST compute a layer's resistance and its heat capacity exactly and round each once, with `round()` (nearest integer, ties to even, Core §2.2). {#FS-THRM-3.1.1 MUST}

A batt of 5½″ — 178,816 base units — at 35 mW/(m·K) is `25 × 178816 / (32 × 35)` = 3991.43 thousandths,
`3991`: R-22.7 in inch-pounds. Half an inch of gypsum board at 160 mW/(m·K) is `25 × 16256 / (32 × 160)`
= 79.375, `79`, and its heat capacity, at 800 kg/m³ and 1090 J/(kg·K), is
`16256 × 800 × 1090 / 1,280,000` = 11,074.4, `11074` J/(m²·K).

## 3.2 An assembly's paths

An assembly has a **clear path**: every layer as it is. An assembly with a framing has a **framed
path** too: every `core` layer with the framing's material in place of its own (2.2) — its
resistance and its heat capacity computed with that material, at the layer's own thickness.

A path's resistance is the sum of its layers' resistances, each rounded first (3.1), and `null` when
any is `null`; its heat capacity likewise. Summing the rounded values, not rounding a sum, makes a
path's resistance the sum a reader sees in a layer-by-layer table.

## 3.3 From resistances to a U-factor

This section is informative: it says how the derived values are used, and defines nothing a deriver
derives.

An assembly's U-factor needs what FS_thermal does not record: the **surface resistances** of the air
films on its two faces, which depend on the direction heat flows and the wind outside. A method
adds them to each path — ISO 6946's conventional values are 0.13 m²·K/W inside a wall and 0.04
outside; ASHRAE's are 0.12 and 0.03 — and combines the paths in **parallel**, by area:

```text
U = (1 − f) / (Rsi + R_clear + Rse) + f / (Rsi + R_framed + Rse)
```

with `f` the framing's fraction. That is the parallel-path method; the isothermal-planes method and a
two-dimensional model of the studs give other answers, and steel framing, whose bridges are strong,
needs one of them. A floor on the ground loses its heat at its edge and through the soil, by a method
of its own — a perimeter factor, ISO 13370 — that reads `edgeResistance`. A door's or a window's
`uFactor` is already a U-factor, and is used as it is.

Software that presents a U-factor, a heat loss or a load built on FS_thermal's values SHOULD name the method and the surface resistances it used. {#FS-THRM-3.3.1 SHOULD}

# 4. Diagnostics

## 4.1 Codes

FS_thermal's diagnostic codes are `FS-THRM-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way. A
diagnostic of an assembly names the element that carries it — the wall type, the roof, the room for
a room's floor.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-THRM-SCH-001` | error | the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_thermal data does | — | 1.3.1, 1.3.2, 1.3.3 |
| `FS-THRM-INV-001` | error | a material's data has both a `conductivity` and a `resistance` | the material | 2.1.1 |
| `FS-THRM-INV-002` | error | a framing's `material`, or a layer's `material` in FS_thermal's data, names no material of the document; once for each element whose data holds one | the element | 2.2.1 |

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-THRM-LINT-001` | warning | an assembly with a framing has no `core` layer (2.2) | the wall type, the roof or the room |
| `FS-THRM-LINT-002` | info | an assembly's clear path has a resistance that is not known: a layer with no material, or whose material states neither a `conductivity` nor a `resistance` (3.1) | the wall type, the roof or the room |

`FS-THRM-LINT-002` is reported for every wall type, and for every roof and room whose FS_thermal data
has `layers`. Lints never make a document invalid, and none says whether an envelope is good enough
(1.4).

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_thermal was evaluated, a deriver derives the object below as the
member `FS_thermal` of the derived values' `extensions`.

```json
{
  "wallTypes": {
    "EW1": {
      "layers": [
        { "resistance": 32, "heatCapacity": 10319 }, { "resistance": 35, "heatCapacity": 10 },
        { "resistance": 0, "heatCapacity": 206 }, { "resistance": 1003, "heatCapacity": 12802 },
        { "resistance": 111, "heatCapacity": 13579 }, { "resistance": 3991, "heatCapacity": 4694 },
        { "resistance": 79, "heatCapacity": 11074 }
      ],
      "clear": { "resistance": 5251, "heatCapacity": 52684 },
      "framed": { "fraction": 230, "resistance": 2424, "heatCapacity": 150460 }
    }
  },
  "roofs": {},
  "floors": {}
}
```

That is the exterior wall type of the suite's envelope house (`examples/001-p16-envelope-house`), the
wall type of 2.3: through its batts 5.251 m²·K/W, through its studs 2.424. With ASHRAE's surface
resistances and the parallel-path method (3.3) that is about R-24.5 in inch-pounds overall; that
sentence is a method's, and not derived.

A deriver MUST derive these values exactly as this chapter defines. {#FS-THRM-5.1.1 MUST}

- `wallTypes` has a member for every wall type of the document; `roofs` for every roof whose
  FS_thermal data has `layers`; `floors` for every room whose FS_thermal `floor` has `layers`, by the
  room's ID.
- Each is an **assembly's derived values**: `layers`, one object for each of its layers in order, its
  `resistance` and its `heatCapacity` (3.1); `clear`, its clear path's `resistance` and `heatCapacity`
  (3.2); and, when it has a framing, `framed`: the framing's `fraction` and its framed path's
  `resistance` and `heatCapacity`. Without a framing it has no member `framed`.
- A value that is not known is `null`; it is never left out.

These are what a layer-by-layer table, a heat-loss estimate and a comparison of two assemblies are
built from (3.3). None of them is a verdict (1.4).

# 6. What this version does not define

- The assembly of a wall whose own `layers` override its type's: it has the layers, and FS_thermal 0.1
  has nowhere to put its framing. A later version may.
- Thermal bridges at junctions, corners and the edges of openings, beyond a framing's fraction.
- Air leakage, ventilation and infiltration: a property of how a house is built, not of what it is
  built of.
- Moisture, vapour permeance and condensation.
- Surface resistances, the U-factor of an assembly, heat loss, loads, and the climate they need: each
  is a method's (3.3).

# 7. Related

## 7.1 Related

FLR-T-16.4 (the thermal envelope: R-values, U-values and thermal mass, heat loss and gain room by
room), FLR-T-16.5, FLR-T-16.6 and FLR-T-16.9 (which read it), FLR-T-12.6 (the advisory energy
estimate), FLR-REQ-153 (an advisory energy and comfort estimate), FLR-REQ-092 (Release Candidate until
a second independent implementation), FLR-ADR-001 (building systems are `FS_` extensions),
FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise; findings never say "compliant"),
FLR-ADR-025 (the conventions every official extension follows). Floorspec Core 0.2, 0.3 and 0.4:
§1.6 and chapter 12 (extension data on core elements), §4.3 (layer functions, whose closing note
sends data about a layer to a wall type's extension data), §8.3 to §8.5 (types and materials),
chapter 15 (floors), chapter 16 (roofs).
