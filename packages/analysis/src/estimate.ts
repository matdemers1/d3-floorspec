/**
 * The advisory energy and comfort estimate (FLR-REQ-153). One method, simple on purpose, every
 * number traceable to an input or an assumption the result lists:
 *
 * 1. **Envelope** (envelope.ts): net wall, window and door areas by façade, exposed ceiling in plan,
 *    the slab edge, and the conditioned volume, from the engine's evaluation of one design.
 * 2. **Assemblies**: each gets a U-factor — the user's, where they set one, else a typical value for
 *    the climate zone: the 2021 IECC's maximum assembly U-factors (Table R402.1.2), used as what a
 *    house built today in that zone typically has, never as a check. The slab edge gets an F-factor
 *    (ASHRAE 90.1 Appendix A): an uninsulated edge in zones 1–2, an R-10 edge in 3–8. Doors are
 *    taken as insulated opaque doors, U-0.35, since Floorspec does not say whether a door is glazed.
 * 3. **Heat loss coefficient**: UA = Σ U·A + F·edge + 0.335·ACH·V (air: ρ·c_p of 1.2 kg/m³ ×
 *    1005 J/(kg·K), per m³/h). A wall or door to an unconditioned room (a garage) counts at half: the
 *    room sits about halfway between indoors and out.
 * 4. **Design loads**: heating = UA × (indoor − 99% outdoor). Cooling = UA × (1% outdoor − indoor) +
 *    sun through the windows at the hour of July 21 when it peaks (solar.ts, × SHGC) + people and
 *    appliances (Manual J's usual allowances: 230 Btu/h a person, one more person than bedrooms, and
 *    1,200 Btu/h for appliances). Latent loads, sun on walls and roof, and ducts are left out.
 * 5. **A typical year**: heating = UA × heating degree days × 24 h; cooling = UA × cooling degree
 *    days × 24 h. Sun and internal gains are left out of both: they lower the heating and raise the
 *    cooling. It is the heat the house needs delivered or removed, not fuel or electricity bought.
 * 6. **Ranges**: every load and yearly figure is shown ±20% and rounded to two significant figures —
 *    a method this simple is not more precise than that.
 *
 * Deterministic: the same document, design and inputs give the same estimate.
 */
import { evaluate, deriveEvaluation, hasOptions, checkedDesigns, type FloorspecDocument } from '@floorspec/engine';
import { ASSUMED_LATITUDE, ASSUMED_ZONE, CLIMATE_PRESETS, fDaysToC, fToC, INDOOR_SUMMER_C, INDOOR_WINTER_C, presetOf, zoneNumber, type Climate } from './climate.js';
import { envelopeOf, HABITABLE, ORIENTATIONS, type Envelope, type EnvelopeOpening, type Orientation } from './envelope.js';
import { inputsOf, type EnergyInputs, type InputProblem } from './inputs.js';
import { dailyVertical, JANUARY_21, JULY_21, TAU, verticalAt } from './solar.js';

/** The words every presentation of an estimate carries. */
export const ADVISORY = 'An estimate to compare options — not an energy-code calculation.';
export const METHOD_VERSION = 'floorspec-analysis/0.1';

/** Imperial U (Btu/(h·ft²·°F)) → W/(m²·K), and F (Btu/(h·ft·°F)) → W/(m·K). */
export const U_IP_TO_SI = 5.678263;
export const F_IP_TO_SI = 1.730735;
/** Btu/h → W. */
export const BTUH_TO_W = 0.29307107;

/** Typical assembly values by zone number (IP), see the module comment. */
const TYPICAL: Readonly<Record<number, { window: number; shgc: number; ceiling: number; wall: number; slab: number }>> = {
  1: { window: 0.5, shgc: 0.25, ceiling: 0.035, wall: 0.084, slab: 0.73 },
  2: { window: 0.4, shgc: 0.25, ceiling: 0.026, wall: 0.084, slab: 0.73 },
  3: { window: 0.3, shgc: 0.25, ceiling: 0.026, wall: 0.06, slab: 0.54 },
  4: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, slab: 0.54 },
  5: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, slab: 0.54 },
  6: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, slab: 0.54 },
  7: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, slab: 0.54 },
  8: { window: 0.3, shgc: 0.4, ceiling: 0.024, wall: 0.045, slab: 0.54 },
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

export type AssemblyKind = 'wall' | 'wallToUnconditioned' | 'ceiling' | 'slab' | 'window' | 'door' | 'air';

