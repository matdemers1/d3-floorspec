/**
 * Films (FLR-T-14.1): a camera path through the house — keyframes, each a saved view (FS_views) or
 * a camera recorded on a walk, reached at a time with an easing and held there a while — and the
 * camera every renderer takes at any moment of it: the editor's timeline as it plays, the worker's
 * frames as it renders them.
 *
 * A film is the owner's, kept in the document as application data (Core 1.7 `extras`, beside the
 * project's units: `extras.d3floorspec.films`, FLR-ADR-051) and edited with `setProperty $document`
 * like any change: undone, versioned, and readable by an agent, without a change to the standard.
 * Nothing derived from the building reads it.
 *
 * The path goes through every keyframe's eye and target on a centripetal Catmull–Rom spline, which
 * never loops or overshoots between keys however unevenly they are spaced; time runs along each
 * segment as its easing says — linear, eased in and out, or held (a cut: the camera stays where it
 * was until the moment it arrives). A key's `hold` keeps the camera still there before it leaves.
 * The focal length is interpolated geometrically, so a zoom feels even.
 */
import type { FloorspecDocument } from '@floorspec/engine';
import type { SavedView, ViewLevels } from './views.js';
import { FOCAL_MAX, FOCAL_MIN, EXPOSURE_MAX, EXPOSURE_MIN } from './views.js';

/** Where films are kept, as a JSON Pointer relative to `$document`. */
export const FILMS_PATH = '/extras/d3floorspec/films';

export const EASES = ['linear', 'ease', 'hold'] as const;
export type Ease = (typeof EASES)[number];
export const EASE_LABELS: Readonly<Record<Ease, string>> = { linear: 'Linear', ease: 'Ease', hold: 'Hold' };

/** A film's bounds: at least a second, at most two minutes, and as many keyframes as a recorded walk needs. */
export const FILM_MIN_MS = 1000;
export const FILM_MAX_MS = 120_000;
export const MAX_FILM_KEYS = 240;
/** A recorded camera's lens when none is given. */
export const RECORDED_FOCAL = 24;

type V3 = readonly [number, number, number];

/** One keyframe, as a film keeps it. Lengths are base units (1/1280 mm); times are milliseconds from the film's start. */
export interface FilmKey {
  /** When the camera arrives. */
  readonly at: number;
  /** How it gets here from the keyframe before (the first key's is never used). */
  readonly ease: Ease;
  /** How long it stays before it leaves, ms. */
  readonly hold: number;
  /** A saved view, by its ID: its camera, lens and cutaway. */
  readonly view?: string;
  /** A camera of its own — a walk's — when there is no view. */
  readonly eye?: V3;
  readonly target?: V3;
  readonly focalLength?: number;
  /** What a recorded keyframe is called. */
  readonly name?: string;
}

export interface Film {
  readonly id: string;
  readonly name: string;
  /** In time order. */
  readonly keys: readonly FilmKey[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= FILM_MAX_MS;

/** The films' records in the document's extras, or an empty object. */
export function filmsData(doc: FloorspecDocument | object): Record<string, Json> {
  const extras = (doc as { extras?: unknown }).extras;
  const ours = isObject(extras) ? extras['d3floorspec'] : undefined;
  const films = isObject(ours) ? ours['films'] : undefined;
  return isObject(films) ? (films as Record<string, Json>) : {};
}

/** One keyframe's record, read with its defaults; undefined when it is not one. */
export function readFilmKey(raw: unknown): FilmKey | undefined {
  if (!isObject(raw) || !isTime(raw['at'])) return undefined;
  const ease: Ease = typeof raw['ease'] === 'string' && (EASES as readonly string[]).includes(raw['ease']) ? (raw['ease'] as Ease) : 'ease';
  const hold = isTime(raw['hold']) ? raw['hold'] : 0;
  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'].slice(0, 200) : undefined;
  if (typeof raw['view'] === 'string' && raw['view'] !== '') return { at: raw['at'], ease, hold, view: raw['view'], ...(name === undefined ? {} : { name }) };
  if (!isPoint(raw['eye']) || !isPoint(raw['target'])) return undefined;
  const f = raw['focalLength'];
  const focalLength = typeof f === 'number' && Number.isFinite(f) && f >= FOCAL_MIN && f <= FOCAL_MAX ? f : RECORDED_FOCAL;
  return { at: raw['at'], ease, hold, eye: [raw['eye'][0], raw['eye'][1], raw['eye'][2]], target: [raw['target'][0], raw['target'][1], raw['target'][2]], focalLength, ...(name === undefined ? {} : { name }) };
}

/** One film's record, read; undefined when it is not one (a reader reads what it can). */
export function readFilm(id: string, raw: unknown): Film | undefined {
  if (!isObject(raw) || typeof raw['name'] !== 'string' || !Array.isArray(raw['keys'])) return undefined;
  const keys = raw['keys']
    .slice(0, MAX_FILM_KEYS)
    .flatMap((k) => readFilmKey(k) ?? [])
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.at - b.k.at || a.i - b.i)
    .map(({ k }) => k);
  return { id, name: raw['name'], keys };
}

/** The document's films, in ID order. */
export function filmsOf(doc: FloorspecDocument | object): Film[] {
  return Object.entries(filmsData(doc))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([id, f]) => readFilm(id, f) ?? []);
}

