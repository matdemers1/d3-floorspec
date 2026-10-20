# @floorspec/render2d

The deterministic SVG plan renderer (FLR-T-2.8). Isomorphic — no Node APIs — so the editor, the
server, MCP and the worker draw the same plan from the same document.

```ts
import { renderPlan } from '@floorspec/render2d';

renderPlan(doc, {
  level: 'MAIN',              // default: the lowest level by elevation, then ID
  theme: 'light',             // 'light' | 'dark' — @d3cloud/ui 1.5 tokens resolved to fixed hex
  scale: 24,                  // SVG pixels per foot
  highlight: ['WI1', 'KIT'],  // drawn in the Floorspec accent (#b5d84a)
  ghost: { before: mainDoc }, // changeset ghosting: added/moved in the accent, removed/old dashed
  dimensions: true,           // exterior dimension strings, ft-in (FLR-T-18.11)
  annotation: { rooms: true, tags: true, custom, notes }, // room strings, door/window tags, FS_annotation
  labels: true,               // room name (or function), net ft², ft-in size, ID
  roof: false,                // the roof layer: eave outline dashed, ridges, hips, valleys, gable ends
  site: { interval: 390144 },  // FS_site's contours every foot of the survey's datum (FLR-T-15.1)
  symbols: bytesBySha256,     // fallback symbol bytes (Core 12.6): Map<sha256, Uint8Array> or (sha256) => bytes
}); // → a standalone SVG string
```

