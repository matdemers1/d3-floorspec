/**
 * What a solar array will make in a typical year (FLR-T-16.1; FS_energy chapter 5, informative). One
 * method, simple on purpose, every number traceable to an input or an assumption the result lists:
 *
 * 1. **The sun** at the site's latitude (Core 1.8; 40° N when the site has none, and the estimate says
 *    so) on each month's representative day (Klein's average days), from the declination and the hour
 *    angle in solar time (solar.ts), every quarter hour from sunrise to sunset.
 * 2. **A typical year's light**: the day's extraterrestrial irradiation on a horizontal surface times a
 *    clearness index for the climate (humid 0.54, dry 0.64, marine 0.47 — about NREL's typical-year
 *    ratio of global to extraterrestrial irradiation in Baltimore, Denver and Seattle — chosen by the climate-zone preset's
 *    letter — climate.ts), split into beam and diffuse by the Erbs monthly-average correlation and spread
 *    through the day by the Collares-Pereira–Rabl (global) and Liu–Jordan (diffuse) hourly ratios —
 *    Duffie & Beckman, *Solar Engineering of Thermal Processes*, 4th ed., §1.10, §2.11–2.13, §2.20.
 * 3. **On the module**: the beam on its plane, the isotropic sky (1 + cos β) / 2 and the ground's
 *    reflection, ρ = 0.2, (1 − cos β) / 2 (Liu–Jordan).
 * 4. **Shade**: from points on the array — each module's centre, at most 24 — a ray toward the sun is
 *    tested against the house's roofs and the walls under their eaves, the other modules, neighbours'
 *    massing (FS_context) and the crowns of trees (FS_landscape's and FS_context's: a crown lets 25% of
 *    the beam through in leaf, 60% when a deciduous tree is bare, November to March, 20% when evergreen).
 *    Only the beam is shaded; the sky and the ground are not. The terrain is not a horizon.
 * 5. **The system**: the modules' watts at standard test conditions (1 kW/m²) times a performance ratio
 *    of 0.77 — temperature, wiring, soiling, mismatch, availability and the inverter, about the losses
 *    PVWatts assumes by default.
 * 6. **A range**: ±20% around each yearly and monthly figure, rounded to two significant figures — a
 *    method this simple is not more precise than that.
 *
 * Isomorphic (FLR-ADR-010) and deterministic: no clock, no random, no network. Advisory, always: an
 * estimate to compare layouts, never a guarantee and never a code's verdict (FLR-ADR-011).
 */
import { contextDrawing, deriveRoofs, solarDrawing, type DrawArray, type DrawModule, type DrawRoofFace, type FloorspecDocument, type SolarDrawing } from '@floorspec/engine';
import { ASSUMED_LATITUDE, ASSUMED_ZONE } from './climate.js';
import { sig2 } from './format.js';
import { inputsOf } from './inputs.js';
import { declination, GROUND_REFLECTANCE, sunAt } from './solar.js';

const RAD = Math.PI / 180;
const M = 1_280_000;

export const PV_METHOD = 'floorspec-analysis/pv-0.1';
/** What every presentation of a production estimate says. */
export const PV_ADVISORY = 'An estimate to compare layouts — not a production guarantee.';
export const PV_METHOD_TEXT =
  'From the site’s latitude, each face’s azimuth and tilt, a typical year’s sun for the climate, and the shade of the house, its trees and its context (packages/analysis). A range to compare layouts — not a production guarantee.';
/** The share of the modules' rated output a system delivers over a year, after its losses. */
export const PERFORMANCE_RATIO = 0.77;
/** ± this share around each figure. */
export const PV_SPREAD = 0.2;
/** The clearness index of a typical year, by the climate preset's moisture letter. */
export const CLEARNESS: Readonly<Record<'A' | 'B' | 'C', number>> = { A: 0.54, B: 0.64, C: 0.47 };
/** How much of the beam a crown lets through. */
export const CROWN_TRANSMITTANCE = { leaf: 0.25, bare: 0.6, evergreen: 0.2 } as const;
/** Klein's average day of each month (Duffie & Beckman table 1.6.1) and the days in it. */
export const MONTH_DAYS: readonly number[] = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];
export const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'] as const;
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
/** The step through the day, hours. */
const STEP = 0.25;
/** At most this many points of an array are shaded. */
export const MAX_SAMPLES = 24;

type V3 = [number, number, number];

