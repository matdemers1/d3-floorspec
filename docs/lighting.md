# Light levels

How bright a house's light fixtures are in every view that turns them on — the path tracer
(`floorspec_render` with a `scene`, and stills), and the editor's 3D view with its Lights toggle — and
how a picture of them is exposed (FLR-T-13.1). One calibration, in photometric units, kept in
`packages/mesh/src/lights.ts` and read by every view.

## What a fixture gives

FS_electrical records a light's kind and, optionally, its `watts` — not its photometry. A light with
`watts` gives 90 lumens a watt (an LED lamp's); a light without gives a typical lamp of its kind:

| Fixture | Lumens | What it stands for |
|---|---|---|
| `ceiling` | 1500 | a flush or semi-flush fitting with two A19 lamps of about 750 lm |
| `recessed` | 800 | a 4″–6″ LED downlight, about 9 W |
| `pendant` | 800 | one lamp under a shade |
| `wall` | 400 | a sconce |
| `track` | 900 | a short track of heads |
| `underCabinet` | 300 | a strip |
| `fan` | 1200 | a fan's light kit |
| `exterior` | 600 | a porch lantern |

Recessed, track, under-cabinet and pendant lights are spots pointing down (a pendant's shade throws
its light down and keeps it off the ceiling), and so is a ceiling light (FLR-T-13.16): its lamp sits
inside the dome of its diffuser, just under the canopy, and the dome sends its light down and out —
fully to 70° from straight down, fading to nothing at 110°, so a little past the horizontal grazes the
ceiling around the fitting and none goes straight up into the canopy. A bare lamp hung 12 cm under
the fitting, shining every way as it did before, lit the ceiling around it to some 3000 lux, and the
fitting was lost in the white. A fan's light kit, a sconce and a lantern shine every way. Each view turns lumens into
candela — over the sphere, or over the cone of a spot out to the middle of its edge — and lights a
surface to I cos θ / d² lux, d in metres, with no other scale: three.js's physically based lights
(`decay` 2, intensity in candela) and the path tracer's lamps (`LUX_PER_UNIT`, 12 500 lux to its unit).
A shadowed lamp in the editor is not cut off; one without a shadow is cut off past its own room.
The editor shadows no more lamps than a 16-unit GPU has texture units for beside a surface's maps and
the sun's shadow (11; `shadowBudget`, FLR-T-13.17), one a room before any room has two.
The editor draws a spot no wider than 85° (three.js's shadow camera cannot span 180°) and glTF
writes one no wider than 90°, so there a ceiling light's dome stops short of the ceiling's glow; the
candela are the same.

Colour: 2700 K inside, 3000 K outside, seen by a camera white-balanced to 3000 K — as a photograph of a
lamp-lit room is taken — so lamps read warm white, not orange.

## Scenes, switches and dimmers

Which lights are on, how bright and how warm is a **lighting** (FLR-T-13.12, `@floorspec/mesh`
`scenes.ts`): every light at full ("All on", what every view drew before scenes), or a list of the
lights that are on, each at an output (1–100 % of full) and, optionally, a colour temperature —
every other off. A house's named scenes are design intent the owner keeps, so they live in the
document: FS_lighting 0.1.0 (FLR-ADR-043), an official extension that requires FS_electrical, holds
`scenes` (`LS1`: `{ "name": "Evening", "on": { "X12": { "output": 40, "cct": 2400 } } }`) and, by
light ID, what a luminaire gives — `lumens`, `cct`, a tunable `cctRange`, `dimmable`. A luminaire's
own `lumens` and `cct` take the place of the typical lamp's above. "All on" and "Off" are built in
and never stored.

Every view resolves a lighting the same way — `lightsOf(doc, derived, lighting)`: a light it turns
off is not in the list, one it dims gives its output's share of its lumens, at its colour
temperature; `lensGlows` says how each fixture's lens (and a lamp's shade) is drawn — dark when off,
scaled and tinted when dimmed or recoloured. The editor's three.js lamps and lenses, the path tracer
(`floorspec_render` with `scene`), the glTF export's KHR_lights_punctual lamps and emissive lenses —
which the GPU still traces — and the headless render all draw that one list.

In the editor, the Lights toggle turns the view's lighting on; with it on, clicking a switch in 3D
(or on the plan, or Enter on a selected switch) turns exactly the lights its `controls` lists off
when any of them is on, else on — and a floor or table lamp is its own switch. The Lighting panel
lists the scenes, a selected light's dimmer and colour temperature, and saves the view's lighting as
a scene with Ops on `$document` (declaring FS_lighting where it is not yet). What is on now is view
state until it is saved.

## A fixture never shadows itself

A luminaire's lamp sits just outside its model (under the lens, under a downlight's trim, in front of
a sconce), and on top of that no piece of a luminaire's own model — canopy, trim, shade, lens — ever
blocks its lamp: the path tracer's shadow rays toward a lamp pass every triangle of that lamp's
fixture (`PtScene.owner`), and the editor leaves every luminaire piece out of the shadow maps. The
GPU still lets a lamp's shadow rays through every lit luminaire's pieces (FLR-T-13.18).

