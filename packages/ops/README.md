# @floorspec/ops

The reference applier of **Floorspec Ops 0.3** (`../floorspec/spec/ops/`), and of Ops 0.2 and 0.1
as published: every change to a Floorspec document is a batch of operations applied as one
transaction (FLR-ADR-008). Isomorphic like `@floorspec/engine`, which it is built on
(FLR-ADR-010): the editor, the server, the MCP server and the CLI apply the same edit to the same
bytes.

The draft is chosen per call. **Ops 0.3**, the default, is Ops 0.2 applied with a Core 0.3 reader:
no new operation and no new member (its requests match `schema/ops/0.3`, which is Ops 0.2's with
`roofs` and `stairs` among `addElement`'s collections), but it applies to Core 0.3 documents — a door
or window type's `operation` and `clearOpening`, an opening's own `clearOpening`, and every member of
a roof or a stair, are members `setProperty` and `unsetProperty` address like any other, and a
result is judged by Core 0.3's invariants (`FS-INV-305` … `308`, `FS-INV-801` … `805`, `FS-INV-901`
… `904`). Roofs mint `RF` IDs and stairs `ST`; removing a level takes or is blocked by its roofs and
by every stair whose `level` or `to` it is; the inverse removes roofs and then stairs after slabs.
Ops 0.3 also edits **materials and finishes** (Core chapter 18: a wall's `finishes`, a texture's
maps; a wall or material that names a material or asset blocks removing it; a wall split by
planarization cuts its regions to its pieces, step 7) and **design options** (Core chapter 19:
`optionSets` and `options` mint `OS` and `OP`; removing an option takes or is blocked by what is in
it; `context.option` adds every new junction, edge, opening, room, slab, roof, stair and extension
element in that option, and selectors, composites and `drawWall` read faces, rooms and junctions in
the edit design; normalization merges and planarizes a level option by option, 5.5). A rejection
found only in an option design carries its `design`. **Ops 0.2** (`{ ops: '0.2' }`) is the
published draft: Core 0.2 documents and Core 0.1 ones (a document declaring "0.3" is `FS-OPS-002`),
and adds the program and extension elements as things an
edit addresses: program items (`addProgramItem`, `addElement` into `items`, `setAdjacency`,
`removeAdjacency`, `addRoom`'s `brief`, `setRoomBrief`, the selectors `item <item>` and
`brief of <room>`, areas such as `"11 m2"`), extension elements (`placeElement` and `moveElement`
on wall-face, surface and free hosts; hosted elements following their walls, moved rooms and split
walls), relative `moveOpening` and `addLevel`. **Ops 0.1** (`{ ops: '0.1' }`) is the published
draft exactly: Core 0.1 documents only, and every 0.2 operation or member is `FS-OPS-001`.

An edit never changes a document's declared version by itself (Ops writes no declaration
implicitly): a 0.1 document stays 0.1 until a batch sets `$document` `/floorspec` to `"0.2"`, and a
0.2 document stays 0.2 until one sets it to `"0.3"` (Ops 0.3 only).

```ts
import { apply, resolveBatch, parseLength, formatLength } from '@floorspec/ops';

const r = apply(modelJson, {
  batch: [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" }],
  context: { locks: [{ element: 'R5' }], retired: ['W9'] },
}); // options: { ops: '0.1' | '0.2' | '0.3' (default), knownExtensions?, extensions? }; request.context.option: the option a batch edits in (0.3) — the validator's registry entries
if (r.status === 'committed') {
  r.document; // B, canonical form (Core §9.2) — the exact bytes to store
  r.hash; // B's content hash (Core §9.3)
  r.resolved; // the primitives applied, every reference resolved (1.4) — the op log entry
  r.created; r.removed; // element IDs
  r.inverse; // the batch that turns B back into A (1.6) — undo
} else r.diagnostics; // FS-OPS-0xx, or the Core errors of the result (1.2.3)

resolveBatch(modelJson, request); // resolve + expand without committing: for echoes and proposals
parseLength(`12' 6 1/2"`); // { ok, value: 4893056n, exact, roundedBy }
parseArea('120 sq ft'); // { ok, value: 18265480888320n } — square base units (3.6)
formatLength(4893056); // `12' 6 1/2"` (1/16" by default); { system: 'metric' } → `3822.7 mm`
```

## Layout

| Path | |
|---|---|
| `src/apply.ts` | the six-step transaction (1.2), `apply` and `resolveBatch` |
| `src/request.ts` | the request's shape per draft (0.1: 1.1.1, 0.2: 1.1.2; FS-OPS-001), host references (4.10) |
| `src/expand.ts` | resolve, expand and apply one operation: primitives and every composite (ch. 4) |
| `src/primitives.ts` | addElement and shorthands, removeElement with the cascade table, setProperty, unsetProperty, moveJunction, setAdjacency, removeAdjacency (ch. 2) |
| `src/references/` | the length and area grammars (`length.ts`), points, vectors, selectors, sides and positions (`resolve.ts`) (ch. 3) |
| `src/model/` | the working copy, the space of IDs (0.3: elements, program items, extension elements) and ID minting (1.5), the faces of a level as selectors read them (3.4) |
| `src/normalize.ts` | 5.1 merge → 5.2 snap rounding (only on a level that breaks Core §5.3), splitting, re-hosting openings and hosted elements → 5.3 join cleanup |
| `src/locks.ts`, `src/inverse.ts` | locks (ch. 6); the inverse (1.6) |
| `src/types.ts` | request, operation and result types |
| `standard/` | the three Ops conformance suites (0.1: 230 cases, 0.2: 359, 0.3: 457), the three request schemas and the diagnostics chapter, vendored by `pnpm sync-standard` and pinned in `LOCK.json` |

## Exactness and determinism

No clock, no randomness, no floating point. A length string is an exact rational (BigInt) rounded
once, ties to even; positions, displacements and re-hosted offsets are `Surd`s from the engine
(integers and square roots), rounded once; crossings and hot pixels are exact rationals; every
predicate is integer arithmetic. IDs and member names are ordered by UTF-16 code units. The browser
project (`pnpm test:browser`) applies the same fixtures in Chromium and requires Node's bytes.

## Commands

```sh
pnpm --filter @floorspec/ops test            # unit tests (Node)
pnpm --filter @floorspec/ops test:browser    # the same in Chromium, plus Node-vs-browser byte equality
pnpm --filter @floorspec/ops conformance     # conformance/ops/<draft> as that draft, and the extensions' Ops cases
pnpm --filter @floorspec/ops sync-standard [../floorspec] [--allow-dirty]
```
