# FS_lighting 0.1.0

> [!warning] Draft
> FS_lighting 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a
> conformance suite, and still changing. It becomes a Release Candidate when an implementation other
> than the suite's own oracle passes its suite, and Ratified only when a second, independent
> implementation does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are
> Drafts, and on FS_electrical 0.1.

FS_lighting describes the light a house is designed to have: what each **luminaire** gives — its
light output, its colour temperature or the range a tunable-white one can be set to, whether it
dims — and the house's named **scenes**: "Evening", "Night light", each the luminaires it turns on,
at what output and colour temperature. A luminaire is a light that is already in the document: an
FS_electrical light, or an element of another extension that gives light — an FS_furniture table
lamp. FS_lighting adds no kind of element; it says what those elements give, and how the house
means them to be lit together.

This extension describes a design. It never says that a design meets a code or a standard of
illumination: a finding about a code is a rule's, in a Floorspec Rules pack, and is advice
(FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Luminaires | what a light gives |
| 3. Scenes | named scenes, and what a scene shows |
| 4. Control | informative: switches and scenes |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | scenes, luminaires |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-LGHT-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_lighting/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_lighting` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_lighting/extension.json` |
| Schema | `registry/FS_lighting/lighting.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_lighting/0.1.0/lighting.schema.json` |
| Requires | `FS_electrical` `^0.1.0` (Core §12.3) |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: FS_lighting adds no kind of element |
| Statement IDs | `FS-LGHT-` |
| Diagnostic codes | `FS-LGHT-SCH-`, `FS-LGHT-INV-`, `FS-LGHT-LINT-` |

## 1.2 Conformance

FS_lighting places requirements on documents, on validators and on derivers, as Floorspec Core
does (Core §0.2). A validator or deriver **implements** FS_lighting 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_lighting (Core §1.6.4). Its rules
apply when the validator knows the version the document targets (Core §12.2) — normally because it
is configured with this specification's registry entry.

A validator that implements FS_lighting 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_lighting at a version at which FS_lighting is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-LGHT-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_lighting's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-LGHT-INV-`) when it reported `FS-LGHT-SCH-001`, and MUST NOT evaluate its lints (`FS-LGHT-LINT-`) unless the document is valid. {#FS-LGHT-1.2.2 MUST NOT}
FS_lighting's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-LGHT-`
error makes a document invalid, and a document with one reports no lint, Core's included. Each
extension a validator implements is evaluated on its own. A document with design options (Core
chapter 19) is evaluated in each of its checked designs, as Core's own invariants are.

FS_lighting's registry entry requires FS_electrical at `^0.1.0`. A document that uses FS_lighting
at a known version and does not use FS_electrical, or uses it at a version outside that range, breaks
Core §12.3.2 or §12.3.3 — a Core error of tier 4 — and so FS_lighting is not evaluated for it. A
validator need not implement FS_electrical, nor know it, to implement FS_lighting.

A validator that implements FS_lighting MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-LGHT-1.2.3 MUST}