export interface AssemblyRow {
  /** What a user value is stored under (inputs.ts): `wall:<type>`, `ceiling`, `slab`, `window`, `door`, `air`. */
  readonly key: string;
  readonly kind: AssemblyKind;
  readonly label: string;
  /** m² (walls, ceiling, windows, doors), m (slab edge) or m³ (air). */
  readonly quantity: number;
  readonly quantityUnit: 'm2' | 'm' | 'm3';
  /** W/(m²·K); W/(m·K) for the slab edge; air changes an hour for air. */
  readonly value: number;
  /** A window's solar heat gain coefficient. */
  readonly shgc?: number;
  /** 1, or UNCONDITIONED_FACTOR toward an unconditioned room. */
  readonly factor: number;
  /** W/K. */
  readonly ua: number;
  readonly source: 'yours' | 'typical';
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
  readonly notes: ComfortNote[];
  readonly assumptions: Assumption[];
  /** For a document with design options: every checked design, the primary first. */
  readonly options?: OptionRow[];
}

/** The climate an estimate uses: the inputs over their preset, the site's latitude for the sun. */
export function resolveClimate(inputs: EnergyInputs, latitude: number | undefined): Climate {
  const zone = inputs.zone ?? ASSUMED_ZONE;
  const p = presetOf(zone) ?? presetOf(ASSUMED_ZONE)!;
  const own = ['heatingDesign', 'coolingDesign', 'hdd', 'cdd', 'indoorWinter', 'indoorSummer'].some((k) => (inputs as Record<string, unknown>)[k] !== undefined);
  const source = own ? 'custom' : inputs.zone === undefined ? 'assumed' : 'preset';
  const label = `Zone ${p.zone} ${source === 'custom' ? 'with your values' : 'preset'} · ${p.kind}, ${p.city}-like${source === 'assumed' ? ' (assumed: no climate set)' : ''}`;
  return {
    source,
    zone: p.zone,
    label,
    heatingDesign: inputs.heatingDesign ?? fToC(p.heatingF),
    coolingDesign: inputs.coolingDesign ?? fToC(p.coolingF),
    hdd: inputs.hdd ?? fDaysToC(p.hddF),
    cdd: inputs.cdd ?? fDaysToC(p.cddF),
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

interface Core {
  readonly envelope: Envelope;
  readonly climate: Climate;
  readonly assemblies: AssemblyRow[];
  readonly facades: FacadeRow[];
  readonly loads: Loads;
  readonly notes: ComfortNote[];
  readonly assumptions: Assumption[];
}

/** Everything but the option comparison, for one evaluated design. */
function estimateEnvelope(doc: FloorspecDocument, envelope: Envelope, inputs: EnergyInputs): Core {
  const climate = resolveClimate(inputs, envelope.latitude);
  const zn = Math.min(8, Math.max(1, zoneNumber(climate.zone)));
  const typ = TYPICAL[zn]!;
  const typical = (what: string): string => `Typical for zone ${String(zn)} (2021 IECC Table R402.1.2, ${what}), not a check`;
  const yours = inputs.assemblies ?? {};
  const assemblies: AssemblyRow[] = [];
  const opened = new Map<string, number>();
  for (const o of envelope.openings) opened.set(o.wall, (opened.get(o.wall) ?? 0) + o.area);

  // Walls: by type, outside and toward unconditioned rooms apart.
  for (const toward of ['outside', 'unconditioned'] as const) {
    const groups = new Map<string, typeof envelope.walls>();
    for (const w of envelope.walls) if (w.toward === toward) groups.set(w.type ?? '', [...(groups.get(w.type ?? '') ?? []), w]);
    for (const [type, ws] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const key = `wall:${type}`;
      const mine = yours[key]?.u;
      const u = mine ?? typ.wall * U_IP_TO_SI;
      const area = sum(ws.map((w) => Math.max(0, w.gross - (opened.get(w.id) ?? 0))));
      const factor = toward === 'outside' ? 1 : UNCONDITIONED_FACTOR;
      const typeName = type === '' ? 'own layers' : (doc.types?.[type]?.name ?? type);
      assemblies.push({
        key,
        kind: toward === 'outside' ? 'wall' : 'wallToUnconditioned',
        label: toward === 'outside' ? `Exterior walls · ${typeName}` : `Walls to unconditioned rooms · ${typeName}`,
        quantity: area,
        quantityUnit: 'm2',
        value: u,
        factor,
        ua: u * area * factor,
        source: mine === undefined ? 'typical' : 'yours',
        sourceText: (mine === undefined ? typical(`frame wall U-${String(typ.wall)}`) : 'Your value') + (factor === 1 ? '' : '; counted at half ΔT'),
        elements: ws.map((w) => w.id),
      });
    }
  }

  // Ceiling to the roof.
  {
    const area = sum(envelope.ceilings.map((c) => c.area));
    if (area > 0) {
      const mine = yours['ceiling']?.u;
      const u = mine ?? typ.ceiling * U_IP_TO_SI;
      assemblies.push({ key: 'ceiling', kind: 'ceiling', label: 'Ceiling under the roof', quantity: area, quantityUnit: 'm2', value: u, factor: 1, ua: u * area, source: mine === undefined ? 'typical' : 'yours', sourceText: mine === undefined ? typical(`ceiling U-${String(typ.ceiling)}`) : 'Your value', elements: envelope.ceilings.map((c) => c.level) });
    }
  }
  // Slab edge.
  {
    const edge = sum(envelope.slabs.map((s) => s.edge));
    if (edge > 0) {
      const mine = yours['slab']?.u;
      const f = mine ?? typ.slab * F_IP_TO_SI;
      assemblies.push({ key: 'slab', kind: 'slab', label: 'Slab edge', quantity: edge, quantityUnit: 'm', value: f, factor: 1, ua: f * edge, source: mine === undefined ? 'typical' : 'yours', sourceText: mine === undefined ? `Typical: ${zn <= 2 ? 'an uninsulated edge' : 'an R-10 edge'}, F-${String(typ.slab)} (ASHRAE 90.1 App. A)` : 'Your value', elements: envelope.slabs.map((s) => s.level) });
    }
  }
  // Windows.
  const windows = envelope.openings.filter((o) => o.kind === 'window');
  const shgc = yours['window']?.shgc ?? typ.shgc;
  if (windows.length) {
    const mine = yours['window']?.u;
    const u = mine ?? typ.window * U_IP_TO_SI;
    const ua = sum(windows.map((w) => u * w.area * (w.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR)));
    const area = sum(windows.map((w) => w.area));
    assemblies.push({ key: 'window', kind: 'window', label: `Windows · ${String(windows.length)}`, quantity: area, quantityUnit: 'm2', value: u, shgc, factor: area > 0 ? ua / (u * area) : 1, ua, source: mine === undefined && yours['window']?.shgc === undefined ? 'typical' : 'yours', sourceText: mine === undefined ? typical(`fenestration U-${String(typ.window)}`) + (yours['window']?.shgc === undefined ? `; SHGC ${String(typ.shgc)} typical` : '; your SHGC') : 'Your value', elements: windows.map((w) => w.id) });
  }
  // Doors (and unfilled openings, counted as doors).
  const doors = envelope.openings.filter((o) => o.kind !== 'window');
  if (doors.length) {
    const mine = yours['door']?.u;
    const u = mine ?? DOOR_U_IP * U_IP_TO_SI;
    const ua = sum(doors.map((d) => u * d.area * (d.toward === 'outside' ? 1 : UNCONDITIONED_FACTOR)));
    const area = sum(doors.map((d) => d.area));
    assemblies.push({ key: 'door', kind: 'door', label: `Doors · ${String(doors.length)}`, quantity: area, quantityUnit: 'm2', value: u, factor: area > 0 ? ua / (u * area) : 1, ua, source: mine === undefined ? 'typical' : 'yours', sourceText: mine === undefined ? `Typical insulated opaque door, U-${String(DOOR_U_IP)}` : 'Your value', elements: doors.map((d) => d.id) });
  }
  // Air.
  const ach = inputs.ach ?? TYPICAL_ACH;
  assemblies.push({ key: 'air', kind: 'air', label: 'Air leakage', quantity: envelope.volume, quantityUnit: 'm3', value: ach, factor: 1, ua: AIR * ach * envelope.volume, source: inputs.ach === undefined ? 'typical' : 'yours', sourceText: inputs.ach === undefined ? `Typical new house: ${String(TYPICAL_ACH)} air changes an hour` : 'Your value', elements: [] });

  // Façades.
  const lat = climate.latitude;
  const gain = (o: EnvelopeOpening, day: number, tau: { beam: number; diffuse: number }): number => o.area * shgc * dailyVertical(lat, day, o.facing, tau);
  const facades: FacadeRow[] = ORIENTATIONS.map((orientation) => {
    const ws = envelope.walls.filter((w) => w.toward === 'outside' && w.orientation === orientation);
    const wins = windows.filter((o) => o.toward === 'outside' && o.orientation === orientation);
    const ds = doors.filter((o) => o.toward === 'outside' && o.orientation === orientation);
    const wallArea = sum(ws.map((w) => w.gross));
    const windowArea = sum(wins.map((o) => o.area));
    return {
      orientation,
      wallArea,
      windowArea,
      doorArea: sum(ds.map((o) => o.area)),
      wwr: wallArea > 0 ? windowArea / wallArea : null,
      solarJuly: sum(wins.map((o) => gain(o, JULY_21, TAU.july))),
      solarJanuary: sum(wins.map((o) => gain(o, JANUARY_21, TAU.january))),
      walls: ws.map((w) => w.id),
      windows: wins.map((o) => o.id),
    };
  });

  // Loads.
  const ua = sum(assemblies.map((a) => a.ua));
  const airUa = assemblies.find((a) => a.kind === 'air')!.ua;
  const heating = ua * Math.max(0, climate.indoorWinter - climate.heatingDesign);
  const dTc = Math.max(0, climate.coolingDesign - climate.indoorSummer);
  const sunny = windows.filter((o) => o.toward === 'outside');
  let coolingHour = 12;
  let solar = -1;
  for (let hour = 7; hour <= 19; hour++) {
    const s = sum(sunny.map((o) => o.area * shgc * verticalAt(lat, JULY_21, hour, o.facing, TAU.july)));
    if (s > solar + 1e-9) {
      solar = s;
      coolingHour = hour;
    }
  }
  const bedrooms = envelope.rooms.filter((r) => r.conditioned && r.function === 'sleeping').length;
  const internal = (bedrooms + 1) * PERSON_W + APPLIANCES_W;
  const coolingParts = { conduction: (ua - airUa) * dTc, air: airUa * dTc, solar: Math.max(0, solar), internal };
  const loads: Loads = {
    ua,
    heating,
    cooling: coolingParts.conduction + coolingParts.air + coolingParts.solar + coolingParts.internal,
    coolingParts,
    coolingHour,
    annualHeating: (ua * climate.hdd * 24) / 1000,
    annualCooling: (ua * climate.cdd * 24) / 1000,
  };

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
    { key: 'climate', text: climate.source === 'assumed' ? `No climate is set: zone ${climate.zone}'s preset is assumed.` : climate.label },
    { key: 'latitude', text: climate.latitudeSource === 'site' ? `The sun is worked out at the site's latitude, ${fmt1(climate.latitude)}°.` : `The site has no location: the sun is worked out at ${String(ASSUMED_LATITUDE)}° N.` },
    { key: 'conditioned', text: 'Every room is heated and cooled except garages and exterior rooms (porches, decks).' },
    { key: 'ceilings', text: `Ceilings are measured in plan${envelope.ceilings.some((c) => c.vaulted) ? '; a vaulted ceiling’s true area is larger' : ''}; each level's floor area not under the level above counts as ceiling to the roof.` },
    { key: 'slab', text: 'The lowest level of each building is taken as a slab on grade; heat is lost through its edge.' },
    { key: 'doors', text: 'Doors are taken as insulated opaque doors; Floorspec does not say whether a door is glazed.' },
    { key: 'unconditioned', text: 'A wall or door to a garage counts at half the temperature difference.' },
    { key: 'voids', text: 'A space walled in on a level with no room — a stair well, an open-to-below — is taken as heated air.' },
    { key: 'gains', text: 'Sun and internal gains are left out of the yearly figures; latent loads, sun on walls and roof, and ducts are left out of the design loads.' },
    { key: 'ranges', text: 'Loads and yearly figures are shown ±20%, rounded to two significant figures.' },
  ];
  if (envelope.unmeasured.length) assumptions.push({ key: 'unmeasured', text: `Left out, with no size to measure: ${envelope.unmeasured.join(', ')}.` });

  return { envelope, climate, assemblies, facades, loads, notes, assumptions };
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

/** The advisory energy and comfort estimate of a document (FLR-REQ-153). Throws EstimateError. */
export function estimateEnergy(document: object, options: EstimateOptions = {}): EnergyEstimate {
  const stored = inputsOf(document);
  const inputs = options.inputs ?? stored.inputs;
  const problems = options.inputs === undefined ? stored.problems : [];
  const { ev, derived } = evaluated(document, options.design);
  const core = estimateEnvelope(ev.view!, envelopeOf(ev, derived), inputs);
  let comparison: OptionRow[] | undefined;
  if (options.compare !== false && hasOptions(ev.document!)) {
    comparison = checkedDesigns(ev.document!).map((d) => {
      const one = evaluated(document, d.design);
      const c = estimateEnvelope(one.ev.view!, envelopeOf(one.ev, one.derived), inputs);
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
    notes: core.notes,
    assumptions: core.assumptions,
    ...(comparison === undefined ? {} : { options: comparison }),
  };
}

export { CLIMATE_PRESETS };
