# @floorspec/layout-solver

A **non-normative** layout solver (Core 0.2 §11.6; FLR-REQ-074, FLR-REQ-075). It turns a program
and its adjacency graph into ranked candidate layouts. Each candidate is a Floorspec Ops batch
that draws the walls, separators, rooms, doors and windows. Isomorphic like the engine
(FLR-ADR-010), and deterministic: the same input gives the same candidates, byte for byte.

```ts
import { solve, toChangesetProposals } from '@floorspec/layout-solver';

const candidates = solve(document, {
  program,          // default: document.program (Core 0.2)
  level: 'L1',      // default: the level items prefer, else the lowest empty one, else a new one
  footprint: { width, depth }, // base units; default: sized from the program
  count: 5,         // at least 3 whenever the program allows
  retired,          // the store's retired IDs (Ops 1.5): never named by a candidate
  emitBrief: true,  // default: the batch links each room to its item (Ops 0.2)
});
candidates[0].batch;  // Ops batch: types, drawWall/drawSeparator, addRoom, addOpening, /brief
candidates[0].score;  // { total, briefFit, circulation, findings, detail }
candidates[0].explanation;
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

`pnpm --filter @floorspec/layout-solver render [ranch|cabin|two-storey-ground] [--count N] [--all-levels]`
writes `out/<sample>-<rank>.svg` and `.png` (the PNG needs `rsvg-convert`). `out/` is gitignored.
