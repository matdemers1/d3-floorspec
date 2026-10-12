# Light levels

How bright a house's light fixtures are in every view that turns them on — the path tracer
(`floorspec_render` with `lights`, and stills), and the editor's 3D view with its Lights toggle — and
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
The editor draws a spot no wider than 85° (three.js's shadow camera cannot span 180°) and glTF
writes one no wider than 90°, so there a ceiling light's dome stops short of the ceiling's glow; the
candela are the same.

Colour: 2700 K inside, 3000 K outside, seen by a camera white-balanced to 3000 K — as a photograph of a
lamp-lit room is taken — so lamps read warm white, not orange.

## A fixture never shadows itself

A luminaire's lamp sits just outside its model (under the lens, under a downlight's trim, in front of
a sconce), and on top of that no piece of a luminaire's own model — canopy, trim, shade, lens — ever
blocks its lamp: the path tracer's shadow rays toward a lamp pass every triangle of that lamp's
fixture (`PtScene.owner`), and the editor leaves every luminaire piece out of the shadow maps.

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

## Exposure

`EXPOSURE_PER_NIT` is what the tone curve is given per cd/m² of luminance; a surface of reflectance ρ
under E lux shows ρE/π cd/m². A picture is metered (its log-average luminance at the key 0.18) and
held within a band:

| Time | Least | Most | So that |
|---|---|---|---|
| night, dusk | 0.01 | 0.04 | a room lit to 150–300 lux reads normally lit at the least — a white wall at 200 lux is 0.5 before the curve; a bedroom at 40–75 lux under its one ceiling light is opened up two stops and reads lit too, as an eye adapts; a room with its lamps off stays dark |
| day | 1.6e-5 | 2e-3 | a sunlit house outside reads right at the least; a daylit room inside, at 500–3000 lux from its windows, is metered up and reads bright and natural, its windows a little blown, as a photograph shows them |

The editor's view meters nothing: with the Lights on it is exposed at the night band's open end
(0.04 — where the tracer exposes a room lit by its one ceiling light), and lamps that do not bounce
are given a 10-lux fill for the light a room's walls and ceiling bounce about it.

The path tracer traces six diffuse bounces for a render with lights, so a lamp-lit room's corners are
not black, and twice the samples by day, when a room is lit by what comes in through its windows.
`floorspec_render` reports the exposure a lit render was metered to (`lit.exposure`, per cd/m²).

The headless rasterized render (`floorspec_render` without `lights` or `sky`) is a drawing, not a
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
  the horizon, lost in the haze between 200 m and 2.4 km. Slabs, patios and driveways sit on it;
  what FS_landscape lays on the ground (FLR-T-13.5) is drawn in place of the lawn (`GroundArea`).
- **Image-based light:** the editor lights the house with the sky's nine spherical harmonics (a
  light probe) and the raster render with the same; the tracers sample the dome itself. Views that do
  not bounce light add a fill of a twelfth of the sun's light on a level surface (`skyBounce`).
- **Exposure:** an outside view is exposed for the sky's light — the key 0.18 on a surface of
  reflectance 0.2 under the sun and sky — within the day band by day, and after dark up to 0.3 per
  cd/m², the long exposure of a night photograph; a render with its lamps on keeps the night band
  above, and a room is metered. The editor's view uses the renderers' filmic curve under a sky.
