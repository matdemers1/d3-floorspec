/**
 * The solar assistant (FLR-T-16.1): it ranks every roof face of a plan by what a kilowatt of modules
 * would make on it in a typical year after shade (@floorspec/analysis), lays the largest grid of
 * modules that keeps every corner clear of the face's setbacks (FS_energy 4.3) on each face worth it —
 * flush on a sloped face, racked toward the equator on a flat roof — stops at a sizing target, and adds
 * an inverter and a rapid-shutdown initiator beside the panel on a circuit of their own. Everything is
 * one Floorspec Ops batch, opened as a pending changeset: an agent's or a person's to accept, never main
 * (FLR-ADR-016).
 *
 * Deterministic: the same plan and options give the same batch, byte for byte — positions are snapped
 * to 1/8″ and every choice is ordered. Advisory: an estimate to compare layouts, never a guarantee, and
 * no code is checked or cited — its breaker margin and its setbacks are Floorspec's defaults.
 */
import {
  arrayExtents,
  arrayFootprint,
  arrayModules,
  compassOf,
  cornerClear,
  deriveRoofs,
  energyCollection,
  evaluate,
  facePolygons,
  facingVector,
  OFFICIAL_READER,
  roofFaces,
  setbacksOf,
  solarDrawing,
  usesEnergy,
  type DrawArray,
  type DrawRoofFace,
  type FloorspecDocument,
  type PvModule,
  type SolarArray,
} from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { grouped, estimateArray, estimateEnergy, occludersOf, solarSite, yearSky, PV_ADVISORY, PV_METHOD_TEXT, pvRange, type MonthSky, type Occluders, type SolarSite } from '@floorspec/analysis';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const IN = 32_512;
const FT = 12 * IN;
/** Positions are snapped to an eighth of an inch. */
const SNAP = IN / 8;
const RAD = Math.PI / 180;

/** A 410 W module, 1,134 × 1,722 mm — the common residential size. */
export const DEFAULT_MODULE: PvModule = { width: 1_451_520, length: 2_204_160, watts: 410 };
/** Racks on a flat roof: 3:12, about 14°. */
export const DEFAULT_RACK = { rise: 3, run: 12 } as const;
/** A face is used when a kW on it makes at least this share of what it makes on the best face. */
export const DEFAULT_CUTOFF = 0.75;
/** A margin kept inside every setback, so that the exact test of FS_energy 4.3 never fails by a rounding. */
const MARGIN = IN / 8;
/** A house's electricity besides heating and cooling — lights, appliances, hot water — a year, kWh; and the heat pump's seasonal COPs. */
export const BASE_USE = 4_000;
export const HEATING_COP = 3;
export const COOLING_COP = 3.5;
/** A breaker carries the inverter's output current with this margin, rounded up to a standard size — a default, not a code check. */
export const BREAKER_MARGIN = 1.25;
const BREAKERS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];

export type SolarTarget = { readonly kind: 'kwh'; readonly kwh: number } | { readonly kind: 'share'; readonly percent: number } | { readonly kind: 'fill' };

export interface SolarOptions {
  /**
   * Stop when the arrays make this much a year: kWh, or a share of the house's use from the energy
   * estimate; `fill` fills every face worth it. Default: 100% of the house's use, or `fill` when no
   * estimate can be made.
   */
  readonly target?: SolarTarget;
  /** The share of the best face's kWh/kW a face must make to be used (0–1). */
  readonly cutoff?: number;
  readonly module?: PvModule;
  readonly rack?: { rise: number; run: number };
  /** Add an inverter, an initiator and a circuit when the plan has none (default true). */
  readonly inverter?: boolean;
  /** IDs a changeset retired, never to be minted again. */
  readonly retired?: readonly string[];
}

