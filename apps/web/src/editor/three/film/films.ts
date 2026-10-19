import { FILM_MAX_MS, FILMS_PATH, filmDuration, filmRecord, filmShots, filmsOf, nextFilmId, toUnits, UNITS_PER_METRE, type Ease, type Film, type FilmCamera, type FilmKey, type FilmShot, type SavedView } from '@floorspec/mesh';
import { useSyncExternalStore } from 'react';
import type { Batch } from '../../ops';
import type { EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { orbitOfView } from '../shot/lens';
import type { Orbit } from '../camera';
import type { ExportJob, FilmLight } from '../../../exports/api';

/**
 * Films in the editor (FLR-T-14.1, FLR-ADR-051): the document's camera paths — kept in its extras at
 * `/extras/d3floorspec/films`, every change a `setProperty $document`, so a film is undone and
 * versioned like the house — and the editor's own state round one: whether its timeline is open,
 * where the playhead is, whether it plays, the light the render dialog last chose, and the film job
 * the server is rendering.
 */

/** The document's films, in ID order. */
export const filmsOfModel = (model: EditorModel): Film[] => filmsOf(model.document);

/** The film the timeline edits: the first the document keeps. */
export const theFilm = (model: EditorModel): Film | null => filmsOfModel(model)[0] ?? null;

/** How far apart a new keyframe is put after the last one, ms. */
export const KEY_GAP_MS = 5000;

/** Save a film whole. */
export const saveFilm = (id: string, film: Omit<Film, 'id'>): Batch => [{ op: 'setProperty', id: '$document', path: `${FILMS_PATH}/${id}`, value: filmRecord(film) }] as Batch;

export const deleteFilm = (id: string): Batch => [{ op: 'unsetProperty', id: '$document', path: `${FILMS_PATH}/${id}` }] as Batch;

/** A film's keys with one replaced, in time order. */
export function withKey(film: Pick<Film, 'keys'>, index: number, key: FilmKey): FilmKey[] {
  return film.keys.map((k, i) => (i === index ? key : k)).sort((a, b) => a.at - b.at);
}

/** A film's keys with one added after the last, `KEY_GAP_MS` on (the first at 0). */
export function appended(film: Pick<Film, 'keys'> | null, key: Omit<FilmKey, 'at'>): FilmKey[] {
  const keys = film?.keys ?? [];
  const end = keys.length === 0 ? 0 : Math.min(FILM_MAX_MS, filmDuration({ keys }) + KEY_GAP_MS);
  return [...keys, { ...key, at: end }];
}

/** The new film's record, or the existing film's with its keys changed: the Ops that save it. */
export function saveKeys(model: EditorModel, film: Film | null, keys: readonly FilmKey[], name?: string): { id: string; batch: Batch } {
  const id = film?.id ?? nextFilmId((x) => filmsOfModel(model).some((f) => f.id === x));
  return { id, batch: saveFilm(id, { name: name ?? film?.name ?? 'Walk-through', keys }) };
}

/** A keyframe's time, clamped and kept clear of its neighbours' holds. */
export function retimed(film: Pick<Film, 'keys'>, index: number, at: number): number {
  const before = film.keys[index - 1];
  const after = film.keys[index + 1];
  const k = film.keys[index];
  const lo = before === undefined ? 0 : before.at + before.hold + 100;
  const hi = after === undefined ? FILM_MAX_MS - (k?.hold ?? 0) : after.at - (k?.hold ?? 0) - 100;
  return Math.round(Math.min(hi, Math.max(lo, at)) / 100) * 100;
}

/** The ease label between two keys, as the board writes it: "Ease", "Hold 2 s · Linear". */
export function segmentWords(from: FilmKey, to: FilmKey, labels: Readonly<Record<Ease, string>>): string {
  return from.hold > 0 ? `Hold ${trimSeconds(from.hold)} s · ${labels[to.ease]}` : labels[to.ease];
}

/** "2", "2.5": seconds without trailing zeros. */
export const trimSeconds = (ms: number): string => String(Math.round(ms / 100) / 10);

/** The 3D view's orbit for a film's camera: metres about the mesh's origin (base units). */
export function orbitOfFilm(camera: Pick<FilmCamera, 'eye' | 'target'>, origin: readonly [number, number, number]): Orbit {
  const m = (p: readonly [number, number, number]): [number, number, number] => [(p[0] - origin[0]) / UNITS_PER_METRE, (p[1] - origin[1]) / UNITS_PER_METRE, (p[2] - origin[2]) / UNITS_PER_METRE];
  return orbitOfView(m(camera.eye), m(camera.target));
}

/** A recorded camera, metres about the origin, as a keyframe's (base units). */
export function recordedKey(eye: readonly [number, number, number], target: readonly [number, number, number], origin: readonly [number, number, number], focalLength: number, name?: string): Omit<FilmKey, 'at'> {
  const o: [number, number, number] = [origin[0] / UNITS_PER_METRE, origin[1] / UNITS_PER_METRE, origin[2] / UNITS_PER_METRE];
  return { ease: 'linear', hold: 0, eye: toUnits(eye, o), target: toUnits(target, o), focalLength: Math.round(focalLength), ...(name === undefined ? {} : { name }) };
}

/** A keyframe's label: its own name, its view's, or "Walk n". */
export function keyLabel(key: FilmKey, index: number, views: readonly SavedView[]): string {
  return key.name ?? (key.view === undefined ? `Walk ${String(index + 1)}` : (views.find((v) => v.id === key.view)?.name ?? `${key.view} (missing)`));
}

/** The shots the timeline plays: every key whose view the document has. */
export const shotsOf = (film: Pick<Film, 'keys'>, views: readonly SavedView[]): FilmShot[] => filmShots(film, views).shots;

/**
 * Thin a recorded walk: a sample kept when the camera has moved or turned since the last kept one,
 * so standing still for a while makes one keyframe, not twenty.
 */
export function thinWalk<T extends { eye: readonly [number, number, number]; target: readonly [number, number, number] }>(samples: readonly T[], metres = 0.15): T[] {
  const out: T[] = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push(s);
      continue;
    }
    const moved = Math.hypot(s.eye[0] - last.eye[0], s.eye[1] - last.eye[1], s.eye[2] - last.eye[2]);
    const turned = Math.hypot(s.target[0] - last.target[0], s.target[1] - last.target[1], s.target[2] - last.target[2]);
    if (moved >= metres || turned >= metres * 2) out.push(s);
  }
  const end = samples[samples.length - 1];
  if (end !== undefined && out[out.length - 1] !== end) out.push(end);
  return out;
}

