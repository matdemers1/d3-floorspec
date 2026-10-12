# @floorspec/mesh

Watertight 3D meshes derived from a Floorspec document (FLR-T-7.4, FLR-REQ-112). Isomorphic like
the engine (FLR-ADR-010): the same package in the browser and in Node.

```ts
import { loadMesher, flatShaded } from '@floorspec/mesh';

const mesher = await loadMesher();            // loads manifold-3d's WASM once, lazily
const house = mesher.meshDocument(doc);        // validates and derives, then meshes
// or, holding the engine's evaluation already:
const same = mesher.meshDerived(ev.document, derived, { levels: ['L1'], origin: [x, y, 0] });

for (const part of house.parts) {
  part.id;     // the Floorspec element — what selecting it in 3D selects in 2D
  part.kind;   // wall, junctionFill, opening, floor, ceiling, slab, roof, roofGable, stairFlight, …, threshold, joinery
  part.closed; // a watertight 2-manifold solid, or a surface (`facing` up, down or side)
  part.mesh;   // { positions: Float32Array (metres), indices: Uint32Array }, CCW from outside
  part.bbox;   // base units, exact
}
```

## Exactness and units

Everything is built from what `@floorspec/engine` derives — integers in base units (1/1280 mm) —
and converted once, at the very end, to Float32 metres relative to `origin` (default `[0, 0, 0]`).
Axes are Floorspec's: x east, y north, **z up**. A three.js scene (y up) rotates the house group −90°
about x. Parts built from exact points (prisms, roofs, landings, fills, surfaces) keep their exact
integer vertices until that conversion; walls (openings subtracted) and stair flights (treads
unioned) are built by manifold-3d in double precision in a local frame at an integer origin.

| kind | from | closed |
|---|---|---|
| `wall` | outline (5.7) × base–top (5.9), each opening's box subtracted | solid |
| `junctionFill` | fill (5.7) × least base – greatest top of its walls; piece `closure:<wall>`: the corner a separator between two walls leaves open, closed to where their faces would meet | solid |
| `opening` | exactly the volume cut from its wall (a pick target; its joinery fills it) | solid |
| `floor` | room polygon × bottom–top (15.1); no thickness → surface facing up | solid / surface |
| `ceiling` | flat, tray (with its step) or vault split at the ridge (15.2–15.4); not drawn inside a room of a higher level whose floor it is above — a double-height room's ceiling stops at a bridge in it | surface, facing down |
| `slab` | outline × bottom–top (15.7) | solid |
| `roof` | thickness: the surface thickened down; none: the attic shell (faces, a soffit at the eave, the surface's edge dropped to the eave along each gable's edge of the outline); flat without thickness, or surface not derived (placeholder) → surface | solid / surface |
| `roofGable` | a gable end, only for a roof with a thickness: on its wall (Core 0.4, 16.5), the roof raking past it; the part of it below the roof's solid, so never in the solid's edge band | surface, facing side |
| `stairFlight` | a flight's treads, each two risers deep, unioned | solid |
| `stairLanding` | a landing by the same rule | solid |
| `stairBlock` | placeholder: a winder or spiral stair's box (17.4) | solid |
| `extension` | an extension element's procedural model, one part per piece (`part.model`), inside its fallback box (12.6); else that box | solid |
| `threshold` | a door's or empty opening's cut plan, where its sill is the wall's base, split at the location line: each half the floor (top, bottom) of the room on its side | solid / surface |
| `joinery` | what fills an opening, a part per piece (`part.model`): lining, casings, a door's slabs and hardware, a window's frame, sashes, glass, stool, apron and sill; a moving piece's `state` | solid |

