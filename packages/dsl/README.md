# @floorspec/dsl

A terse, line-oriented **relational authoring language** for rough plans (FLR-REQ-140). You write
`kitchen 14x12 east-of dining` and it compiles to one **Floorspec Ops 0.3** batch: every change is
still an op (FLR-ADR-008), applied by `@floorspec/ops` and checked by `@floorspec/engine`. A
decompiler, `toDsl`, writes a rectilinear plan back as DSL.

Isomorphic like the engine (FLR-ADR-010): no Node built-ins, no clock, no randomness. Exact
(FLR-ADR-004): every length is parsed by the Ops reference grammar's own `parseLength` and every
coordinate the batch carries is an integer of base units. Deterministic: the same text gives the
same batch, byte for byte.

```ts
import { compile, build, toDsl, formatDiagnostic } from '@floorspec/dsl';

const r = compile(text, { base });   // base: the document the batch will apply to (default: empty Core 0.3)
if (r.ok) r.batch;                   // Ops 0.3 operations; r.sources[i] is the line that made r.batch[i]
else r.diagnostics.map(formatDiagnostic); // "line 3, column 19: room c cannot be both east-of a and east-of b"

const b = build(text);               // compile → apply (@floorspec/ops) → check (@floorspec/engine)
if (b.ok) b.document;                // the canonical document (Core §9.2) and b.hash
                                     // an Ops or Core error is placed on the line that made it

toDsl(document);                     // DSL text; DecompileError if the plan is not rectilinear
```

## A whole plan

```text
# the app's three-room house — examples/three-room-house.fsdsl
project "Three-room house"
level main "Main floor" at 0 height 9'

wall exterior EXT26 "2x6 exterior wall": finish 3/4", substrate 7/16", core 5 1/2", finish 1/2" justify core-face
wall interior INT24 "2x4 partition": finish 1/2", core 3 1/2", finish 1/2"

living "Living room" 20x24 at 0,0
bedroom 16x12 east-of living
kitchen 16x12 north-of bedroom
open living-kitchen          # a separator, no wall

door living-bedroom 32" at 8' from south hinge north swing into bedroom
door living south 36" at 6' from east hinge east swing south "Front door"
window kitchen north 3'x3' sill 3'6" at 6' from west
window living north 6'x4' sill 3' at 6' from west "Picture window"

brief: 3 bed, 2 bath 50 sq ft, office min 9 m2
adjacent bed-bath
```

## Grammar

One statement per line; `#` starts a comment. Keywords are case-insensitive. A **handle** is a word
(`kitchen`, `bed_2`) or a quoted name (`"Living room"`); rooms are referred to by handle or name.

| Statement | Means |
|---|---|
| `units imperial` \| `units metric` | what a bare number is: feet (the default) or metres. Once, before any length. |
| `project "Name"` | the project's name (`setProperty $project /name`). |
| `building "Name"` | the building (default "House"); a base with exactly one building is reused. |
| `level <handle> ["Name"] [at <elevation> \| above <level> \| below <level>] [height <length>]` | an `addLevel`. Rooms after it are on it. Default: the first at 0, each next above the one before; height 9' (2.7 m). Rooms before any `level` are on an implicit level "Main". |
| `wall exterior\|interior [<ID>] ["Name"]: <layers> [justify center\|exterior-face\|interior-face\|core-face]` | the wall type every exterior (one side outside) or interior (rooms both sides) wall is drawn with. `<layers>` is a thickness (`6"`, one core layer) or `<function> <thickness>, …` from the exterior face in (Core §8.3). Defaults: 6" / 4 1/2" (150 / 100 mm) core, centred. |
| `<room> ["Name"] <W>x<D> [<placement>…] [as <function>] [for <brief item>]` | a room: a rectangle `W` east–west by `D` north–south (`room <handle> …` if the handle is a keyword). |
| `open <room>-<room>` | the boundary between two rooms is a separator (no wall, no door needed). |
| `door <room>-<room> <width>[x<height>] [at <len> from <side>] [hinge <side>] [swing <side> \| swing into <room>] ["Name"]` | a door in the wall two rooms share. Height default 6'8" (2100 mm). |
| `door <room> <side> …` | a door in an outside wall on that side of a room. |
| `window <room> <side> <W>x<H> [sill <len>] [at <len> from <side>] ["Name"]` | a window; sill default 3' (900 mm). |
| `opening <room>-<room> <width>[x<height>] [sill <len>] [at …]` | an empty (cased) opening — no fill. |
| `brief: <item>, <item>, …` | program items (`addProgramItem`). An item is `[count] <handle> ["Name"] [<area>] [min <area>] [on <level>] [as <function>]`: `3 bed`, `2 bath 50 sq ft`, `office min 9 m2`, `"Great room" as living 300 sq ft`. |
| `adjacent a-b` \| `near a-b` \| `apart a-b` | an adjacency of two brief items: required, preferred, forbidden (`setAdjacency`). |

