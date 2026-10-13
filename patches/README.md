# Patched dependencies

pnpm applies each patch here to the one exact version it is keyed to (`patchedDependencies` in
`pnpm-workspace.yaml`). A bump of that package fails the install until its patch is redone or
dropped: a patch never lands silently on a version it was not written against.

## three-gpu-pathtracer@0.0.26.patch (FLR-T-13.18)

The editor's GPU still (`apps/web/src/editor/three/still/gpu/tracer.ts`, the only module that imports
the library) is held to the worker's CPU still by `apps/worker/test/gpu-parity.test.ts`. Five things
kept it from agreeing in a sunlit room and in a lamp-lit one. Two are fixed in the scene
(`gpu/scene.ts` `prepareHouse`): every material is double-sided, and a spot lamp is set back along
its axis so the disc the library samples is the lamp. The meter is fixed in `tracer.ts`. The rest is
this patch, to the wavefront tracer the library uses by default (the megakernel is not patched and
not used):

| File | Change | Why |
| --- | --- | --- |
| `compute/wavefront/TraceShadowRayKernel.js` | A shadow ray toward the sun or a lamp goes on through a thin-walled transmissive surface, dimmed by what it lets straight through at its angle (transmission × colour × (1 − Fresnel), as the BSDF's straight-through lobe). A shadow ray toward a lamp goes on through a material whose `castShadow` is false. What got through is written to the result's `barycoord`. | 0.0.26 stops every shadow ray at the first surface ("opaque occlusion … TODO"): no sun through windows. And a luminaire's own dome, lens and trim shadowed its lamp. |
| `compute/wavefront/LogicKernel.js` | Next-event light is multiplied by that `barycoord`. | So glass dims the sun it lets through. |
| `compute/wavefront/MaterialKernel.js` | The environment's shadow ray is queued unbounded (`maxDist` 0, which the trace kernels already read as "no limit"), so the shadow kernel can tell it from the sun's and the lamps'. | The sky through a window is reached by BSDF rays too, under MIS. Letting its shadow rays through glass as well would count it twice. |
| `compute/wavefront/MaterialKernel.js` | A punctual light on the far side of a thin pane is not sampled from the pane. | The pane's shadow-ray pass-through already brings that light to the surface beyond. Sampled from the pane too, through a lobe that "filter glossy" had blurred to roughness 0.45, it smeared a second copy of every sun patch across the room: +1 to +2.5 stops. |
| `compute/wavefront/MaterialKernel.js` | Emission counts only on a path whose every scatter so far had a pdf of at least 1: the camera's own view, straight or in a mirror, a polished face or through glass. | An emissive surface in a Floorspec still is a lit lens (31 250 cd/m²). Its lamp lights the room. Gathered by bounces too, the lens lit the kitchen about two stops over. |

`prepareHouse` marks a lit luminaire's pieces with both `material.castShadow = false` (read by this
patch) and `mesh.visibleToShadowRays = false` (0.0.27's own flag).

No upstream issue or pull request has been opened yet.

### At three-gpu-pathtracer 0.0.27 (FLR-T-13.15)

Checked against the 0.0.27 tarball (published 2026-10-08):

- **Still needed:** glass. 0.0.27's shadow rays still stop at a transmissive surface (the
  megakernel's "opaque occlusion" note is still there, and the wavefront shadow kernel is still
  hit-or-miss). The new `raycastShadow` hits both sides and skips objects with
  `visibleToShadowRays === false`, but it neither passes nor dims glass. Port the pass-through and
  the dimming onto `raycastShadow`, plus the `barycoord` multiply in its `LogicKernel`.
- **Still needed:** the lens rule and the pane rule in `MaterialKernel`. 0.0.27's
  `visibleToCameraRays` is for area lights only. Note that 0.0.27 queues `maxDist` as
  `lightDist * (1 − ε)`, so keep the environment's 0 marker or replace it with a field.
- **Drop:** the `castShadow` pass in the shadow kernel. 0.0.27's per-object `visibleToShadowRays`
  does the same job, and `prepareHouse` already sets it. One difference: 0.0.27 skips such an
  object for every shadow ray, the sun's included.
- **Unchanged in the library, kept in the scene:** the spot disc. It still sits
  `radius / tan(cone)` ahead of the light, so `spotSetback` stays. 0.0.27's light selection, weighted
  by each light's estimated contribution, should make a night still with 41 lamps less noisy.

Re-record the GPU references after the bump (`apps/worker/test/fixtures/gpu-still/index.json` says how).