// ─── The editor's film state ───────────────────────────────────────────────────────────────

export interface FilmState {
  /** The timeline is open. */
  open: boolean;
  /** The playhead, ms. */
  time: number;
  playing: boolean;
  loop: boolean;
  /** The keyframe being edited (its index), whose popover is open. */
  selected: number | null;
  /** Recording a walk: when it began (ms, performance clock), or null. */
  recording: number | null;
  /** The light the render dialog last chose: the sun track shows it. */
  light: FilmLight;
  /** The day-to-night clocks last chosen. */
  timelapse: { date: string; from: string; to: string; lightsAtDusk: boolean } | null;
  /** The render dialog is open. */
  dialog: boolean;
  /** The film job the server is rendering or has rendered, and whether its card is folded away. */
  job: ExportJob | null;
  folded: boolean;
}

export class FilmStore {
  private state: FilmState = { open: false, time: 0, playing: false, loop: false, selected: null, recording: null, light: 'timeline', timelapse: null, dialog: false, job: null, folded: false };
  private readonly listeners = new Set<() => void>();
  get = (): FilmState => this.state;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<FilmState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const stores = new WeakMap<EditorStore, FilmStore>();

/** The film state of an editor: one per editor store. */
export function filmOf(store: EditorStore): FilmStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new FilmStore();
    stores.set(store, s);
  }
  return s;
}

export function useFilmState<T>(store: EditorStore, selector: (s: FilmState) => T): T {
  const film = filmOf(store);
  return useSyncExternalStore(film.subscribe, () => selector(film.get()));
}