// ── the sky ────────────────────────────────────────────────────────────────────

/** The site the sun is worked out for. */
export interface SolarSite {
  readonly latitude: number;
  readonly latitudeSource: 'site' | 'assumed';
  /** Degrees counter-clockwise from project north to true north (Core 1.8). */
  readonly trueNorth: number;
  readonly zone: string;
  readonly zoneSource: 'yours' | 'assumed';
  readonly clearness: number;
}

export function solarSite(doc: FloorspecDocument): SolarSite {
  const loc = doc.site?.location;
  const { inputs } = inputsOf(doc);
  const zone = inputs.zone ?? ASSUMED_ZONE;
  const letter = /[ABC]$/.exec(zone)?.[0] as 'A' | 'B' | 'C' | undefined;
  return {
    latitude: loc === undefined ? ASSUMED_LATITUDE : loc.latitude / 1e6,
    latitudeSource: loc === undefined ? 'assumed' : 'site',
    trueNorth: (doc.site?.trueNorth ?? 0) / 1e6,
    zone,
    zoneSource: inputs.zone === undefined ? 'assumed' : 'yours',
    clearness: CLEARNESS[letter ?? 'A'],
  };
}

/** A month's sky: its representative day and every quarter hour's sun and irradiance (kWh/m² an hour). */
export interface MonthSky {
  readonly month: number;
  readonly days: number;
  /** Daily horizontal irradiation, global and diffuse, kWh/m². */
  readonly H: number;
  readonly Hd: number;
  readonly steps: readonly { readonly sun: V3; readonly altitude: number; readonly global: number; readonly diffuse: number; readonly beam: number }[];
}

/** The sun as a unit vector in the plan's coordinates (x east of project, y project north, z up). */
function sunVector(altitude: number, azimuth: number, trueNorth: number): V3 {
  // azimuth: clockwise from true north; the plan's bearing convention is atan2(x, y) + trueNorth.
  const b = (azimuth - trueNorth) * RAD;
  const c = Math.cos(altitude * RAD);
  return [c * Math.sin(b), c * Math.cos(b), Math.sin(altitude * RAD)];
}

/** Duffie & Beckman's monthly-average day for a latitude and a clearness index. */
export function monthSky(latitude: number, month: number, clearness: number, trueNorth = 0): MonthSky {
  const n = MONTH_DAYS[month]!;
  const phi = latitude * RAD;
  const delta = declination(n) * RAD;
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  const Gsc = 1.367; // kW/m²
  const H0 = ((24 / Math.PI) * Gsc * (1 + 0.033 * Math.cos((2 * Math.PI * n) / 365)) * (Math.cos(phi) * Math.cos(delta) * Math.sin(ws) + ws * Math.sin(phi) * Math.sin(delta)));
  const K = clearness;
  const H = Math.max(0, K * H0);
  const wsDeg = ws / RAD;
  const fd = wsDeg <= 81.4 ? 1.391 - 3.56 * K + 4.189 * K * K - 2.137 * K ** 3 : 1.311 - 3.022 * K + 3.427 * K * K - 1.821 * K ** 3;
  const Hd = H * Math.max(0, Math.min(1, fd));
  const a = 0.409 + 0.5016 * Math.sin(ws - Math.PI / 3);
  const b = 0.6609 - 0.4767 * Math.sin(ws - Math.PI / 3);
  const denom = Math.sin(ws) - ws * Math.cos(ws);
  const steps: MonthSky['steps'][number][] = [];
  if (denom > 1e-9) {
    const halfDay = wsDeg / 15;
    const count = Math.ceil((2 * halfDay) / STEP);
    const dt = (2 * halfDay) / count;
    for (let i = 0; i < count; i++) {
      const hour = 12 - halfDay + (i + 0.5) * dt;
      const w = (hour - 12) * 15 * RAD;
      const rd = (Math.PI / 24) * ((Math.cos(w) - Math.cos(ws)) / denom);
      const rt = rd * (a + b * Math.cos(w));
      const global = Math.max(0, rt * H) * dt;
      const diffuse = Math.min(global, Math.max(0, rd * Hd) * dt);
      const s = sunAt(latitude, n, hour);
      steps.push({ sun: sunVector(s.altitude, s.azimuth, trueNorth), altitude: s.altitude, global, diffuse, beam: global - diffuse });
    }
  }
  return { month, days: DAYS_IN_MONTH[month]!, H, Hd, steps };
}