A lit lens shows; it does not light. Its glow (31 250 cd/m²) is what the camera sees of it, directly,
in a mirror or a polished face, or through glass. The light the room gets is its lamp's. In the GPU
still the lens's glow once lit the room on top of its lamp, and a kitchen at night came out about two
stops bright.

## Noise

A lit render is 16 samples a pixel, smoothed by an edge-aware denoiser (FLR-T-13.16):

- **Only bounced light is clamped.** The firefly cap applies to what a path gathers past its first
  bounce — a lucky bounce onto the bright ceiling over a lamp is what sparks. What the camera's first
  surface shows lit directly, a lit lens included, is never clamped: clamped, a lens and the ceiling
  beside it were cut to the same white.
- **A pixel on an edge is smoothed from both faces.** Its normal is the average of the faces it saw,
  shorter than one; the denoiser weighs its neighbours against that, more gently the more mixed it
  is. Weighed as a unit normal it matched neither face and kept its own few samples, and every
  casing, sill, cabinet edge and wall-to-ceiling line sparkled.

Shadow rays are most of a lit render's time: one stops at the first wall in its way rather than
finding the nearest, and every bounce past the first samples one lamp where the first surface samples
two. A 1280-pixel lit render of a room takes about 30% less time for it, the picture's light the
same.

## Gloss, metal and glass

The path tracer's surfaces are the GPU still's (FLR-T-13.14, FLR-ADR-040; `apps/worker/src/pathtrace/brdf.ts`),
glTF's metallic-roughness model as three-gpu-pathtracer traces it:

- **GGX.** A diffuse base under a microfacet gloss: Trowbridge-Reitz's distribution with α the
  roughness squared, Smith's height-correlated masking, Schlick's Fresnel. A dielectric's facets reflect
  4% face on; a metal's reflect its base colour, and a metal has no diffuse — steel and mirrors show the
  room in their own colour. What a single bounce off the facets loses is put back (the GPU tracer's
  energy compensation), and what the gloss reflects the diffuse beneath it does not get.
- **Sampled where it reflects.** A path goes on off the gloss or the diffuse in proportion to what each
  reflects, off the gloss along a facet the viewer sees. The sun and the lamps are sampled through the
  whole lobe, so a polished floor shows their highlights. Seen in a mirror or a polished face (roughness
  under 0.2), the room is still the camera's view: a lit lens glows in it, and its light is not clamped.
- **Glass.** Glazing is a thin pane: each face reflects by Fresnel's equations for its ior (1.5), light
  bounces between the faces, and the tint absorbs along the slanted path — glass.ts's rule worked out
  from first principles, held to it within 4% of what it lets through. Where nothing stands in the way
  of what a pane reflects, it shows the sky; where something does — the lit room behind the camera at
  night — the reflection is traced. Shadow rays pass a pane by what it lets through at their angle, so
  the sun lays sharp patches through a window.
- **Specular 0.** A material may say it has none of the dielectric's gloss (glTF's
  KHR_materials_specular): a pure diffuser, as a lighting calculation's surfaces of a given reflectance
  are (the test rooms above). A glTF colour is a diffuse base with the gloss on top, so a 0.35 floor
  reflects about 0.39 in all.

**Against the GPU still.** `apps/worker/test/gpu-parity.test.ts` holds the CPU still to stored GPU stills
of the Courtyard House. They were traced on an M4 Pro by the editor's own still modules and read
before the meter. Each region of a 4 × 3 grid must match in mean luminance (cd/m²) within 0.6 of a
stop, and the regions' mean within 0.3. Six views are compared: the kitchen, great room and primary
bath under an overcast sky; the house outside in the sun; the great room on a clear afternoon with
the sun through its windows; and the kitchen at night with its lamps on.

The last two agree because the GPU still was made to trace them as the CPU still does (FLR-T-13.18).
Its library, three-gpu-pathtracer 0.0.26, is patched; `patches/README.md` says how, and what to do
at 0.0.27. The scene side is in `gpu/scene.ts` `prepareHouse`. Together they make these changes:

