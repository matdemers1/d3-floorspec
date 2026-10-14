# FS_views 0.1.0

> [!warning] Draft
> FS_views 0.1.0 is a **Draft** (`registry/README.md`): specified, with a schema and a conformance
> suite, and still changing. It becomes a Release Candidate when an implementation other than the
> suite's own oracle passes its suite, and Ratified only when a second, independent implementation
> does too (FLR-REQ-092). It builds on Floorspec Core 0.2, 0.3 and 0.4, which are Drafts.

FS_views keeps the **views** of a house: its photographs, as the owner means them to be taken. A
view is a named camera — where it stands, what it looks at, its lens, the shape of its picture, its
depth of field and exposure — and what it shows: the whole house or a level cut away, the sky it is
seen under, the date and time that place the sun, and the lights, off, all on, or as an FS_lighting
scene sets them. "Hero exterior", "Kitchen island", "Dusk from the garden": every renderer and every
agent that reads the document can show the same picture again.

A view is design intent, as a scene of FS_lighting is: what the house is meant to look like from
where it is meant to be seen. It is not the state of anyone's screen. FS_views adds no kind of
element and requires no other extension (FLR-ADR-046); it reads the scenes of FS_lighting as data,
without implementing FS_lighting (1.3).

This extension describes a design. It never says that a design meets a code or a standard: a
finding about a code is a rule's, in a Floorspec Rules pack, and is advice (FLR-ADR-011).

## Contents

| Chapter | |
|---|---|
| 1. Conventions | status, conformance, data, units |
| 2. Views | the camera: eye and target, lens, picture, depth of field, exposure |
| 3. What a view shows | levels, the sky and the sun, the lights |
| 4. Rendering | informative: how a reader is meant to show a view |
| 5. Diagnostics | codes, the catalogue, lints |
| 6. Derived values | views |
| 7. Related | |

# 1. Conventions

## 1.1 Status and identifiers

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used as in Floorspec Core
§0.1. Every normative statement ends with a tag `{#FS-VIEW-<chapter>.<section>.<n> LEVEL}`, and
every `MUST` and `MUST NOT` is exercised by the conformance suite in
`conformance/ext/FS_views/0.1.0/`. An identifier is never reused.

| | |
|---|---|
| Name | `FS_views` |
| Version | `0.1.0` |
| Status | Draft |
| Registry entry | `registry/FS_views/extension.json` |
| Schema | `registry/FS_views/views.schema.json`, published at `https://d3cloud.io/floorspec/schema/ext/FS_views/0.1.0/views.schema.json` |
| Requires | nothing |
| Core drafts | `0.2`, `0.3` and `0.4`: the drafts whose documents it is evaluated for (1.2) |
| Kinds | none: FS_views adds no kind of element |
| Statement IDs | `FS-VIEW-` |
| Diagnostic codes | `FS-VIEW-SCH-`, `FS-VIEW-INV-`, `FS-VIEW-LINT-` |

## 1.2 Conformance

FS_views places requirements on documents, on validators and on derivers, as Floorspec Core does
(Core §0.2). A validator or deriver **implements** FS_views 0.1.0 when it does what this
specification says; it is then also a reader that implements FS_views (Core §1.6.4). Its rules apply
when the validator knows the version the document targets (Core §12.2) — normally because it is
configured with this specification's registry entry.

