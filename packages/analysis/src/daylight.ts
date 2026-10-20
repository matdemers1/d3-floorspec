/**
 * Daylight you can see (FLR-T-14.7): what a daylight study of a house is and how it is read — the
 * four named bands, the work plane, the grid, the sun-hours schedule, the desks and beds a glare
 * flag is pinned to, and the words every view and MCP use. The numbers themselves are the worker's
 * (apps/worker `pathtrace/daylight.ts`): path-traced irradiance gathers over the same scene the
 * stills draw (FLR-ADR-055; docs/daylight.md for its accuracy).
 *
 * Isomorphic (FLR-ADR-010) and deterministic. Advisory, always (FLR-ADR-011): a band says what the
 * light is like — never that a room passes or fails (the word FLR-ADR-011 forbids is never printed).
 */
import { grouped } from './format.js';

/** The work plane: 2′-6″ above the floor, a desk's height, where illuminance is reported. Metres. */
export const WORK_PLANE = 0.762;
/** The grid's pitch: one foot. Metres. */
export const GRID_SPACING = 0.3048;
/** Paths gathered at each point of the grid. */
export const DAYLIGHT_SAMPLES = 64;
/** Every how many minutes the sun is looked for on the chosen day: sun-hours today and glare hours. */
export const DAY_STEP_MINUTES = 10;
/** The sun below this altitude (degrees) during a glare's hours is a low sun — in the eyes as well as on the desk. */
export const LOW_SUN = 20;

/** The four bands of illuminance on the work plane, brightest first (the legend's order). */
export type DaylightBand = 'bright' | 'useful' | 'lamp' | 'dim';

export interface BandInfo<B extends string> {
  readonly id: B;
  /** "Useful daylight". */
  readonly label: string;
  /** "300–3,000 lx". */
  readonly range: string;
  /** Inclusive lower bound, exclusive upper (the top band's upper is Infinity). */
  readonly min: number;
  readonly max: number;
}

/**
 * Owner-facing bands, not a rainbow: under 100 lx is dim, 100–300 lx needs a lamp for tasks,
 * 300–3,000 lx is useful daylight, and over 3,000 lx is bright enough that glare is likely — the
 * ranges of useful daylight illuminance (Nabil and Mardaljevic, 2005), named for what they mean.
 */
export const DAYLIGHT_BANDS: readonly BandInfo<DaylightBand>[] = [
  { id: 'bright', label: 'Bright — glare likely', range: 'over 3,000 lx', min: 3000, max: Infinity },
  { id: 'useful', label: 'Useful daylight', range: '300–3,000 lx', min: 300, max: 3000 },
  { id: 'lamp', label: 'Needs a lamp for tasks', range: '100–300 lx', min: 100, max: 300 },
  { id: 'dim', label: 'Dim', range: 'under 100 lx', min: 0, max: 100 },
];

/** The band an illuminance (lux) is in. Exactly 3,000 lx is still useful; exactly 300 is useful; exactly 100 needs a lamp. */
export function bandOf(lux: number): DaylightBand {
  if (lux > 3000) return 'bright';
  if (lux >= 300) return 'useful';
  if (lux >= 100) return 'lamp';
  return 'dim';
}

/** Sun-hours over a year on a spot of floor, in four bands too: the same four colours, sunniest first. */
export type SunBand = 'lots' | 'some' | 'little' | 'none';

export const SUN_BANDS: readonly BandInfo<SunBand>[] = [
  { id: 'lots', label: 'Sun most days', range: 'over 1,000 h a year', min: 1000, max: Infinity },
  { id: 'some', label: 'Some sun', range: '250–1,000 h', min: 250, max: 1000 },
  { id: 'little', label: 'A little sun', range: '1–250 h', min: 1, max: 250 },
  { id: 'none', label: 'No direct sun', range: 'none', min: 0, max: 1 },
];

export function sunBandOf(hours: number): SunBand {
  if (hours > 1000) return 'lots';
  if (hours >= 250) return 'some';
  if (hours >= 1) return 'little';
  return 'none';
}

/** The sun-hours bands drawn in the illuminance bands' colours, rank for rank. */
export const SUN_BAND_COLOUR: Readonly<Record<SunBand, DaylightBand>> = { lots: 'bright', some: 'useful', little: 'lamp', none: 'dim' };