**Placements.** `at <x>,<y>` puts the room's south-west corner there. A relation —
`east-of`, `west-of`, `north-of`, `south-of <room>` — puts the room against that room's side, and
aligns it on the other axis: on the south edge for `east-of`/`west-of` and the west edge for
`north-of`/`south-of` unless it says `aligned north|south|east|west|center` (also
`top|bottom|left|right|middle`). Two relations on different axes (`east-of hall north-of garage`)
fix both coordinates, and an explicit relation or alignment wins over a default alignment. The
first room of a level with no placement is at the origin; every other room needs one. Relations
may name rooms declared later.

**Sizes are wall location lines.** A room's rectangle is drawn on the walls' location lines (centre
lines unless a wall is justified otherwise), so rooms tile exactly and share walls; its net area
(Core §6.4) is smaller by the walls' thickness. With centred walls of one thickness `t`, a room
walled on every side has `(W − t)(D − t)`, exactly.

**Lengths and areas** are the Ops reference grammar (Ops §3.1, §3.6): `12'`, `12' 6 1/2"`,
`12'6-1/2"`, `3/4 in`, `3810 mm`, `3.81 m`; `120 sq ft`, `11 m2`. A bare number is in the plan's unit
(`14x12` is 14 ft by 12 ft; `4.2x3.6` under `units metric` is metres). An inch or foot mark follows its
number directly — `36 "Front door"` is 36 ft and a name.

**Functions** (Core §4.1) are inferred from the room's name, then its handle: the last word that
names one decides (`Primary bedroom` → sleeping, `dining_room` → dining, `kitchen_pantry` → storage;
hall, foyer → circulation; den, family → living; study → office; …). `as <function>` overrides.
No such word: `unspecified`.

**Openings.** A door between two rooms goes in the one wall they share (two rectangles share at most
one); a door or window on a room's side goes in an outside wall on that side. Centred by default;
`at <length> from <side>` measures from that end of the shared wall, or of the room's side. `hinge`
names the end its leaf hangs from and `swing` the side it opens into (or `swing into <room>`),
by compass, whichever way the wall was drawn. Door and window types are made once per size
(`D36`, `W3636`, or a minted `T<n>`).

## What it compiles to

`parse → resolve → plane graph → batch`:

1. **Resolve.** Each relation is a constraint on one coordinate of a room's rectangle; rooms are
   resolved depth-first through their dependencies (a cycle is an error), constraints on one axis
   must agree exactly, and rooms on one level must not overlap. All exact integers.
2. **Plane graph.** Every rectangle side is split at every rectangle corner inside it, and equal
   pieces merged: those pieces are the level's edges, a T always has its junction (Core §5.3), and
   two rooms share at most one piece. A piece with a room on one side is exterior, drawn clockwise
   (Core §5.4: its exterior on the left); with rooms on both sides interior, or a separator if `open`.
3. **Batch.** `setProperty $project`, `addElement buildings`, `addLevel`, `addElement types` (as
   each type is first used), `drawWall` / `drawSeparator` per piece, `addProgramItem`,
   `setAdjacency`, `addRoom` (anchor at the rectangle's centre, name, function, brief), and
   `addOpening` by relative reference — `wall between Kitchen and Dining`, `north wall of Kitchen` —
   with `at: "centered"` or an exact offset (by wall ID only when a name would be ambiguous). IDs are
   minted as Ops 1.5 mints them, free in the base document.

Errors carry a line and column: `FS-DSL-SYNTAX` (the grammar), `FS-DSL-LAYOUT` (overlaps,
conflicting or ambiguous relations, cycles, a door where no wall is, an opening past its wall's end
or across a junction), `FS-DSL-REFERENCE` (a room, level or item that does not exist). An `FS-OPS-…`
or `FS-INV-…` error from applying the batch is placed on the line that made the operation or element.

## The decompiler

`toDsl(document)` writes a document whose every room is an axis-aligned rectangle of wall location
lines, and whose walls and separators are exactly the plane graph of those rectangles (what the
compiler draws), with one exterior and one interior assembly. Rooms are placed by relations where an
edge meets another room's exactly, by `at` otherwise, in an order decided by geometry, never by ID —
so `toDsl(build(toDsl(d)))` is `toDsl(d)`. Openings are written with explicit sizes, positions,
hinges and swings. Materials, finishes, the site, joins, wall tops and extension elements are not
said; geometry the DSL cannot say is a `DecompileError`, never a different plan.

## Tests

`pnpm --filter @floorspec/dsl test`:

- `compile.test.ts` — the grammar, relations and alignments, metric and imperial lengths, function
  inference, the brief, determinism, and every error with its line and column.
- `templates.test.ts` — for each app template (`apps/web/src/projects/templates/`): the handwritten
  description in `examples/` compiles to the template's rooms (names, functions, exact net areas and
  polygons) and openings (spans, sills, heads, hinge jambs and swing sides); and template → DSL →
  document keeps all of them.
- `roundtrip.test.ts` — 150 random rectilinear plans (slicing floorplans with notches, open
  boundaries, doors, windows, a second level in every third): each compiles to `(W − t)(D − t)` per
  closed room, and document → DSL → document is the same plan; and the layout solver's candidates
  (an independent writer of rectilinear plans) round-trip the same way.
