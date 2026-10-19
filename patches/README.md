# Patched dependencies

pnpm applies each patch here to the one exact version it is keyed to (`patchedDependencies` in
`pnpm-workspace.yaml`). A bump of that package fails the install until its patch is redone or
dropped: a patch never lands silently on a version it was not written against.

## three-gpu-pathtracer@0.0.27.patch (FLR-T-13.18, carried to 0.0.27 by FLR-T-13.15)

The editor's GPU still (`apps/web/src/editor/three/still/gpu/tracer.ts`, the only module that imports
the library) is held to the worker's CPU still by `apps/worker/test/gpu-parity.test.ts`. Five things
kept it from agreeing in a sunlit room and in a lamp-lit one. Two are fixed in the scene
(`gpu/scene.ts` `prepareHouse`): every material is double-sided, and a spot lamp is set back along
its axis so the disc the library samples is the lamp. The meter is fixed in `tracer.ts`. A lit
luminaire's own pieces are passed by the library itself since 0.0.27: `prepareHouse` sets
`mesh.visibleToShadowRays = false` on them, and the library's `raycastShadow` skips such a mesh. The
rest is this patch, to the wavefront tracer the library uses by default (the megakernel is not
patched and not used):

| File | Change | Why |
| --- | --- | --- |
| `compute/wavefront/TraceShadowRayKernel.js` | A shadow ray toward the sun or a lamp goes on through a thin-walled transmissive surface, dimmed by what it lets straight through at its angle (transmission × colour × (1 − Fresnel), as the BSDF's straight-through lobe), up to 8 crossings, each one a call to the library's own `raycastShadow`. What got through is written to the result's `barycoord`. The library's `forwardBlocked` is kept across the crossings. | 0.0.27's shadow rays still stop at the first transmissive surface: no sun through windows. |
| `compute/wavefront/LogicKernel.js` | Next-event light is multiplied by that `barycoord`. | So glass dims the sun it lets through. |
| `compute/wavefront/MaterialKernel.js` | The environment's shadow ray is queued unbounded (`maxDist` 0, which the trace kernels read as "no limit") instead of 0.0.27's `lightDist × (1 − ε)`, so the shadow kernel can tell it from the sun's and the lamps'. | The sky through a window is reached by BSDF rays too, under MIS. Letting its shadow rays through glass as well would count it twice. |
| `compute/wavefront/MaterialKernel.js` | A punctual light on the far side of a thin pane is not sampled from the pane. | The pane's shadow-ray pass-through already brings that light to the surface beyond. Sampled from the pane too, through a lobe that "filter glossy" had blurred to roughness 0.45, it smeared a second copy of every sun patch across the room: +1 to +2.5 stops. |
| `compute/wavefront/MaterialKernel.js` | Emission counts only on a path whose every scatter so far had a pdf of at least 1: the camera's own view, straight or in a mirror, a polished face or through glass. | An emissive surface in a Floorspec still is a lit lens (31 250 cd/m²). Its lamp lights the room. Gathered by bounces too, the lens lit the kitchen about two stops over. 0.0.27's `visibleToCameraRays` is for area lights only. |

No upstream issue or pull request has been opened yet.

### From 0.0.26 to 0.0.27 (FLR-T-13.15)

The 0.0.26 patch also let a lamp's shadow rays through a material whose `castShadow` was false.
That part is dropped: 0.0.27's per-object `visibleToShadowRays` does the job, and nothing in the
wavefront tracer reads a material's `castShadow` any more, so `prepareHouse` no longer clones a
luminaire's materials to set it. One difference: the library passes such a mesh for every shadow
ray, the sun's included, so by day a lit luminaire casts no sun shadow in a GPU still. It also
marks such a ray `forwardBlocked`, so its light is not MIS-weighted against a BSDF ray that could
never reach it.

0.0.27 picks the light for next-event estimation by its estimated contribution at the point lit (a
spot by its cone and the nearest point of its disc) rather than uniformly among every light and the
sky. With the Courtyard House's 41 lamps on, a kitchen at night draws on a handful of them, and the
still cleans up at the same samples. Measured on an M4 Pro (headless Chromium WebGPU) through
`traceStill` as the dialog calls it, 320 × 240, the traced radiance before the denoiser against a
2048-sample render by the same version:

| View | Samples | Relative MSE, 0.0.26 → 0.0.27 | RMS error in stops, 0.0.26 → 0.0.27 |
| --- | --- | --- | --- |
| Kitchen (R8) at night, lamps on | 16 | 2.35 → 0.35 | 1.45 → 0.52 |
| | 64 | 0.56 → 0.050 | 0.69 → 0.27 |
| | 256 | 0.18 → 0.011 | 0.42 → 0.14 |
| The house from the south-west at night, lamps on | 16 | 10.5 → 0.81 | 0.84 → 0.46 |
| | 64 | 1.99 → 0.16 | 0.41 → 0.26 |
| | 256 | 0.64 → 0.032 | 0.28 → 0.18 |

The converged pictures did not move: the six references re-recorded at 0.0.27 are within 0.02 of a
stop of 0.0.26's in every region, and `gpu-parity.test.ts` measures what it did before (within 0.54
and 0.18 of a stop at worst). The spot disc still sits `radius / tan(cone)` ahead of the light, so
`spotSetback` stays. three-mesh-bvh 0.9.16 changed nothing the tracer uses. oidn-web 0.5.0's API
change (`initUNetFromBuffer`/`initUNetFromURL` take `{ device }`; the library still passes
`adapterInfo` beside it, which is ignored) needs nothing here, and its tiles now run between event
loop turns rather than one a frame.

### At the next version

Read the wavefront kernels' diff first. The glass pass-through and the lens rule are the parts most
likely to be fixed upstream: drop each one the library does itself, keep the environment's 0 marker
for as long as the shadow kernel passes glass, and re-record the GPU references
(`apps/worker/test/fixtures/gpu-still/index.json` says how they were made).
