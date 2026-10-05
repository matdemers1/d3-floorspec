# FS_lowvoltage 0.1.0

> [!warning] Release Candidate
> FS_lowvoltage 0.1.0 is a **Release Candidate** (`registry/README.md`): specified, with a schema
> and a conformance suite, and frozen unless implementations find a problem. It becomes Ratified
> only when a second, independent implementation passes its conformance suite (FLR-REQ-092). It
> builds on Floorspec Core 0.2, which is a Draft.

FS_lowvoltage describes the low-voltage systems of a house: **outlets** for data, coax, phone and
fibre, **doorbells**, **security** devices, **speakers**, and the **head-ends** they are run to — a
structured media enclosure, a network rack, an alarm panel, an amplifier. A device names its
head-end, as a home run does; cable routes are not in this version.

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data |
| 2. Elements | outlets, doorbells, security devices, speakers, head-ends; fallbacks and clearances |
| 3. Connections | runs to head-ends; doorbell buttons and chimes |
| 4. Diagnostics | codes, the catalogue, lints |
| 5. Derived values | the room of an element, head-ends, rooms |
| 6. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-LOWV-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_lowvoltage/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_lowvoltage` |
| Version | `0.1.0` |
| Status | Release Candidate |
| Registry entry | `registry/FS_lowvoltage/extension.json` |
| Schema | `registry/FS_lowvoltage/lowvoltage.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_lowvoltage/0.1.0/lowvoltage.schema.json` |
| Requires | nothing |
| Kinds | `outlets`, `doorbells`, `security`, `speakers`, `headEnds` (none requires an asset or a symbol) |
| Statement IDs | `FS-LOWV-` |
| Diagnostic codes | `FS-LOWV-SCH-`, `FS-LOWV-INV-`, `FS-LOWV-LINT-` |

## 1.2 Conformance

FS_lowvoltage places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_lowvoltage 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_lowvoltage (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_lowvoltage 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"` and uses FS_lowvoltage at a version at which FS_lowvoltage is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-LOWV-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_lowvoltage's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-LOWV-INV-`) when it reported `FS-LOWV-SCH-001`, and MUST NOT evaluate its lints (`FS-LOWV-LINT-`) unless the document is valid. {#FS-LOWV-1.2.2 MUST NOT}
FS_lowvoltage's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-LOWV-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own.

A validator that implements FS_lowvoltage MUST report each condition of chapter 4 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-LOWV-1.2.3 MUST}

