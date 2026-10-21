/**
 * The advisory energy and comfort estimate (FLR-REQ-153, FLR-T-12.6), room by room (FLR-T-16.4). One
 * method, simple on purpose, every number traceable to an input or an assumption the result lists:
 *
 * 1. **Envelope** (envelope.ts, rooms.ts): each conditioned room's outside walls, windows and doors,
 *    the share of its ceiling under the roof (and which roof), the share of an upper room's floor over
 *    a garage or nothing, and a ground-floor room's slab edge — from the engine's evaluation of one
 *    design.
 * 2. **Assemblies**: each gets a U-factor — the user's, where they set one (inputs.ts); else, for a
 *    document that uses FS_thermal 0.1.0 (FLR-ADR-066), the assembly's own, layer by layer, by the
 *    parallel-path method with ASHRAE's surface resistances (assemblies.ts), any material without
 *    thermal data taking the thermal library's typical value (thermal-library.ts) — and a window's or
 *    door's its type's FS_thermal rating; else a typical value for the climate zone: the 2021 IECC's
 *    maximum assembly U-factors (Table R402.1.2), used as what a house built today in that zone
 *    typically has, never as a check. The slab edge gets an F-factor (ASHRAE 90.1 Appendix A): from its
 *    FS_thermal edge insulation (assemblies.ts' slabF), else uninsulated in zones 1–2 and R-10 in 3–8.
 * 3. **Heat loss coefficient**: UA = Σ U·A + F·edge + 0.335·ACH·V (air: ρ·c_p of 1.2 kg/m³ × 1005
 *    J/(kg·K), per m³/h). A wall, floor or door to an unconditioned room (a garage) counts at half: the
 *    room sits about halfway between indoors and out. Air leakage is shared among the rooms by their
 *    share of the outside wall.
 * 4. **Design loads** (Manual J-style, advisory): heating = UA × (indoor − 99% outdoor), room by room
 *    and for the house. Cooling = UA × (1% outdoor − indoor) + sun through the windows
 *    (solar.ts, × each window's SHGC) at the hour of July 21 when it peaks — each room at its own peak
 *    hour, the house at its own (a block load, so the rooms' cooling sums to more than the house's) —
 *    + people and appliances (Manual J's usual allowances: 230 Btu/h a person, one in each bedroom and
 *    one more in the living room, and 1,200 Btu/h of appliances in the kitchen). Latent loads, sun on
 *    walls and roof, and ducts are left out.
 * 5. **A typical year**: heating = UA × heating degree days × 24 h; cooling = UA × cooling degree
 *    days × 24 h. Sun and internal gains are left out of both. It is the heat the house needs
 *    delivered or removed, not fuel or electricity bought.
 * 6. **Climate**: the user's zone and values; else the station nearest the site's location
 *    (climate.ts, within 250 km); else the 4A preset, assumed.
 * 7. **Ranges**: every load and yearly figure is shown ±20% and rounded to two significant figures —
 *    a method this simple is not more precise than that.
 *
 * Deterministic: the same document, design and inputs give the same estimate.
 */
import { evaluate, deriveEvaluation, hasOptions, checkedDesigns, type FloorspecDocument } from '@floorspec/engine';
import { ASSUMED_LATITUDE, ASSUMED_ZONE, CLIMATE_PRESETS, fDaysToC, fToC, INDOOR_SUMMER_C, INDOOR_WINTER_C, nearestStation, presetOf, STATION_RANGE_KM, zoneNumber, type Climate } from './climate.js';
import { envelopeOf, HABITABLE, ORIENTATIONS, type Envelope, type EnvelopeOpening, type Orientation } from './envelope.js';
import { inputsOf, type EnergyInputs, type InputProblem } from './inputs.js';
import { dailyVertical, JANUARY_21, JULY_21, TAU, verticalAt } from './solar.js';
import { documentAssemblies, edgeResistanceOf, floorThermal, rText, roofThermal, slabF, thermalView, unitThermal, uText, wallTypeThermal, type AssemblyThermal, type ThermalView } from './assemblies.js';
import { roomCovers } from './rooms.js';

/** The words every presentation of an estimate carries. */
export const ADVISORY = 'An estimate to compare options — not an energy-code calculation.';
export const METHOD_VERSION = 'floorspec-analysis/0.2';
/** The room-by-room method, named wherever a room's load is shown. */
export const ROOM_METHOD = 'Room by room, Manual J-style: U·A·ΔT through each surface, air leakage shared by outside wall, sun through each window at the room’s own peak hour on July 21, people and appliances — advisory, ±20%.';

/** Imperial U (Btu/(h·ft²·°F)) → W/(m²·K), and F (Btu/(h·ft·°F)) → W/(m·K). */
export const U_IP_TO_SI = 5.678263;
export const F_IP_TO_SI = 1.730735;
/** Btu/h → W. */
export const BTUH_TO_W = 0.29307107;
const FT2_PER_M2 = 10.763910;

/** Typical assembly values by zone number (IP), see the module comment. */
const TYPICAL: Readonly<Record<number, { window: number; shgc: number; ceiling: number; wall: number; floor: number; slab: number }>> = {
  1: { window: 0.5, shgc: 0.25, ceiling: 0.035, wall: 0.084, floor: 0.064, slab: 0.73 },
  2: { window: 0.4, shgc: 0.25, ceiling: 0.026, wall: 0.084, floor: 0.064, slab: 0.73 },
  3: { window: 0.3, shgc: 0.25, ceiling: 0.026, wall: 0.06, floor: 0.047, slab: 0.54 },
  4: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, floor: 0.047, slab: 0.54 },
  5: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, floor: 0.033, slab: 0.54 },
  6: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, floor: 0.033, slab: 0.54 },
  7: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, floor: 0.028, slab: 0.54 },
  8: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, floor: 0.028, slab: 0.54 },
};
const DOOR_U_IP = 0.35;
/** Natural air changes an hour of a typical new house (about 7 ACH50 ÷ 20). */
export const TYPICAL_ACH = 0.35;
/** A wall or door to an unconditioned room counts at this share of the full ΔT. */
export const UNCONDITIONED_FACTOR = 0.5;
/** ρ·c_p of air, W per (m³/h) per K. */
export const AIR = 0.335;
const PERSON_W = 230 * BTUH_TO_W;
const APPLIANCES_W = 1200 * BTUH_TO_W;
/** ± this share around each load and yearly figure. */
export const SPREAD = 0.2;