/** One face, as the assistant ranked it. */
export interface FacePlan {
  readonly key: string;
  readonly roof: string;
  readonly roofName?: string;
  readonly face?: number;
  readonly tilt: number;
  readonly bearing: number | null;
  /** "faces S", "flat · racked S". */
  readonly facing: string;
  /** kWh a year for each kW on it, after shade; 0 when nothing fits. */
  readonly perKw: number;
  readonly shade: number;
  /** Its kWh/kW as a share of the best face's. */
  readonly share: number;
  readonly status: 'used' | 'skipped';
  readonly reason?: string;
  readonly array?: string;
  readonly modules: number;
  readonly rows: number;
  readonly columns: number;
  readonly layout: 'portrait' | 'landscape';
  readonly kw: number;
  readonly annual: number;
}

export interface ProposedArray {
  readonly id: string;
  readonly roof: string;
  readonly face?: number;
  readonly name: string;
  readonly modules: number;
  readonly rows: number;
  readonly columns: number;
  readonly layout: 'portrait' | 'landscape';
  readonly mount: 'flush' | 'racked';
  readonly kw: number;
  readonly monthly: number[];
  readonly annual: number;
  readonly low: number;
  readonly high: number;
  readonly perKw: number;
  readonly facing: string;
}

export interface SolarProposal {
  readonly name: string;
  readonly batch: Operation[];
  readonly explanation: string[];
  readonly faces: FacePlan[];
  readonly arrays: ProposedArray[];
  readonly inverter: { id: string; watts: number; kind: 'hybrid'; on: string } | null;
  readonly shutdown: string | null;
  readonly circuit: string | null;
  readonly total: { modules: number; kw: number; annual: number; low: number; high: number };
  /** The target it sized to, kWh a year, and where it came from. */
  readonly target: { kwh: number; source: string } | null;
  /** The house's electricity a year from the energy estimate, when one could be made. */
  readonly houseUse: number | null;
  readonly notes: string[];
  readonly advisory: string;
  readonly method: string;
}

export class SolarError extends Error {}

// ── geometry in an array's frame ─────────────────────────────────────────────

type P2 = [number, number];

interface Frame2 {
  readonly rotation: number;
  readonly u: P2;
  readonly v: P2;
}

function frameOf(rotation: number): Frame2 {
  const f = facingVector(rotation);
  const fx = Number(f[0]);
  const fy = Number(f[1]);
  const l = Math.sqrt(fx * fx + fy * fy);
  const u: P2 = [fx / l, fy / l];
  return { rotation, u, v: [-u[1], u[0]] };
}

const toLocal = (fr: Frame2, x: number, y: number): P2 => [x * fr.u[0] + y * fr.u[1], x * fr.v[0] + y * fr.v[1]];
const toPlan = (fr: Frame2, p: number, q: number): P2 => [p * fr.u[0] + q * fr.v[0], p * fr.u[1] + q * fr.v[1]];

/** The rotation (microdegrees) that faces the equator in plan, after the site's trueNorth. */
export function equatorRotation(site: SolarSite): number {
  const bearing = site.latitude >= 0 ? 180 : 0;
  const b = (bearing - site.trueNorth) * RAD;
  // The plan vector of a bearing: (sin b, cos b); its direction counter-clockwise from +X.
  const deg = Math.atan2(Math.cos(b), Math.sin(b)) / RAD;
  let r = Math.round(deg * 1_000) * 1_000;
  if (r <= -180_000_000) r += 360_000_000;
  if (r > 180_000_000) r -= 360_000_000;
  return r;
}

interface HalfPlane {
  readonly np: number;
  readonly nq: number;
  readonly c: number;
}

/** A face's clear region in local coordinates: half-planes inset by each edge's setback (convex faces), or null. */
function clearRegion(face: DrawRoofFace, fr: Frame2, poly: readonly (readonly number[])[]): HalfPlane[] | null {
  const loc = poly.map((p) => toLocal(fr, p[0]!, p[1]!));
  const n = loc.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += loc[i]![0] * loc[(i + 1) % n]![1] - loc[(i + 1) % n]![0] * loc[i]![1];
  const ccw = area > 0;
  const hp: HalfPlane[] = [];
  for (let i = 0; i < n; i++) {
    const a = loc[i]!;
    const b = loc[(i + 1) % n]!;
    const c = loc[(i + 2) % n]!;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (ccw ? cr < -1e-6 : cr > 1e-6) return null; // not convex
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l === 0) continue;
    const np = (ccw ? -dy : dy) / l;
    const nq = (ccw ? dx : -dx) / l;
    const pa = poly[i]!;
    const pb = poly[(i + 1) % n]!;
    const s = face.edges.find((e) => e.a[0] === pa[0] && e.a[1] === pa[1] && e.b[0] === pb[0] && e.b[1] === pb[1])?.setback ?? 0;
    hp.push({ np, nq, c: np * a[0] + nq * a[1] + s + MARGIN });
  }
  return hp;
}