/** A film by its ID or its name — exactly, then ignoring case. */
export function filmNamed(doc: FloorspecDocument | object, key: string): Film | undefined {
  const films = filmsOf(doc);
  const k = key.trim();
  return films.find((f) => f.id === k) ?? films.find((f) => f.name === k) ?? films.find((f) => f.name.toLowerCase() === k.toLowerCase());
}

/** A free ID for a new film: F1, F2, … */
export function nextFilmId(taken: (id: string) => boolean): string {
  for (let i = 1; ; i++) if (!taken(`F${String(i)}`)) return `F${String(i)}`;
}

/** The record a film is kept as: only what differs from its defaults. */
export function filmRecord(film: Omit<Film, 'id'>): Json {
  return {
    name: film.name,
    keys: film.keys.map((k) => ({
      at: Math.round(k.at),
      ...(k.ease === 'ease' ? {} : { ease: k.ease }),
      ...(k.hold > 0 ? { hold: Math.round(k.hold) } : {}),
      ...(k.view === undefined
        ? { eye: (k.eye ?? [0, 0, 0]).map(Math.round), target: (k.target ?? [0, 0, 0]).map(Math.round), ...(k.focalLength === undefined || k.focalLength === RECORDED_FOCAL ? {} : { focalLength: Math.round(k.focalLength) }) }
        : { view: k.view }),
      ...(k.name === undefined ? {} : { name: k.name }),
    })),
  };
}

/** How long a film runs, ms: to its last keyframe, and the hold there. */
export function filmDuration(film: Pick<Film, 'keys'>): number {
  const last = film.keys[film.keys.length - 1];
  return last === undefined ? 0 : last.at + last.hold;
}

/** How many frames a film is at a frame rate. */
export const filmFrameCount = (durationMs: number, fps: number): number => Math.max(1, Math.round((durationMs * fps) / 1000));

/** What is wrong with a film's timing, in words; null when nothing. */
export function filmProblem(film: Pick<Film, 'keys'>): string | null {
  if (film.keys.length < 2) return 'a film needs at least two keyframes';
  if (film.keys.length > MAX_FILM_KEYS) return `a film has at most ${String(MAX_FILM_KEYS)} keyframes`;
  const d = filmDuration(film);
  if (d < FILM_MIN_MS) return 'a film runs at least one second';
  if (d > FILM_MAX_MS) return `a film runs at most ${String(FILM_MAX_MS / 1000)} seconds`;
  for (let i = 1; i < film.keys.length; i++) {
    const a = film.keys[i - 1]!;
    const b = film.keys[i]!;
    if (b.at < a.at + a.hold) return `keyframe ${String(i + 1)} comes before keyframe ${String(i)} has finished holding`;
  }
  return null;
}

// ─── Easing ─────────────────────────────────────────────────────────────────────────────────

/** Time along a segment, 0–1, as its easing runs it: linear, eased in and out (smoothstep), or held until the end. */
export function ease(kind: Ease, u: number): number {
  const t = Math.min(1, Math.max(0, u));
  switch (kind) {
    case 'linear':
      return t;
    case 'ease':
      return t * t * (3 - 2 * t);
    case 'hold':
      return t >= 1 ? 1 : 0;
  }
}

// ─── The camera at a moment ─────────────────────────────────────────────────────────────────

/** A keyframe made a camera: its own, or its saved view's. Lengths are base units. */
export interface FilmShot {
  readonly at: number;
  readonly ease: Ease;
  readonly hold: number;
  readonly eye: V3;
  readonly target: V3;
  readonly focalLength: number;
  /** Tenths of a stop. */
  readonly exposure: number;
  readonly twoPoint: boolean;
  readonly level?: string;
  readonly levels: ViewLevels;
  /** The saved view it is, when it is one. */
  readonly view?: SavedView;
  readonly label: string;
}

/** A film's keyframes as cameras, and the saved views it names that the document does not have. */
export function filmShots(film: Pick<Film, 'keys'>, views: readonly SavedView[]): { shots: FilmShot[]; missing: string[] } {
  const missing: string[] = [];
  const shots: FilmShot[] = [];
  film.keys.forEach((k, i) => {
    const base = { at: k.at, ease: k.ease, hold: k.hold };
    if (k.view !== undefined) {
      const v = views.find((x) => x.id === k.view);
      if (v === undefined) {
        missing.push(k.view);
        return;
      }
      shots.push({ ...base, eye: v.eye, target: v.target, focalLength: v.focalLength, exposure: v.exposure, twoPoint: v.twoPoint, ...(v.level === undefined ? {} : { level: v.level }), levels: v.levels, view: v, label: k.name ?? v.name });
      return;
    }
    shots.push({ ...base, eye: k.eye ?? [0, 0, 0], target: k.target ?? [0, 0, 0], focalLength: k.focalLength ?? RECORDED_FOCAL, exposure: 0, twoPoint: false, levels: 'cutaway', label: k.name ?? `Walk ${String(i + 1)}` });
  });
  return { shots, missing };
}