- Shadow rays toward the sun and the lamps pass glass, dimmed by what it lets through.
- A pane's far-side lamps and sun are not sampled from the pane itself, so they are not counted twice.
- A lamp's shadow rays pass lit luminaires' pieces.
- A lit lens lights nothing.
- Every face is seen from both sides.
- A pane is traced at the index whose one face reflects what its two faces do (`paneIor`): 7.7% face
  on. Its colour is raised by what that takes from the light it lets through (`paneGain`).
- A spot's sampled disc sits on its lamp.

## Exposure

`EXPOSURE_PER_NIT` is what the tone curve is given per cd/m² of luminance; a surface of reflectance ρ
under E lux shows ρE/π cd/m². A picture is metered (its log-average luminance at the key 0.18) and
held within a band:

| Time | Least | Most | So that |
|---|---|---|---|
| night, dusk | 0.01 | 0.04 | a room lit to 150–300 lux reads normally lit at the least — a white wall at 200 lux is 0.5 before the curve; a bedroom at 40–75 lux under its one ceiling light is opened up two stops and reads lit too, as an eye adapts; a room with its lamps off stays dark |
| day | 1.6e-5 | 2e-3 | a sunlit house outside reads right at the least; a daylit room inside, at 500–3000 lux from its windows, is metered up and reads bright and natural, its windows a little blown, as a photograph shows them |

The editor's GPU still is metered as the worker's still is: on the finished picture, after the
denoiser (FLR-T-13.18). Metered on its first 16 samples a pixel, as it was, the noise pulled the
log-average down — dark pixels count for more in it than bright ones. The great room on a sunny
afternoon came out at the day band's most open, 1.3 stops over the worker's still; now it is within
0.15 of a stop.

The editor's view meters nothing: with the Lights on it is exposed at the night band's open end
(0.04 — where the tracer exposes a room lit by its one ceiling light), and lamps that do not bounce
are given a 10-lux fill for the light a room's walls and ceiling bounce about it.

The path tracer traces six diffuse bounces for a render with lights, so a lamp-lit room's corners are
not black, and twice the samples by day, when a room is lit by what comes in through its windows.
`floorspec_render` reports the exposure a lit render was metered to (`lit.exposure`, per cd/m²).

The headless rasterized render (`floorspec_render` without a `scene` or `sky`) is a drawing, not a
lighting simulation: it is lit by a fixed studio rig and is not part of this calibration.

## Skies and the sun

Every view — the editor's 3D view, the headless render with `sky`, the worker's path tracer and the
editor's GPU still — is seen under one sky, `@floorspec/mesh/sky` (FLR-T-13.4, 13.9):

- **Presets:** Clear day (the default), Overcast, Dusk, Night and Studio. The editor keeps the choice
  per project in the browser; `floorspec_render` and stills take `sky`.
- **The dome** is a CC0 HDRI from Poly Haven (`packages/mesh/sky`, its sources, digests and licence in
  `SOURCES.json` and `NOTICE.md`), its sun taken out, turned about the vertical so the glow its sun
  left sits where the real sun is, and scaled so the sky alone lights a level surface to a calibrated
  illuminance: a clear sky 2.5–23.5 klx by the sun's altitude, overcast 0.5–20.5 klx, dusk about
  25 lx, a moonlit night under 1 lx (seen blue).
- **The sun** is placed by the NOAA algorithm from the site's latitude, longitude and true north
  (Core 1.8) at a date and time — the editor's Sky and sun panel, or a render's `at` (ISO 8601; with
  no offset, the site's zone by its longitude). A document with no location is placed as if at
  40° N, 75° W, and every view says so. Its illuminance falls through the air mass (Kasten and Young;
  about 93 klx at noon, 50 klx 15° up) and it reddens as it sets. A clear sky follows its sun: past
  6° it fades through the dusk sky into night's, and a moon opposite the sun takes its place.
- **The ground** is a lawn at true scale (a procedural tile every 4 m, varied across the site), out to
  the horizon, lost in the haze between 200 m and 2.4 km. It has no mowing stripes (FLR-T-13.17):
  the same stripes over the whole plane read from above at dusk as diagonal bands; and a view reading
  it from far off blends the tile's two halvings either side of its pixel's footprint, so no
  distance shows a step. Slabs, patios and driveways sit on it;
  what FS_landscape lays on the ground (FLR-T-13.5) is drawn in place of the lawn (`GroundArea`).
- **Image-based light:** the editor lights the house with the sky's nine spherical harmonics (a
  light probe) and the raster render with the same; the tracers sample the dome itself. Views that do
  not bounce light add a fill of a twelfth of the sun's light on a level surface (`skyBounce`).