export type AssemblyKind = 'wall' | 'wallToUnconditioned' | 'ceiling' | 'floor' | 'slab' | 'window' | 'door' | 'air';
/** Where an assembly's value came from: yours (the inputs), the document's FS_thermal data, the thermal library's typical values for its materials, or the climate zone's typical. */
export type ValueOrigin = 'yours' | 'document' | 'library' | 'typical';

export interface AssemblyRow {
  /** What a user value is stored under (inputs.ts): `wall:<type>`, `roof:<roof>`, `ceiling`, `floor`, `floor:<room>`, `slab`, `window`, `door`, `air`. */
  readonly key: string;
  readonly kind: AssemblyKind;
  readonly label: string;
  /** m² (walls, ceiling, floors, windows, doors), m (slab edge) or m³ (air). */
  readonly quantity: number;
  readonly quantityUnit: 'm2' | 'm' | 'm3';
  /** W/(m²·K); W/(m·K) for the slab edge; air changes an hour for air. Area-weighted where its parts differ. */
  readonly value: number;
  /** A window's solar heat gain coefficient, area-weighted. */
  readonly shgc?: number;
  /** 1, or UNCONDITIONED_FACTOR toward an unconditioned room (weighted). */
  readonly factor: number;
  /** W/K. */
  readonly ua: number;
  readonly source: ValueOrigin;
  /** Where the value came from, in words. */
  readonly sourceText: string;
  /** The elements it covers. */
  readonly elements: string[];
}

export interface FacadeRow {
  readonly orientation: Orientation;
  /** m², gross, outside walls only. */
  readonly wallArea: number;
  readonly windowArea: number;
  readonly doorArea: number;
  /** Window area ÷ gross wall area; null without walls. */
  readonly wwr: number | null;
  /** kWh a clear day of solar heat through the windows (× SHGC), July 21 and January 21. */
  readonly solarJuly: number;
  readonly solarJanuary: number;
  readonly walls: string[];
  readonly windows: string[];
}

export interface Loads {
  /** W/K: the whole heat loss coefficient. */
  readonly ua: number;
  /** W. */
  readonly heating: number;
  readonly cooling: number;
  readonly coolingParts: { readonly conduction: number; readonly air: number; readonly solar: number; readonly internal: number };
  /** The solar hour of July 21 the cooling load is worked at. */
  readonly coolingHour: number;
  /** kWh a typical year. */
  readonly annualHeating: number;
  readonly annualCooling: number;
}

/** What a room's load is made of. */
export type PartKind = 'windows' | 'doors' | 'walls' | 'ceiling' | 'floor' | 'slab' | 'air' | 'sun' | 'people' | 'appliances';

export interface LoadPart {
  readonly kind: PartKind;
  /** "Windows · 92 ft², U-0.30" is built by the screen from `kind`, `quantity` and `value`. */
  readonly label: string;
  /** W. */
  readonly watts: number;
  /** m² (or m of slab edge, m³ of air) it covers. */
  readonly quantity: number;
  /** Its U (W/(m²·K)), F (W/(m·K)) or ACH, area-weighted; absent for sun and gains. */
  readonly value?: number;
  readonly elements: string[];
}

/** The four bands of the heat-loss legends (the board's 16.4 frames). */
export type LossBand = 'low' | 'typical' | 'raised' | 'high';
/** Bands of a room's heating load per area of floor, Btu/h per ft²: low < 6 ≤ typical < 12 ≤ raised < 18 ≤ high. */
export const ROOM_BANDS = [6, 12, 18] as const;
/** Bands of a surface's loss per area on the design day, Btu/h per ft² of surface: low < 1.5 ≤ typical < 3 ≤ raised < 8 ≤ high. */
export const SURFACE_BANDS = [1.5, 3, 8] as const;
export const lossBandOf = (v: number, cuts: readonly [number, number, number]): LossBand => (v < cuts[0] ? 'low' : v < cuts[1] ? 'typical' : v < cuts[2] ? 'raised' : 'high');

export interface RoomLoad {
  readonly room: string;
  readonly name: string;
  readonly level: string;
  readonly function: string;
  /** m², m³. */
  readonly area: number;
  readonly volume: number;
  /** Its walls to the outside. */
  readonly exteriorWalls: number;
  /** m² of its windows facing west. */
  readonly westGlass: number;
  /** W at the heating design temperature, and what it is made of. */
  readonly heating: number;
  readonly heatingParts: LoadPart[];
  /** W at the cooling design temperature and the room's peak hour of sun. */
  readonly cooling: number;
  readonly coolingHour: number;
  readonly coolingParts: LoadPart[];
  /** Heating, Btu/h per ft² of floor, and its band. */
  readonly perArea: number;
  readonly band: LossBand;
}

/** A surface of the heat-loss map in 3D: an envelope wall, a window, a door, a roof over conditioned rooms. */
export interface SurfaceLoss {
  readonly element: string;
  readonly kind: 'wall' | 'window' | 'door' | 'roof';
  /** W/(m²·K). */
  readonly u: number;
  /** m². */
  readonly area: number;
  /** W/m² on the heating design day, the unconditioned factor included. */
  readonly flux: number;
  /** Btu/h per ft² on the design day, and its band. */
  readonly perArea: number;
  readonly band: LossBand;
  readonly toward: 'outside' | 'unconditioned';
}

/** The house's heating load by what it goes through: the 3D map's "share of the heating load". */
export interface HeatingShare {
  readonly kind: 'windows' | 'air' | 'walls' | 'slab' | 'ceiling' | 'floor' | 'doors';
  readonly watts: number;
  readonly share: number;
}

export type NoteKind = 'westGlass' | 'crossVentilation' | 'noOperableWindow' | 'glassyFacade';

export interface ComfortNote {
  readonly kind: NoteKind;
  readonly severity: 'warning' | 'note';
  /** One line: "West glass in Living may overheat late in the day". */
  readonly title: string;
  /** What it is based on: "Living · LW1, LW2 · 8.5 m² facing west". */
  readonly detail: string;
  readonly rooms: string[];
  readonly openings: string[];
}

export interface Assumption {
  readonly key: string;
  readonly text: string;
}

