import { useEffect, useSyncExternalStore } from 'react';
import type { DaylightStudy } from '@floorspec/analysis';
import { useEditor, type EditorStore } from '../store';
import { sunOf, useSunState } from '../three/sun/study';
import { browserOffset, parseDate, type Clock } from '../three/sun/clock';

/**
 * Daylight you can see (FLR-T-14.7): the editor's daylight study, beside the 3D view's state and like
 * it one per editor. Whether it shows (on the plan and in 3D), whether its panel is open over the 3D
 * view, what it shows (illuminance, or a year of sun-hours), the sky, the glare flags, and the June
 * versus December comparison — and the study itself, fetched from the api (`GET /daylight`, path-traced
 * by the worker) for the version shown, at the sun study's clock: one clock, so the sun drawn in 3D
 * and the light studied are the same sun. View state: nothing here is written to the document.
 */

export type DaylightMeasure = 'illuminance' | 'sunHours';
export type DaylightSky = 'clear' | 'overcast';

/** A study with the version it answers. */
export type Study = DaylightStudy & { readonly head: string; readonly hash: string };

export interface DaylightState {
  /** The overlay, the legend and the glare flags show — on the plan and in 3D. */
  on: boolean;
  /** The Daylight panel is open over the 3D view. */
  open: boolean;
  measure: DaylightMeasure;
  sky: DaylightSky;
  /** Glare flags at desks and beds. */
  glare: boolean;
  /** The other solstice's afternoon beside this one: June against December. */
  compare: boolean;
  /** The day playing, an hour at a time, each hour studied before the next. */
  playing: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  study: Study | null;
  /** The comparison's study, at the same time on the other solstice. */
  other: Study | null;
}

const INITIAL: DaylightState = { on: false, open: false, measure: 'illuminance', sky: 'clear', glare: true, compare: false, playing: false, status: 'idle', error: null, study: null, other: null };

export class DaylightStore {
  private state: DaylightState = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** Studies already made, by what they answer: a version, a time, a sky, a design. */
  readonly cache = new Map<string, Study>();

  get = (): DaylightState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<DaylightState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** On or off; off closes the panel too. */
  toggle(on: boolean = !this.state.on): void {
    this.set(on ? { on: true } : { on: false, open: false, compare: false, playing: false });
  }
}

const stores = new WeakMap<EditorStore, DaylightStore>();

export function daylightOf(store: EditorStore): DaylightStore {
  let d = stores.get(store);
  if (d === undefined) {
    d = new DaylightStore();
    stores.set(store, d);
  }
  return d;
}

export function useDaylight<T>(store: EditorStore, selector: (s: DaylightState) => T): T {
  const d = daylightOf(store);
  return useSyncExternalStore(d.subscribe, () => selector(d.get()), () => selector(d.get()));
}

// ─── The clock, as the api reads it ──────────────────────────────────────────────────────────

const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');

/** `2026-06-21T15:00-04:00`: the sun study's clock with the offset it is read in, as `at` takes it. */
export function atOf(clock: Clock): string {
  const offset = clock.offset === 'auto' ? browserOffset(clock.date) : clock.offset;
  const m = Math.round(clock.minutes) % 1440;
  return `${clock.date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** The other solstice in the clock's year: December 21 for a date from April to September, else June 21. */
export function otherSolstice(date: string): string {
  const p = parseDate(date);
  const year = p?.y ?? 2026;
  const summer = p !== null && p.m >= 4 && p.m <= 9;
  return `${String(year).padStart(4, '0')}-${summer ? '12' : '06'}-21`;
}

/** The days the panel offers: the equinoxes and solstices as an owner names them. */
export const DAYS: readonly { readonly label: string; readonly month: number; readonly day: number }[] = [
  { label: 'Mar 20', month: 3, day: 20 },
  { label: 'Jun 21', month: 6, day: 21 },
  { label: 'Sep 22', month: 9, day: 22 },
  { label: 'Dec 21', month: 12, day: 21 },
];

export function dayIn(date: string, month: number, day: number): string {
  const year = parseDate(date)?.y ?? 2026;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

// ─── Fetching ────────────────────────────────────────────────────────────────────────────────

/** What the api says when it cannot make a study, in words. */
async function failure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; title?: string; detail?: string };
    return body.detail ?? body.title ?? body.error ?? `the server answered ${String(res.status)}`;
  } catch {
    return `the server answered ${String(res.status)}`;
  }
}

export async function fetchDaylight(projectId: string, q: { at: string; sky: DaylightSky; design: Record<string, string> }, signal: AbortSignal): Promise<Study> {
  const params = new URLSearchParams({ at: q.at, sky: q.sky });
  if (Object.keys(q.design).length > 0) params.set('design', JSON.stringify(q.design));
  const res = await fetch(`/api/projects/${projectId}/daylight?${params.toString()}`, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(await failure(res));
  return (await res.json()) as Study;
}

/** How long the clock rests before the study is asked for: a slider dragged asks once. */
const SETTLE_MS = 350;

/**
 * Keep the study in step with the version shown, the sun study's clock, the sky and the design,
 * while daylight is on — and the comparison's study while it is asked for. Mounted once per editor.
 */
export function useDaylightSync(store: EditorStore): void {
  const d = daylightOf(store);
  const on = useDaylight(store, (s) => s.on);
  const sky = useDaylight(store, (s) => s.sky);
  const compare = useDaylight(store, (s) => s.compare);
  const hash = useEditor(store, (s) => s.model?.hash ?? null);
  const design = useEditor(store, (s) => s.design);
  const clock = useSunState(store, (s) => s.clock);
  const at = atOf(clock);
  const otherAt = atOf({ ...clock, date: otherSolstice(clock.date) });
  const designKey = JSON.stringify(design);
  useEffect(() => {
    if (!on || hash === null) return;
    const key = (when: string) => `${hash}|${designKey}|${when}|${sky}`;
    const hit = d.cache.get(key(at));
    const otherHit = compare ? d.cache.get(key(otherAt)) : null;
    if (hit !== undefined && (otherHit === null || otherHit !== undefined)) {
      d.set({ status: 'ready', error: null, study: hit, other: otherHit ?? null });
      return;
    }
    d.set({ status: 'loading', error: null, ...(hit === undefined ? {} : { study: hit }) });
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      const want = (when: string): Promise<Study> => {
        const cached = d.cache.get(key(when));
        if (cached !== undefined) return Promise.resolve(cached);
        return fetchDaylight(store.projectId, { at: when, sky, design: JSON.parse(designKey) as Record<string, string> }, abort.signal).then((s) => {
          d.cache.set(key(when), s);
          return s;
        });
      };
      Promise.all([want(at), compare ? want(otherAt) : Promise.resolve(null)])
        .then(([study, other]) => { d.set({ status: 'ready', error: null, study, other }); })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          d.set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
        });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [d, store, on, hash, designKey, at, otherAt, sky, compare]);
}

/** Turn daylight on at a day of the year, at the sun study's time (the board's Jun 21, 3:00 pm). */
export function showDaylightAt(store: EditorStore, date: string, minutes?: number): void {
  sunOf(store).setClock({ date, ...(minutes === undefined ? {} : { minutes }) });
  daylightOf(store).toggle(true);
}