/** The twelve months' skies of a site. */
export const yearSky = (site: SolarSite): MonthSky[] => Array.from({ length: 12 }, (_, m) => monthSky(site.latitude, m, site.clearness, site.trueNorth));

// ── shade ──────────────────────────────────────────────────────────────────────

/** What can shade a module: triangles (opaque) and tree crowns (ellipsoids that let some light through). Metres. */
export interface Occluders {
  readonly triangles: Float64Array;
  /** Which source each triangle came from: an array's module (`module:<array>:<row>:<column>`), else '' . */
  readonly owners: readonly string[];
  readonly crowns: readonly { readonly c: V3; readonly r: V3; readonly kind: 'deciduous' | 'evergreen'; readonly id: string }[];
}

const m = (v: number): number => v / M;

function pushPoly(tri: number[], owners: string[], poly: readonly (readonly number[])[], owner = ''): void {
  for (let i = 1; i + 1 < poly.length; i++) {
    for (const p of [poly[0]!, poly[i]!, poly[i + 1]!]) tri.push(m(p[0]!), m(p[1]!), m(p[2]!));
    owners.push(owner);
  }
}

function pushWall(tri: number[], owners: string[], a: readonly number[], b: readonly number[], z0: number, z1: number): void {
  if (z1 <= z0) return;
  pushPoly(tri, owners, [
    [a[0]!, a[1]!, z0],
    [b[0]!, b[1]!, z0],
    [b[0]!, b[1]!, z1],
    [a[0]!, a[1]!, z1],
  ]);
}

