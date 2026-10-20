# Daylight

Daylight you can see (FLR-T-14.7): how much light reaches each floor at a date and time, how many
hours of direct sun each spot of floor gets that day and over a year, and which desks and beds direct
sun reaches — in the 3D view, on the plan, in the room inspector, over the API and over MCP.
**Advisory, always** (FLR-ADR-011): it describes the light; it never passes or fails a room, and
nothing it prints says a room meets anything.

## What is shown

**Illuminance on the work plane** — a horizontal plane 2′-6″ (762 mm) above each room's floor, a
desk's height — in four named bands, never a rainbow ramp:

| Band | Lux | What it means |
|---|---|---|
| Bright — glare likely | over 3,000 | direct sun, or close to a big window: too bright to work in comfortably |
| Useful daylight | 300–3,000 | enough to read and work by without a lamp |
| Needs a lamp for tasks | 100–300 | fine to move about in; a lamp for reading or work |
| Dim | under 100 | a lamp is needed |

These are the useful-daylight-illuminance ranges (Nabil and Mardaljevic, 2005), named for what an
owner does about them. Exactly 3,000 lx is useful, 300 useful, 100 needs a lamp.

**Sun-hours** — hours of direct sun on the work plane: that day (every ten minutes) and over a
year (every hour on the 21st of each month, each standing for its month's days). A room's sun-hours
are the hours with direct sun somewhere on its work plane. The year is shown in four bands too —
sun most days (over 1,000 h), some sun (250–1,000 h), a little sun (1–250 h), no direct sun — in the
same four colours.

**Glare** — a flag on each FS_furniture `desk` and `bed` that direct sun reaches that day, with the
hours: a desk's whole top, 5 cm in from its edges; a bed's pillow end, the first 60 cm from its head
(at most 30% of its length) at the mattress's height (55 cm or the box's top if lower). Sun on any of
nine points over the zone counts. "Low sun" when the sun is under 20° for most of those hours — in
the eyes as well as on the desk. No flags under an overcast sky.

Colour is never the only cue: the bright band is hatched and the dim band dotted, in the overlay and
in every legend swatch, and every band has its name and range beside it. The legend is on screen
whenever the overlay is.

## How it is computed

A job on the Postgres queue (`analysis.daylight`, FLR-ADR-055), path-traced by the worker
(`apps/worker/src/pathtrace/daylight.ts`) on the scene its stills draw, and kept per version, time,
sky and design for as long as job outputs are kept (seven days): `GET /api/projects/:id/daylight?at=…`.

- **The scene** is the architecture alone: walls with their openings cut, floors, ceilings, slabs,
  roofs, stairs, doors and glazing. No furniture, fixtures or planting — they would put grid points
  inside cabinets and cast their own shadows on the grid; the study is of the house's light.
- **The grid** is every room's floor at one-foot pitch, the point on the work plane facing up. Rooms
  whose function is `exterior` are left out.
- **Direct sun** at a point: one shadow ray toward the sun's centre, through glass by the pane's
  Fresnel transmission at its angle (the thin-pane rule every view draws glass with), blocked by
  anything opaque. The sun's illuminance is @floorspec/mesh's (`sunlight`: about 115 klx above the
  air, through the Kasten–Young air mass), times the sine of its altitude. The sun's place is NOAA's.
- **Sky and bounced light** at a point: a path-traced irradiance gather — 64 cosine-weighted paths
  over the upper hemisphere, stratified 8 × 8, each followed through glass and up to four diffuse
  bounces (Russian roulette after the second), the sun sampled at every bounce, the sky's radiance
  where a path escapes: @floorspec/mesh's sky dome, the same cd/m² every view lights with, and the
  lawn below the horizon. E = π × the mean radiance. Each point's gather is averaged with its
  neighbours in the same room (3 × 3) before the direct sun is added.
- **Deterministic**: every point's paths draw from their own seeded stream, so a version, a time and
  a sky always give the same study.

The Courtyard House (two levels, about 4,300 grid points) takes two to three seconds on an M-series
Mac.

## How accurate it is

It is a simulation of the model under a standard sky, good for comparing options and seasons — not
a measurement and not a daylight-code calculation.

- **The sky is a standard sky**, not the site's weather: a calibrated clear-sky HDRI or an overcast
  one, scaled to clear-sky illuminance for the sun's altitude. Real skies vary by a factor of two or
  more from day to day; the bands are wide on purpose.
- **Nothing outside the house shades it**: trees, neighbours and the terrain are not in the scene
  (FS_landscape planting is left out with the furniture). Real windows facing a neighbour get less.
- **Surfaces reflect as their colour's luminance**, perfectly diffusely, within 3–90%. Glossy floors
  and mirrors do not throw sun patches; deep reveals and blinds are not modelled.
- **Glass is clear float glass** unless the model's material says otherwise; low-e coatings, tints
  and frit beyond the material's colour are not in it. Glass reflection back into the room is
  dropped from the bounced light — a few percent low near windows.
- **Noise**: 64 paths a point, smoothed, leave about ±10% on the bounced light from point to point;
  the direct sun is exact for the sun's centre (a sun patch's edge is sharp, where a real one is
  blurred by the sun's half-degree disc). Near a band's edge, a point can fall either side.
- **Rooms, not furniture**: the light on a desk under a shelf, or in a cupboard, is the room's.
- **Sun-hours are geometry**: the hours the sun could reach, under a clear sky every day, sampled
  every ten minutes on the day and every hour on twelve days of the year — a few percent coarse.

Compared by hand (apps/worker/test/daylight.test.ts): the sun patch through a window falls where the
window's geometry puts it, at the sun's illuminance × sin(altitude) × the pane's transmission; a
point under open uniform sky sees πL exactly; and the sky through an open or glazed window matches a
fine numerical integral of its view factor to within 3–8% (the black room's 3% reflectance adds a
little).

## In the editor

- **3D**: Daylight (⌥D) on the Experiences cluster opens its panel under it — illuminance or a year
  of sun-hours, the date (Mar 20, Jun 21, Sep 22, Dec 21) and the time of day, a clear or overcast
  sky, the legend, glare flags on or off, the advisory, and a comparison with the other solstice. The
  date and time are the Sky and sun panel's clock, so the sun drawn and the light studied are the
  same sun; the clock is read in this browser's offset on that date, or the one picked there. The
  study is laid a centimetre over the floors of the level the view is cut at (every level in the
  whole house and on a walk); glare flags are pinned to their desks and beds.
- **Plan**: while daylight is on, the level's study lies over its floors, with a chip saying what
  is shown, the legend, the glare flags, and — when comparing — June against December for every room
  with a desk or a bed (and the selected room).
- **Inspector**: a room's daylight — its bands as a bar, the share of useful daylight, its median,
  sun-hours that day and a year, and glare at its desk or bed.

## Over the API and MCP

`GET /api/projects/:id/daylight?at=2026-12-21T15:00-05:00&sky=clear` answers with the study: each
level's grid (lux, sun-hours that day and a year, −1 outside the rooms), each room's median, mean,
band shares and sun-hours, the glare flags with their hours, the sun and the outside light. An `at`
without an offset is read in the site's zone by its longitude, as every `at` is.

MCP reads it as the resource `floorspec://{project}/daylight?at=…` (clear sky) — in words, room by
room — so the tool list stays as it is. The design-partner prompt says when to read it.