/** The q interval of the clear region on the line p, or null. */
function interval(hp: readonly HalfPlane[], p: number): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (const h of hp) {
    const rest = h.c - h.np * p;
    if (Math.abs(h.nq) < 1e-12) {
      if (rest > 1e-6) return null;
      continue;
    }
    const bound = rest / h.nq;
    if (h.nq > 0) lo = Math.max(lo, bound);
    else hi = Math.min(hi, bound);
  }
  return lo <= hi ? [lo, hi] : null;
}

interface Fit {
  readonly layout: 'portrait' | 'landscape';
  readonly rows: number;
  readonly columns: number;
  readonly pc: number;
  readonly lo: number;
  readonly hi: number;
}

function depthOf(rows: number, depth: number, gap: number, kind: { pitch: { rise: number; run: number } | null; rack: { rise: number; run: number } | null; rowGap: number }): number {
  if (kind.rack) {
    const t = Math.atan2(kind.rack.rise, kind.rack.run);
    return rows * depth * Math.cos(t) + (rows - 1) * kind.rowGap;
  }
  if (kind.pitch) {
    const cos = kind.pitch.run / Math.sqrt(kind.pitch.rise ** 2 + kind.pitch.run ** 2);
    return (rows * depth + (rows - 1) * gap) * cos;
  }
  return rows * depth + (rows - 1) * gap;
}

/** The largest grid of modules whose corners keep clear on a convex face. */
function bestFit(hp: readonly HalfPlane[], pRange: P2, mod: PvModule, gap: number, kind: Parameters<typeof depthOf>[3]): Fit | null {
  let best: Fit[] = [];
  let bestCount = 0;
  for (const layout of ['portrait', 'landscape'] as const) {
    const depth = layout === 'portrait' ? mod.length : mod.width;
    const breadth = layout === 'portrait' ? mod.width : mod.length;
    for (let rows = 1; rows <= 60; rows++) {
      const D = depthOf(rows, depth, gap, kind);
      if (D > pRange[1] - pRange[0]) break;
      let any = false;
      for (let pc = pRange[1]; pc - D >= pRange[0] - 1; pc -= IN) {
        const a = interval(hp, pc);
        const b = interval(hp, pc - D);
        if (a === null || b === null) continue;
        const lo = Math.max(a[0], b[0]);
        const hi = Math.min(a[1], b[1]);
        if (hi <= lo) continue;
        const columns = Math.floor((hi - lo + gap) / (breadth + gap));
        if (columns < 1) continue;
        any = true;
        const count = rows * columns;
        const fit: Fit = { layout, rows, columns, pc, lo, hi };
        if (count > bestCount) {
          bestCount = count;
          best = [fit];
        } else if (count === bestCount && best[0]!.layout === layout && best[0]!.rows === rows) best.push(fit);
      }
      if (!any && rows > 1) break;
    }
  }
  return best.length === 0 ? null : best[Math.floor((best.length - 1) / 2)]!;
}

const snap = (x: number): number => Math.round(x / SNAP) * SNAP;