/** Everything that can shade an array in a document: its roofs and the walls under them, its arrays' modules, its neighbours and its trees. */
export function occludersOf(doc: FloorspecDocument, drawing: SolarDrawing = solarDrawing(doc)): Occluders {
  const tri: number[] = [];
  const owners: string[] = [];
  const roofs = deriveRoofs(doc, doc.floorspec === '0.4');
  const ground = Math.min(0, ...Object.values(doc.levels ?? {}).map((l) => l?.elevation ?? 0));
  for (const [, r] of Object.entries(roofs)) {
    if (r.surface === null) continue;
    for (const f of r.surface.faces) pushPoly(tri, owners, f.polygon);
    for (const g of r.surface.gables) pushPoly(tri, owners, g.polygon);
    const o = r.outline;
    for (let i = 0; i < o.length; i++) pushWall(tri, owners, o[i]!, o[(i + 1) % o.length]!, ground, r.eave);
  }
  for (const a of drawing.arrays) for (const mod of a.modules) pushPoly(tri, owners, mod.corners, `module:${a.id}:${String(mod.row)}:${String(mod.column)}`);
  const ctx = contextDrawing(doc);
  for (const n of ctx.neighbours) {
    for (let i = 0; i < n.footprint.length; i++) pushWall(tri, owners, n.footprint[i]!, n.footprint[(i + 1) % n.footprint.length]!, n.elevation, n.eaves);
    for (const p of n.roofPlanes) pushPoly(tri, owners, p);
    for (const g of n.gables) pushPoly(tri, owners, g);
    if (n.roofPlanes.length === 0) pushPoly(tri, owners, n.footprint.map((p) => [p[0], p[1], n.ridge]));
  }
  const crowns: Occluders['crowns'][number][] = [];
  for (const t of ctx.trees) {
    const r = m(t.spread) / 2;
    const top = m(t.elevation + t.height);
    crowns.push({ c: [m(t.at[0]), m(t.at[1]), top - r], r: [r, r, r], kind: t.form, id: t.id });
  }
  const land = (doc.extensions as Record<string, { collections?: { plants?: Record<string, unknown> } } | undefined> | undefined)?.['FS_landscape'];
  for (const [id, p] of Object.entries(land?.collections?.plants ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const el = p as { form?: string; foliage?: string; clearHeight?: number; host?: { level?: string; position?: [number, number] }; fallback?: { box?: { min: number[]; max: number[] }; level?: string } };
    if (el.form !== 'tree' || el.host?.position === undefined || el.fallback?.box === undefined) continue;
    const box = el.fallback.box;
    const z0 = doc.levels?.[el.host.level ?? el.fallback.level ?? '']?.elevation ?? 0;
    const rx = m(Math.max(box.max[0]! - box.min[0]!, box.max[1]! - box.min[1]!)) / 2;
    const bottom = m(z0 + Math.max(box.min[2]!, el.clearHeight ?? 0));
    const top = m(z0 + box.max[2]!);
    const rz = Math.max(0.5, (top - bottom) / 2);
    crowns.push({ c: [m(el.host.position[0]), m(el.host.position[1]), bottom + rz], r: [rx, rx, rz], kind: el.foliage === 'evergreen' ? 'evergreen' : 'deciduous', id });
  }
  return { triangles: Float64Array.from(tri), owners, crowns };
}

/** Does the ray o + t·d (t > ε) meet triangle i? Möller–Trumbore. */
function hitsTriangle(T: Float64Array, i: number, o: V3, d: V3): boolean {
  const k = i * 9;
  const ax = T[k]!, ay = T[k + 1]!, az = T[k + 2]!;
  const e1x = T[k + 3]! - ax, e1y = T[k + 4]! - ay, e1z = T[k + 5]! - az;
  const e2x = T[k + 6]! - ax, e2y = T[k + 7]! - ay, e2z = T[k + 8]! - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1e-3;
}

function hitsCrown(c: Occluders['crowns'][number], o: V3, d: V3): boolean {
  const ox = (o[0] - c.c[0]) / c.r[0], oy = (o[1] - c.c[1]) / c.r[1], oz = (o[2] - c.c[2]) / c.r[2];
  const dx = d[0] / c.r[0], dy = d[1] / c.r[1], dz = d[2] / c.r[2];
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (ox * dx + oy * dy + oz * dz);
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return false;
  const t = (-B + Math.sqrt(disc)) / (2 * A);
  return t > 0;
}

/** Leaf-on from April to October, in the northern hemisphere; the other way round in the southern. */
const inLeaf = (month: number, latitude: number): boolean => (latitude >= 0 ? month >= 3 && month <= 9 : month <= 3 || month >= 9);

/** The share of the beam that reaches a point along d (toward the sun): 0 behind something opaque, a crown's transmittance through each crown. */
export function beamReaching(occ: Occluders, o: V3, d: V3, month: number, latitude: number, skip: (owner: string) => boolean = () => false): number {
  const n = occ.owners.length;
  for (let i = 0; i < n; i++) if (!skip(occ.owners[i]!) && hitsTriangle(occ.triangles, i, o, d)) return 0;
  let through = 1;
  for (const c of occ.crowns) if (hitsCrown(c, o, d)) through *= c.kind === 'evergreen' ? CROWN_TRANSMITTANCE.evergreen : inLeaf(month, latitude) ? CROWN_TRANSMITTANCE.leaf : CROWN_TRANSMITTANCE.bare;
  return through;
}

// ── a plane in the sky ───────────────────────────────────────────────────────

/** A surface's unit normal from its tilt (degrees) and the bearing it faces (degrees clockwise from true north). */
export function normalOf(tilt: number, bearing: number, trueNorth = 0): V3 {
  const b = (bearing - trueNorth) * RAD;
  const s = Math.sin(tilt * RAD);
  return [s * Math.sin(b), s * Math.cos(b), Math.cos(tilt * RAD)];
}

/** A year on a plane: kWh/m² a month, unshaded and shaded, at points of it. */
export interface PlaneYear {
  /** kWh/m² each month, as shaded. */
  readonly monthly: number[];
  /** kWh/m² each month with nothing in the way. */
  readonly open: number[];
}

/**
 * Plane-of-array irradiation a month, kWh/m², for points with one normal: the beam at each point times
 * the share reaching it, averaged over the points, plus the isotropic sky and the ground.
 */
export function planeYear(sky: readonly MonthSky[], normal: V3, points: readonly { p: V3; skip?: (owner: string) => boolean }[], occ: Occluders | null, latitude: number): PlaneYear {
  const cb = normal[2];
  const skyF = (1 + cb) / 2;
  const groundF = (1 - cb) / 2;
  const monthly: number[] = [];
  const open: number[] = [];
  for (const ms of sky) {
    let day = 0;
    let dayOpen = 0;
    for (const s of ms.steps) {
      const diffuse = s.diffuse * skyF + s.global * GROUND_REFLECTANCE * groundF;
      day += diffuse;
      dayOpen += diffuse;
      if (s.altitude <= 1 || s.beam <= 0) continue;
      const cosT = normal[0] * s.sun[0] + normal[1] * s.sun[1] + normal[2] * s.sun[2];
      if (cosT <= 0) continue;
      const beam = (s.beam / Math.sin(s.altitude * RAD)) * cosT;
      dayOpen += beam;
      if (occ === null || points.length === 0) {
        day += beam;
        continue;
      }
      let reach = 0;
      for (const pt of points) {
        const o: V3 = [pt.p[0] + normal[0] * 0.05, pt.p[1] + normal[1] * 0.05, pt.p[2] + normal[2] * 0.05];
        reach += beamReaching(occ, o, s.sun, ms.month, latitude, pt.skip);
      }
      day += beam * (reach / points.length);
    }
    monthly.push(day * ms.days);
    open.push(dayOpen * ms.days);
  }
  return { monthly, open };
}

// ── arrays ─────────────────────────────────────────────────────────────────────

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** A figure ±20%, each end to two significant figures. */
export function pvRange(value: number): { low: number; high: number } {
  return { low: sig2(value * (1 - PV_SPREAD)), high: sig2(value * (1 + PV_SPREAD)) };
}

/** A yearly estimate of one array. */
export interface ArrayEstimate {
  readonly id: string;
  readonly name?: string;
  readonly roof: string;
  readonly face?: number;
  readonly modules: number;
  readonly kw: number;
  readonly tilt: number;
  /** Degrees clockwise from true north; null for flush on a flat roof. */
  readonly bearing: number | null;
  /** kWh each month, and in the year. */
  readonly monthly: number[];
  readonly annual: number;
  readonly low: number;
  readonly high: number;
  /** kWh a year for each kW of modules. */
  readonly perKw: number;
  /** The share of the year's beam-and-sky irradiation lost to shade. */
  readonly shade: number;
  /** The month the shade takes most and least, with its share. */
  readonly worst: { month: number; share: number };
  readonly best: { month: number; share: number };
  /** What shades it most: crowns and neighbours by ID, or "the house". */
  readonly shadedBy: string[];
}

export interface SolarEstimate {
  readonly method: string;
  readonly advisory: string;
  readonly methodText: string;
  readonly site: SolarSite;
  readonly arrays: ArrayEstimate[];
  readonly total: { kw: number; modules: number; monthly: number[]; annual: number; low: number; high: number };
  readonly assumptions: string[];
}

function samplesOf(mods: readonly DrawModule[], arrayId: string): { p: V3; skip: (owner: string) => boolean }[] {
  const take = Math.max(1, Math.ceil(mods.length / MAX_SAMPLES));
  const out: { p: V3; skip: (owner: string) => boolean }[] = [];
  for (let i = 0; i < mods.length; i += take) {
    const mod = mods[i]!;
    const own = `module:${arrayId}:${String(mod.row)}:${String(mod.column)}`;
    out.push({ p: [m(mod.centre[0]), m(mod.centre[1]), m(mod.centre[2])], skip: (o) => o === own });
  }
  return out;
}

/** What shades the array's points most over the year, by name: crowns by ID, neighbours, the house. */
function shadersOf(occ: Occluders, sky: readonly MonthSky[], normal: V3, pts: readonly { p: V3; skip: (o: string) => boolean }[], latitude: number): string[] {
  const score = new Map<string, number>();
  for (const ms of sky)
    for (const s of ms.steps) {
      if (s.altitude <= 1 || s.beam <= 0) continue;
      if (normal[0] * s.sun[0] + normal[1] * s.sun[1] + normal[2] * s.sun[2] <= 0) continue;
      for (const pt of pts) {
        const o: V3 = [pt.p[0] + normal[0] * 0.05, pt.p[1] + normal[1] * 0.05, pt.p[2] + normal[2] * 0.05];
        for (const c of occ.crowns) if (hitsCrown(c, o, s.sun)) score.set(c.id, (score.get(c.id) ?? 0) + s.beam * ms.days);
        const n = occ.owners.length;
        for (let i = 0; i < n; i++)
          if (!pt.skip(occ.owners[i]!) && hitsTriangle(occ.triangles, i, o, s.sun)) {
            const who = occ.owners[i]!.startsWith('module:') ? 'the other modules' : 'the house and its neighbours';
            score.set(who, (score.get(who) ?? 0) + s.beam * ms.days);
            break;
          }
      }
    }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([k]) => k);
}