export interface OptionRow {
  /** Undefined for the primary design, else its option's ID. */
  readonly tag: string | null;
  readonly label: string;
  readonly design: Record<string, string>;
  readonly heating: number;
  readonly cooling: number;
  readonly annualHeating: number;
  readonly annualCooling: number;
  readonly windowArea: number;
  readonly wallArea: number;
}

export interface EnergyEstimate {
  readonly advisory: string;
  readonly method: string;
  readonly design: Record<string, string> | null;
  readonly climate: Climate;
  readonly inputs: EnergyInputs;
  /** What was wrong with the stored inputs (and so not used). */
  readonly problems: InputProblem[];
  readonly summary: { readonly conditionedArea: number; readonly volume: number; readonly rooms: number; readonly envelopeWalls: number; readonly openings: number };
  readonly assemblies: AssemblyRow[];
  readonly facades: FacadeRow[];
  readonly loads: Loads;
  /** FLR-T-16.4: each conditioned room's heating and cooling load, Manual J-style. */
  readonly rooms: RoomLoad[];
  /** FLR-T-16.4: the envelope's surfaces for the heat-loss map. */
  readonly surfaces: SurfaceLoss[];
  /** FLR-T-16.4: the house's heating load by what it goes through, largest first. */
  readonly shares: HeatingShare[];
  /** FLR-T-16.4: whether the document uses FS_thermal, so its own assemblies are used. */
  readonly thermal: boolean;
  /** FLR-T-16.4: every wall type's, roof's and floor's assembly, layer by layer (assemblies.ts). */
  readonly envelope: AssemblyThermal[];
  readonly notes: ComfortNote[];
  readonly assumptions: Assumption[];
  /** For a document with design options: every checked design, the primary first. */
  readonly options?: OptionRow[];
}