/** What the panel and every answer say first (FLR-ADR-011). */
export const DAYLIGHT_ADVISORY = 'Advisory, not a compliance check.';
/** And then. */
export const DAYLIGHT_NOTE = 'A simulation of this model under a standard sky — real light depends on trees, neighbours, blinds and the glass itself. It describes the light; it never passes or fails a room.';

// ─── The sun-hours schedule ──────────────────────────────────────────────────────────────────

/** The days a year of sun-hours is sampled on: the 21st of every month, each standing for its month's days. */
export const YEAR_DAYS: readonly { readonly month: number; readonly day: 21; readonly days: number }[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map((days, i) => ({ month: i + 1, day: 21 as const, days }));

/** `YYYY-MM-DD` of the 21st of a month. */
export const dateOf21 = (year: number, month: number): string => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-21`;

// ─── Glare: desks and beds ───────────────────────────────────────────────────────────────────

/** A work or sleep surface a glare flag can be pinned to (FS_furniture `desk` and `bed`). */
export interface GlareZone {
  /** The FS_furniture piece's ID. */
  readonly id: string;
  readonly name: string;
  readonly kind: 'desk' | 'bed';
  readonly room?: string;
  readonly level?: string;
  /** The zone in plan: four corners, metres, the document's frame (x east, y north). */
  readonly corners: readonly (readonly [number, number])[];
  /** Its height above the piece's base, metres: a desk's top, a pillow on a mattress. */
  readonly height: number;
}

const UNITS = 1_280_000;
/** How far into a bed from its head end the pillows lie, metres; and at most this share of its length. */
const PILLOW = 0.6;
/** A mattress's top above the floor, metres, when the bed's box is taller (a headboard). */
const MATTRESS = 0.55;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const vec = (v: unknown): number[] | null => (Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null);

/**
 * The desks' tops and the beds' pillow ends in a document: each FS_furniture piece of category
 * `desk` or `bed` placed by a position and a rotation (Core 12.6's fallback box in its own frame —
 * +x from its back, or a bed's head, to its front or foot). A desk's whole top, 5 cm in from its
 * edges; a bed's first 60 cm from the headboard (at most 30% of its length), 10 cm in from its sides,
 * at the mattress's top.
 */
export function glareZones(document: unknown): GlareZone[] {
  if (!isObject(document)) return [];
  const ext = isObject(document['extensions']) ? document['extensions'] : {};
  const furniture = isObject(ext['FS_furniture']) ? ext['FS_furniture'] : {};
  const collections = isObject(furniture['collections']) ? furniture['collections'] : {};
  const pieces = isObject(collections['pieces']) ? collections['pieces'] : {};
  const out: GlareZone[] = [];
  for (const id of Object.keys(pieces).sort()) {
    const p = pieces[id];
    if (!isObject(p)) continue;
    const kind = p['category'];
    if (kind !== 'desk' && kind !== 'bed') continue;
    const host = isObject(p['host']) ? p['host'] : {};
    const fallback = isObject(p['fallback']) ? p['fallback'] : {};
    const box = isObject(fallback['box']) ? fallback['box'] : {};
    const pos = vec(host['position']);
    const min = vec(box['min']);
    const max = vec(box['max']);
    if (pos === null || pos.length < 2 || min === null || max === null || min.length < 3 || max.length < 3) continue;
    const turn = typeof host['rotation'] === 'number' ? (host['rotation'] / 1e6) * (Math.PI / 180) : 0;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const m = (u: number): number => u / UNITS;
    let x0 = m(min[0]!), x1 = m(max[0]!), y0 = m(min[1]!), y1 = m(max[1]!);
    let height: number;
    if (kind === 'desk') {
      const inset = Math.min(0.05, (x1 - x0) / 4, (y1 - y0) / 4);
      x0 += inset; x1 -= inset; y0 += inset; y1 -= inset;
      height = m(max[2]!);
    } else {
      x1 = x0 + Math.min(PILLOW, 0.3 * (x1 - x0));
      const inset = Math.min(0.1, (y1 - y0) / 4);
      y0 += inset; y1 -= inset;
      height = Math.min(m(max[2]!), MATTRESS);
    }
    const at = (lx: number, ly: number): [number, number] => [m(pos[0]!) + c * lx - s * ly, m(pos[1]!) + s * lx + c * ly];
    const level = typeof fallback['level'] === 'string' ? fallback['level'] : undefined;
    const room = typeof host['room'] === 'string' ? host['room'] : undefined;
    const name = typeof p['name'] === 'string' && p['name'].trim() !== '' ? p['name'] : kind === 'desk' ? 'Desk' : 'Bed';
    out.push({ id, name, kind, ...(room === undefined ? {} : { room }), ...(level === undefined ? {} : { level }), corners: [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)], height });
  }
  return out;
}

// ─── What a study is ─────────────────────────────────────────────────────────────────────────

/**
 * One level's grid on the work plane: `columns` × `rows` cells of `spacing` metres from `origin`
 * (the south-west corner, metres, the document's frame), row 0 the southernmost, cells row by row.
 * A cell outside every room holds −1.
 */
export interface DaylightGrid {
  readonly level: string;
  readonly origin: readonly [number, number];
  readonly spacing: number;
  readonly columns: number;
  readonly rows: number;
  /** The highest floor top of the level's rooms, metres above the document's datum: where an overlay is drawn. */
  readonly elevation: number;
  /** Illuminance on the work plane at the chosen time, lux, whole numbers. */
  readonly lux: readonly number[];
  /** Hours of direct sun on the work plane that day, tenths. */
  readonly sunToday: readonly number[];
  /** Hours of direct sun on the work plane in a year, whole hours. */
  readonly sunYear: readonly number[];
}

/** An hour range of the day, minutes after the site's midnight: [from, to). */
export interface HourRange {
  readonly from: number;
  readonly to: number;
}

export interface DaylightRoom {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  /** Grid cells in it. */
  readonly cells: number;
  /** The median and mean illuminance on its work plane, lux. */
  readonly median: number;
  readonly mean: number;
  /** The share of its work plane in each band, 0–1. */
  readonly shares: Readonly<Record<DaylightBand, number>>;
  /** Hours that day, and in a year, with direct sun somewhere on its work plane. */
  readonly sunToday: number;
  readonly sunYear: number;
}

export interface GlareFlag {
  readonly id: string;
  readonly name: string;
  readonly kind: 'desk' | 'bed';
  readonly room?: string;
  readonly roomName?: string;
  readonly level: string;
  /** Where the flag is pinned: the zone's middle, metres, the document's frame; and its height above the datum. */
  readonly at: readonly [number, number];
  readonly z: number;
  /** When direct sun reaches the zone that day. */
  readonly hours: readonly HourRange[];
  /** Direct sun on it at the chosen time. */
  readonly now: boolean;
  /** The sun is low (under LOW_SUN) for most of those hours. */
  readonly low: boolean;
}

export interface DaylightStudy {
  /** The time studied, as the site's clock reads it: `2026-06-21T15:00`, and the offset (minutes east of UTC) it was read in. */
  readonly at: string;
  readonly offset: number;
  readonly sky: 'clear' | 'overcast';
  /** The sun's place (degrees, true azimuth), or null when it is down. */
  readonly sun: { readonly azimuth: number; readonly altitude: number } | null;
  readonly site: { readonly latitude: number; readonly longitude: number; readonly assumed: boolean };
  /** Lux on a level surface outside, in the open: sky and sun. */
  readonly outside: { readonly sky: number; readonly sun: number };
  readonly workPlane: number;
  readonly spacing: number;
  readonly samples: number;
  readonly levels: readonly DaylightGrid[];
  readonly rooms: readonly DaylightRoom[];
  readonly glare: readonly GlareFlag[];
  readonly advisory: string;
  readonly ms: number;
}

/** The median of some numbers (0 for none). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The share of some illuminances in each band. */
export function bandShares(values: readonly number[]): Record<DaylightBand, number> {
  const out: Record<DaylightBand, number> = { bright: 0, useful: 0, lamp: 0, dim: 0 };
  if (values.length === 0) return out;
  for (const v of values) out[bandOf(v)] += 1;
  for (const b of Object.keys(out) as DaylightBand[]) out[b] /= values.length;
  return out;
}

/**
 * Runs of sampled moments: each moment `stepMinutes` long from its own minute — merged where they
 * touch, so ten-minute samples at 15:10, 15:20 … 16:30 are 15:10–16:40.
 */
export function hourRanges(minutes: readonly number[], stepMinutes = DAY_STEP_MINUTES): HourRange[] {
  const sorted = [...minutes].sort((a, b) => a - b);
  const out: { from: number; to: number }[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && m <= last.to) last.to = Math.max(last.to, m + stepMinutes);
    else out.push({ from: m, to: m + stepMinutes });
  }
  return out;
}

const clock = (minutes: number): { h: number; m: number; pm: boolean } => {
  const t = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  return { h: h % 12 === 0 ? 12 : h % 12, m: t % 60, pm: h >= 12 };
};

/** "3:00 pm". */
export function clockText(minutes: number): string {
  const c = clock(minutes);
  return `${String(c.h)}:${String(c.m).padStart(2, '0')} ${c.pm ? 'pm' : 'am'}`;
}

/** "3:10–4:40 pm", "11:50 am–12:30 pm": the am/pm once when both ends share it. */
export function rangeText(r: HourRange): string {
  const a = clock(r.from);
  const b = clock(r.to);
  const hm = (c: { h: number; m: number }) => `${String(c.h)}:${String(c.m).padStart(2, '0')}`;
  return a.pm === b.pm ? `${hm(a)}–${hm(b)} ${b.pm ? 'pm' : 'am'}` : `${hm(a)} ${a.pm ? 'pm' : 'am'}–${hm(b)} ${b.pm ? 'pm' : 'am'}`;
}

/** A glare flag's words: "Den desk · sun 3:10–4:40 pm", "low sun" when the sun is low. */
export function glareText(flag: GlareFlag, place?: string): string {
  const who = place === undefined || place === '' ? flag.name : `${place} ${flag.kind}`;
  return `${who} · ${flag.low ? 'low sun' : 'sun'} ${flag.hours.map(rangeText).join(', ')}`;
}

const pct = (x: number): string => `${String(Math.round(x * 100))} %`;

/**
 * A study in words, for MCP and the API's text form: when and under what sky, then each room — its
 * median, its shares by band, its sun-hours — and each glare flag. Advisory: it describes the
 * light, and never says a room passes or fails anything.
 */
export function describeDaylight(study: DaylightStudy, rooms?: readonly string[]): string {
  const lines: string[] = [];
  const [date = '', time = '00:00'] = study.at.split('T');
  const [h = 0, m = 0] = time.split(':').map(Number);
  const o = Math.abs(study.offset);
  const zone = `UTC${study.offset < 0 ? '−' : '+'}${String(Math.floor(o / 60)).padStart(2, '0')}:${String(o % 60).padStart(2, '0')}`;
  lines.push(`Daylight on ${date} at ${clockText(h * 60 + m)} (${zone} at the site), ${study.sky} sky. ${DAYLIGHT_ADVISORY}`);
  lines.push(study.sun === null ? 'The sun is down.' : `The sun is ${String(Math.round(study.sun.altitude))}° up at ${String(Math.round(study.sun.azimuth))}° (true). Outside, in the open: ${grouped(study.outside.sky + study.outside.sun)} lx.`);
  if (study.site.assumed) lines.push('The model records no location: the site is assumed at 40° N, 75° W.');
  lines.push(`Illuminance on the work plane, ${String(Math.round(study.workPlane * 1000))} mm (2′-6″) above each floor, in four bands: ${DAYLIGHT_BANDS.map((b) => `${b.label} ${b.range}`).join('; ')}.`);
  const wanted = rooms === undefined ? null : new Set(rooms);
  for (const r of study.rooms) {
    if (wanted !== null && !wanted.has(r.id) && !(r.name !== undefined && wanted.has(r.name))) continue;
    const shares = DAYLIGHT_BANDS.filter((b) => r.shares[b.id] > 0).map((b) => `${pct(r.shares[b.id])} ${b.label.toLowerCase()}`).join(', ');
    lines.push(`- ${r.name ?? r.id} (${r.id}, ${r.level}): median ${grouped(r.median)} lx; ${shares}; sun on the floor ${r.sunToday.toFixed(1)} h that day, ${grouped(r.sunYear)} h a year.`);
  }
  if (study.glare.length === 0) lines.push('Glare: no direct sun reaches a desk or a bed that day.');
  for (const g of study.glare) {
    if (wanted !== null && g.room !== undefined && !wanted.has(g.room) && !(g.roomName !== undefined && wanted.has(g.roomName))) continue;
    lines.push(`- Glare: ${g.name} (${g.id}${g.roomName === undefined ? '' : `, ${g.roomName}`}) — ${g.low ? 'low ' : ''}sun ${g.hours.map(rangeText).join(', ')}${g.now ? ', including the time studied' : ''}.`);
  }
  lines.push(DAYLIGHT_NOTE);
  return lines.join('\n');
}