/** The FS_energy array for a fit, its corner centred along the face. */
function arrayOf(face: DrawRoofFace, fr: Frame2, fit: Fit, mod: PvModule, gap: number, rack: { rise: number; run: number } | null, rowGap: number, columns = fit.columns): SolarArray {
  const breadth = fit.layout === 'portrait' ? mod.width : mod.length;
  const B = columns * breadth + (columns - 1) * gap;
  const qc = fit.lo + (fit.hi - fit.lo - B) / 2;
  const at = toPlan(fr, fit.pc, qc);
  return {
    roof: face.roof,
    ...(face.face === undefined ? {} : { face: face.face }),
    module: { ...mod },
    layout: fit.layout,
    rows: fit.rows,
    columns,
    ...(rack ? { tilt: { ...rack }, rowGap } : {}),
    rapidShutdown: 'module',
    host: { mode: 'free', level: face.level, position: [snap(at[0]), snap(at[1])], rotation: fr.rotation },
  };
}

/** Is the array clear by FS_energy's exact test (4.3)? */
function exactlyClear(doc: FloorspecDocument, a: SolarArray, roofs: ReturnType<typeof deriveRoofs>): boolean {
  const r = roofs[a.roof];
  if (r?.surface === undefined || r.surface === null) return false;
  const setbacks = setbacksOf(doc);
  const polys = facePolygons(r, a);
  return arrayFootprint(doc, a).every((c) => cornerClear(c, polys, r.eave, setbacks));
}

/** The fallback box of an array: its footprint in its frame, from its lowest module to its highest. */
function withFallback(doc: FloorspecDocument, a: SolarArray, roofs: ReturnType<typeof deriveRoofs>): SolarArray {
  const mods = arrayModules(doc, a, roofs[a.roof]);
  const lvl = doc.levels?.[(a.host as { level: string }).level]?.elevation ?? 0;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const m of mods)
    for (const c of m.corners) {
      z0 = Math.min(z0, c[2]);
      z1 = Math.max(z1, c[2]);
    }
  const ext = arrayExtents(doc, a);
  const D = Number(ext.D);
  const B = Number(ext.B);
  const bottom = Math.floor(z0 - lvl);
  const top = Math.max(bottom + 51_200, Math.ceil(z1 - lvl) + 51_200);
  return { ...a, fallback: { level: (a.host as { level: string }).level, box: { min: [-D, 0, bottom], max: [0, B, top] } } };
}

// ── IDs ──────────────────────────────────────────────────────────────────────

function usedIds(doc: FloorspecDocument): Set<string> {
  const used = new Set<string>();
  for (const [key, c] of Object.entries(doc as unknown as Json)) {
    if (key === 'extensions' || key === 'program' || !isObject(c)) continue;
    for (const k of Object.keys(c)) used.add(k);
  }
  const items = (doc.program as Json | undefined)?.['items'];
  if (isObject(items)) for (const k of Object.keys(items)) used.add(k);
  for (const data of Object.values((doc.extensions ?? {}) as Json)) {
    if (!isObject(data)) continue;
    for (const [member, value] of Object.entries(data)) {
      if (!isObject(value)) continue;
      if (member === 'collections') {
        for (const coll of Object.values(value)) if (isObject(coll)) for (const k of Object.keys(coll)) used.add(k);
      } else for (const k of Object.keys(value)) used.add(k);
    }
  }
  return used;
}

// ── the inverter, the initiator and the circuit ──────────────────────────────

interface PanelSpot {
  readonly panel: string;
  readonly wall: string;
  readonly side: 'left' | 'right';
  readonly offset: number;
  readonly length: number;
  readonly volts: number[];
  readonly level: string;
}

function panelSpot(doc: FloorspecDocument): PanelSpot | null {
  const el = (doc.extensions as Json | undefined)?.['FS_electrical'];
  const panels = isObject(el) && isObject(el['collections']) && isObject(el['collections']['panels']) ? (el['collections']['panels'] as Record<string, Json>) : {};
  for (const id of Object.keys(panels).sort()) {
    const p = panels[id]!;
    const h = p['host'] as { mode?: string; wall?: string; side?: 'left' | 'right'; offset?: number } | undefined;
    if (h?.mode !== 'wallFace' || h.wall === undefined || p['fedBy'] !== undefined) continue;
    const w = doc.walls?.[h.wall];
    if (w === undefined) continue;
    const s = doc.junctions?.[w.start]?.position;
    const e = doc.junctions?.[w.end]?.position;
    if (s === undefined || e === undefined) continue;
    const length = Math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2);
    return { panel: id, wall: h.wall, side: h.side ?? 'left', offset: h.offset ?? 0, length, volts: (p['volts'] as number[] | undefined) ?? [240], level: w.level };
  }
  return null;
}