/** The climate an estimate uses: the inputs over their preset, or the station nearest the site, and the site's latitude for the sun. */
export function resolveClimate(inputs: EnergyInputs, latitude: number | undefined, longitude?: number): Climate {
  const near = inputs.zone === undefined && latitude !== undefined && longitude !== undefined ? nearestStation(latitude, longitude) : undefined;
  const station = near !== undefined && near.km <= STATION_RANGE_KM ? near : undefined;
  const zone = inputs.zone ?? station?.station.zone ?? ASSUMED_ZONE;
  const p = presetOf(zone) ?? presetOf(ASSUMED_ZONE)!;
  const base = station?.station ?? p;
  const own = ['heatingDesign', 'coolingDesign', 'hdd', 'cdd', 'indoorWinter', 'indoorSummer'].some((k) => (inputs as Record<string, unknown>)[k] !== undefined);
  const source = own ? 'custom' : inputs.zone !== undefined ? 'preset' : station !== undefined ? 'site' : 'assumed';
  const km = station === undefined ? '' : `${String(Math.round(station.km))} km`;
  const label =
    station !== undefined && inputs.zone === undefined
      ? `${station.station.city} · zone ${station.station.zone}${own ? ' with your values' : ''} (the nearest station, ${km} from the site)`
      : `Zone ${p.zone} ${source === 'custom' ? 'with your values' : 'preset'} · ${p.kind}, ${p.city}-like${source === 'assumed' ? ' (assumed: no climate set)' : ''}`;
  return {
    source,
    ...(station === undefined || inputs.zone !== undefined ? {} : { station: { city: station.station.city, km: station.km } }),
    zone: p.zone,
    label,
    heatingDesign: inputs.heatingDesign ?? fToC(base.heatingF),
    coolingDesign: inputs.coolingDesign ?? fToC(base.coolingF),
    hdd: inputs.hdd ?? fDaysToC(base.hddF),
    cdd: inputs.cdd ?? fDaysToC(base.cddF),
    indoorWinter: inputs.indoorWinter ?? INDOOR_WINTER_C,
    indoorSummer: inputs.indoorSummer ?? INDOOR_SUMMER_C,
    latitude: latitude ?? ASSUMED_LATITUDE,
    latitudeSource: latitude === undefined ? 'assumed' : 'site',
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const names = (doc: FloorspecDocument) => (id: string): string => doc.rooms?.[id]?.name ?? doc.openings?.[id]?.name ?? id;
const fmt1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
const DIRECTION: Record<Orientation, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };
const W_PER_M2_TO_BTUH_FT2 = 1 / BTUH_TO_W / FT2_PER_M2;

/** Does the document use FS_thermal (FLR-ADR-066)? Then its assemblies are its own. */
export const usesThermal = (doc: FloorspecDocument): boolean => Object.hasOwn((doc.extensionsUsed ?? {}), 'FS_thermal');

/** One surface's or air's share of the loss, before it is grouped into rows and rooms. */
interface Exposure {
  readonly room?: string;
  readonly kind: AssemblyKind;
  readonly key: string;
  readonly label: string;
  readonly elements: string[];
  readonly quantity: number;
  readonly unit: 'm2' | 'm' | 'm3';
  readonly value: number;
  readonly factor: number;
  readonly ua: number;
  readonly source: ValueOrigin;
  readonly sourceText: string;
  readonly shgc?: number;
  readonly opening?: EnvelopeOpening;
  /** The element drawn on the heat-loss map, and its kind there. */
  readonly surface?: { element: string; kind: SurfaceLoss['kind']; toward: 'outside' | 'unconditioned' };
}

interface Core {
  readonly envelope: Envelope;
  readonly climate: Climate;
  readonly assemblies: AssemblyRow[];
  readonly facades: FacadeRow[];
  readonly loads: Loads;
  readonly rooms: RoomLoad[];
  readonly surfaces: SurfaceLoss[];
  readonly shares: HeatingShare[];
  readonly thermal: boolean;
  readonly notes: ComfortNote[];
  readonly assumptions: Assumption[];
}

const thermalOrigin = (a: AssemblyThermal): ValueOrigin => (a.fromDocument ? 'document' : 'library');
const thermalText = (a: AssemblyThermal): string =>
  `${a.fromDocument ? 'The document’s assembly' : 'The document’s layers, with the thermal library’s typical values where a material states none'}: ${a.rEffective === null ? '' : `${rText(a.rEffective)}, ${uText(a.u!)}; `}${a.method}${a.framing ? `; framing ${a.framing.text}` : ''}`;

/** Everything but the option comparison, for one evaluated design. */
function estimateEnvelope(doc: FloorspecDocument, envelope: Envelope, derived: ReturnType<typeof deriveEvaluation>, inputs: EnergyInputs): Core {
  const climate = resolveClimate(inputs, envelope.latitude, envelope.longitude);
  const zn = Math.min(8, Math.max(1, zoneNumber(climate.zone)));
  const typ = TYPICAL[zn]!;
  const typical = (what: string): string => `Typical for zone ${String(zn)} (2021 IECC Table R402.1.2, ${what}), not a check`;
  const yours = inputs.assemblies ?? {};
  const thermal = usesThermal(doc);
  const view: ThermalView | null = thermal ? thermalView(doc) : null;
  const typeName = (id: string): string => (doc.types?.[id] as { name?: string } | undefined)?.name ?? id;
  const roomName = names(doc);
  const exposures: Exposure[] = [];

  // Openings, by wall.
  const opened = new Map<string, number>();
  for (const o of envelope.openings) opened.set(o.wall, (opened.get(o.wall) ?? 0) + o.area);

  // Walls.
  const wallU = new Map<string, { u: number; source: ValueOrigin; text: string }>();
  const wallValue = (type: string, toward: 'outside' | 'unconditioned') => {
    const k = `${type}|${toward}`;
    const hit = wallU.get(k);
    if (hit) return hit;
    const key = `wall:${type}`;
    const mine = yours[key]?.u;
    const a = view !== null && type !== '' ? wallTypeThermal(view, type, toward) : undefined;
    const v =
      mine !== undefined
        ? { u: mine, source: 'yours' as const, text: 'Your value' }
        : a !== undefined && a.u !== null
          ? { u: a.u, source: thermalOrigin(a), text: thermalText(a) }
          : { u: typ.wall * U_IP_TO_SI, source: 'typical' as const, text: typical(`frame wall U-${String(typ.wall)}`) };
    wallU.set(k, v);
    return v;
  };
  for (const w of envelope.walls) {
    const type = w.type ?? '';
    const v = wallValue(type, w.toward);
    const area = Math.max(0, w.gross - (opened.get(w.id) ?? 0));
    const factor = w.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR;
    const tn = type === '' ? 'own layers' : typeName(type);
    exposures.push({
      ...(w.room === undefined ? {} : { room: w.room }),
      kind: w.toward === 'outside' ? 'wall' : 'wallToUnconditioned',
      key: `wall:${type}`,
      label: w.toward === 'outside' ? `Exterior walls · ${tn}` : `Walls to unconditioned rooms · ${tn}`,
      elements: [w.id],
      quantity: area,
      unit: 'm2',
      value: v.u,
      factor,
      ua: v.u * area * factor,
      source: v.source,
      sourceText: v.text + (factor === 1 ? '' : '; counted at half ΔT'),
      surface: { element: w.id, kind: 'wall', toward: w.toward },
    });
  }

  // Windows and doors (an unfilled opening counts as a door).
  for (const o of envelope.openings) {
    const fill = doc.openings?.[o.id]?.fill;
    const rated = view !== null ? unitThermal(doc, fill) : {};
    const factor = o.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR;
    if (o.kind === 'window') {
      const mine = yours['window'];
      const u = mine?.u ?? rated.u ?? typ.window * U_IP_TO_SI;
      const shgc = mine?.shgc ?? rated.shgc ?? typ.shgc;
      const source: ValueOrigin = mine?.u !== undefined || mine?.shgc !== undefined ? 'yours' : rated.u !== undefined ? 'document' : 'typical';
      const text =
        mine?.u !== undefined
          ? 'Your value'
          : rated.u !== undefined
            ? `The window type’s FS_thermal rating${rated.shgc === undefined ? '' : `, SHGC ${String(rated.shgc)}`}`
            : typical(`fenestration U-${String(typ.window)}`) + (mine?.shgc === undefined && rated.shgc === undefined ? `; SHGC ${String(typ.shgc)} typical` : '');
      exposures.push({ ...(o.room === undefined ? {} : { room: o.room }), kind: 'window', key: 'window', label: 'Windows', elements: [o.id], quantity: o.area, unit: 'm2', value: u, factor, ua: u * o.area * factor, source, sourceText: text, shgc, opening: o, surface: { element: o.id, kind: 'window', toward: o.toward } });
    } else {
      const mine = yours['door']?.u;
      const u = mine ?? rated.u ?? DOOR_U_IP * U_IP_TO_SI;
      const source: ValueOrigin = mine !== undefined ? 'yours' : rated.u !== undefined ? 'document' : 'typical';
      const text = mine !== undefined ? 'Your value' : rated.u !== undefined ? 'The door type’s FS_thermal rating' : `Typical insulated opaque door, U-${String(DOOR_U_IP)}`;
      exposures.push({ ...(o.room === undefined ? {} : { room: o.room }), kind: 'door', key: 'door', label: 'Doors', elements: [o.id], quantity: o.area, unit: 'm2', value: u, factor, ua: u * o.area * factor, source, sourceText: text, opening: o, surface: { element: o.id, kind: 'door', toward: o.toward } });
    }
  }

  // Ceilings, floors and slab edges, room by room.
  const conditioned = new Set(envelope.rooms.filter((r) => r.conditioned).map((r) => r.id));
  const covers = roomCovers(doc, derived, (id) => conditioned.has(id));
  const roomOf = new Map(envelope.rooms.map((r) => [r.id, r]));
  const roofCache = new Map<string, AssemblyThermal | undefined>();
  for (const c of covers) {
    const r = roomOf.get(c.room);
    if (r === undefined) continue;
    for (const e of c.ceiling) {
      const area = r.area * e.share;
      if (area <= 0) continue;
      const roof = e.roof;
      let a: AssemblyThermal | undefined;
      if (roof !== undefined && view !== null) {
        if (!roofCache.has(roof)) roofCache.set(roof, roofThermal(view, roof));
        a = roofCache.get(roof);
      }
      const key = a !== undefined ? `roof:${roof!}` : 'ceiling';
      const mine = yours[key]?.u;
      const factor = e.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR;
      const v =
        mine !== undefined
          ? { u: mine, source: 'yours' as ValueOrigin, text: 'Your value' }
          : a !== undefined && a.u !== null
            ? { u: a.u, source: thermalOrigin(a), text: thermalText(a) }
            : { u: typ.ceiling * U_IP_TO_SI, source: 'typical' as ValueOrigin, text: typical(`ceiling U-${String(typ.ceiling)}`) };
      const roofName = roof === undefined ? undefined : ((doc.roofs as Record<string, { name?: string }> | undefined)?.[roof]?.name ?? roof);
      exposures.push({ room: c.room, kind: 'ceiling', key, label: a !== undefined ? `Roof · ${roofName!}` : 'Ceiling under the roof', elements: [roof ?? c.room], quantity: area, unit: 'm2', value: v.u, factor, ua: v.u * area * factor, source: v.source, sourceText: v.text, ...(roof === undefined ? {} : { surface: { element: roof, kind: 'roof' as const, toward: e.toward } }) });
    }
    for (const e of c.floor) {
      const area = r.area * e.share;
      if (area <= 0) continue;
      const a = view !== null ? floorThermal(view, c.room, e.toward) : undefined;
      const key = a !== undefined ? `floor:${c.room}` : 'floor';
      const mine = yours[key]?.u;
      const factor = e.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR;
      const v =
        mine !== undefined
          ? { u: mine, source: 'yours' as ValueOrigin, text: 'Your value' }
          : a !== undefined && a.u !== null
            ? { u: a.u, source: thermalOrigin(a), text: thermalText(a) }
            : { u: typ.floor * U_IP_TO_SI, source: 'typical' as ValueOrigin, text: typical(`floor U-${String(typ.floor)}`) };
      exposures.push({ room: c.room, kind: 'floor', key, label: e.toward === 'outside' ? 'Floors over the outside' : 'Floors over unconditioned rooms', elements: [c.room], quantity: area, unit: 'm2', value: v.u, factor, ua: v.u * area * factor, source: v.source, sourceText: v.text + (factor === 1 ? '' : '; counted at half ΔT') });
    }
  }
  // The slab edge: the outside walls of each building's lowest conditioned level, room by room (a void's to no room).
  const groundRooms = new Set(covers.filter((c) => c.onGround).map((c) => c.room));
  const groundLevels = new Set(envelope.slabs.map((s) => s.level));
  for (const w of envelope.walls) {
    if (w.toward !== 'outside' || !groundLevels.has(w.level)) continue;
    if (w.room !== undefined && !groundRooms.has(w.room)) continue;
    const mine = yours['slab']?.u;
    const edge = view !== null && w.room !== undefined ? edgeResistanceOf(doc, w.room) : undefined;
    const f = mine ?? (edge !== undefined ? slabF(edge) : typ.slab * F_IP_TO_SI);
    const source: ValueOrigin = mine !== undefined ? 'yours' : edge !== undefined ? 'document' : 'typical';
    const text =
      mine !== undefined
        ? 'Your value'
        : edge !== undefined
          ? `The floor’s FS_thermal edge insulation, ${rText(edge)}: F-${(f / F_IP_TO_SI).toFixed(2)} (ASHRAE 90.1 Appendix A, uninsulated F-0.73 to R-10 F-0.54, linear)`
          : `Typical: ${zn <= 2 ? 'an uninsulated edge' : 'an R-10 edge'}, F-${String(typ.slab)} (ASHRAE 90.1 App. A)`;
    exposures.push({ ...(w.room === undefined ? {} : { room: w.room }), kind: 'slab', key: 'slab', label: 'Slab edge', elements: [w.level], quantity: w.length, unit: 'm', value: f, factor: 1, ua: f * w.length, source, sourceText: text });
  }
  // Air: the house's, shared among the rooms by their share of the outside wall.
  const ach = inputs.ach ?? TYPICAL_ACH;
  const airUa = AIR * ach * envelope.volume;
  const outsideWall = new Map<string, number>();
  for (const w of envelope.walls) if (w.toward === 'outside' && w.room !== undefined) outsideWall.set(w.room, (outsideWall.get(w.room) ?? 0) + w.gross);
  const allOutside = sum([...outsideWall.values()]);
  const airText = inputs.ach === undefined ? `Typical new house: ${String(TYPICAL_ACH)} air changes an hour` : 'Your value';
  const airShare = (room: string): number => (allOutside > 0 ? (outsideWall.get(room) ?? 0) / allOutside : (roomOf.get(room)?.volume ?? 0) / Math.max(1e-9, envelope.volume));

  // Rows: the exposures grouped by assembly.
  const groups = new Map<string, Exposure[]>();
  for (const e of exposures) {
    const k = `${e.kind}|${e.key}|${e.label}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const order: AssemblyKind[] = ['wall', 'wallToUnconditioned', 'ceiling', 'floor', 'slab', 'window', 'door'];
  const assemblies: AssemblyRow[] = [...groups.values()]
    .sort((a, b) => order.indexOf(a[0]!.kind) - order.indexOf(b[0]!.kind) || (a[0]!.key < b[0]!.key ? -1 : a[0]!.key > b[0]!.key ? 1 : 0) || (a[0]!.label < b[0]!.label ? -1 : 1))
    .map((g) => {
      const first = g[0]!;
      const quantity = sum(g.map((e) => e.quantity));
      const ua = sum(g.map((e) => e.ua));
      const weighted = sum(g.map((e) => e.value * e.quantity));
      const value = quantity > 0 ? weighted / quantity : first.value;
      const factor = quantity > 0 && value > 0 ? ua / (value * quantity) : first.factor;
      const sources = new Set(g.map((e) => e.source));
      const source: ValueOrigin = sources.has('yours') ? 'yours' : sources.has('document') ? 'document' : sources.has('library') ? 'library' : 'typical';
      const texts = [...new Set(g.map((e) => e.sourceText))];
      const shgcs = g.filter((e) => e.shgc !== undefined);
      const label = first.kind === 'window' || first.kind === 'door' ? `${first.label} · ${String(g.length)}` : first.label;
      return {
        key: first.key,
        kind: first.kind,
        label,
        quantity,
        quantityUnit: first.unit,
        value,
        ...(shgcs.length ? { shgc: sum(shgcs.map((e) => e.shgc! * e.quantity)) / Math.max(1e-12, sum(shgcs.map((e) => e.quantity))) } : {}),
        factor,
        ua,
        source,
        sourceText: texts.length === 1 ? texts[0]! : texts.join(' · '),
        elements: [...new Set(g.flatMap((e) => e.elements))],
      };
    });
  assemblies.push({ key: 'air', kind: 'air', label: 'Air leakage', quantity: envelope.volume, quantityUnit: 'm3', value: ach, factor: 1, ua: airUa, source: inputs.ach === undefined ? 'typical' : 'yours', sourceText: airText, elements: [] });

  // Façades.
  const lat = climate.latitude;
  const winExp = exposures.filter((e) => e.kind === 'window');
  const gainOf = (e: Exposure, day: number, tau: { beam: number; diffuse: number }): number => e.quantity * e.shgc! * dailyVertical(lat, day, e.opening!.facing, tau);
  const shgcOf = new Map(winExp.map((e) => [e.opening!.id, e.shgc!]));
  const gain = (o: EnvelopeOpening, day: number, tau: { beam: number; diffuse: number }): number => o.area * (shgcOf.get(o.id) ?? typ.shgc) * dailyVertical(lat, day, o.facing, tau);
  const facades: FacadeRow[] = ORIENTATIONS.map((orientation) => {
    const ws = envelope.walls.filter((w) => w.toward === 'outside' && w.orientation === orientation);
    const wins = winExp.filter((e) => e.opening!.toward === 'outside' && e.opening!.orientation === orientation);
    const ds = exposures.filter((e) => e.kind === 'door' && e.opening!.toward === 'outside' && e.opening!.orientation === orientation);
    const wallArea = sum(ws.map((w) => w.gross));
    const windowArea = sum(wins.map((e) => e.quantity));
    return {
      orientation,
      wallArea,
      windowArea,
      doorArea: sum(ds.map((e) => e.quantity)),
      wwr: wallArea > 0 ? windowArea / wallArea : null,
      solarJuly: sum(wins.map((e) => gainOf(e, JULY_21, TAU.july))),
      solarJanuary: sum(wins.map((e) => gainOf(e, JANUARY_21, TAU.january))),
      walls: ws.map((w) => w.id),
      windows: wins.map((e) => e.opening!.id),
    };
  });

  // Loads, the house's.
  const dTh = Math.max(0, climate.indoorWinter - climate.heatingDesign);
  const dTc = Math.max(0, climate.coolingDesign - climate.indoorSummer);
  const ua = sum(assemblies.map((a) => a.ua));
  const sunAt = (ws: readonly Exposure[], hour: number): number => sum(ws.filter((e) => e.opening!.toward === 'outside').map((e) => e.quantity * e.shgc! * verticalAt(lat, JULY_21, hour, e.opening!.facing, TAU.july)));
  const peak = (ws: readonly Exposure[]): { hour: number; solar: number } => {
    let hour = 12;
    let solar = -1;
    for (let h = 7; h <= 19; h++) {
      const s = sunAt(ws, h);
      if (s > solar + 1e-9) {
        solar = s;
        hour = h;
      }
    }
    return { hour, solar: Math.max(0, solar) };
  };
  const house = peak(winExp);
  const bedrooms = envelope.rooms.filter((r) => r.conditioned && r.function === 'sleeping').length;
  const internal = (bedrooms + 1) * PERSON_W + APPLIANCES_W;
  const coolingParts = { conduction: (ua - airUa) * dTc, air: airUa * dTc, solar: house.solar, internal };
  const loads: Loads = {
    ua,
    heating: ua * dTh,
    cooling: coolingParts.conduction + coolingParts.air + coolingParts.solar + coolingParts.internal,
    coolingParts,
    coolingHour: house.hour,
    annualHeating: (ua * climate.hdd * 24) / 1000,
    annualCooling: (ua * climate.cdd * 24) / 1000,
  };

  // Rooms.
  const condRooms = envelope.rooms.filter((r) => r.conditioned);
  const living = condRooms.find((r) => r.function === 'living') ?? condRooms.find((r) => r.function === 'kitchen' || r.function === 'dining') ?? [...condRooms].sort((a, b) => b.area - a.area)[0];
  const kitchens = condRooms.filter((r) => r.function === 'kitchen');
  const PART_OF: Partial<Record<AssemblyKind, PartKind>> = { wall: 'walls', wallToUnconditioned: 'walls', window: 'windows', door: 'doors', ceiling: 'ceiling', floor: 'floor', slab: 'slab' };
  const LABEL: Record<PartKind, string> = { windows: 'Windows', doors: 'Doors', walls: 'Walls', ceiling: 'Ceiling', floor: 'Floor', slab: 'Slab edge', air: 'Air leakage', sun: 'Sun through the windows', people: 'People', appliances: 'Appliances' };
  const roomLoads: RoomLoad[] = condRooms.map((r) => {
    const mine = exposures.filter((e) => e.room === r.id);
    const byPart = new Map<PartKind, Exposure[]>();
    for (const e of mine) {
      const p = PART_OF[e.kind]!;
      byPart.set(p, [...(byPart.get(p) ?? []), e]);
    }
    const share = airShare(r.id);
    const conductive = (dT: number): LoadPart[] =>
      (['windows', 'doors', 'walls', 'ceiling', 'floor', 'slab'] as PartKind[]).flatMap((p) => {
        const es = byPart.get(p);
        if (!es?.length) return [];
        const q = sum(es.map((e) => e.quantity));
        return [{ kind: p, label: LABEL[p], watts: sum(es.map((e) => e.ua)) * dT, quantity: q, value: q > 0 ? sum(es.map((e) => e.value * e.quantity)) / q : es[0]!.value, elements: [...new Set(es.flatMap((e) => e.elements))] }];
      });
    const airPart = (dT: number): LoadPart[] => (share > 0 ? [{ kind: 'air', label: LABEL.air, watts: airUa * share * dT, quantity: r.volume, value: ach, elements: [] }] : []);
    const heatingParts = [...conductive(dTh), ...airPart(dTh)].filter((p) => p.watts > 0);
    const own = mine.filter((e) => e.kind === 'window');
    const sun = peak(own);
    const people = (r.function === 'sleeping' ? 1 : 0) + (r.id === living?.id ? 1 : 0);
    const appliances = kitchens.length ? (kitchens.some((k) => k.id === r.id) ? APPLIANCES_W / kitchens.length : 0) : r.id === living?.id ? APPLIANCES_W : 0;
    const coolingParts: LoadPart[] = [
      ...conductive(dTc),
      ...airPart(dTc),
      ...(sun.solar > 0 ? [{ kind: 'sun' as const, label: LABEL.sun, watts: sun.solar, quantity: sum(own.map((e) => e.quantity)), elements: own.map((e) => e.opening!.id) }] : []),
      ...(people > 0 ? [{ kind: 'people' as const, label: LABEL.people, watts: people * PERSON_W, quantity: people, elements: [] }] : []),
      ...(appliances > 0 ? [{ kind: 'appliances' as const, label: LABEL.appliances, watts: appliances, quantity: 1, elements: [] }] : []),
    ].filter((p) => p.watts > 0);
    const heating = sum(heatingParts.map((p) => p.watts));
    const perArea = r.area > 0 ? (heating * W_PER_M2_TO_BTUH_FT2) : 0;
    return {
      room: r.id,
      name: roomName(r.id),
      level: r.level,
      function: r.function,
      area: r.area,
      volume: r.volume,
      exteriorWalls: mine.filter((e) => e.kind === 'wall').length,
      westGlass: sum(own.filter((e) => e.opening!.toward === 'outside' && e.opening!.orientation === 'W').map((e) => e.quantity)),
      heating,
      heatingParts: heatingParts.sort((a, b) => b.watts - a.watts),
      cooling: sum(coolingParts.map((p) => p.watts)),
      coolingHour: sun.hour,
      coolingParts: coolingParts.sort((a, b) => b.watts - a.watts),
      perArea: r.area > 0 ? perArea / r.area : 0,
      band: lossBandOf(r.area > 0 ? perArea / r.area : 0, ROOM_BANDS),
    };
  });

  // Surfaces for the map: one per element, its exposures pooled.
  const bySurface = new Map<string, Exposure[]>();
  for (const e of exposures) if (e.surface) bySurface.set(`${e.surface.kind}|${e.surface.element}`, [...(bySurface.get(`${e.surface.kind}|${e.surface.element}`) ?? []), e]);
  const surfaces: SurfaceLoss[] = [...bySurface.values()]
    .map((es) => {
      const s = es[0]!.surface!;
      const area = sum(es.map((e) => e.quantity));
      const u = area > 0 ? sum(es.map((e) => e.value * e.quantity)) / area : es[0]!.value;
      const flux = area > 0 ? (sum(es.map((e) => e.ua)) * dTh) / area : 0;
      const perArea = flux * W_PER_M2_TO_BTUH_FT2;
      return { element: s.element, kind: s.kind, u, area, flux, perArea, band: lossBandOf(perArea, SURFACE_BANDS), toward: s.toward };
    })
    .sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : a.kind < b.kind ? -1 : 1));

  // The heating load's shares.
  const SHARE_OF: Partial<Record<AssemblyKind, HeatingShare['kind']>> = { wall: 'walls', wallToUnconditioned: 'walls', window: 'windows', door: 'doors', ceiling: 'ceiling', floor: 'floor', slab: 'slab', air: 'air' };
  const shareWatts = new Map<HeatingShare['kind'], number>();
  for (const a of assemblies) {
    const k = SHARE_OF[a.kind]!;
    shareWatts.set(k, (shareWatts.get(k) ?? 0) + a.ua * dTh);
  }
  const shares: HeatingShare[] = [...shareWatts].filter(([, w]) => w > 0).map(([kind, watts]) => ({ kind, watts, share: loads.heating > 0 ? watts / loads.heating : 0 })).sort((a, b) => b.watts - a.watts || (a.kind < b.kind ? -1 : 1));

  const windows = winExp.map((e) => e.opening!);
  // Comfort notes.
  const name = names(doc);
  const notes: ComfortNote[] = [];
  const rooms = envelope.rooms.filter((r) => r.conditioned);
  for (const r of rooms) {
    const west = windows.filter((o) => o.room === r.id && o.toward === 'outside' && o.orientation === 'W');
    const westArea = sum(west.map((o) => o.area));
    if (westArea >= 1.5 && westArea >= 0.05 * r.area) {
      const july = sum(west.map((o) => gain(o, JULY_21, TAU.july)));
      notes.push({
        kind: 'westGlass',
        severity: 'warning',
        title: `West glass in ${name(r.id)} may overheat late in the day`,
        detail: `${name(r.id)} · ${west.map((o) => name(o.id)).join(', ')} · ${fmt1(westArea)} m² facing west, ${fmt1(july)} kWh of sun on a clear July day`,
        rooms: [r.id],
        openings: west.map((o) => o.id),
      });
    }
  }
  for (const r of rooms) {
    const own = windows.filter((o) => o.room === r.id && o.toward === 'outside');
    const operable = own.filter((o) => o.operable);
    if (HABITABLE.has(r.function)) {
      const faces = new Set(operable.map((o) => o.orientation));
      if (operable.length === 0)
        notes.push({
          kind: 'noOperableWindow',
          severity: 'note',
          title: `${name(r.id)} has no window that opens`,
          detail: own.length === 0 ? `${name(r.id)} · no window in an outside wall` : `${name(r.id)} · ${own.map((o) => name(o.id)).join(', ')} ${own.length === 1 ? 'is' : 'are'} fixed`,
          rooms: [r.id],
          openings: own.map((o) => o.id),
        });
      else if (faces.size === 1)
        notes.push({
          kind: 'crossVentilation',
          severity: 'note',
          title: `${name(r.id)} has no cross-ventilation`,
          detail: `${name(r.id)} · ${operable.length === 1 ? 'its only window that opens' : 'its windows that open'}, ${operable.map((o) => name(o.id)).join(', ')}, ${operable.length === 1 ? 'faces' : 'all face'} ${DIRECTION[[...faces][0]!]}`,
          rooms: [r.id],
          openings: operable.map((o) => o.id),
        });
    } else if (r.function === 'bath' && operable.length === 0) {
      notes.push({ kind: 'noOperableWindow', severity: 'note', title: `${name(r.id)} has no window that opens`, detail: `${name(r.id)} · plan an exhaust fan`, rooms: [r.id], openings: own.map((o) => o.id) });
    }
  }
  for (const f of facades)
    if (f.wwr !== null && f.wwr > 0.3)
      notes.push({
        kind: 'glassyFacade',
        severity: 'note',
        title: `The ${DIRECTION[f.orientation]} façade is ${String(Math.round(f.wwr * 100))}% glass`,
        detail: `${fmt1(f.windowArea)} m² of window in ${fmt1(f.wallArea)} m² of wall: more heat lost in winter${f.orientation === 'S' ? '' : ' and gained in summer'}`,
        rooms: [...new Set(windows.filter((o) => f.windows.includes(o.id)).flatMap((o) => (o.room === undefined ? [] : [o.room])))],
        openings: f.windows,
      });


  const assumptions: Assumption[] = [
    { key: 'climate', text: climate.source === 'assumed' ? `No climate is set and no station is within ${String(STATION_RANGE_KM)} km of the site: zone ${climate.zone}'s preset is assumed.` : climate.label },
    { key: 'latitude', text: climate.latitudeSource === 'site' ? `The sun is worked out at the site's latitude, ${fmt1(climate.latitude)}°.` : `The site has no location: the sun is worked out at ${String(ASSUMED_LATITUDE)}° N.` },
    { key: 'conditioned', text: 'Every room is heated and cooled except garages and exterior rooms (porches, decks).' },
    { key: 'ceilings', text: `Ceilings are measured in plan, sampled room by room${envelope.ceilings.some((c) => c.vaulted) ? '; a vaulted ceiling’s true area is larger' : ''}: each room's floor area not under a heated room of the level above counts as ceiling to the roof over it.` },
    { key: 'slab', text: 'The lowest level of each building is taken as a slab on grade; heat is lost through its edge.' },
    { key: 'doors', text: thermal ? 'A door is its type’s FS_thermal rating, or an insulated opaque door where its type has none.' : 'Doors are taken as insulated opaque doors; Floorspec does not say whether a door is glazed.' },
    { key: 'unconditioned', text: 'A wall, floor or door to a garage counts at half the temperature difference.' },
    { key: 'voids', text: 'A space walled in on a level with no room — a stair well, an open-to-below — is taken as heated air.' },
    { key: 'gains', text: 'Sun and internal gains are left out of the yearly figures; latent loads, sun on walls and roof, and ducts are left out of the design loads.' },
    { key: 'rooms', text: 'Rooms: air leakage is shared by each room’s share of the outside wall; one person in each bedroom and one more in the living room, appliances in the kitchen; each room’s cooling at its own peak hour of sun, the house’s at its own.' },
    { key: 'assemblies', text: thermal ? 'Assemblies are the document’s own (FS_thermal), layer by layer by the parallel-path method with ASHRAE’s surface resistances; a material that states no thermal values takes the thermal library’s typical value, and its row says so.' : 'The plan does not use FS_thermal: assemblies take the climate zone’s typical values. Add thermal values to its materials and types to use its own.' },
    { key: 'ranges', text: 'Loads and yearly figures are shown ±20%, rounded to two significant figures.' },
  ];
  if (envelope.unmeasured.length) assumptions.push({ key: 'unmeasured', text: `Left out, with no size to measure: ${envelope.unmeasured.join(', ')}.` });

  return { envelope, climate, assemblies, facades, loads, rooms: roomLoads, surfaces, shares, thermal, notes, assumptions };
}

export interface EstimateOptions {
  /** The user's inputs. Default: what the document holds at `/extras/d3floorspec/energy`. */
  readonly inputs?: EnergyInputs;
  /** The design to estimate (Core 19.6). Default the primary. */
  readonly design?: Readonly<Record<string, string>>;
  /** Compare every checked design (Core 19.5) when the document has options. Default true. */
  readonly compare?: boolean;
}

/** Thrown when there is nothing to estimate: an invalid document, or a design that is not one of its. */
export class EstimateError extends Error {}

function evaluated(document: object, design: Readonly<Record<string, string>> | undefined) {
  const ev = evaluate(document, design === undefined ? {} : { design: { ...design } });
  if (!ev.valid || !ev.document) throw new EstimateError('the plan is not valid, so there is nothing to estimate');
  if (!ev.view || !ev.analysis) throw new EstimateError('that design is not one of the plan’s');
  return { ev, derived: deriveEvaluation(ev) };
}

/** The advisory energy and comfort estimate of a document (FLR-REQ-153), room by room (FLR-T-16.4). Throws EstimateError. */
export function estimateEnergy(document: object, options: EstimateOptions = {}): EnergyEstimate {
  const stored = inputsOf(document);
  const inputs = options.inputs ?? stored.inputs;
  const problems = options.inputs === undefined ? stored.problems : [];
  const { ev, derived } = evaluated(document, options.design);
  const core = estimateEnvelope(ev.view!, envelopeOf(ev, derived), derived, inputs);
  let comparison: OptionRow[] | undefined;
  if (options.compare !== false && hasOptions(ev.document!)) {
    comparison = checkedDesigns(ev.document!).map((d) => {
      const one = evaluated(document, d.design);
      const c = estimateEnvelope(one.ev.view!, envelopeOf(one.ev, one.derived), one.derived, inputs);
      const label = d.tag === undefined ? 'Primary design' : (ev.document!.options?.[d.tag]?.name ?? d.tag);
      return {
        tag: d.tag ?? null,
        label,
        design: { ...d.design },
        heating: c.loads.heating,
        cooling: c.loads.cooling,
        annualHeating: c.loads.annualHeating,
        annualCooling: c.loads.annualCooling,
        windowArea: sum(c.facades.map((f) => f.windowArea)),
        wallArea: sum(c.facades.map((f) => f.wallArea)),
      };
    });
  }
  const e = core.envelope;
  return {
    advisory: ADVISORY,
    method: METHOD_VERSION,
    design: ev.design ? { ...ev.design } : null,
    climate: core.climate,
    inputs,
    problems,
    summary: { conditionedArea: e.conditionedArea, volume: e.volume, rooms: e.rooms.filter((r) => r.conditioned).length, envelopeWalls: e.walls.length, openings: e.openings.length },
    assemblies: core.assemblies,
    facades: core.facades,
    loads: core.loads,
    rooms: core.rooms,
    surfaces: core.surfaces,
    shares: core.shares,
    thermal: core.thermal,
    envelope: core.thermal ? documentAssemblies(ev.view!) : [],
    notes: core.notes,
    assumptions: core.assumptions,
    ...(comparison === undefined ? {} : { options: comparison }),
  };
}

export { CLIMATE_PRESETS };
