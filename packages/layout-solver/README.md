# @floorspec/layout-solver

A **non-normative** layout solver (Core 0.2 §11.6; FLR-REQ-074, FLR-REQ-075). It turns a program
and its adjacency graph into ranked candidate layouts. Each candidate is a Floorspec Ops batch
that draws the walls, separators, rooms, doors and windows. Isomorphic like the engine
(FLR-ADR-010), and deterministic: the same input gives the same candidates, byte for byte.

```ts
import { solve, toChangesetProposals } from '@floorspec/layout-solver';

const candidates = solve(document, {
  program,          // default: document.program (Core 0.2)
  level: 'L1',      // default: the level items prefer, else the lowest empty one, else a new one —
                    // or both of two stacked levels the items prefer (Two levels, below)
  footprint: { width, depth }, // base units; default: sized from the program
  count: 5,         // at least 3 whenever the program allows
  retired,          // the store's retired IDs (Ops 1.5): never named by a candidate
  emitBrief: true,  // default: the batch links each room to its item (Ops 0.2)
});
candidates[0].batch;  // Ops batch: types, drawWall/drawSeparator, addRoom, addOpening, /brief
candidates[0].score;  // { total, briefFit, circulation, findings, detail }
candidates[0].explanation;
candidates[0].levels;     // ['L1'], or ['L1', 'L2'] for a two-level candidate
candidates[0].stair;      // a two-level candidate's stair, as the engine derives it
toChangesetProposals(candidates); // [{ name, batch }]: one POST /api/projects/:id/changesets each
```

## How it works

1. **Strategies** (`builders.ts`) tile a rectangular footprint on a 6-inch grid (a slicing
   floorplan). In **wing**, the living spaces sit west and the bedrooms in a wing along a 4' hall,
   optionally with the primary suite across the hall's end. **split** puts the primary suite on the
   far side of the living spaces. **compact** has no hall, for small programs. Each strategy has
   variants: band partitions, orders, living to the front or the rear or as a great room, laundry
   by the bedrooms or the kitchen, and open or walled. Rooms are sized from `targetArea`, never
   below a least dimension per function. En-suite rooms (a bath or closet the brief wants beside one
   bedroom) are placed beside that bedroom.
2. **Access** (`access.ts`): the living spaces and halls are joined by separators or cased
   openings. Every other room then takes one door, best first. A bedroom never opens off another
   bedroom. A layout with an unreachable room is dropped.
3. **Estimate** every variant from its rectangles. **Emit** the best distinct ones as batches
   (`emit.ts`): exterior walls run clockwise, located on their exterior face. The batch adds only
   integer coordinates, the types it uses, and IDs minted as Ops 1.5 mints them.
4. **Measure** (`measure.ts`): apply each batch with `@floorspec/ops`, then check the result with
   `@floorspec/engine`. A batch that does not commit is dropped, and so is one with any error.
   **Score** it (`score.ts`), see its module comment:
   `total = 100 × (0.5 briefFit + 0.3 circulation + 0.2 findings)`.

## Two levels

When no level is asked for and the brief's items prefer two empty levels, one directly above the
other in one building, each candidate lays out both (FLR-T-12.16):

1. **The lower level** is laid out as a single level is, and enlarged a little when the upper rooms
   need more floor than its outline gives.
2. **The stair** (`stair.ts`) is straight, 3' wide, with 10" treads, risers of at most 7 3/4" and 6' 8"
   of declared headroom. How many risers it has and which of its steps the floor above must be open
   over are the engine's to say (Core 17.4, 17.6): a probe asks it once. The stair stands in an entry,
   a living or a dining room, along one of its sides, clear of its walls, with 3' of the room's floor
   before its foot and no door or cased opening of the room within 3' of it — rising in any of the
   four directions, which `Frame` maps onto one canonical case where it rises north.
3. **The upper level** (`upper.ts`) takes the lower level's outline. The stair's well runs from the
   head back to just before the first step that needs the opening, so the lowest steps keep the
   floor above them and the headroom is measured; it is a face with no room (Core 17.6), open to a
   4' hall across the head, which the stair arrives in. The upper rooms go in bands either side of
   the hall — every way of sharing them out is costed and the cheapest that tiles is kept — with a
   closet under the low steps and bonus rooms or closets where the brief leaves the outline unfilled.
4. **One batch** upgrades a document older than Core 0.4 (`minHeadroom` is a 0.4 member), draws both
   levels (each type added once), and adds the stair. It is measured as one house: the stair joins
   its foot room and head room, as in the door graph (Core 14.1). A candidate is dropped unless the
   engine derives the stair between the rooms it was placed between, with headroom of at least its
   `minHeadroom` (no `FS-LINT-019`) and 3' of floor at its foot and head (the engine's `landings`).

The well is a bounded face with no room in it, so every two-level candidate has one `FS-LINT-003`
(information). Asked for one level (`level`), the solver lays out that level alone, as before.

## Applied as given, measured as committed

Since Ops 0.2, `@floorspec/ops` applies to Core 0.2 documents, so each batch is applied to the
document as given and the committed result is checked directly: the batch sets each placed room's
`brief` (`emitBrief`, default true), and the engine derives `countMet`, `minAreaMet`,
`targetAreaMet` and `adjacent` (11.3, 11.4) and lints 008–011 from the document itself. A *probe
view* still derives `adjacent` and `connected` for every pair of rooms: this is the circulation
graph. A program passed in that the document does not hold is laid out against the document with
it (as Core 0.2), and its candidates set no `brief`: the document has no items for them to name.

The server runs the solver on main at `POST /api/projects/:projectId/layouts` and opens one
changeset per candidate (`toChangesetProposals`); the MCP tool `floorspec_propose_layouts` calls it.

## Rendering

`pnpm --filter @floorspec/layout-solver render [ranch|cabin|two-storey-ground] [--count N] [--all-levels] [--out DIR]`
writes `<out>/<sample>-<rank>-<level>.svg` and `.png` for every level a candidate lays out (the PNG
needs `rsvg-convert`); `out/`, the default, is gitignored. `--all-levels` lays the two-storey brief
out on one level, as it was before two-level layouts.