/** One array's year. */
export function estimateArray(a: DrawArray, sky: readonly MonthSky[], occ: Occluders | null, site: SolarSite): ArrayEstimate {
  const mod = a.modules[0];
  const normal: V3 = mod ? mod.normal : [0, 0, 1];
  const pts = samplesOf(a.modules, a.id);
  const year = planeYear(sky, normal, pts, occ, site.latitude);
  const kw = a.watts / 1000;
  const monthly = year.monthly.map((x) => x * kw * PERFORMANCE_RATIO);
  const annual = sum(monthly);
  const losses = year.monthly.map((x, i) => (year.open[i]! > 0 ? 1 - x / year.open[i]! : 0));
  let worst = 0;
  let best = 0;
  losses.forEach((l, i) => {
    if (l > losses[worst]! + 1e-9) worst = i;
    if (l < losses[best]! - 1e-9) best = i;
  });
  const open = sum(year.open);
  return {
    id: a.id,
    ...(a.name === undefined ? {} : { name: a.name }),
    roof: a.roof,
    ...(a.face === undefined ? {} : { face: a.face }),
    modules: a.modules.length,
    kw,
    tilt: a.tilt,
    bearing: a.bearing,
    monthly,
    annual,
    ...pvRange(annual),
    perKw: kw > 0 ? annual / kw : 0,
    shade: open > 0 ? 1 - sum(year.monthly) / open : 0,
    worst: { month: worst, share: losses[worst]! },
    best: { month: best, share: losses[best]! },
    shadedBy: occ === null ? [] : shadersOf(occ, sky, normal, pts, site.latitude),
  };
}