**Whose reader.** `renderPlan` validates the document once, with `reader` (Core 1.6.4, 12.2: the
extensions it implements, the extensions it knows, the newest Core draft, a package's files) —
default `DEFAULT_READER`, the reference implementation's `OFFICIAL_READER`, so a document that
requires an official extension draws. A caller that has already evaluated the document passes the
evaluation and nothing is validated again:

```ts
const ev = evaluate(bytes, { ...OFFICIAL_READER, design });   // the caller's reader, once
renderEvaluation(ev, { level: 'MAIN', theme: 'dark' });        // no second validation
sceneOf(ev, 'MAIN', derived);                                  // the scene alone, as the worker's drawings use it
renderPlan(doc, { reader: { extensions: ['FS_electrical'], knownExtensions } }); // a reader of its own
```

- **Geometry is the engine's.** Wall outlines, junction fills, room polygons and opening points are
  the values `@floorspec/engine` derives exactly and rounds once; the renderer only places symbols
  (door leaves, swings, glazing) relative to them.
- **Doors by operation (Core 8.4, FLR-T-12.24):** a single swing as its leaf open at 90° and a
  quarter arc; double doors as two leaves whose arcs meet at the middle; a double-acting door with
  a swing to each side; a pocket door half drawn into a pocket in the wall, dashed in the floor's
  colour over the poché; a bypass slider as two leaves on two tracks; a barn door on its face with
  its open position dashed; a bifold as zig-zag leaves; an overhead (garage) door as a dashed line
  just inside the opening; a cased opening with no leaf. `hinge` and `swing` are respected where
  Core gives them meaning and read as hints elsewhere.
- **Furniture and fixtures (FLR-T-12.24):** an element whose fallback symbol's bytes the caller
  gives (`symbols`) is drawn as that image on its box, turned with its placement and inked into the
  palette through one `feColorMatrix`; otherwise FS_furniture and FS_plumbing elements are drawn as
  their kind's outline — a bed with pillows, a sofa with back and arms, tables, chairs, a counter
  line on cabinets, burners, a toilet's tank and bowl, basins, a tub, a shower and its drain — and
  any other element as its fallback box. Room labels keep clear of them. `doorSymbol` and
  `fixtureSymbol` (`plansymbols.ts`) are the geometry the worker's PDF and DXF drawings and the
  editor's plan canvas (FLR-T-12.27) draw too; `boxFrame` and `categoryOf` give them an element's
  box and kind as the scene reads them.
- **Wall poché is one body:** an outline layer under a fill layer, so wall pieces and junction fills
  join without seams. Openings are cut through one mask, and the floor runs through them.
- **Stairs and roofs (Core 0.3):** a stair is drawn on the level it rises from — its treads and
  landings, dashed above the cut plane 4 ft up, a break line across the first tread above it, and
  an UP arrow along its walkline; a winder or spiral stair, whose steps Core does not derive, as its
  box (and a spiral's circle). Roofs are on the optional roof layer. `stairSymbol` and `roofSymbol`
  are exported so the editor's canvas draws the same symbols.
- **Deterministic:** elements drawn in ID order, every number through one two-decimal formatter, no
  clock, no randomness, no trigonometry. Identical input gives identical bytes; the golden SVGs in
  `test/golden` hold it to that.
- Styling follows the Floorspec (FLR) Figma board's plan canvas: rooms on `surface-card`, poché in
  `fg`, separators dashed in `border-float`, doors in `fg-faint` with a dashed quarter swing,
  windows in `info`, dimensions in JetBrains Mono.

- **Dimensions and annotation (FLR-T-18.11, FLR-ADR-047)** are one layout, `annotate.ts`, that this
  renderer, the worker's PDF and DXF and the editor's canvas all draw. `exteriorStrings` reads each
  side off the building's outer boundary (`outline.ts`: the union of the wall and junction pieces):
  the openings located, the major jogs and the overall size, nearest first — corners where the
  boundary turns 20° or more or an arc wall ends, an arc's furthest point on the side it bulges to,
  points under 6" apart merged, a recessed face's openings on a string of their own just off it.
  `roomStrings` runs one across and one up each room of 8 ft or more, beside its label; `customString`
  draws a person's FS_annotation string as the engine resolves it; `tagsOf` places door and window
  tags with `openingMarks`' D1…/W1…. `layoutAnnotations` puts it all on paper — lines, ticks,
  extension lines, lengths, tags, notes with leaders — in the medium's metrics (`PDF_METRICS`,
  `SCREEN_METRICS`): exterior strings stacked outward, a length too long for its span on a row of its
  own with a leader, the strings beyond it moved out by that row, and the depth each side reaches
  returned for the margins. `scaleBarOf` is the graphic scale every drawing prints.

- **The site (FLR-T-15.1, FS_site)** is drawn on the lowest level from the engine's `siteDrawing`:
  contours every foot of the survey's datum under the floors (`site: { interval, majorEvery }`), the
  survey's own contour lines dashed, cut hatched in amber and fill in rows of blue dashes over the
  paving (never colour alone), the spots with their heights, and the lot with each edge's bearing and
  length and the setback line — four plan layers, `site`, `contours`, `grading` and `spots`, on in
  Landscape mode. `siteLayers` is exported so the editor's canvas draws the same SVG.
- **Outdoor rooms (FLR-T-15.2, FS_outdoor)** are drawn from their own parameters through the engine's
  `outdoor` helpers, so the posts drawn are the posts derived: a pool's water inside its coping, a
  fence's line in timber with its posts and each gate's leaf and swing, a kitchen's appliances along its
  run, a fire's flame — over the floors — and a shelter last of all, its posts solid and its beams and
  rafters (a porch's roof, a sail) dashed, overhead. One plan layer, `outdoor`, on in Landscape mode and
  ghosted in the Decorator and Electrical modes; `outdoorOf` and `outdoorLayers` are exported so the
  editor's canvas draws the same SVG.
- **Context (FLR-T-15.3, FS_context)** — the street, the neighbours and the trees beyond the lot — is drawn
  on the lowest level in one neutral style of its own, never the design's: the carriageway tinted between
  its curb lines, the strips dotted and the sidewalks' backs in thin grey, the centreline dashed and the
  street named along it; each neighbour's footprint hatched and dashed with its ridge (and hips); each tree
  a dashed crown. A dashed "Context · …" tag sits by each kind. One plan layer, `context`, on in Landscape
  mode and off in every other; `contextLayers` is exported so the editor's canvas draws the same SVG.

PNG output lives in the worker (`apps/worker/src/render`): `renderPlanPng(doc, { width, ...opts })`
rasterises with resvg and the bundled Inter / JetBrains Mono, never the host's fonts.

The sample houses in `test/fixtures` are links to `packages/mcp/test/fixtures` — one set of
documents for the renderer and the summary.