const INVERTER_BOX = { min: [0, -230_400, 0], max: [256_000, 230_400, 896_000] };
const SHUTDOWN_BOX = { min: [0, -96_000, 0], max: [128_000, 96_000, 192_000] };

/** A spot along the panel's wall `delta` from the panel, kept 1′ from either end. */
function besideOffset(spot: PanelSpot, delta: number): number {
  const want = spot.offset + delta;
  const lo = FT;
  const hi = spot.length - FT;
  if (want >= lo && want <= hi) return Math.round(want);
  const other = spot.offset - delta;
  return Math.round(Math.min(hi, Math.max(lo, other)));
}

// ── the proposal ─────────────────────────────────────────────────────────────

const facingText = (face: DrawRoofFace, racked: boolean, rackBearing: number): string =>
  face.bearing === null ? (racked ? `flat · racked ${compassOf(rackBearing)}` : 'flat') : `faces ${compassOf(face.bearing)}`;

const faceName = (face: DrawRoofFace): string => face.roofName ?? face.roof;

const round0 = (x: number): number => Math.round(x);

/** The house's electricity a year, from the energy estimate: heating and cooling by a heat pump, and the rest. */
export function houseUseOf(doc: FloorspecDocument): number | null {
  try {
    const e = estimateEnergy(doc);
    return e.loads.annualHeating / HEATING_COP + e.loads.annualCooling / COOLING_COP + BASE_USE;
  } catch {
    return null;
  }
}

