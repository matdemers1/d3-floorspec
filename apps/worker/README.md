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
- `src/export/gltf/` — FLR-T-9.2: the 3D model as **glTF 2.0 binary** and **USDZ**, both written
  from one scene (`scene.ts`) of one version in one design (default the primary; the job's `design`
  chooses another, and the file records which). The scene is what the engine derives, meshed by
  `@floorspec/mesh`, turned to +Y up in metres by Core 2.3 — Floorspec (x, y, z) at (x, z, −y) /
  1,280,000 — with a node per element (`extras.floorspec` = id, kind, level) under a node per level.
  Materials are the document's PBR materials (Core 18.1: colour to linear, metallic and roughness
  from thousandths); a wall's faces take their resolved finishes (18.6) with each finish region cut
  out of its face; surfaces whose material has a texture carry UVs exactly as 18.3 places them
  (`u = s′/w`, `v = −t′/h`), and tangents when a normal map is embedded. Maps are embedded when the
  exporter is given their bytes (`images`) and they are PNG or JPEG; **the worker has no asset store
  to read yet**, so a job's export carries colours and lists the maps it left out in its summary.
  An extension element's fallback model is marked by a child node at its 12.6 placement; the model
  itself is not merged in. USDZ is a stored ZIP, every file 64-byte aligned, root layer `model.usda`
  (metersPerUnit 1, upAxis Y, UsdPreviewSurface), moved so the footprint is centred on the origin
  and the lowest point is on the floor (AR Quick Look's origin). Deterministic: same version, same
  bytes, on macOS and in the linux image alike. Tests run the Khronos validator (`gltf-validator`)
  over every valid Core 0.3 conformance case and the fixture houses — zero errors, zero warnings —
  and, where Apple's `usdchecker` is installed (macOS), `usdchecker --arkit --strict` on the USDZ.
- `src/render/` — FLR-T-2.8: plan PNGs through resvg, with the bundled fonts only.
- `src/alerts/` — FLR-T-12.2: alert email through the D3 Auth mail relay (`MAIL_RELAY_URL`,
  `MAIL_RELAY_TOKEN`, `ALERT_TO`; redacted, once an hour per kind, remembered in the `alerts` table),
  shared with the api as `@d3-floorspec/worker/alerts`; and the health watchdog `src/index.ts`
  starts — the api's `/health` (`HEALTH_URL`, default `http://api:3400/health` in production) and
  the database, every `WATCHDOG_INTERVAL_MS` (60 s), one email after `WATCHDOG_THRESHOLD` (3)
  failures in a row and one on recovery. See `docs/runbooks/restore.md`.

```bash
pnpm --filter @d3-floorspec/worker test    # drawings, glTF/USDZ, plan render, heartbeat, alerts, watchdog
```
