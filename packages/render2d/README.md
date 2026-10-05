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
  dimensions: true,           // overall exterior dimensions, ft-in
  labels: true,               // room name (or function), net ft², ft-in size, ID
  roof: false,                // the roof layer: eave outline dashed, ridges, hips, valleys, gable ends
}); // → a standalone SVG string
```

- **Geometry is the engine's.** Wall outlines, junction fills, room polygons and opening points are
  the values `@floorspec/engine` derives exactly and rounds once; the renderer only places symbols
  (door leaves, swings, glazing) relative to them.
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

PNG output lives in the worker (`apps/worker/src/render`): `renderPlanPng(doc, { width, ...opts })`
rasterises with resvg and the bundled Inter / JetBrains Mono, never the host's fonts.

The sample houses in `test/fixtures` are links to `packages/mcp/test/fixtures` — one set of
documents for the renderer and the summary.