export function proposeSolar(document: string | Uint8Array | FloorspecDocument | object, options: SolarOptions = {}): SolarProposal {
  const evaluation = evaluate(document, OFFICIAL_READER);
  if (!evaluation.valid || evaluation.view === undefined) throw new SolarError('the plan is not valid: fix its errors before laying out solar');
  // The primary design's view (Core 0.3, 19.3): the document itself when it has no design options.
  const doc = evaluation.view;
  if (doc.floorspec !== '0.3' && doc.floorspec !== '0.4') throw new SolarError('the plan has no roofs: a Floorspec 0.2 plan cannot carry them');
  const mod = options.module ?? DEFAULT_MODULE;
  const gap = IN;
  const rack = options.rack ?? DEFAULT_RACK;
  const cutoff = options.cutoff ?? DEFAULT_CUTOFF;
  const site = solarSite(doc);
  const sky: MonthSky[] = yearSky(site);
  const drawing = solarDrawing(doc);
  const occ: Occluders = occludersOf(doc, drawing);
  const roofs = deriveRoofs(doc, doc.floorspec === '0.4');
  const faces = roofFaces(doc, doc.floorspec === '0.4', roofs);
  const taken = new Set([...usedIds(doc), ...(options.retired ?? [])]);
  const mint = (prefix: string): string => {
    for (let n = 1; ; n++) {
      const id = `${prefix}${String(n)}`;
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
  const notes: string[] = [];
  const occupied = new Set(drawing.arrays.map((a) => (a.face === undefined ? a.roof : `${a.roof}:${String(a.face)}`)));
  const equator = equatorRotation(site);
  const rackBearing = site.latitude >= 0 ? 180 : 0;
  const altNoon = Math.max(10, 90 - Math.abs(site.latitude) - 23.45);
  const rackLift = mod.width * Math.sin(Math.atan2(rack.rise, rack.run));
  // Racks far enough apart that one does not shade the next at noon at the winter solstice.
  const rowGap = Math.round(Math.min(10 * FT, Math.max(FT, rackLift / Math.tan(altNoon * RAD))) / SNAP) * SNAP;

  interface Candidate {
    face: DrawRoofFace;
    array: SolarArray | null;
    fit: Fit | null;
    perKw: number;
    shade: number;
    est: ReturnType<typeof estimateArray> | null;
    reason?: string;
  }
  const candidates: Candidate[] = [];
  for (const face of faces) {
    if (occupied.has(face.key)) {
      candidates.push({ face, array: null, fit: null, perKw: 0, shade: 0, est: null, reason: 'already has an array' });
      continue;
    }
    const flat = face.face === undefined;
    const fr = frameOf(flat ? equator : face.rotation);
    const poly = [...face.polygons].sort((a, b) => b.length - a.length)[0]!;
    const hp = clearRegion(face, fr, poly);
    if (hp === null) {
      candidates.push({ face, array: null, fit: null, perKw: 0, shade: 0, est: null, reason: 'its outline is not convex: lay it out by hand' });
      continue;
    }
    const ps = poly.map((p) => toLocal(fr, p[0], p[1])[0]);
    const kind = { pitch: face.pitch, rack: flat ? rack : null, rowGap };
    let fit = bestFit(hp, [Math.min(...ps), Math.max(...ps)], mod, gap, kind);
    let array = fit === null ? null : arrayOf(face, fr, fit, mod, gap, flat ? rack : null, rowGap);
    // The exact test decides: a rounding the float search missed drops a column.
    while (array !== null && fit !== null && !exactlyClear(doc, array, roofs)) {
      if (fit.columns <= 1) {
        array = null;
        break;
      }
      fit = { ...fit, columns: fit.columns - 1 };
      array = arrayOf(face, fr, fit, mod, gap, flat ? rack : null, rowGap);
    }
    if (array === null || fit === null) {
      candidates.push({ face, array: null, fit: null, perKw: 0, shade: 0, est: null, reason: 'too small for a row of modules inside its setbacks' });
      continue;
    }
    const draw = asDrawArray(doc, 'candidate', array, roofs, face, flat ? rackBearing : null);
    const est = estimateArray(draw, sky, occ, site);
    candidates.push({ face, array, fit, perKw: est.perKw, shade: est.shade, est });
  }

  const bestPerKw = Math.max(0, ...candidates.map((c) => c.perKw));
  const ranked = [...candidates].sort((a, b) => b.perKw - a.perKw || (a.face.key < b.face.key ? -1 : 1));
  const houseUse = houseUseOf(doc);
  let target: { kwh: number; source: string } | null = null;
  if (options.target?.kind === 'kwh') target = { kwh: options.target.kwh, source: `${String(round0(options.target.kwh))} kWh a year, as asked` };
  else if (options.target === undefined || options.target.kind === 'share') {
    const percent = options.target?.kind === 'share' ? options.target.percent : 100;
    if (houseUse === null) notes.push('No energy estimate could be made for this plan, so the share of its use was not a target: every face worth it is filled.');
    else target = { kwh: (houseUse * percent) / 100, source: `${String(percent)}% of the house’s ≈ ${grouped(Math.round(houseUse / 100) * 100)} kWh a year` };
  }

  const ops: Operation[] = [];
  const arrays: ProposedArray[] = [];
  const plans: FacePlan[] = [];
  let made = 0;
  for (const c of ranked) {
    const share = bestPerKw > 0 ? c.perKw / bestPerKw : 0;
    const flat = c.face.face === undefined;
    const base = {
      key: c.face.key,
      roof: c.face.roof,
      ...(c.face.roofName === undefined ? {} : { roofName: c.face.roofName }),
      ...(c.face.face === undefined ? {} : { face: c.face.face }),
      tilt: flat && c.array ? Math.atan2(rack.rise, rack.run) / RAD : c.face.tilt,
      bearing: c.face.bearing,
      facing: facingText(c.face, flat && c.array !== null, rackBearing),
      perKw: c.perKw,
      shade: c.shade,
      share,
    };
    const skip = (reason: string): void => {
      plans.push({ ...base, status: 'skipped', reason, modules: 0, rows: 0, columns: 0, layout: 'portrait', kw: 0, annual: 0 });
    };
    if (c.array === null || c.fit === null || c.est === null) {
      skip(c.reason ?? 'nothing fits');
      continue;
    }
    if (share < cutoff) {
      skip(`${String(Math.round(share * 100))}% of the best face — below the ${String(Math.round(cutoff * 100))}% cutoff`);
      continue;
    }
    if (target !== null && made >= target.kwh) {
      skip('the target is met without it');
      continue;
    }
    let array = c.array;
    let est = c.est;
    let columns = c.fit.columns;
    if (target !== null && made + est.annual > target.kwh) {
      const perModule = est.annual / (c.fit.rows * c.fit.columns);
      const need = Math.ceil((target.kwh - made) / perModule);
      columns = Math.max(1, Math.min(c.fit.columns, Math.ceil(need / c.fit.rows)));
      if (columns < c.fit.columns) {
        array = arrayOf(c.face, frameOf(flat ? equator : c.face.rotation), c.fit, mod, gap, flat ? rack : null, rowGap, columns);
        est = estimateArray(asDrawArray(doc, 'candidate', array, roofs, c.face, flat ? rackBearing : null), sky, occ, site);
      }
    }
    const id = mint('PV');
    const name = faceName(c.face);
    const placed = withFallback(doc, { ...array, name } as unknown as SolarArray, roofs);
    const { host, ...element } = placed as SolarArray & { host: { mode: 'free'; level: string; position: [number, number]; rotation: number } };
    ops.push({
      op: 'placeElement',
      extension: 'FS_energy',
      collection: 'pvArrays',
      id,
      host: { mode: 'free', level: host.level, at: [host.position[0], host.position[1]], rotation: host.rotation },
      element,
    } as unknown as Operation);
    made += est.annual;
    const kw = (c.fit.rows * columns * mod.watts) / 1000;
    arrays.push({
      id,
      roof: c.face.roof,
      ...(c.face.face === undefined ? {} : { face: c.face.face }),
      name,
      modules: c.fit.rows * columns,
      rows: c.fit.rows,
      columns,
      layout: c.fit.layout,
      mount: flat ? 'racked' : 'flush',
      kw,
      monthly: est.monthly,
      annual: est.annual,
      low: est.low,
      high: est.high,
      perKw: est.perKw,
      facing: base.facing,
    });
    plans.push({ ...base, status: 'used', array: id, modules: c.fit.rows * columns, rows: c.fit.rows, columns, layout: c.fit.layout, kw, annual: est.annual });
  }

  // The inverter, the initiator and their circuit.
  let inverter: SolarProposal['inverter'] = null;
  let shutdown: string | null = null;
  let circuit: string | null = null;
  const existingInverters = energyCollection<{ arrays?: string[] }>(doc, 'inverters');
  if (arrays.length > 0 && options.inverter !== false) {
    const dcWatts = arrays.reduce((s, a) => s + a.kw * 1000, 0);
    if (existingInverters.length > 0) {
      const [iid, inv] = existingInverters[0]!;
      ops.push({ op: 'setProperty', id: iid, path: '/arrays', value: [...(inv.arrays ?? []), ...arrays.map((a) => a.id)] } as unknown as Operation);
      notes.push(`The new arrays join ${iid}, the plan's inverter.`);
    } else {
      const spot = panelSpot(doc);
      if (spot === null) notes.push('The plan has no panel on a wall to put the inverter beside: add one, or place the inverter by hand.');
      else {
        const iid = mint('INV');
        const watts = Math.ceil(dcWatts / 1.2 / 100) * 100;
        const at = besideOffset(spot, 3 * FT);
        ops.push({
          op: 'placeElement',
          extension: 'FS_energy',
          collection: 'inverters',
          id: iid,
          host: { mode: 'wallFace', wall: spot.wall, side: spot.side, at, height: 4 * FT },
          element: { fallback: { box: structuredClone(INVERTER_BOX) }, kind: 'hybrid', watts, inputs: Math.min(4, Math.max(1, arrays.length)), arrays: arrays.map((a) => a.id), name: `Inverter · ${(watts / 1000).toFixed(1)} kW hybrid` },
        } as unknown as Operation);
        inverter = { id: iid, watts, kind: 'hybrid', on: spot.wall };
        const sid = mint('RS');
        ops.push({
          op: 'placeElement',
          extension: 'FS_energy',
          collection: 'shutdowns',
          id: sid,
          host: { mode: 'wallFace', wall: spot.wall, side: spot.side, at: besideOffset(spot, -2 * FT), height: 5 * FT },
          element: { fallback: { box: structuredClone(SHUTDOWN_BOX) }, arrays: arrays.map((a) => a.id), name: 'Rapid shutdown' },
        } as unknown as Operation);
        shutdown = sid;
        const volts = spot.volts.includes(240) ? 240 : spot.volts.includes(230) ? 230 : Math.max(...spot.volts);
        const amps = (watts / volts) * BREAKER_MARGIN;
        const breaker = BREAKERS.find((b) => b >= amps) ?? Math.ceil(amps);
        const cid = mint('C');
        ops.push({
          op: 'setProperty',
          id: '$document',
          path: `/extensions/FS_electrical/circuits/${cid}`,
          value: { panel: spot.panel, breaker, poles: volts >= 200 ? 2 : 1, volts, loads: [iid, sid], name: 'PV inverter' },
        } as unknown as Operation);
        circuit = cid;
      }
    }
  }
  if (ops.length > 0 && !usesEnergy(doc)) ops.unshift({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_energy', value: '0.1.0' } as unknown as Operation);

  const total = { modules: arrays.reduce((s, a) => s + a.modules, 0), kw: arrays.reduce((s, a) => s + a.kw, 0), annual: made, ...pvRange(made) };
  const explanation: string[] = [];
  explanation.push(`Ranked ${String(faces.length)} roof face${faces.length === 1 ? '' : 's'} by a kW’s typical year after shade, kept each face’s eave, ridge and rake setbacks, and used the faces making at least ${String(Math.round(cutoff * 100))}% of the best.`);
  for (const a of arrays) explanation.push(`${a.id}: ${String(a.modules)} modules on ${a.name} (${a.facing}), ${a.kw.toFixed(1)} kW, ${String(a.low)}–${String(a.high)} kWh a year.`);
  for (const p of plans) if (p.status === 'skipped' && p.reason !== undefined) explanation.push(`${p.roofName ?? p.roof} (${p.facing}) left bare: ${p.reason}.`);
  if (inverter !== null) explanation.push(`${inverter.id}: a ${(inverter.watts / 1000).toFixed(1)} kW hybrid inverter beside the panel, battery-ready; ${shutdown ?? ''} rapid shutdown at each module, its initiator beside it; both on ${circuit ?? ''}.`);
  if (target !== null) explanation.push(`Sized to ${target.source}.`);
  explanation.push(PV_ADVISORY);
  return {
    name: 'Solar on the roof',
    batch: ops,
    explanation,
    faces: plans,
    arrays,
    inverter,
    shutdown,
    circuit,
    total,
    target,
    houseUse,
    notes,
    advisory: PV_ADVISORY,
    method: PV_METHOD_TEXT,
  };
}

/** An array as @floorspec/analysis draws and estimates it, before it is in the document. */
function asDrawArray(doc: FloorspecDocument, id: string, a: SolarArray, roofs: ReturnType<typeof deriveRoofs>, face: DrawRoofFace, rackBearing: number | null): DrawArray {
  const modules = arrayModules(doc, a, roofs[a.roof]);
  return {
    id,
    roof: a.roof,
    ...(a.face === undefined ? {} : { face: a.face }),
    level: face.level,
    mount: a.tilt ? 'racked' : 'flush',
    tilt: a.tilt ? Math.atan2(a.tilt.rise, a.tilt.run) / RAD : face.tilt,
    bearing: face.bearing ?? rackBearing,
    footprint: [],
    modules,
    rows: a.rows,
    columns: a.columns,
    layout: a.layout ?? 'portrait',
    moduleWatts: a.module.watts,
    watts: a.rows * a.columns * a.module.watts,
    clear: true,
    inverter: null,
    rapidShutdown: 'module',
  };
}
