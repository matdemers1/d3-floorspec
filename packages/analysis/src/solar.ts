/**
 * Sun on a vertical wall, on a clear day — the ASHRAE clear-sky model (Handbook — Fundamentals 2013,
 * chapter 14): the sun's position from the latitude, the declination and the hour angle in apparent
 * solar time; beam and diffuse irradiance from the air mass and two clear-sky optical depths; and
 * the irradiance on a vertical surface as beam × cos θ, diffuse × Y (the chapter's vertical-surface
 * ratio) and ground reflection from grass-like ground (ρ = 0.2).
 *
 * The optical depths are one typical mid-latitude US site's (the chapter's Atlanta values), July
 * and January — not the site's own, so these are a clear day somewhere like it, which is all an
 * advisory estimate needs. No clock and no time zone: hours are solar time, days are the 21st.
 */

const RAD = Math.PI / 180;

/** The day of the year of the 21st of July and of January. */
export const JULY_21 = 202;
export const JANUARY_21 = 21;

/** ASHRAE clear-sky optical depths (beam, diffuse) of a typical mid-latitude US site. */
export const TAU: Readonly<Record<'july' | 'january', { beam: number; diffuse: number }>> = {
  july: { beam: 0.556, diffuse: 1.779 },
  january: { beam: 0.334, diffuse: 2.614 },
};

/** The ground's reflectance: grass and soil. */
export const GROUND_REFLECTANCE = 0.2;

export interface SunAt {
  /** Altitude above the horizon, degrees (negative: below). */
  readonly altitude: number;
  /** Azimuth, degrees clockwise from true north. */
  readonly azimuth: number;
}

/** Declination, degrees (Cooper). */
export const declination = (day: number): number => 23.45 * Math.sin((360 * (284 + day) / 365) * RAD);

/** Where the sun is at a solar hour (12 = solar noon) on a day of the year at a latitude. */
export function sunAt(latitude: number, day: number, hour: number): SunAt {
  const L = latitude * RAD;
  const d = declination(day) * RAD;
  const H = 15 * (hour - 12) * RAD;
  const sinB = Math.cos(L) * Math.cos(d) * Math.cos(H) + Math.sin(L) * Math.sin(d);
  const beta = Math.asin(Math.max(-1, Math.min(1, sinB)));
  // Azimuth from north, clockwise: atan2(sin H, cos H sin L − tan δ cos L) + 180°.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(L) - Math.tan(d) * Math.cos(L)) / RAD + 180;
  return { altitude: beta / RAD, azimuth: ((az % 360) + 360) % 360 };
}

/** Beam (normal) and diffuse (horizontal) clear-sky irradiance, W/m², for a solar altitude. */
export function clearSky(altitude: number, day: number, tau: { beam: number; diffuse: number }): { beam: number; diffuse: number } {
  if (altitude <= 0) return { beam: 0, diffuse: 0 };
  const e0 = 1367 * (1 + 0.033 * Math.cos((360 * (day - 3) / 365) * RAD));
  const m = 1 / (Math.sin(altitude * RAD) + 0.50572 * (6.07995 + altitude) ** -1.6364);
  const ab = 1.454 - 0.406 * tau.beam - 0.268 * tau.diffuse + 0.021 * tau.beam * tau.diffuse;
  const ad = 0.507 + 0.205 * tau.beam - 0.08 * tau.diffuse - 0.19 * tau.beam * tau.diffuse;
  return { beam: e0 * Math.exp(-tau.beam * m ** ab), diffuse: e0 * Math.exp(-tau.diffuse * m ** ad) };
}

/**
 * Total irradiance on a vertical surface whose outward normal faces `facing` (degrees clockwise
 * from true north), W/m²: beam, sky diffuse and ground-reflected.
 */
export function onVertical(sun: SunAt, sky: { beam: number; diffuse: number }, facing: number): number {
  if (sun.altitude <= 0) return 0;
  const cosTheta = Math.cos(sun.altitude * RAD) * Math.cos((sun.azimuth - facing) * RAD);
  const beam = sky.beam * Math.max(0, cosTheta);
  const y = Math.max(0.45, 0.55 + 0.437 * cosTheta + 0.313 * cosTheta * cosTheta);
  const diffuse = sky.diffuse * y;
  const ground = (sky.beam * Math.sin(sun.altitude * RAD) + sky.diffuse) * GROUND_REFLECTANCE * 0.5;
  return beam + diffuse + ground;
}

/** Irradiance on a vertical surface at a solar hour, W/m². */
export function verticalAt(latitude: number, day: number, hour: number, facing: number, tau: { beam: number; diffuse: number }): number {
  const sun = sunAt(latitude, day, hour);
  return onVertical(sun, clearSky(sun.altitude, day, tau), facing);
}

/** A whole clear day on a vertical surface, kWh/m², summed every quarter hour of solar time. */
export function dailyVertical(latitude: number, day: number, facing: number, tau: { beam: number; diffuse: number }): number {
  let wh = 0;
  for (let q = 0; q < 96; q++) wh += verticalAt(latitude, day, (q + 0.5) / 4, facing, tau) * 0.25;
  return wh / 1000;
}
