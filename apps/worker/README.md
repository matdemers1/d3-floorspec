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
- `src/render/` — FLR-T-2.8: plan PNGs through resvg, with the bundled fonts only.

```bash
pnpm --filter @d3-floorspec/worker test    # drawings, render, heartbeat
```
