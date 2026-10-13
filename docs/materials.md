# Real materials

How a house's finishes look in every view — the editor's 3D view, the headless render, the path
tracer, the glTF and USDZ exports and the GPU still that loads the glTF (FLR-T-13.6). One library
of physically based materials at their real size, one way of laying their maps on every surface.

## The library

`@floorspec/mesh/materials` is a CC0 library of 56 materials: woods (planks, herringbone, cedar
boards, veneers), decking, tile (porcelain, subway, zellige, terrazzo, terracotta), stone (marble,
quartz, granite, bluestone, fieldstone), brick (running bond in red, whitewashed and buff Roman,
herringbone pavers), plaster (smooth, limewash, stucco), concrete (smooth, broom, epoxy), six paint
sheens, metals (brushed stainless, satin brass, blackened steel, copper, anodised aluminium),
fabrics (linen, wool, velvet, leather, carpet), glass (clear, frosted, bronze), roofing (standing
seam, slate, cedar shakes, clay barrel tile), siding (fibre-cement lap, board and batten, V-groove)
and pavers. Each is a Core material (8.5, 18.1) with its maps:

| Map | Core member (18.2) | Channels |
|---|---|---|
| `*.albedo.jpg` | `asset` | base colour, sRGB |
| `*.normal.jpg` | `normal` | tangent-space normal, +Y up the tile |
| `*.orm.jpg` | `metallicRoughness` and `occlusion` | occlusion red, roughness green, metalness blue (glTF's) |

A tile's real-world size is the publisher's measurement (Poly Haven's `dimensions`) or, for
ambientCG's, counted from what the image shows; maps are 1K, 2K for white oak, herringbone,
terrazzo, marble and red brick — about 36 MB in all, JPEG, so every view and decoder reads them
(KTX2 would need a transcoder in the worker and the editor). Sources, digests and licence:
`packages/mesh/materials/SOURCES.json` and `NOTICE.md`; `scripts/prepare-materials.py` makes them.

**A colour map averages to its item's colour** (FLR-T-13.17). Core 18.1 makes a material's base
colour the texel of its colour map where the map is drawn, and its `color` where it is not — a
plan, a swatch, a distant view; the colour never multiplies the map, and no view multiplies them
(the editor's vertex colours, the raster's, the path tracer's and the glTF's base colour factor are
white under a map). So the two are one material only when the map averages to the colour: the
prepare script scales each map's channels in linear light until its mean is its item's `color`
(`calibrate`), keeping its grain, veining and joints. Library 0.1.0 took the publishers' scans as
they were exposed, and white oak came out a mid brown half as light as white oak — under a sunny
window it read as walnut. A bare metal's map (`metallic` 1000) is its measured reflectance and is
left as it is.

**Colour-agnostic items** — the paints, smooth plaster, stucco, siding, the standing seam, V-groove
boards — have no base colour map: their `color` is their base colour (18.1), so a person's colour is
kept, and the maps are only their relief and sheen. A paint's sheen is its `roughness`: flat 950,
matte 880, eggshell 720, satin 560, semi-gloss 360, gloss 200, over a roller's stipple they share.

## In a document

A library material is embedded, never referred to by URL: an asset for each map file (by digest,
`path` `assets/<sha256>.jpg`, so two materials sharing a file share an asset) and the material, its
`source` naming the library (`https://d3cloud.io/floorspec/library/materials`), its version and the
item (Core 8.1). Core needs nothing new: a tile's size is `texture.size`, a plank's direction is
`texture.rotation`, the maps are 18.2's.

- **The editor**: Materials → Material library (the board's frame 13c) — a category, a card with a
  swatch of 2 ft of it at its real size, Add. Adding uploads the files into the project's asset store
  (so its package is complete) and embeds it. The inspector's Texture section (frame 13d) names the
  item and turns the texture (0°, 90°, ±45°).
- **MCP**: an agent names an item wherever a material goes — `"floorFinish": "white-oak-plank"`, a
  layer's, a face's, a region's, a slab's or a roof's — and the tools embed it with its maps the
  first time, uploading every library file a batch's assets name.
- **In place**: `swapToLibraryMaterial` turns an existing material into an item without moving a
  reference — every finish, layer, slab and roof that names it is the library's now, and a
  colour-agnostic item keeps the material's colour.

- **Brought up to date**: `refreshLibraryMaterials(document)` is the batch that moves every material
  embedded from an earlier build of the library to this one (0.2.0's calibrated maps): each one
  swapped in place — the new map files added as assets, so a tool uploads them, its turn, offset,
  name and a colour-agnostic item's colour kept — and every asset only the old maps used removed.

A view that holds the package draws a library digest from its own copy when the project's store
lacks it (a batch applied without uploads): the editor from its bundled files, the worker from
`@floorspec/mesh/materials/<file>`.

## Laid at true scale

Walls, floors and ceilings are laid as Core 18.3 says (`surfaceGroups`). Where 18.3 says nothing,
`@floorspec/mesh` `worldCoordinates` gives world-scale coordinates in base units:

- **a roof's slopes along them** — `s` along the eave, `t` up the slope, true lengths on any pitch —
  so standing seams run down the slope at their width and slates course along the eave;
- **everything else by a box projection** seen from outside — a counter's top in plan, its edge
  along its front, a slab's top running on from the floor beside it.

Square roots only, no trigonometry: every engine gives the same values. Model pieces are dressed
by role (`ROLE_LIBRARY`, a view's choice): a counter's stone as white quartz, cabinets and doors in
rift oak, upholstery in wool and linen, sinks in brushed stainless, rugs in wool carpet, brass as
brass, pavers, brick and concrete in the landscape as theirs.

## In each view

| View | Base colour | Normal | Roughness, metalness | Occlusion |
|---|---|---|---|---|
| Editor (three.js `MeshStandardMaterial`) | yes | yes | yes, metalness held to 0.5 (no reflections traced; a probe lights it) | yes, on the probe's light |
| Raster render | yes, mip-mapped | lit by the key light or the sun | — | yes |
| Path tracer | yes | lights every hit | GGX gloss and metal, as the GPU still's (FLR-T-13.14): reflections traced, a metal's in its colour, no diffuse | the light a bounce brings, and half the sun's and lamps' |
| glTF, USDZ, GPU still | yes | yes, with tangents | yes | yes |

In the editor a surface's ORM map is read through one texture unit (roughness, metalness and
occlusion from the one image), and as many lamps cast shadows as a 16-unit GPU has units for beside
a surface's maps and the sun's shadow (`shadowBudget`, FLR-T-13.17): over it a shader fails to link
and three.js draws nothing with it — with "All on", every textured floor and wall vanished.

The tracer's surfaces are glTF's metallic-roughness model as the GPU still traces it — GGX, Smith,
Schlick, reflections traced and sampled where they reflect (lighting.md, "Gloss, metal and glass").
Library glass is drawn
see-through where a view can (the glTF's transmission, the tracer's and the raster's thin glass) — a
view's reading of the item, since Core 18.1 has no transmission.

## Glass

Every view draws a pane by `@floorspec/mesh` `glass.ts` (FLR-T-13.17): what is behind it times what
the pane lets through, plus what its face reflects. Clear float glass lets about 90% through face on
(two faces at 4% each, Fresnel at n = 1.5) with the faint green of its iron; seen at a slant its faces
reflect more (Schlick) and its path through the glass is longer, so a pane seen edge-on is a
mirror with a green cast. A glass's colour is what it lets through: `paneTransmission` softens a
document's or a look's colour to it (a bronze glass is browner). The raster composites
`behind × transmission + reflected sky`, the tracer multiplies its path by the transmission and adds
the sky the face reflects, the editor blends with the transmission as a constant blend colour, and
the glTF's glass has the transmission as its base colour under KHR_materials_transmission. Drawn
before as a pale blue surface laid over the view at 35%, a window turned the lawn behind it to teal.