- **Exposure:** an outside view is exposed for the sky's light — the key 0.18 on a surface of
  reflectance 0.2 under the sun and sky (0.08 after dark) — within the day band by day, and after dark up to 0.3 per
  cd/m², the long exposure of a night photograph; a render with its lamps on keeps the night band
  above, and a room is metered. The editor's view uses the renderers' filmic curve under a sky.

## Presentation (FLR-T-13.7)

The editor's 3D view draws in **Draft** — as it always has: Lambert's even diffuse, the panes in one
blended pass, light and fast — or **Presentation**, chosen from the Quality control in the chips at
the bottom left and kept in the browser. Presentation is the default where WebGL runs on a GPU and
Draft where it is drawn in software (SwiftShader, llvmpipe), where Presentation is offered but slow.
Its passes and three.js's post-processing load the first time it is chosen, in a chunk of their own.

It is the same light, seen better. **The exposure and the tone curve are Draft's** — the renderers'
filmic curve under a sky, three.js's ACES in the studio, at `skyExposure` or `LIT_EXPOSURE` — applied
once to the whole picture at the end (three.js's OutputPass reads the renderer's own) instead of in
each material, so a room reads as bright in both; the e2e holds the picture's mean luminance to
Draft's within a band. The sky still lights the house through its light probe.

| Pass | What it does |
|---|---|
| Materials | every surface physically based (MeshStandard): walls 0.85 rough, floors 0.5, ceilings 0.95, a model's untextured piece its role's finish; the library's textured materials as they are |
| Reflections of the sky | the dome prefiltered (three.js's PMREM) as `scene.environment` — reflections only: its irradiance is not added to the probe's |
| Soft shadows | PCSS on the sun (its angular radius) and on every shadowed lamp (its emitter's radius): a penumbra that widens with the gap between what casts it and what it falls on, found with the comparison samplers three.js already binds — no texture unit more |
| Ambient occlusion | GTAO at half size, denoised, over corners, under furniture, where walls meet floors; never over glass, a lit lens or the sky |
| Screen-space reflections | from every surface smoother than 0.6, a ray marched in screen space against the depth; what it finds takes the place of the sky's reflection there, blurrier the rougher and the longer. Indoors (inside a room's footprint, between its floor and ceiling) the sky's reflection is taken out altogether — a floor reflects the room, not the sky |
| Glass | glass.ts per pixel: what is behind multiplied by `glassTransmission` at the angle it is seen at, then the face's Fresnel reflection added (the sky's, the sun's and lamps' glints, and what the trace finds) |
| Bloom | only a lit lens (drawn far over the curve's white, as a lamp is far brighter than what it lights) and the sky; a surface is clipped to white, never glows |
| Anti-aliasing | SMAA on each frame while moving; standing still, twelve frames a sub-pixel apart averaged (temporal accumulation), which also smooths the shadows', occlusion's and reflections' noise |

**Texture units.** A lit surface in Presentation also samples the sky's prefiltered map: one unit
more, so `shadowBudget` gives 10 shadowed lamps rather than 11 on a 16-unit GPU
(`PRESENTATION_SCENE_TEXTURE_UNITS`). PCSS adds none; the screen-space passes sample their own
buffers in passes of their own.

**One draw of the scene a frame** (FLR-T-13.19). The screen-space passes need to know, per pixel, what
kind of reflector is there and how rough it is: the scene's own draw writes that into the alpha of its
float target (three.js's `opaque_fragment`, patched under Presentation's defines — a physically based
surface its kind and roughness, a lit lens "light", a pane's reflecting pass "glass", over the
transmitting pass's unchanged alpha), its depth goes to a depth texture, and the normals the occlusion
and the reflections need are rebuilt from the depth. What is blended over the house — a highlight, an
outline — and the sky's dome keep the alpha under them. There is no second, geometry-buffer pass
swapping every mesh's material.

**Frame rate.** Moving, it measures itself and draws at a lower resolution (down to 40% of each side) when the
GPU cannot hold 40 fps — its buffers resized in place as it steps down, the passes kept, so the first turn in
a room is not a string of stalls while each step's passes are made anew; a moment after the camera stops it draws at full resolution and refines.
Every program the scene needs is compiled off the frame (KHR_parallel_shader_compile where there is
one), and the whole scene is drawn once, unculled, to have the driver build its pipelines — once what
every material compiles to has stayed the same for 600 ms with the camera still, not on each of a
house's textures as it arrives — so turning to a room not yet seen does not stall on its shaders. Half floats top out at
65 504 cd/m²: the sky by the sun can pass it, so the resolve and the prefiltered dome are held under it.