A validator that implements FS_views 0.1.0 MUST evaluate the diagnostics of this specification for a document that declares Floorspec `"0.2"`, `"0.3"` or `"0.4"` — a Core draft this version lists (1.1) — and uses FS_views at a version at which FS_views is known (Core §12.2) and which equals `0.1.0` (Core §12.3), and MUST NOT evaluate them for any other document. {#FS-VIEW-1.2.1 MUST}

Such a validator MUST NOT evaluate FS_views's diagnostics for a document for which Core's tiers 0 to 4 reported an error, MUST NOT evaluate its invariants (`FS-VIEW-INV-`) when it reported `FS-VIEW-SCH-001`, and MUST NOT evaluate its lints (`FS-VIEW-LINT-`) unless the document is valid. {#FS-VIEW-1.2.2 MUST NOT}
FS_views's errors are part of tier 4 (Core §10.1) and its lints part of tier 5: an `FS-VIEW-` error
makes a document invalid, and a document with one reports no lint, Core's included. Each extension a
validator implements is evaluated on its own. A document with design options (Core chapter 19) is
evaluated in each of its checked designs, as Core's own invariants are.

FS_views requires no other extension. A validator that implements FS_views need not implement
FS_lighting, nor know it, to check a view's `scene` (3.3).

A validator that implements FS_views MUST report each condition of chapter 5 as a diagnostic with the code, severity and elements that chapter gives, once for each occurrence, sorted with Core's diagnostics by code and then by elements (Core §10.2). {#FS-VIEW-1.2.3 MUST}

A deriver that implements FS_views MUST derive the values of chapter 6 for every valid document for which FS_views was evaluated, and MUST NOT derive them for any other document. {#FS-VIEW-1.2.4 MUST}

A reader that does not implement FS_views, or does not know this version, reads a document that uses
it as Core §1.6.9 says. FS_views has no elements, so it finds nothing of FS_views's to draw: it shows
the house as it would without it, from wherever it likes, and nothing of chapters 2 to 6.

## 1.3 Data

FS_views's top-level data, `extensions.FS_views`, is an object with one member, optional:

| Member | Type | Default | Meaning |
|---|---|---|---|
| `views` | object: ID → view | `{}` | the saved views of chapters 2 and 3 |

```json
"FS_views": {
  "views": {
    "SV1": {
      "name": "Hero exterior",
      "eye": [-12800000, -19200000, 2048000],
      "target": [6400000, 3840000, 3200000],
      "focalLength": 24,
      "twoPoint": true,
      "aspect": "3:2",
      "aperture": "f/8",
      "focus": 25600000,
      "exposure": 3,
      "level": "L1",
      "levels": "cutaway",
      "sky": "clear",
      "at": "2026-06-21T19:30",
      "lights": "on",
      "scene": "LS1"
    }
  }
}
```

FS_views's top-level data MUST match the schema `views.schema.json` of this version. {#FS-VIEW-1.3.1 MUST}

A view is not an element: it has no fallback and no place in the building. But its ID is in the
document's one space of IDs (Core §3.1.3), as an FS_lighting scene's is, so that a diagnostic can
name it among its elements and nothing else can be mistaken for it.

A view's ID MUST NOT be the ID of an element, a program item or an extension element, nor the ID of a scene in `extensions.FS_lighting.scenes`. {#FS-VIEW-1.3.2 MUST NOT}
Ops does not mint view IDs. `SV1`, `SV2` … are a good choice: `SV` is no prefix Ops mints with
(Ops §1.5).

FS_views reads, of FS_lighting's data, only the IDs of its scenes: the members of
`extensions.FS_lighting.scenes`. It reads them as they are, without checking them and whether or not
the document uses FS_lighting at a version anyone knows, since it does not implement FS_lighting: an
`extensions.FS_lighting` that is not an object, or a `scenes` that is not an object, holds no scene,
and a document without FS_lighting's data has none.

FS_views 0.1 defines no data on core elements. A writer preserves such data (Core §1.6.6), and an
implementation of this version does not read it.

## 1.4 Units

A point of a view — its `eye` and its `target` — is three lengths `[x, y, z]` in base units of
1/1280 mm (Core §2.1): plan coordinates in Core's system (Core §2.3: x to project east, y to project
north) and z, a height above project zero, up. A `focus` is a length too. A focal length is in whole
**millimetres** of a lens on a 36 × 24 mm frame, and an exposure compensation in **tenths of a
stop**. Each is a JSON integer: nothing in FS_views is a fraction, and nothing it derives is.

# 2. Views

## 2.1 Views

A **view**, in `views`, is a saved camera: a named picture of the house.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `name` | string, 1–200 characters | — (always present) | what it is called: "Hero exterior" |
| `eye` | point: three lengths | — (always present) | where the camera stands (2.2) |
| `target` | point: three lengths | — (always present) | the point it looks at (2.2) |
| `focalLength` | integer, 8–1200 | `35` | the lens's focal length, in millimetres on a 36 × 24 mm frame (2.3) |
| `twoPoint` | boolean | `false` | two-point perspective: the camera held level, its lens shifted (2.3) |
| `aspect` | `"3:2"`, `"16:9"`, `"4:5"` or `"1:1"` | `"3:2"` | the picture's width : height (2.4) |
| `aperture` | `"f/1.4"`, `"f/2"`, `"f/2.8"`, `"f/4"`, `"f/5.6"`, `"f/8"`, `"f/11"`, `"f/16"` or `"f/22"` | absent: everything in focus | the depth of field (2.5) |
| `focus` | length, at least 1 | the distance from `eye` to `target` | the distance in focus; only with `aperture` (2.5) |
| `exposure` | integer, −30 – 30 | `0` | exposure compensation, in tenths of a stop (2.6) |
| `level` | ID | absent: the whole house | cut away above this level (3.1) |
| `levels` | `"cutaway"` or `"only"` | `"cutaway"` | with `level`: that level and those below it, or that level alone (3.1) |
| `sky` | `"clear"`, `"overcast"`, `"dusk"`, `"night"` or `"studio"` | `"clear"` | the sky it is seen under (3.2) |
| `at` | string: a local date and time | absent: a reader's own choice | the date and time that place the sun (3.2) |
| `lights` | `"off"` or `"on"` | `"off"` | the house's light fixtures (3.3) |
| `scene` | ID | absent | a scene of FS_lighting (3.3) |
| `extras` | object | `{}` | Core §1.7 |

The schema requires `aperture` of a view that has `focus`, and `level` of a view that has `levels`:
a distance in focus means nothing to a pinhole, and a way of cutting away means nothing without a
level to cut at.

Two views MUST NOT have the same `name`. {#FS-VIEW-2.1.1 MUST NOT}
Names are compared as strings, exactly: "Hero exterior" and "Hero Exterior" are two names. A view
and an FS_lighting scene may share a name: they are not the same kind of thing.

> [!note] Writing views
> Floorspec Ops mints no view IDs and has no operation of its own for a view. A writer adds, changes
> or removes one with `setProperty` or `unsetProperty` of `$document` — the path
> `/extensions/FS_views/views/SV1` for the view `SV1`; the first view of a document that declares
> FS_views without its data creates `extensions.FS_views` on the way (Ops §2.3). Ops does not
> follow references inside an extension's own members (Ops §0.5): an applier that implements
> FS_views and knows it rejects a batch whose result breaks this specification — a view whose eye is
> its target, or one naming a level the batch removes.

## 2.2 Eye and target

A view's `eye` is where the camera stands, and its `target` the point it looks at: the line from
`eye` to `target` is the **line of sight**. Both are points in space (1.4), anywhere: in a room, in
the garden, above the roof. Without `twoPoint`, `target` is at the centre of the picture.

A view's `eye` and `target` MUST NOT be the same point. {#FS-VIEW-2.2.1 MUST NOT}
A camera at the point it looks at looks nowhere.

## 2.3 Lens

`focalLength` is the focal length of the view's lens, in millimetres, as on a full-frame camera:
its frame is 36 × 24 mm, and the frame's **long side**, 36 mm, spans the picture's long side,
whichever way the picture is turned (2.4). The picture's angle of view across its long side is
therefore 2·atan(18 / `focalLength`): about 74° at 24 mm, 54° at 35 mm, 24° at 85 mm. A short lens
shows a room from its corner; a long one a facade from across the street.

With `twoPoint`, the view is a **two-point perspective**: the camera is held level — its line of
sight horizontal, at the height of `eye` — and its lens is shifted vertically, as an architectural
photographer's shift lens is, by as much as puts `target` where a camera tilted to look at it would
put it, at the centre of the picture. Vertical lines stay vertical and parallel: walls do not lean
in, however high the house or low the camera.

A shift lens goes only so far. Looking steeply up a facade or down into a stairwell, a two-point
view's shift grows without limit: straight up or down, it has no level line of sight to keep.

A view whose `twoPoint` is `true` SHOULD have a line of sight no more than 30° above or below level. {#FS-VIEW-2.3.1 SHOULD}

## 2.4 Picture

`aspect` is the shape of the picture, its width : height: `"3:2"`, the shape of the 36 × 24 mm frame
itself; `"16:9"`, a screen's; `"4:5"`, a portrait; `"1:1"`, a square. A reader that renders a view
sizes its picture from `aspect`, at whatever resolution it renders. In a `"4:5"` picture the long
side is its height, and the lens's 36 mm spans that (2.3); in a `"1:1"` picture both sides do.

## 2.5 Depth of field

`aperture` is the f-number of the view's lens: with it, the view has the depth of field of a lens of
`focalLength` at that f-number on the 36 × 24 mm frame — at `"f/1.4"`, shallow, a pendant sharp
against a soft room; at `"f/16"`, nearly all of the house sharp. Without `aperture`, the view is a
pinhole: everything is in focus.

`focus` is the distance from `eye`, along the line of sight, that is in focus. Without it, it is the
distance from `eye` to `target`: the camera focuses on what it looks at. A `focus` without an
`aperture` is never written (2.1).

## 2.6 Exposure

`exposure` is exposure compensation, in tenths of a stop, over what a reader meters for the view: `3`
is three tenths of a stop brighter, `-10` a whole stop darker. It is a photographer's correction —
brighter for a white kitchen, darker for a dusk sky — and says nothing of how a reader meters.

# 3. What a view shows

## 3.1 Levels

Without `level`, a view shows the whole house: every level and the roof. With `level`, it **cuts
away** above that level: that level's ceilings and the roof over it are left off, so the camera can
look into its rooms from above. `levels` says what else is shown:

| `levels` | Shows |
|---|---|
| `"cutaway"` (the default) | that level and every level below it |
| `"only"` | that level alone |

A view's `level` MUST be the ID of a level of the document. {#FS-VIEW-3.1.1 MUST}

## 3.2 The sky and the sun

`sky` is the sky the house is seen under: `"clear"`, with the sun where `at` places it; `"overcast"`,
soft light without shadows; `"dusk"`, the last of the light; `"night"`, dark, lit by the house's own
lights; `"studio"`, an even, neutral light with no sky at all.

`at` is the date and time at the site, in ISO 8601: `YYYY-MM-DDTHH:MM`, with seconds `:SS` if
wanted, and `Z` or an offset `±HH:MM` if wanted. Written without an offset, it is the time in the
site's own zone, whatever zone that is; written with one, it is that time. With the site's
`location` and `trueNorth` (Core §1.8), it places the sun. Without `at`, a reader places the sun as
it chooses.

A view's `at` MUST name a day its month has, in the Gregorian calendar: no 31 April, and no 29 February outside a leap year — a year divisible by 4, except a year divisible by 100 that is not divisible by 400. {#FS-VIEW-3.2.1 MUST}
The schema checks the rest of the form of `at`: a month from 01 to 12, a day from 01 to 31, an hour
from 00 to 23, minutes and seconds from 00 to 59, and an offset of at most 14 hours.

## 3.3 Lights

`lights` is what the view shows of the house's light fixtures: `"off"`, none lit, or `"on"`, every
one lit at full. `scene` names a scene of FS_lighting: the view shows the lights as that scene sets
them — the luminaires it turns on, each at its output and colour temperature, and every other light
off (FS_lighting §3.2). A scene turns lights on: a view with a `scene` shows its lights on, and may
say so with `"lights": "on"` or leave `lights` out.

A view's `scene` MUST be the ID of a scene in `extensions.FS_lighting.scenes`. {#FS-VIEW-3.3.1 MUST}
FS_views reads that member as data (1.3): a document without FS_lighting's data has no scenes, and
a view in it names none.

A view that has a `scene` MUST NOT have `lights` `"off"`. {#FS-VIEW-3.3.2 MUST NOT}

# 4. Rendering

This chapter is informative.

A reader that renders a view places a pinhole camera at `eye`, looking at `target`, with the top of
its picture towards +z. A line of sight straight up or down has no such top; a reader then puts
project north (+y) at the top of the picture.

Its field of view is the lens's (2.3): 2·atan(18 / `focalLength`) across the picture's long side,
and across the short side the angle that `aspect` gives — 2·atan(12 / `focalLength`) across the
height of a `"3:2"` picture. A wider or narrower picture of the same lens shows more or less of the
house to either side, never a different scale.

With `twoPoint`, the camera looks along the horizontal through `eye` towards `target` — the line of
sight with its height taken out — and the picture is shifted vertically by `focalLength` × dz / d,
in the frame's millimetres, where dz is the height of `target` above `eye` and d the horizontal
distance between them, so that `target` falls at its centre. A reader shows a steep two-point view
as best it can, or as a tilted one; `FS-VIEW-LINT-001` says that it is steep.

A rasterized drawing need not show depth of field. A reader that does gives the view a lens of
`focalLength` at `aperture`, focused at `focus`, with the circle of confusion of the 36 × 24 mm
frame; one that does not shows everything sharp, as it would without `aperture`.

Exposure compensation multiplies the exposure a reader meters by 2^(`exposure` / 10): `10` doubles
it, `-10` halves it, `3` brightens it by about 23 %.

A view is a request to a reader, never a promise of what its picture looks like: two renderers show
the same view with their own materials, their own sky and their own sense of a light's glow. What
they share is where the camera is, what it sees, and how.

# 5. Diagnostics

## 5.1 Codes

FS_views's diagnostic codes are `FS-VIEW-<tier>-<nnn>`, with the tier named as in Floorspec Core
§10.1: `SCH`, `INV`, `LINT`. A diagnostic is a Core diagnostic (Core §10.2) in every other way:
`elements` lists IDs, sorted; a view is named by its ID.

## 5.2 The catalogue

| Code | Severity | Condition | Elements | Rule |
|---|---|---|---|---|
| `FS-VIEW-SCH-001` | error | the top-level data does not match the schema | — | 1.3.1 |
| `FS-VIEW-INV-001` | error | a view's ID is the ID of an element, a program item or an extension element, or of a scene in `extensions.FS_lighting.scenes` (1.3) | the view | 1.3.2 |
| `FS-VIEW-INV-002` | error | a view's `eye` and `target` are the same point | the view | 2.2.1 |
| `FS-VIEW-INV-003` | error | a view's `level` is not the ID of a level of the document | the view | 3.1.1 |
| `FS-VIEW-INV-004` | error | a view's `scene` is not the ID of a scene in `extensions.FS_lighting.scenes` (1.3) | the view | 3.3.1 |
| `FS-VIEW-INV-005` | error | a view has a `scene` and `lights` `"off"` | the view | 3.3.2 |
| `FS-VIEW-INV-006` | error | two views have the same `name`; once for each pair | both views | 2.1.1 |
| `FS-VIEW-INV-007` | error | a view's `at` names a day its month does not have | the view | 3.2.1 |

Each invariant is evaluated for every view, and a view that breaks several reports each.

## 5.3 Lints

| Code | Severity | Condition | Elements |
|---|---|---|---|
| `FS-VIEW-LINT-001` | warning | a view whose `twoPoint` is `true` has a line of sight more than 30° above or below level: with (dx, dy, dz) the `target` less the `eye`, 3·dz² > dx² + dy² | the view |

The condition is exact integer arithmetic on the view's lengths: no angle is computed. No line of
sight between two points of integer coordinates is exactly 30° from level, so the lint never depends
on rounding.

Lints never make a document invalid. A steep two-point view is not wrong — it is a picture a shift
lens cannot take — and the lint says only that.

# 6. Derived values

## 6.1 Derivation

For a valid document for which FS_views was evaluated, a deriver derives the object below as the
member `FS_views` of the derived values' `extensions` (the conformance suite's
`derived.extensions`). Every object's members are in ID order.

```json
{
  "views": {
    "SV1": { "name": "Hero exterior", "level": null, "lights": "off", "scene": null },
    "SV3": { "name": "Dusk from the garden", "level": null, "lights": "on", "scene": "LS1" }
  }
}
```

A deriver MUST derive these values exactly as this chapter defines. {#FS-VIEW-6.1.1 MUST}

## 6.2 Views

`views` has a member for every view: its `name`; `level`, its `level`, or `null` when it has none;
`lights`, `"on"` when its `lights` is `"on"` or it has a `scene`, and `"off"` otherwise; and
`scene`, its `scene`, or `null` when it has none.

These are the values a list of a house's views is built from: what each is called, the level it
cuts away at, and whether its lights are on and by which scene. Everything else of a view is the
view itself, read from the document.

# 7. Related

## 7.1 Related

FLR-T-13.10 (a camera for photographs: saved views), FLR-ADR-046 (views as an extension: no kind
of its own, no requirement, views in the one space of IDs, FS_lighting's scenes read as data), FLR-T-13.12 and FS_lighting 0.1.0 chapter 3
(named lighting scenes, which a view may show), FLR-REQ-092 (Release Candidate until a second
independent implementation), FLR-ADR-001 (a tiny core; everything else an `FS_` extension),
FLR-ADR-007 (the extension model), FLR-ADR-011 (rules advise; findings never say a design meets a
code). Floorspec Core 0.2, 0.3 and 0.4 chapter 2 (lengths and the coordinate system), §1.8 (the
site's location and true north), §3.1.3 (the one space of IDs) and chapter 12 (extensions), Core 0.3
chapter 19 (design options), and Ops §0.5 and §2.3 (`setProperty` of `$document`).
