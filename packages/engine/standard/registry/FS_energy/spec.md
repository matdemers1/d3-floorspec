# FS_energy 0.1.0

> [!warning] Draft
> FS_energy 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_energy describes the energy a house makes on its own site. Version 0.1.0 describes **solar
arrays** on its roofs — photovoltaic modules laid out in rows and columns on a roof face, flush with
it or racked at a tilt on a flat roof, kept back from its eaves, ridges and rakes — the **inverters**
that turn their output into the house's power, and the **rapid-shutdown initiators** that switch
them off. Each is an extension element (Core 12.5): it has a fallback box, so a reader without
FS_energy still shows that something is there.

An array is laid on a roof's derived surface (Core 16.5): it names its roof and the face it lies on,
and its plan footprint is derived exactly from its layout and the face's pitch. What an array will
produce in a year is an estimate, never a value this specification derives (chapter 5).

This extension describes a design. It never says that a design meets a code: a finding about a code
is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011). Its setbacks are Floorspec's
own round defaults, so that every array has edges a rule can test — they are not any code's.

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Arrays | the array, its roof and face, its frame, its layout and footprint |
| 3. Inverters and rapid shutdown | inverters, shutdown initiators, on circuits |
| 4. Setbacks | the setbacks, a face's edges, keeping clear |
| 5. Production | informative: a range and its method |
| 6. Diagnostics | codes, the catalogue, lints |
| 7. Derived values | arrays, inverters, shutdowns, totals |
| 8. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-ENGY-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_energy/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_energy` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_energy/extension.json` |
| Schema | `registry/FS_energy/energy.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_energy/0.1.0/energy.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | `pvArrays`, `inverters`, `shutdowns` (none requires an asset or a symbol) |
| Statement IDs | `FS-ENGY-` |
| Diagnostic codes | `FS-ENGY-SCH-`, `FS-ENGY-INV-`, `FS-ENGY-LINT-` |

## 1.2 Conformance

FS_energy places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_energy 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_energy (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_energy 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_energy at a version at which FS_energy is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-ENGY-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_energy's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-ENGY-INV-`) when it reported `FS-ENGY-SCH-001`, and MUST NOT evaluate its lints (`FS-ENGY-LINT-`) unless the document is valid. {#FS-ENGY-1.2.2 MUST NOT}
FS_energy's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-ENGY-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each design its validator checks, as Core is.

A document of Core 0.2 has no roofs (Core 0.3 added them), so an array in one names no roof
(2.2.1); FS_energy still evaluates it, as its siblings do.

A validator that implements FS_energy MUST report each condition of chapter 6 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-ENGY-1.2.3 MUST}