A deriver that implements FS_lowvoltage MUST derive the values of chapter 5 for every valid document for which FS_lowvoltage was evaluated, and MUST NOT derive them for any other document. {#FS-LOWV-1.2.4 MUST}

A reader that does not implement FS_lowvoltage, or does not know this version, reads its elements
as Core §1.6.9 says — fallbacks, placements and clearances, and nothing of chapters 3 to 5.

## 1.3 Data

FS_lowvoltage's top-level data, `extensions.FS_lowvoltage`, is an object with one member, optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `collections` | object: kind → (ID → element) | `{}` | the elements of chapter 2, by kind (Core §12.5) |

FS_lowvoltage's top-level data MUST match the schema `lowvoltage.schema.json` of this version. {#FS-LOWV-1.3.1 MUST}

FS_lowvoltage 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

# 2. Elements

Every element below is an extension element (Core §12.5): besides the members its table lists, it
has `fallback`, and may have `host`, `clearances`, `name` and `extras`, which Floorspec Core checks.
Most are on a wall face or a ceiling.

Every element of chapter 2 except a head-end belongs to one or more **systems** — the kinds of
cabling a head-end terminates:

| Element | Its systems |
|---|---|
| an outlet | each of its `media` |
| a doorbell | `"doorbell"` |
| a security device | `"security"` |
| a speaker | `"audio"` |

## 2.1 Outlets

An **outlet** (`outlets`) is a wall or floor plate with data, coax, phone or fibre ports.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `media` | array of distinct `"data"`, `"coax"`, `"phone"`, `"fiber"`, at least one | — (always present) | what it carries |
| `ports` | integer 1–64 | `1` | the ports it has of each medium |
| `headEnd` | ID of a head-end | absent | where it is run to (3.1) |

## 2.2 Doorbells

A **doorbell** (`doorbells`) is a button at a door, a video doorbell, or the chime they ring.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `part` | `"button"`, `"videoButton"` or `"chime"` | — (always present) | which part it is |
| `chime` | ID of a doorbell whose `part` is `"chime"` | absent | for a button: the chime it rings (3.2) |
| `headEnd` | ID of a head-end | absent | where it is run to: a transformer, a hub (3.1) |

## 2.3 Security devices

A **security device** (`security`) is a door or window contact, a motion or glass-break sensor, a
keypad, a siren or a camera.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `device` | `"contact"`, `"motion"`, `"glassBreak"`, `"keypad"`, `"siren"` or `"camera"` | — (always present) | what it is |
| `zone` | string, 1–64 characters | absent | its zone |
| `wireless` | boolean | `false` | true when it reports to its head-end without a cable |
| `headEnd` | ID of a head-end | absent | where it is run or reports to (3.1) |

## 2.4 Speakers

A **speaker** (`speakers`) is a speaker or a volume control.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `speaker` | `"inCeiling"`, `"inWall"`, `"surface"`, `"subwoofer"` or `"volumeControl"` | — (always present) | what it is |
| `zone` | string, 1–64 characters | absent | its audio zone |
| `headEnd` | ID of a head-end | absent | where it is run to (3.1) |

## 2.5 Head-ends

A **head-end** (`headEnds`) is where runs end.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `headEnd` | `"structuredMedia"`, `"networkRack"`, `"alarmPanel"`, `"audioAmplifier"` or `"doorbellTransformer"` | — (always present) | what it is |
| `serves` | array of distinct `"data"`, `"coax"`, `"phone"`, `"fiber"`, `"security"`, `"audio"`, `"doorbell"`, at least one | — (always present) | the systems it terminates |

## 2.6 Fallbacks and clearances

No kind of FS_lowvoltage requires an asset or a symbol in its fallback (Core §12.4.2).

A writer that adds an element of FS_lowvoltage SHOULD give its fallback a 2D `symbol`, so that a reader without the extension draws it as a plan symbol rather than a box. {#FS-LOWV-2.6.1 SHOULD}

A head-end is opened and worked on from the front. Floorspec's **default envelope** for a head-end
is named `access`, with the purpose `access`, in its frame, with `box` its fallback box: `min`
`[box.max.x, box.min.y, box.min.z]` and `max` `[box.max.x + 600 mm, box.max.y, box.max.z]` — 600 mm
in front of it, as wide and as tall as it is. This is Floorspec's own round default, not a code's
number.

A writer that adds a head-end SHOULD give it the default envelope `access`, or an envelope with the purpose `access` that it has better information for. {#FS-LOWV-2.6.2 SHOULD}
One without gets the lint `FS-LOWV-LINT-003`.

# 3. Connections

## 3.1 Runs

An element's `headEnd` names the head-end it is run to — one home run, of whatever cable its
systems need.

An element's `headEnd` MUST be the ID of a head-end of FS_lowvoltage. {#FS-LOWV-3.1.1 MUST}

An element MUST be run only to a head-end that serves every one of its systems (2). {#FS-LOWV-3.1.2 MUST}
A speaker run to an alarm panel, or a data and coax outlet run to a rack that terminates only data,
is a contradiction in the design.

## 3.2 Doorbells

A doorbell's `chime` MUST be the ID of a doorbell whose `part` is `"chime"`, and a doorbell whose `part` is `"chime"` MUST NOT have a `chime`. {#FS-LOWV-3.2.1 MUST}

A button without a `chime` gets the lint `FS-LOWV-LINT-002`.

# 4. Diagnostics

## 4.1 Codes

FS_lowvoltage's diagnostic codes are `FS-LOWV-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way.

## 4.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-LOWV-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-LOWV-INV-001` | error | a `headEnd` is not a head-end | the element | 3.1.1 |
| `FS-LOWV-INV-002` | error | a `chime` is not a chime, or a chime has a `chime` | the doorbell | 3.2.1 |
| `FS-LOWV-INV-003` | error | an element is run to a head-end that does not serve one of its systems | the element and the head-end | 3.1.2 |

`FS-LOWV-INV-003` is evaluated only for an element without `FS-LOWV-INV-001`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-LOWV-4.2.1 MUST NOT}

## 4.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-LOWV-LINT-001` | info | an outlet, a speaker, or a security device that is not wireless, run to no head-end | the element |
| `FS-LOWV-LINT-002` | warning | a doorbell button or video doorbell that rings no chime | the doorbell |
| `FS-LOWV-LINT-003` | warning | a head-end with no clearance envelope whose purpose is `access` (2.6) | the head-end |

Lints never make a document invalid.

# 5. Derived values

## 5.1 Derivation

For a valid document for which FS_lowvoltage was evaluated, a deriver derives the object below as
the member `FS_lowvoltage` of the derived values' `extensions`. Every list of IDs is sorted.

```json
{
  "headEnds": { "X15": { "runs": ["X16", "X18", "X19", "X20"], "ports": { "coax": 2, "data": 2 } } },
  "rooms": { "R1": ["X16", "X18", "X19"], "R3": ["X15", "X20"] }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-LOWV-5.1.1 MUST}

**The room of an element** is as FS_electrical §6.1 defines it: the host's room for a `surface`
host; the room anchored in the face on the host's side of the wall for a `wallFace` host (the face
left of the wall's location line, walked from start to end, for `"left"`, and right of it for
`"right"`); the room anchored in the bounded face containing a `free` host's position, unless the
position is on a location line; and no room otherwise.

## 5.2 Head-ends and rooms

- `headEnds` has a member for every head-end: `runs`, the elements whose `headEnd` it is; and
  `ports`, for each medium that an outlet run to it carries, the sum of those outlets' `ports` — the
  ports the head-end terminates, by medium.
- `rooms` has a member for every room that holds an element of FS_lowvoltage (5.1): those elements.

# 6. Related

## 6.1 Related

FLR-T-5.6, FLR-REQ-092 (Release Candidate until a second independent implementation), FLR-ADR-001
(building systems are `FS_` extensions), FLR-ADR-007 (the extension model). Floorspec Core 0.2
chapters 12 and 13.