/** The camera at a moment of a film. Lengths are base units, unrounded. */
export interface FilmCamera {
  readonly eye: [number, number, number];
  readonly target: [number, number, number];
  readonly focalLength: number;
  readonly exposure: number;
  readonly twoPoint: boolean;
  readonly level?: string;
  readonly levels: ViewLevels;
  /** The keyframe it is at, or the one it left; and how far it is towards the next (0 at a key). */
  readonly key: number;
  readonly towards: number;
  readonly label: string;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * A point on the centripetal Catmull–Rom segment from p1 to p2 (with p0 before and p3 after) at t,
 * 0–1: the Barry–Goldman pyramid with knots spaced by the square root of each chord.
 */
export function catmullRom(p0: V3, p1: V3, p2: V3, p3: V3, t: number): [number, number, number] {
  const knot = (a: V3, b: V3): number => Math.max(1e-9, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = lerp(t1, t2, t);
  const mix = (a: V3, b: V3, ta: number, tb: number): [number, number, number] => {
    const w = tb - ta < 1e-12 ? 0 : (u - ta) / (tb - ta);
    return [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
  };
  // A segment of zero length (the same point twice) stays put.
  if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) < 1e-9) return [p1[0], p1[1], p1[2]];
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** Extend past an end: the point a straight continuation would reach, so an end segment eases in and out without a kink. */
const beyond = (from: V3, to: V3): [number, number, number] => [2 * to[0] - from[0], 2 * to[1] - from[1], 2 * to[2] - from[2]];

/**
 * Where the camera is at `t` ms into a film of these shots: at a keyframe while it holds there, on
 * the spline between two keys as the second's easing runs, and at the first before it starts and the
 * last after it ends. A held segment is a cut: the spline does not reach across it.
 */
export function filmCameraAt(shots: readonly FilmShot[], t: number): FilmCamera {
  const first = shots[0];
  if (first === undefined) throw new RangeError('a film needs at least one keyframe');
  const at = (s: FilmShot, key: number): FilmCamera => ({
    eye: [s.eye[0], s.eye[1], s.eye[2]],
    target: [s.target[0], s.target[1], s.target[2]],
    focalLength: s.focalLength,
    exposure: s.exposure,
    twoPoint: s.twoPoint,
    ...(s.level === undefined ? {} : { level: s.level }),
    levels: s.levels,
    key,
    towards: 0,
    label: s.label,
  });
  if (t <= first.at + first.hold || shots.length === 1) return at(first, 0);
  for (let i = 0; i + 1 < shots.length; i++) {
    const a = shots[i]!;
    const b = shots[i + 1]!;
    const leave = a.at + a.hold;
    if (t <= leave) return at(a, i);
    if (t >= b.at) continue;
    const u = ease(b.ease, (t - leave) / Math.max(1, b.at - leave));
    if (u <= 0) return at(a, i);
    // The neighbours the spline bends through: none across a cut.
    const before = i > 0 && a.ease !== 'hold' ? shots[i - 1]! : null;
    const after = i + 2 < shots.length && shots[i + 2]!.ease !== 'hold' ? shots[i + 2]! : null;
    const path = (p: (s: FilmShot) => V3): [number, number, number] => catmullRom(before === null ? beyond(p(b), p(a)) : p(before), p(a), p(b), after === null ? beyond(p(a), p(b)) : p(after), u);
    const near = u < 0.5 ? a : b;
    return {
      eye: path((s) => s.eye),
      target: path((s) => s.target),
      focalLength: Math.exp(lerp(Math.log(a.focalLength), Math.log(b.focalLength), u)),
      exposure: Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, lerp(a.exposure, b.exposure, u))),
      twoPoint: a.twoPoint && b.twoPoint,
      ...(near.level === undefined ? {} : { level: near.level }),
      levels: near.levels,
      key: i,
      towards: u,
      label: `${a.label} → ${b.label}`,
    };
  }
  return at(shots[shots.length - 1]!, shots.length - 1);
}

/**
 * A film's camera as a saved view the renderers already take (`viewCamera`), in a 16:9 frame — a
 * video's. Its sky, time and lights are the film's, given apart.
 */
export function filmViewOf(camera: FilmCamera): SavedView {
  return {
    id: 'film',
    name: camera.label,
    eye: camera.eye,
    target: camera.target,
    focalLength: camera.focalLength,
    twoPoint: camera.twoPoint,
    aspect: '16:9',
    exposure: camera.exposure,
    ...(camera.level === undefined ? {} : { level: camera.level }),
    levels: camera.levels,
    sky: 'clear',
    lights: 'off',
  };
}

/** "0:30", "1:05": a film's length as the timeline shows it. */
export function filmClock(ms: number, tenths = false): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${String(m)}:${sec}`;
}