A deriver that implements FS_energy MUST derive the values of chapter 7 for every valid document for which FS_energy was evaluated, and MUST NOT derive them for any other document. {#FS-ENGY-1.2.4 MUST}

A reader that does not implement FS_energy, or does not know this version, reads a document that
uses it as Core §1.6.9 says: it finds the extension's elements, checks their core members, and
derives their fallbacks and placements — and nothing of chapters 2 to 7.

## 1.3 Data

FS_energy's top-level data, `extensions.FS_energy`, is an object with two members, both optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapters 2 and 3, by kind (Core §12.5) |
| `setbacks` | setbacks (4.1) | every default of 4.1 | how far arrays keep from a face's edges |

```json
"FS_energy": {
  "collections": {
    "pvArrays": {
      "PV1": { "name": "South roof", "roof": "RF1", "face": 0, "rows": 1, "columns": 5,
               "module": { "width": 1170432, "length": 1950720, "watts": 350 },
               "host": { "mode": "free", "level": "L1", "position": [780288, -780288], "rotation": -90000000 },
               "fallback": { "level": "L1", "box": { "min": [-1560576, 0, 4041216], "max": [0, 5982208, 5211648] } } }
    },
    "inverters": {
      "INV1": { "kind": "hybrid", "watts": 3800, "inputs": 2, "arrays": ["PV1"],
                "host": { "mode": "wallFace", "wall": "W1", "side": "right", "offset": 1170432, "height": 1536000 },
                "fallback": { "level": "L1", "box": { "min": [0, -320000, 0], "max": [256000, 320000, 896000] } } }
    }
  },
  "setbacks": { "eave": 585216, "ridge": 1170432, "rake": 1170432 }
}
```

FS_energy's top-level data MUST match the schema `energy.schema.json` of this version. {#FS-ENGY-1.3.1 MUST}

FS_energy 0.1 defines no data on core elements (`extensions.FS_energy` on a roof, a wall …). A
writer preserves such data (Core §1.6.6), and an implementation of this version does not read it.

## 1.4 Units

Lengths are Core lengths (Core §2.1): integers in base units of 1/1280 mm. A module's rating and an
inverter's are integer **watts** — direct current at standard test conditions for a module, the
alternating current it delivers for an inverter. A pitch is Core's: `{ "rise", "run" }`, two
positive integers (Core §2.5). An area is in square base units, written as Core writes a room's
area (Core §2.5). Nothing in FS_energy is a fraction.

# 2. Arrays

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `option` (Core 0.3), `name` and `extras`, which
Floorspec Core checks. A member with a default may be omitted; canonicalization never omits it for
you (Core §12.5).

## 2.1 The array

A **solar array** (`pvArrays`) is a rectangle of identical photovoltaic modules — **rows** of them
up the roof's slope, each of **columns** modules along it — on one face of one roof.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `roof` | ID of a roof | — (always present) | the roof it is on (2.2) |
| `face` | integer ≥ 0 | absent: a flat roof | the index of the sloped edge of the roof's footprint whose face it lies on (2.2) |
| `module` | object | — (always present) | the module: its `width` and `length` (lengths ≥ 1, its short and long sides) and its `watts` (integer ≥ 1), all always present |
| `layout` | `"portrait"` or `"landscape"` | `"portrait"` | how each module is turned: portrait, its length up the slope; landscape, its width |
| `rows` | integer 1–1,000 | — (always present) | the rows, counted up the slope from the corner (2.4) |
| `columns` | integer 1–1,000 | — (always present) | the modules in each row |
| `gap` | length ≥ 0 | `32512` (1″) | the gap between two modules of a row |
| `rowGap` | length ≥ 0 | the array's `gap` | the gap between two rows (2.4) |
| `tilt` | pitch | absent: flush | on a flat roof, the pitch the modules are racked to, each row on its own rack |
| `rapidShutdown` | `"module"` or `"array"` | `"module"` | where rapid shutdown acts: at each module, by module-level electronics, or at the array's boundary |

```json
"PV1": { "roof": "RF1", "face": 0, "rows": 1, "columns": 5,
         "module": { "width": 1170432, "length": 1950720, "watts": 350 },
         "host": { "mode": "free", "level": "L1", "position": [780288, -780288], "rotation": -90000000 },
         "fallback": { "level": "L1", "box": { "min": [-1560576, 0, 4041216], "max": [0, 5982208, 5211648] } } }
```

Five 3′ × 5′ modules of 350 W in one row, portrait, on the south face of a roof pitched 9:12: 5′ up
the slope, so 4′ in plan (2.4), and 15′ 4″ along it.

An array is **flush** when it has no `tilt` — its modules lie on the face — and **racked** when it
has one.

## 2.2 Its roof and its face

A roof's surface is derived face by face (Core 16.5); each face of a roof that slopes carries the
index `edge` of the sloped footprint edge it rises from. An array names its roof and, on a roof that
slopes, that index: the **array's face** is every derived face of the roof whose `edge` is `face`,
and on a flat roof its one face.

An array's `roof` MUST be the ID of a roof of the document. {#FS-ENGY-2.2.1 MUST}

An array's `face`, on a roof with a sloped edge (Core 16.2), MUST be present and be the index of a sloped edge of its roof's footprint, and on a roof with no sloped edge — a flat roof — MUST be absent. {#FS-ENGY-2.2.2 MUST}

A roof Core does not derive the surface of (Core 16.4) has no faces to lay an array on. A document SHOULD NOT have an array on such a roof. {#FS-ENGY-2.2.3 SHOULD NOT}
An array on one is reported by `FS-ENGY-LINT-003`, and is not tested against setbacks (4.3).

## 2.3 The frame

An array is placed by its host, Core's `free` host (Core 13.3), so that its frame, its fallback and
its placement are Core's: its `position` is the array's **corner** — on the side of the array
nearest the eave, at the right of its bottom row as a person standing below the roof sees it — and
its `rotation` the way the array **faces**: down the slope.

An array MUST have a host, and its host MUST be a `free` host on its roof's `level`. {#FS-ENGY-2.3.1 MUST}

On a face, the way down the slope is the **outward normal** of the face's sloped edge: for the
footprint's edge `face`, from vertex `a` to vertex `b`, with `(dx, dy) = b − a`, the vector
`(dy, −dx)` when the footprint runs counter-clockwise (its shoelace area is positive) and
`(−dy, dx)` when it runs clockwise — a vector of integers.

An array with a `face` MUST have a host whose `rotation` (default `0`) is the direction (Core 13.1) of the outward normal of its face's sloped edge, and MUST NOT have a `tilt`. {#FS-ENGY-2.3.2 MUST}
So a flush array on a sloped face faces exactly as the face does, to the microdegree, and the frame
Core derives from the rotation (Core 13.1) is the face's. On a flat roof the rotation is the
writer's: a racked array faces the way its modules tilt to, and a flush one is only turned in plan.

## 2.4 Layout and footprint

In the array's frame (Core 13.1), x is forward — down the slope, out of the face — and y is to the
left of forward. A module's **depth** is its side up the slope — its `length` in portrait, its
`width` in landscape — and its **breadth** the other. The rows run from the corner up the slope, to
negative x; the columns run from the corner to positive y.

The array's **breadth** in plan is `B = columns × breadth + (columns − 1) × gap`. Its **depth** in
plan, `D`, is:

| The array | `D` |
|---|---|
| flush on a sloped face of pitch `rise / run` | `round(L × run / √(rise² + run²))`, where `L = rows × depth + (rows − 1) × rowGap` is its length up the slope |
| racked to a tilt of `rise / run` | `rows × P + (rows − 1) × rowGap`, where `P = round(depth × run / √(rise² + run²))` is one rack's depth in plan |
| flush on a flat roof | `rows × depth + (rows − 1) × rowGap` |

Each `round` is rounded once, exactly (Core §2.2), and is never a tie: `length × run / √(rise² + run²)`
is a half only if `√(rise² + run²)` is rational, and then twice the length times the run, an even
number, would equal an odd multiple of the hypotenuse of a Pythagorean triple, which is odd. So a flush array's length up the slope is
projected to plan once, its gaps with it, while a racked array's `rowGap` is measured in plan,
between one rack's footprint and the next — where a writer keeps the racks far enough apart that one
does not shade the next.

The array's **footprint** is the footprint (Core 13.2) of the box from `(−D, 0)` to `(0, B)` in its
frame: the four plan points with local coordinates `(−D, 0)`, `(0, 0)`, `(0, B)` and `(−D, B)`,
each mapped exactly and rounded once, as a ring that starts at its least vertex and runs
counter-clockwise. Its **modules** are `rows × columns`; its **watts** are its modules times its
module's `watts`; its **area** is its modules times its module's `width` times its `length`, the
modules' own area, whatever their pitch.

## 2.5 The fallback

A reader without FS_energy draws an array's fallback box (Core 12.6) in the array's frame.

A writer that adds an array SHOULD give it a fallback box whose footprint is the array's footprint and whose bottom and top are the lowest and highest points of its modules above the level, so that a reader without FS_energy shows where the array is. {#FS-ENGY-2.5.1 SHOULD}

# 3. Inverters and rapid shutdown

## 3.1 Inverters

An **inverter** (`inverters`) turns the direct current of the arrays it serves into the house's
alternating current: a string inverter, a hybrid inverter that can also charge a battery, or the
gateway of microinverters at each module.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `"string"`, `"hybrid"` or `"micro"` | `"string"` | what kind of inverter |
| `watts` | integer ≥ 1 | — (always present) | its rated output, alternating current |
| `inputs` | integer 1–64 | `1` | its maximum-power-point inputs |
| `arrays` | array of distinct IDs | `[]` | the arrays it serves |

Each ID in an inverter's `arrays` MUST be the ID of an array of FS_energy. {#FS-ENGY-3.1.1 MUST}

An array MUST NOT be served by more than one inverter. {#FS-ENGY-3.1.2 MUST NOT}

An array SHOULD be served by an inverter. {#FS-ENGY-3.1.3 SHOULD}
An array no inverter serves is reported by `FS-ENGY-LINT-002`, an `info` lint: a design in progress
often has arrays before it has an inverter.

## 3.2 Rapid-shutdown initiators

A **rapid-shutdown initiator** (`shutdowns`) is the switch that brings the arrays it controls to a
safe voltage — usually beside the service, where a firefighter finds it.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `arrays` | array of distinct IDs | `[]` | the arrays it controls |

Each ID in a shutdown initiator's `arrays` MUST be the ID of an array of FS_energy. {#FS-ENGY-3.2.1 MUST}

An array's `rapidShutdown` says where its shutdown acts; the initiator says what starts it. Neither
is a statement that a design meets a code's requirement for rapid shutdown.

## 3.3 On circuits

An inverter delivers its power to the house through a circuit, and an initiator is wired to one:
FS_electrical's circuits name them as loads (FS_electrical 3.2), which FS_electrical allows for an
element of another extension. FS_energy reads no circuit; FS_electrical reads FS_energy's elements
only as IDs.

A document that uses FS_electrical and FS_energy SHOULD list each inverter among the loads of an FS_electrical circuit — the circuit its output is connected to. {#FS-ENGY-3.3.1 SHOULD}

# 4. Setbacks

## 4.1 The setbacks

An array keeps back from the edges of its face — a clear path along the eave, below the ridge and
beside the rakes. How far is FS_energy's top-level `setbacks`:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `eave` | length ≥ 0 | `585216` (18″) | from an eave edge |
| `ridge` | length ≥ 0 | `1170432` (3′) | from a ridge edge |
| `rake` | length ≥ 0 | `1170432` (3′) | from a rake edge |

These are Floorspec's own round defaults, chosen so that every array has edges a rule can test, and
measured in plan. They are not taken from any code, and they are not a code's requirement: what a
jurisdiction asks of the paths and setbacks on a roof is a rule's to say, in a Floorspec Rules
pack, which cites its source.

## 4.2 A face's edges

Each edge of a derived face of a roof (Core 16.5), from one vertex of its polygon to the next, is
one of three kinds, by the elevations of its two ends:

| The edge | Its kind |
|---|---|
| level, at the roof's eave elevation | an **eave** |
| level, above the eave | a **ridge** — a ridge, a break, or the high edge of a shed |
| sloping | a **rake** — a rake, a hip or a valley |

So every edge of a flat roof's face is an eave. Each kind keeps its setback (4.1).

## 4.3 Keeping clear

An array is tested by the four corners of its footprint (2.4), in plan, against the polygons of its
face (2.2), in plan. A corner is **clear** when it lies in one of those polygons, inside it or on its
boundary, and for each edge of that polygon its distance from the edge — the segment, not its line
— is at least the setback the edge's kind keeps. The test is exact, in integers: a distance `d` is
compared with a setback `s` as `d²` with `s²`.

A document SHOULD keep every corner of every array clear. {#FS-ENGY-4.3.1 SHOULD}
An array a corner of which is not clear is reported by `FS-ENGY-LINT-001`, a `warning`. Only the
corners are tested: on a face with a re-entrant corner, an array between clear corners may still
reach into a setback, and a reader that draws setbacks shows it.

# 5. Production

This chapter is informative, but for its one statement.

## 5.1 A range and its method

What an array will produce depends on the sun at the site, the weather of a typical year, the
face's tilt and azimuth, what shades it, the temperature of the modules and the losses of the
system. None of it is exact, and FS_energy derives none of it.

Software that estimates an array's production SHOULD present it as a range, with its method and its assumptions, and SHOULD NOT present it as a guarantee or as a statement that a design meets a code. {#FS-ENGY-5.1.1 SHOULD}

## 5.2 D3 Floorspec's method

D3 Floorspec's estimate is one such method, described so that it can be compared, not followed:

- **The sun** at the site's latitude (Core 1.8), on a representative day of each month, from the
  declination and the hour angle in solar time;
- **A typical year's light**: the day's extraterrestrial irradiation on a horizontal surface times
  a clearness index for the climate, split into beam and diffuse by the Erbs monthly-average
  correlation and spread through the day by the Collares-Pereira–Rabl and Liu–Jordan ratios (Duffie
  & Beckman, *Solar Engineering of Thermal Processes*, chapter 2);
- **On the array**: the beam on its plane, the isotropic sky and the ground's reflection (Liu–Jordan);
- **Shade**: the beam is lost where a ray toward the sun from a point of the array meets the house's
  roofs and walls, a tree — FS_landscape's and FS_context's, leafless in winter if deciduous — or a
  neighbour's massing (FS_context); the sky is not shaded;
- **The system**: the modules' watts at standard test conditions times a performance ratio for
  temperature, wiring, soiling, mismatch and the inverter;
- **A range**: ±20% around the result, rounded to two significant figures.

# 6. Diagnostics

## 6.1 Codes

FS_energy's diagnostic codes are `FS-ENGY-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted.

## 6.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-ENGY-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-ENGY-INV-001` | error | an array whose `roof` is not the ID of a roof | the array | 2.2.1 |
| `FS-ENGY-INV-002` | error | an array whose `face` is missing on a roof that slopes, is not the index of a sloped edge of it, or is present on a flat roof | the array | 2.2.2 |
| `FS-ENGY-INV-003` | error | an array without a host, or whose host is not a `free` host on its roof's level | the array | 2.3.1 |
| `FS-ENGY-INV-004` | error | an array with a `face` whose host's rotation is not the direction of its face's outward normal, or that has a `tilt` | the array | 2.3.2 |
| `FS-ENGY-INV-005` | error | an inverter or a shutdown initiator whose `arrays` lists an ID that is not an array of FS_energy | the inverter or initiator | 3.1.1, 3.2.1 |
| `FS-ENGY-INV-006` | error | an array listed by more than one inverter | the array and those inverters | 3.1.2 |

Each invariant is reported once for each element that breaks it: `FS-ENGY-INV-005` once for an
inverter or initiator however many of its IDs are not arrays, and `FS-ENGY-INV-006` once for an
array however many inverters list it. An array whose `roof` breaks 2.2.1 is not tested for 2.2.2,
2.3.1 or 2.3.2; one whose `face` breaks 2.2.2, or whose host breaks 2.3.1, is not tested for 2.3.2.

## 6.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-ENGY-LINT-001` | warning | an array a corner of whose footprint is not clear of its face's edges (4.3.1) | the array |
| `FS-ENGY-LINT-002` | info | an array no inverter serves (3.1.3) | the array |
| `FS-ENGY-LINT-003` | warning | an array on a roof whose surface Core does not derive (2.2.3) | the array |

Lints never make a document invalid.

# 7. Derived values

## 7.1 Derivation

For a valid document for which FS_energy was evaluated, a deriver derives the object below as the
member `FS_energy` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every object's members are in ID order. The example is the conformance
suite's sunny house (`examples/…-p16-sunny-house`), trimmed to its flush array and the inverter:
PV1 is 4′ deep in plan and 15′ 4″ wide, its corner 2′ east and 2′ south of the house's corner.

```json
{
  "arrays": {
    "PV1": { "roof": "RF1", "face": 0, "mount": "flush", "pitch": { "rise": 9, "run": 12 },
             "modules": 5, "watts": 1750, "area": "11415925555200",
             "footprint": [[780288, -780288], [6762496, -780288], [6762496, 780288], [780288, 780288]],
             "inverter": "INV1" }
  },
  "inverters": {
    "INV1": { "arrays": ["PV1"], "watts": 1750 }
  },
  "shutdowns": {},
  "modules": 5,
  "watts": 1750
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-ENGY-7.1.1 MUST}

## 7.2 Arrays

`arrays` has a member for every array, by its ID:

| Member | Value |
|---|---|
| `roof` | its roof |
| `face` | its `face`; absent on a flat roof |
| `mount` | `"flush"` or `"racked"` (2.1) |
| `pitch` | the pitch its modules lie at: its face's sloped edge's (Core 16.1) when flush on a sloped face, its `tilt` when racked, and `null` when flush on a flat roof |
| `modules`, `watts`, `area` | 2.4 |
| `footprint` | its footprint (2.4) |
| `inverter` | the inverter that serves it, or `null` |

## 7.3 Inverters, shutdowns and the totals

`inverters` has a member for every inverter, by its ID: its `arrays`, sorted, and `watts`, the sum
of their watts — the direct current it is offered, for comparison with its own rating. `shutdowns`
has a member for every rapid-shutdown initiator: its `arrays`, sorted. `modules` and `watts` are the
sums over every array.

These are what an agent reads to answer "how big is the system on the roof?" or "which inverter does
the garage roof's array feed?" without drawing anything.

# 8. Related

## 8.1 Related

FLR-T-16.1 (solar on the roof: arrays laid out on roof faces, sized by orientation and shading, with
yearly production), FLR-ADR-065 (FS_energy: on-site generation as a new extension of elements on
Core's derived roof faces, not FS_electrical 0.2.0), FLR-ADR-011 (advisory, never "compliant"),
FLR-ADR-001 (a tiny core; building systems are `FS_` extensions), FLR-ADR-007 (the extension
model), FLR-ADR-025 (the conventions of the official extensions), FLR-REQ-092 (Release Candidate
until a second independent implementation). FS_electrical 0.1.0 chapter 3 (circuits, and loads of
another extension). Floorspec Core 0.2, 0.3 and 0.4 chapters 1.8 (the site), 2, 12, 13 (frames and
hosts), 16 (roofs) and 19 (design options).
