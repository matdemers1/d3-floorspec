# apps/worker

The Postgres job-queue drain (FLR in Foreman for the tasks behind it).

- `src/queue/` — claims queued jobs from `jobs` with `FOR UPDATE SKIP LOCKED`, woken by NOTIFY on
  `floorspec_jobs` and a five-second poll; retakes a job whose lock is ten minutes stale (three
  attempts at most); stores each file in `job_outputs` for seven days. Started by `src/index.ts`
  when `DATABASE_URL` is set; the api runs the same drain in-process when `JOB_DRAIN=inline` (the
  default outside production).
- `src/export/drawings/` — FLR-T-9.3: `exportPdf` (a dimensioned sheet per level, a 3D view, the
  NOT FOR CONSTRUCTION mark; PDFKit, fonts embedded) and `exportDxf` (AutoCAD 2000 DXF per level in
  millimetres on NCS-pattern layers; a ZIP for several). Both are pure functions of the document
  and the version's facts: the same version gives the same bytes, on a laptop or in the image.
  FLR-T-9.7: **stairs** on the plan of the level they rise from — treads under the 4 ft cut solid,
  above it dashed, the cut line across the first tread above it with a break, UP along the
  walkline from the foot — and again on the level they arrive at, every tread solid with DN from
  the head (render2d's `stairSymbol` geometry; `symbols.ts` adds only the break and the labels).
  **Roofs**: each roof's eave dashed on its own level's plan (it is above the cut), and a **roof
  plan** sheet (`A-1nn` after the floor plans) and DXF file whenever a drawn level carries a roof:
  eave and gable ends, ridges, hips and valleys (render2d's `roofSymbol`), a slope arrow downhill
  on every pitched face with its pitch (`6:12`; degrees for a metric project), the exterior walls
  below dashed. DXF layers `A-FLOR-STRS`, `A-FLOR-STRS-OVHD` (hidden linetype), `A-FLOR-STRS-IDEN`,
  `A-ROOF-OVHD` (dashed), `A-ROOF-OTLN`, `A-ROOF-RIDG`, `A-ROOF-VLLY`, `A-ROOF-IDEN`. **Designs**:
  the job's `design` (Core 19.6) chooses which design is drawn, the primary by default; the title
  block's DESIGN line and the DXF note say which (`Deck — Deck · Kitchen — B: open`). The sheet's
  **3D view** is the mesh — `render3d`'s `renderView` over the same scene the glTF export writes,
  cut away above the sheet's level (the whole model on the roof plan and schedule sheets) — as a
  PNG at 300 dpi of the panel, replacing the painter's-algorithm axonometric.
- `src/export/ifc/` — FLR-T-9.4: `exportIfc` evaluates and derives the version with the engine and
  POSTs `{document, derived, hash, design, file}` to the Python IFC worker (`workers/ifc`,
  `IFC_WORKER_URL`, default `http://ifc-worker:3410` in production and `http://127.0.0.1:3410`
  elsewhere), which writes IFC4 ADD2 TC1 Reference View through IfcOpenShell — LGPL, so in its own
  process and image. Job kind `export.ifc`; the file is stored like any other export.
- `src/export/gltf/` — FLR-T-9.2: the 3D model as **glTF 2.0 binary** and **USDZ**, both written
  from one scene (`scene.ts`) of one version in one design (default the primary; the job's `design`
  chooses another, and the file records which). The scene is what the engine derives, meshed by
  `@floorspec/mesh`, turned to +Y up in metres by Core 2.3 — Floorspec (x, y, z) at (x, z, −y) /
  1,280,000 — with a node per element (`extras.floorspec` = id, kind, level) under a node per level.
  Materials are the document's PBR materials (Core 18.1: colour to linear, metallic and roughness
  from thousandths); a wall's faces take their resolved finishes (18.6) with each finish region cut
  out of its face; surfaces whose material has a texture carry UVs exactly as 18.3 places them
  (`u = s′/w`, `v = −t′/h`), and tangents when a normal map is embedded. Maps are embedded when the
  exporter is given their bytes (`images`) and they are PNG or JPEG. A job reads them from the asset
  store (`ASSET_DIR`, `ab/cd/<sha256>`; the worker mounts the api's `assets` volume read-only) by
  the digest the document records, checks the bytes against that digest and their signature
  against the declared media type, and embeds only digests the job's project has uploaded
  (`project_assets`); anything else is left out and listed in the job's summary.
  An extension element's fallback model is marked by a child node at its 12.6 placement; the model
  itself is not merged in. USDZ is a stored ZIP, every file 64-byte aligned, root layer `model.usda`
  (metersPerUnit 1, upAxis Y, UsdPreviewSurface), moved so the footprint is centred on the origin
  and the lowest point is on the floor (AR Quick Look's origin). Deterministic: same version, same
  bytes, on macOS and in the linux image alike. Tests run the Khronos validator (`gltf-validator`)
  over every valid Core 0.3 conformance case and the fixture houses — zero errors, zero warnings —
  and, where Apple's `usdchecker` is installed (macOS), `usdchecker --arkit --strict` on the USDZ.
- `src/render3d/` — FLR-T-8.5: headless 3D render-back. A PNG of the scene above from a named view
  (`sw`, `se`, `ne`, `nw`, `top` — the editor's presets, framed on the house), or standing in a room
  (by ID or name: at eye height just inside its first door, else in its far corner, looking at its
  middle), optionally cut away above a level and with elements highlighted. Drawn by a small
  software rasterizer (`raster.ts`: z-buffer, flat Lambert shading, 2× supersampling, ink where
  planes meet, glass blended last) in plain JavaScript — **no Chromium, no GPU, no WebGL** in the
  image, so the picture is the same on every machine and the image grew by about 2 MB (manifold-3d's
  WASM and the mesher), not by a browser. A 1024 × 768 render takes a few hundred milliseconds. The
  api's `GET /render?view=3d` queues a `render.3d` job and waits for it (60 s by default); MCP
  `floorspec_render` with `view: "3d"` and `camera` (a view's name, or a room's ID or name) calls it.
  `renderGlb` draws an exported .glb back through the same rasterizer — how the tests look at one.
- `src/render/` — FLR-T-2.8: plan PNGs through resvg, with the bundled fonts only.
- `src/alerts/` — FLR-T-12.2: alert email through the D3 Auth mail relay (`MAIL_RELAY_URL`,
  `MAIL_RELAY_TOKEN`, `ALERT_TO`; redacted, once an hour per kind, remembered in the `alerts` table),
  shared with the api as `@d3-floorspec/worker/alerts`; and the health watchdog `src/index.ts`
  starts — the api's `/health` (`HEALTH_URL`, default `http://api:3400/health` in production) and
  the database, every `WATCHDOG_INTERVAL_MS` (60 s), one email after `WATCHDOG_THRESHOLD` (3)
  failures in a row and one on recovery. See `docs/runbooks/restore.md`.

```bash
pnpm --filter @d3-floorspec/worker test    # drawings, glTF/USDZ, 3D render, plan render, heartbeat, alerts, watchdog
```