`part.bbox` is exact: for floors, ceilings, slabs, roofs and extension elements it is the engine's
derived box (for a ceiling a bridge stands in, the box of what is left of it, inside the engine's);
for a wall it is the exact box of the outline prism minus its cuts (computed slab by slab in
rationals), which equals manifold-3d's double-precision box within a nanometre.

## Fixture models (FLR-T-12.21)

An extension element this package knows is drawn as a procedural model of what it is, instead of
its plain fallback box: FS_electrical's receptacles, switches, panels, alarms and every kind of
light; FS_plumbing's fixtures (toilet, basin, kitchen sink, tub, shower, hose bibb) and water
heaters; FS_furniture's pieces, appliances and casework; FS_mechanical's gas appliances (range,
grill, fireplace or fire pit). `src/models/` holds them, chosen by the member each collection
names what an element is by (`discriminant`, `elementKind`). Each model is drawn in the element's
own frame, fitted to its box — x from its back to its front, y from its right to its left, z up —
and carried to the plan through the box's derived footprint, so every vertex lies inside the box.

Each piece is a part of its own, keyed `extension:<id>:<piece>`, with `part.model = { kind, role,
smooth? }`: the element's kind, what the piece is made of — one of `MODEL_ROLES`, each with its look
in `ROLE_LOOKS` (porcelain, stainless, a counter's stone, a lamp's lens …) that the editor, the
render, the path tracer and the glTF export all draw it with — and `smooth` for a round piece. A sink
whose bowls lie inside a counter top at its height is set into it: the counter is cut for them.
Round things are drawn from a written-out table of 24 cosines, never `Math.cos`, so Node and the
browser mesh the same bytes. `meshDocument(doc, { models: false })` draws every element as its box.

## Joinery (FLR-T-13.8)

An opening is filled with what a joiner would make of it (`src/joinery.ts`), drawn in its own frame —
x along it from its derived start point, y across the wall to the left of its location line, z up
from its sill — and carried to the plan once, each point rounded to a base unit:

- **every opening** is lined (jambs and a head the wall's thickness deep — a window's from its frame
  to the room's face) and cased on its faces;
- **a door**, by its type's operation (Core 8.4), `hinge` and `swing` (7.1) read as the plan reads
  them (render2d `plansymbols.ts`): a slab hung on three hinges with a lever each side; a pair; a
  double-acting slab with push plates; a pocket slab running into the wall beyond its hinge jamb
  (open, only as far as the wall goes); two bypass panels on two tracks; a barn slab on its rail;
  bifold panels in pairs; a garage door's horizontal sections, inside the opening on the side it
  rises on (the room's, where only one side has one); nothing for `cased`. A pair or a slider in an
  outside wall — French and patio doors — and any door whose type's name says glass, glazed, French,
  patio or lite has stiles and rails round a glass panel, and is clad dark like a window;
- **a window**, by its operation: a frame near the outside face; one sash (casement, awning, hopper,
  tilt-turn, pivot), two offset (single- and double-hung) or side by side (horizontal slider), or
  the glass set in the frame (fixed); mullions and muntins only where its type's name asks (twin,
  triple, mullion; grille, muntin, divided, colonial, prairie) — clean by default; a stool and an
  apron inside when its sill is 300 mm or more off the floor, a sill outside.

`meshDocument(doc, { doors })` draws doors `closed` (default), `open` — swung to 90°, slid, folded,
raised under the ceiling — or `both`, every moving piece each way with its `state`, for a view that
switches without meshing again (the editor: closed in orbit, open in the walkthrough). Every turn is a
quarter turn, so there is no trigonometry; round pieces use the circle table. Each piece's role
(`millwork`, `frame`, `door`, `glass`, `darkMetal`, `stainless`) has its look in `ROLE_LOOKS`. Closed,
every piece stays inside the cut grown by `ENVELOPE` (100 mm along the wall and proud of each face,
120 mm above the head and below the sill), a pocket's or barn door's by its width more along the wall
on its side; open, within a door's width (or a garage door's height) of either face.

## Materials (FLR-T-13.6)

`@floorspec/mesh/materials` is the material library: 56 CC0 physically based materials at their
real size — each a Core material ready to embed (`embedLibraryMaterial`) or to put in place of one
a document has (`swapToLibraryMaterial`), its maps as assets and its `source` naming the item — and
the files of their maps in `materials/` (`SOURCES.json`, `NOTICE.md`, `scripts/prepare-materials.py`).
`ROLE_LIBRARY` dresses a model's pieces by role. `worldCoordinates` (`src/texcoords.ts`) lays a
texture at true scale where Core 18.3 does not: a roof along its slopes, the rest by a box
projection, square roots only. See `docs/materials.md`.

## manifold-3d

Pinned at **3.2.1**, the newest release with no dependencies (3.3 onwards pulls in the manifoldCAD
toolchain). In Node it reads `manifold.wasm` beside its script; in a browser it resolves
`new URL('manifold.wasm', import.meta.url)`, which Vite serves as an asset. A bundler that does not
can pass `loadMesher({ locateFile: () => url })`. Its own type declarations do not resolve under
NodeNext, so `src/kernel.ts` writes out the part of the API this package uses.

## Tests

`pnpm test` (Node) runs the property tests over every valid case of the vendored conformance suites,
the editor's template, the plan renderer's fixture houses, the layout solver's ranch under a hip
roof and 80 generated rectilinear houses: watertight (edge twins, manifold-3d status, Euler genus),
volume against the exact analytic value, every opening cut (ray test), every doorway floored by its
thresholds and every corner a separator leaves closed (ray tests), every piece of joinery one exact
solid inside its envelope, exact bounding boxes, and determinism; `joinery.node.test.ts` meshes a
house with every door and window operation closed, open and both. `pnpm test:browser` runs the isomorphic ones in headless Chromium and compares every
mesh byte for byte with Node's. `pnpm timings` prints how long the ranch takes.