A deriver that implements FS_lighting MUST derive the values of chapter 6 for every valid document for which FS_lighting was evaluated, and MUST NOT derive them for any other document. {#FS-LGHT-1.2.4 MUST}

A reader that does not implement FS_lighting, or does not know this version, reads a document that
uses it as Core §1.6.9 says. FS_lighting has no elements, so it finds nothing of FS_lighting's to
draw: it shows each light as FS_electrical, or the extension it belongs to, has it shown, and
nothing of chapters 2 to 6.

## 1.3 Data

FS_lighting's top-level data, `extensions.FS_lighting`, is an object with two members, both
optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `luminaires` | object: ID → luminaire | `{}` | what each light gives (2.1), by the light's ID |
| `scenes` | object: ID → scene | `{}` | the named scenes of chapter 3 |

```json
"FS_lighting": {
  "luminaires": {
    "X2": { "lumens": 450, "cct": 2700, "dimmable": true },
    "X4": { "lumens": 800, "cct": 3000, "cctRange": [2700, 5000], "dimmable": true }
  },
  "scenes": {
    "LS1": { "name": "Evening", "on": { "X2": { "output": 60 }, "X4": { "output": 40, "cct": 2700 } } }
  }
}
```

FS_lighting's top-level data MUST match the schema `lighting.schema.json` of this version. {#FS-LGHT-1.3.1 MUST}

A luminaire is not an element: it is what an element gives, keyed by that element's ID. A scene is
not an element either — it has no fallback and no place in the building — but its ID is in the
document's one space of IDs (Core §3.1.3), so that a diagnostic can name it among its elements and
nothing else can be mistaken for it.

A scene's ID MUST NOT be the ID of an element, a program item or an extension element. {#FS-LGHT-1.3.2 MUST NOT}
Ops does not mint scene IDs. `LS1`, `LS2` … are a good choice: `LS` is no prefix Ops mints with
(Ops §1.5).

FS_lighting reads, of FS_electrical's data, only which collection an element is in — whether it is
a light, a switch or something else — and a switch's `control` and `controls` (FS_electrical §2.3).
It reads them as they are, without checking them, since it does not implement FS_electrical: a
`controls` that is not an array lists nothing, and an absent `control` is `"single"`.

FS_lighting 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and
an implementation of this version does not read it.

## 1.4 Units

A colour temperature is a correlated colour temperature in **kelvin**, a light output is in
**lumens**, and a scene's output is in **percent** of a luminaire's full output. Each is a JSON
integer: nothing in FS_lighting is a fraction, and nothing it derives is.

# 2. Luminaires

## 2.1 Luminaires

A **luminaire**, in `luminaires`, is what a light gives. Its key is the ID of the light it
describes.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `lumens` | integer, 1–1,000,000 | absent: not stated | its light output at full |
| `cct` | integer, 1,000–10,000 | absent: not stated | its colour temperature at full output, in kelvin; for a tunable-white luminaire, the one it gives when a scene names none |
| `cctRange` | array of two integers, each 1,000–10,000: `[warmest, coolest]` | absent: not tunable | a tunable-white luminaire's range of colour temperature |
| `dimmable` | boolean | absent: not stated | whether its output can be dimmed |
| `extras` | object | `{}` | Core §1.7 |

A light is anything that gives light in the house: a light of FS_electrical — a ceiling light, a
pendant, a recessed downlight, an exterior light — or an element of another extension that does,
such as a floor or table lamp of FS_furniture, plugged into a receptacle rather than wired to a
switch. FS_lighting reads nothing of the light but its ID and, for a light of FS_electrical, which
switches control it (chapter 4).

Every ID of `luminaires` MUST be the ID of a light of FS_electrical (its collection `lights`), or of an extension element of an extension other than FS_electrical. {#FS-LGHT-2.1.1 MUST}
An FS_electrical switch or receptacle gives no light, and an ID that is no extension element names
nothing a luminaire can be.

A luminaire's `cctRange` MUST give its warmest colour temperature first: its first value MUST be less than its second. {#FS-LGHT-2.1.2 MUST}

A luminaire that has both `cct` and `cctRange` MUST have its `cct` within its range, the bounds included. {#FS-LGHT-2.1.3 MUST}

A writer that records a scene dimming a luminaire SHOULD record whether that luminaire is dimmable. {#FS-LGHT-2.1.4 SHOULD}
A luminaire whose `dimmable` is absent is not stated either way, and gets no lint for being dimmed
(5.3).

## 2.2 A light FS_lighting says nothing of

This section is informative.

A light that has no member of `luminaires` is still a light, and a scene may turn it on (3.1). A
view that shows it lit uses what it knows of a typical lamp of its kind — a pendant's, a recessed
downlight's, a table lamp's — and says nothing of it that this document does not. Nothing here
asks a document to describe every light, and nothing here derives an output or a colour temperature
that the document does not state.

# 3. Scenes

## 3.1 Scenes

A **scene**, in `scenes`, is a named arrangement of the house's light: the luminaires it turns on,
each at an output and a colour temperature, and every other one off.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `name` | string, 1–200 characters | — (always present) | what it is called: "Evening" |
| `on` | object: ID → setting | `{}` | the luminaires it turns on, and how; **every luminaire it does not list is off** |
| `extras` | object | `{}` | Core §1.7 |

A **setting**, in a scene's `on`:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `output` | integer, 1–100 | `100` | its light output, in percent of its full output |
| `cct` | integer, 1,000–10,000 | absent: the luminaire's own | the colour temperature it is set to, in kelvin |

A scene with an empty `on` turns every light off. An output of 0 is never written: a light a scene
does not turn on is left out of its `on`.

Every ID of a scene's `on` MUST be the ID of a light of FS_electrical, or of an extension element of an extension other than FS_electrical. {#FS-LGHT-3.1.1 MUST}
The IDs are checked in every checked design (Core §19), as a circuit's loads are: a scene that turns
on a light of one design option is broken in a design without that light. FS_lighting 0.1 gives a
scene no `option`.

Two scenes MUST NOT have the same `name`. {#FS-LGHT-3.1.2 MUST NOT}
Names are compared as strings, exactly: "Evening" and "evening" are two names.

> [!note] Writing scenes
> Floorspec Ops mints no scene IDs and has no operation of its own for a scene. A writer adds,
> changes or removes one with `setProperty` or `unsetProperty` of `$document` — the path
> `/extensions/FS_lighting/scenes/LS1` for the scene `LS1`. Ops does not follow references inside an
> extension's own members (Ops §0.5): an applier that implements FS_lighting and knows it rejects a
> batch that removes a light a scene still turns on, since the result breaks 3.1.1. Remove the light
> from the scene's `on` in the same batch.

## 3.2 What a scene shows

This section is informative.

A view that shows a scene lights each luminaire in its `on` at `output` percent of its full output,
at the setting's `cct` or, without one, at the luminaire's own colour temperature, and lights
nothing else. A scene is design intent — the house's Evening, as its designer means it — and never
the state of the switches at a moment: nothing in a document records which lights are on now, and a
scene says nothing of how anyone gets from one scene to another.

A view may offer "All on" and "Off" as well as the document's scenes, without storing them: every
light at full, and none, are not design decisions a document needs to keep.

# 4. Control

This chapter is informative.

FS_electrical's switch `controls` (FS_electrical §4.1) say which lights a switch turns on and off
together, and its `control` how: a single switch, a dimmer, a smart switch. That is wiring. A scene
is independent of it: it may turn on lights of several switches, some lights of one switch and not
others, and a lamp that no switch controls at all. Recalling a scene is a lighting control system's
work, or a person's at the switches, and FS_lighting describes neither.

So a scene that dims a light that no dimmer or smart switch controls (`FS-LGHT-LINT-003`) is not
wrong: the light may dim at the fixture, or be driven by a controller this version cannot describe,
or the design may be waiting for its switches. The lint is advice — an `info` — that the scene asks
for something the wiring as drawn cannot do.

# 5. Diagnostics

## 5.1 Codes

FS_lighting's diagnostic codes are `FS-LGHT-<tier>-<nnn>`, with the tier named as in Floorspec
Core §10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted; a scene and a luminaire are named by their IDs.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-LGHT-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-LGHT-INV-001` | error | a scene's ID is the ID of an element, a program item or an extension element | the ID | 1.3.2 |
| `FS-LGHT-INV-002` | error | an ID of `luminaires` is neither a light of FS_electrical nor an extension element of another extension | the ID | 2.1.1 |
| `FS-LGHT-INV-003` | error | a luminaire's `cctRange` whose first value is not less than its second | the luminaire | 2.1.2 |
| `FS-LGHT-INV-004` | error | a luminaire's `cct` outside its `cctRange` | the luminaire | 2.1.3 |
| `FS-LGHT-INV-005` | error | an ID of a scene's `on` is neither a light of FS_electrical nor an extension element of another extension; once for each such ID | the scene | 3.1.1 |
| `FS-LGHT-INV-006` | error | two scenes have the same `name`; once for each pair | both scenes | 3.1.2 |

Not every invariant is evaluated for every luminaire: `FS-LGHT-INV-004` is evaluated only for a
luminaire without `FS-LGHT-INV-003`.

A validator MUST NOT report a diagnostic that this section says is not evaluated. {#FS-LGHT-5.2.1 MUST NOT}

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-LGHT-LINT-001` | warning | a scene sets an `output` below 100 for a luminaire whose `dimmable` is `false` | the scene and the luminaire |
| `FS-LGHT-LINT-002` | warning | a scene sets a `cct` its luminaire cannot give: outside the luminaire's `cctRange`, or — for a luminaire without `cctRange` that has a `cct` — other than that `cct` | the scene and the luminaire |
| `FS-LGHT-LINT-003` | info | a scene sets an `output` below 100 for a light of FS_electrical that no switch whose `control` is `"dimmer"` or `"smart"` controls (chapter 4) | the scene and the light |

Each is reported once for each scene and each luminaire of its `on` it holds for. A luminaire whose
`dimmable` is absent gets no `FS-LGHT-LINT-001`, and one without a member of `luminaires`, or with
neither `cct` nor `cctRange`, gets no `FS-LGHT-LINT-002`: FS_lighting does not guess what a light
can do.

Lints never make a document invalid. They say that a scene asks for what its luminaires, as
described, cannot give; none says that a design does or does not meet a code.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_lighting was evaluated, a deriver derives the object below as the
member `FS_lighting` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every list of IDs is sorted; every object's members are in ID order.

```json
{
  "scenes": { "LS1": { "name": "Evening", "on": ["X3", "X7"], "dimmed": ["X3"] } },
  "luminaires": { "X3": { "scenes": ["LS1"] }, "X7": { "scenes": ["LS1"] } }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-LGHT-6.1.1 MUST}

## 6.2 Scenes and luminaires

`scenes` has a member for every scene: its `name`; `on`, the IDs of its `on`; and `dimmed`, those of
them whose setting's `output` is below 100.

`luminaires` has a member for every ID that is a member of `luminaires` or of some scene's `on`:
`scenes`, the scenes that turn it on — empty for a luminaire that no scene turns on.

These are the values a lighting schedule and a scene list are built from.

# 7. Related

## 7.1 Related

FLR-T-13.12 (luminaires and named lighting scenes), FLR-ADR-043 (lighting as an extension over
FS_electrical's lights: no kind of its own, scenes in the one space of IDs), FLR-REQ-092 (Release
Candidate until a second independent implementation), FLR-ADR-001 (a tiny core; building systems
are `FS_` extensions), FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise; findings never
say a design meets a code). FS_electrical 0.1.0 chapters 2 and 4 (lights, switches and what they
control). Floorspec Core 0.2, 0.3 and 0.4 chapter 12 (extensions, and dependencies in 12.3), Core 0.3
chapter 19 (design options), and Ops §0.5 and §2.3 (`setProperty` of `$document`).