/** The production estimate of every array of a document. Deterministic. */
export function estimateSolar(doc: FloorspecDocument, options: { shade?: boolean; drawing?: SolarDrawing } = {}): SolarEstimate {
  const site = solarSite(doc);
  const drawing = options.drawing ?? solarDrawing(doc);
  const sky = yearSky(site);
  const occ = options.shade === false ? null : occludersOf(doc, drawing);
  const arrays = drawing.arrays.map((a) => estimateArray(a, sky, occ, site));
  const monthly = Array.from({ length: 12 }, (_, i) => sum(arrays.map((a) => a.monthly[i]!)));
  const annual = sum(monthly);
  return {
    method: PV_METHOD,
    advisory: PV_ADVISORY,
    methodText: PV_METHOD_TEXT,
    site,
    arrays,
    total: { kw: sum(arrays.map((a) => a.kw)), modules: sum(arrays.map((a) => a.modules)), monthly, annual, ...pvRange(annual) },
    assumptions: assumptionsOf(site),
  };
}

export function assumptionsOf(site: SolarSite): string[] {
  return [
    site.latitudeSource === 'site' ? `Latitude ${site.latitude.toFixed(1)}° from the site’s location.` : `Latitude ${String(ASSUMED_LATITUDE)}° N assumed — the site has no location.`,
    `Clearness index ${site.clearness.toFixed(2)} for climate zone ${site.zone}${site.zoneSource === 'assumed' ? ' (assumed)' : ''}: a typical year, not this year’s weather.`,
    `Performance ratio ${PERFORMANCE_RATIO.toFixed(2)}: temperature, wiring, soiling, mismatch and the inverter.`,
    'Shade on the beam from the roofs, the walls under them, the other modules, neighbours and tree crowns; the sky and the ground are not shaded, and the terrain is not a horizon.',
    `Every figure ±${String(PV_SPREAD * 100)}%, to two significant figures.`,
  ];
}

// ── faces, for the assistant ─────────────────────────────────────────────────

/** A face's year for one kW of modules lying on it (or racked on a flat roof at `rack`): kWh/kW, its months, and its shade. */
export function faceYield(face: DrawRoofFace, sky: readonly MonthSky[], occ: Occluders | null, site: SolarSite, points: readonly V3[], rack?: { tilt: number; bearing: number }): { perKw: number; monthly: number[]; shade: number } {
  const normal: V3 = face.downslope === null ? (rack ? normalOf(rack.tilt, rack.bearing, site.trueNorth) : [0, 0, 1]) : normalOf(face.tilt, face.bearing ?? 0, site.trueNorth);
  const year = planeYear(sky, normal, points.map((p) => ({ p })), occ, site.latitude);
  const monthly = year.monthly.map((x) => x * PERFORMANCE_RATIO);
  const open = sum(year.open);
  return { perKw: sum(monthly), monthly, shade: open > 0 ? 1 - sum(year.monthly) / open : 0 };
}
