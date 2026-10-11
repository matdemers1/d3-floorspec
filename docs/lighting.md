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
its light down and keeps it off the ceiling); the rest shine every way. Each view turns lumens into
candela — over the sphere, or over the cone of a spot out to the middle of its edge — and lights a
surface to I cos θ / d² lux, d in metres, with no other scale: three.js's physically based lights
(`decay` 2, intensity in candela) and the path tracer's lamps (`LUX_PER_UNIT`, 12 500 lux to its unit).
A shadowed lamp in the editor is not cut off; one without a shadow is cut off past its own room.

Colour: 2700 K inside, 3000 K outside, seen by a camera white-balanced to 3000 K — as a photograph of a
lamp-lit room is taken — so lamps read warm white, not orange.

## A fixture never shadows itself

A luminaire's lamp sits just outside its model (under the lens, under a downlight's trim, in front of
a sconce), and on top of that no piece of a luminaire's own model — canopy, trim, shade, lens — ever
blocks its lamp: the path tracer's shadow rays toward a lamp pass every triangle of that lamp's
fixture (`PtScene.owner`), and the editor leaves every luminaire piece out of the shadow maps.

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

The headless rasterized render (`floorspec_render` without `lights`) is a drawing, not a lighting
simulation: it is lit by a fixed studio rig and is not part of this calibration.
