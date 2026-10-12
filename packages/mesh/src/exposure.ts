/**
 * How every view exposes a picture (FLR-T-13.1): what its tone curve is given for each cd/m² of
 * luminance, the luminance a surface of reflectance ρ under E lux shows being ρE/π. One calibration
 * for the path tracer, the headless render and the editor's 3D view.
 *
 * - `night` 0.01: a room lit to 150–300 lux reads as a normally lit room — a white wall (ρ 0.8) at
 *   200 lux, 51 cd/m², is given 0.5, a light tone short of the curve's shoulder; a kitchen's 500
 *   lux on its counters is bright, not blown. The least a picture by lamplight is exposed to.
 * - `nightMax` 0.04: how far a dimmer picture by lamplight may be opened up — two stops, as an eye
 *   adapts to a room. A bedroom at 40–75 lux under its one ceiling light reads normally lit too, a
 *   room with no lamp on stays dark, and so does the night outside.
 * - `day` 1.6e-5: full sun outside — a white wall in it, about 20 000 cd/m², is given 0.3.
 * - `dayMax` 2e-3: a daylit interior, at 500–3000 lux from its windows, metered as a camera would:
 *   bright and natural, its windows blown a little, as a photograph of a room shows them.
 *
 * Between each pair, a picture is metered: its log-average luminance at the photographic key 0.18.
 */
export const EXPOSURE_PER_NIT = { night: 0.01, nightMax: 0.04, day: 1.6e-5, dayMax: 2e-3 } as const;
