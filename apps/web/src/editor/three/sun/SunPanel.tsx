import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, Select, Tooltip } from '@d3cloud/ui';
import { ChevronLeft, ChevronRight, Pause, Play, Sun, SunDim, Sunrise, X } from 'lucide-react';
import { SKY_LABELS, SKY_PRESETS, type SkyPreset } from '@floorspec/mesh/sky';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { Row } from '../../fields';
import { browserOffset, clockAt, formatDate, formatOffset, formatTime, formatTimeShort, nowIn, OFFSETS, parseDate, type Clock } from './clock';
import { compassPoint, seasonInstant, SEASONS, type Season, type SunDay } from './solar';
import { dayOf, placedSite, siteOf, studyOf, sunOf, useStudy, useSunState, type Site, type Study } from './study';
import { SiteFields } from './SiteFields';
import { formatDegrees } from './degrees';
import './sun.css';

/**
 * The sun and shadow study's controls (FLR-T-8.6, FLR-REQ-123): the toolbar's Sun button, the
 * panel it opens over the 3D view — the date with the solstices, the equinoxes and now, the time of
 * day as a slider that plays and steps, the offset the clock is read in, and the site's place — the
 * chip that stands for the panel when it is closed, and the inspector's "Shadows" row the board's
 * 08 frame draws ("Sun · Oct 4 · 3 pm").
 *
 * The sun's place is always written out — compass point, azimuth and altitude — for a person who
 * cannot see the shadows. Nothing plays unless a person presses Play; with reduced motion, play
 * steps a quarter-hour a second instead of sweeping.
 */

const STEP = 15;

function round(v: number): string {
  return String(Math.round(v));
}

/** `Clear day · Oct 4 · 3 pm`, `Dusk · Oct 4`, `Studio`: the chip's and the inspector's summary of the sky. */
export function skySummary(sky: SkyPreset, clock: Clock): string {
  if (sky === 'studio') return SKY_LABELS.studio;
  if (sky === 'dusk' || sky === 'night') return `${SKY_LABELS[sky]} · ${formatDate(clock.date)}`;
  return `${SKY_LABELS[sky]} · ${formatDate(clock.date)} · ${formatTimeShort(clock.minutes)}`;
}

/** The sun's place in words. */
export function describeSun(study: Study | null, site: Site): string {
  if (site.latitude === null || site.longitude === null) {
    const where = study === null ? '' : ` ${describeSun(study, { ...site, latitude: 0, longitude: 0 })}`;
    return `The site has no location yet, so the sun is placed as if at 40° N, 75° W: add its latitude and longitude for its own.${where}`;
  }
  if (study === null) return 'The sun is off.';
  const { azimuth, altitude } = study.position;
  const where = `azimuth ${round(azimuth)}° (${compassPoint(azimuth)})`;
  if (study.night) return `Night: the sun is ${round(-altitude)}° below the horizon, ${where}.`;
  return `Sun in the ${compassPoint(azimuth)}, ${round(altitude)}° above the horizon: ${where}, altitude ${altitude.toFixed(1)}°.`;
}

function describeDay(day: SunDay | null, offset: number): string | null {
  if (day === null) return null;
  const t = (ms: number) => formatTime(clockAt(ms, offset).minutes);
  if (day.always === 'up') return `The sun does not set · solar noon ${t(day.noon)}`;
  if (day.always === 'down') return 'The sun does not rise on this date.';
  const parts = [day.sunrise === null ? null : `Sunrise ${t(day.sunrise)}`, `solar noon ${t(day.noon)}`, day.sunset === null ? null : `sunset ${t(day.sunset)}`];
  return parts.filter((p) => p !== null).join(' · ');
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReduced(query.matches); };
    query.addEventListener('change', update);
    return () => { query.removeEventListener('change', update); };
  }, []);
  return reduced;
}

const wrap = (m: number) => ((m % 1440) + 1440) % 1440;

// ─── The toolbar button ──────────────────────────────────────────────────────────────────────

export function SunButton({ store }: { store: EditorStore }) {
  const open = useSunState(store, (s) => s.open);
  return (
    <Tooltip content={open ? 'Close the sky and sun' : 'Sky and sun: the sky, and the sun by date and time'}>
      <IconButton label="Sky and sun" icon={<Sun />} size="sm" pressed={open} onClick={() => { sunOf(store).toggle(); }} />
    </Tooltip>
  );
}

// ─── The chip, when the panel is closed ──────────────────────────────────────────────────────

export function SunChip({ store }: { store: EditorStore }) {
  const sky = useSunState(store, (s) => s.sky);
  const open = useSunState(store, (s) => s.open);
  const clock = useSunState(store, (s) => s.clock);
  if (sky === 'studio' || open) return null;
  const summary = skySummary(sky, clock);
  return (
    <button type="button" className="fs-three__chip fs-sun__chip" onClick={() => { sunOf(store).set({ open: true }); }} aria-label={`${summary}. Open the sky and sun`}>
      {sky === 'night' || sky === 'dusk' ? <SunDim aria-hidden="true" /> : <Sun aria-hidden="true" />}
      {summary}
    </button>
  );
}

// ─── The inspector's row ─────────────────────────────────────────────────────────────────────

export function ShadowsRow({ store }: { store: EditorStore }) {
  const sky = useSunState(store, (s) => s.sky);
  const clock = useSunState(store, (s) => s.clock);
  return (
    <Row label="Sky">
      <span className="fs-three-section__value">{skySummary(sky, clock)}</span>
    </Row>
  );
}

/** Each preset's swatch: its sky over its ground, as the board draws it — pictures of skies, not interface colour. */
const SWATCHES: Readonly<Record<SkyPreset, string>> = {
  clear: 'linear-gradient(#3f73b8, #a9c6e4 60%, #6a8a3f 62%, #557633)', // d3-allow: a clear sky over a lawn
  overcast: 'linear-gradient(#8d97a3, #d2d7dc 60%, #6f805a 62%, #5a6b47)', // d3-allow: an overcast sky over a lawn
  dusk: 'linear-gradient(#1f2d5c, #7b6a95 45%, #eba66d 60%, #38432c 62%, #2a3322)', // d3-allow: a dusk sky over a lawn
  night: 'linear-gradient(#05080f, #1d2742 60%, #151b14 62%, #0f140e)', // d3-allow: a night sky over a lawn
  studio: 'linear-gradient(#e2e4e7, #f4f4f5 60%, #dcdcde 62%, #cfcfd2)', // d3-allow: a studio's backdrop
};

/**
 * The sky presets (FLR-T-13.4), the board's "Sky/Preset tile": a radiogroup of five, each a swatch
 * of that sky over its ground and its name. Arrow keys move the choice, as a radiogroup's do.
 */
function SkyPicker({ store, sky }: { store: EditorStore; sky: SkyPreset }) {
  const sun = sunOf(store);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (i: number) => {
    const next = SKY_PRESETS[(i + SKY_PRESETS.length) % SKY_PRESETS.length] ?? 'clear';
    sun.setSky(next);
    refs.current[SKY_PRESETS.indexOf(next)]?.focus();
  };
  return (
    <div className="fs-sky__presets" role="radiogroup" aria-label="Sky">
      {SKY_PRESETS.map((p, i) => (
        <button
          key={p}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={p === sky}
          tabIndex={p === sky ? 0 : -1}
          className="fs-sky__preset"
          data-sky={p}
          onClick={() => { sun.setSky(p); }}
          onKeyDown={(e) => {
            const by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            if (by !== 0) {
              e.preventDefault();
              pick(i + by);
            }
          }}
        >
          <span className="fs-sky__swatch" aria-hidden="true" style={{ background: SWATCHES[p] }} />
          <span className="fs-sky__label">{SKY_LABELS[p]}</span>
        </button>
      ))}
    </div>
  );
}

/** Whether the sun is on and below the horizon: the walkthrough's sky goes dark. */
export function useSunNight(store: EditorStore, model: EditorModel | null): boolean {
  const on = useSunState(store, (s) => s.on);
  const clock = useSunState(store, (s) => s.clock);
  return useStudy(model, on, clock)?.night ?? false;
}

// ─── The panel ───────────────────────────────────────────────────────────────────────────────

export function SunPanel({ store, model }: { store: EditorStore; model: EditorModel }) {
  const sky = useSunState(store, (s) => s.sky);
  const open = useSunState(store, (s) => s.open);
  const clock = useSunState(store, (s) => s.clock);
  const playing = useSunState(store, (s) => s.playing);
  const lapse = useSunState(store, (s) => s.lapse);
  const readOnly = useEditor(store, (s) => s.readOnly !== null);
  const sun = sunOf(store);
  const site = siteOf(model);
  const placed = placedSite(site);
  const study = useMemo(() => (sky === 'studio' ? null : studyOf(placed, clock)), [sky, placed.latitude, placed.longitude, placed.trueNorth, clock]);
  const located = site.latitude !== null && site.longitude !== null;
  const offset = clock.offset === 'auto' ? browserOffset(clock.date) : clock.offset;
  const dayKey = `${clock.date}|${String(offset)}|${String(placed.latitude)}|${String(placed.longitude)}`;
  // Recomputed per date and place, not per minute.
  const day = useMemo(() => dayOf(placed, { ...clock, offset }), [dayKey]);
  const timed = sky === 'clear' || sky === 'overcast';
  const reduced = useReducedMotion();
  const ids = { date: useId(), time: useId(), zone: useId(), status: useId() };
  const [siteOpen, setSiteOpen] = useState(!located);

  // Play: a day in 24 seconds, or with reduced motion a quarter-hour each second. Stops when the panel goes.
  // A timelapse (FLR-T-13.9) runs from sunrise to sunset in 12 seconds and stops at sunset.
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const toLocal = (ms: number) => clockAt(ms, offset).minutes;
  const sunrise = day?.sunrise === undefined || day.sunrise === null ? 6 * 60 : toLocal(day.sunrise);
  const sunset = day?.sunset === undefined || day.sunset === null ? 18 * 60 : toLocal(day.sunset);
  useEffect(() => {
    if (!playing) return;
    const end = lapse ? sunset : null;
    const rate = lapse ? Math.max(60, sunset - sunrise) / 12 : 60; // minutes a second
    const advance = (to: number) => {
      if (end !== null && to >= end) {
        sun.set({ playing: false, lapse: false, clock: { ...clockRef.current, minutes: end } });
        return false;
      }
      sun.setClock({ minutes: end === null ? wrap(to) : to });
      return true;
    };
    if (reduced) {
      const timer = window.setInterval(() => { advance(Math.round(clockRef.current.minutes / STEP) * STEP + STEP); }, 1000);
      return () => { window.clearInterval(timer); };
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (advance(clockRef.current.minutes + (dt / 1000) * rate)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); };
  }, [playing, lapse, reduced, sun, sunrise, sunset]);
  useEffect(() => () => { sun.set({ playing: false, lapse: false }); }, [sun]);

  if (!open) return null;

  const minutes = Math.round(clock.minutes);
  const step = (by: number) => { sun.setClock({ minutes: wrap(Math.round(clock.minutes / STEP) * STEP + by) }); };
  const toSeason = (season: Season) => {
    const year = parseDate(clock.date)?.y ?? new Date().getFullYear();
    sun.setClock({ date: clockAt(seasonInstant(year, season), offset).date });
  };
  const toNow = () => {
    const now = nowIn(clock.offset);
    sun.setClock({ date: now.date, minutes: now.minutes });
  };
  const status = sky === 'studio' ? 'Studio light: even, with no sun, sky or lawn — for reading the model rather than the light.' : sky === 'night' ? 'Night: moonlight, no sun.' : sky === 'dusk' ? `Dusk: just after sunset${day?.sunset === undefined || day.sunset === null ? '' : ` on ${formatDate(clock.date)}, ${formatTime(sunset)}`}.` : describeSun(study, site);
  const dayLine = describeDay(day, offset);
  const zone = [{ value: 'auto', label: `This browser · ${formatOffset(browserOffset(clock.date))}` }, ...OFFSETS.map((o) => ({ value: String(o), label: formatOffset(o) }))];
  const siteLine = located ? `${formatDegrees(site.latitude ?? 0, 'latitude')}, ${formatDegrees(site.longitude ?? 0, 'longitude')} · true north ${formatDegrees(site.trueNorth, 'north')}` : 'No location · assumed 40° N, 75° W';

  return (
    <section
      className="fs-sun"
      aria-label="Sun and shadow"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          sun.set({ open: false, playing: false });
          document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
        }
        e.stopPropagation();
      }}
    >
      <header className="fs-sun__head">
        {study?.night === true || sky === 'night' || sky === 'dusk' ? <SunDim aria-hidden="true" /> : <Sun aria-hidden="true" />}
        <h2 className="fs-sun__title">Sky and sun</h2>
        <IconButton label="Close the sky and sun" icon={<X />} size="sm" onClick={() => { sun.set({ open: false, playing: false, lapse: false }); }} />
      </header>

      <p id={ids.status} className="fs-sun__status" role="status" aria-live={playing ? 'off' : 'polite'} data-night={study?.night === true || sky === 'night' ? 'on' : undefined}>
        {status}
      </p>

      <span className="fs-overline">Sky</span>
      <SkyPicker store={store} sky={sky} />

      {sky !== 'studio' ? <span className="fs-overline">Sun · date and time at the site</span> : null}
      {sky !== 'studio' ? (
        <>
          <Row label="Date" htmlFor={ids.date}>
            <Input
              id={ids.date}
              type="date"
              appearance="filled"
              value={clock.date}
              onChange={(e) => { if (parseDate(e.target.value) !== null) sun.setClock({ date: e.target.value }); }}
            />
          </Row>
          <div className="fs-sun__presets" role="group" aria-label="Date presets">
            {SEASONS.map((s) => (
              <Button key={s.id} variant="secondary" size="sm" onClick={() => { toSeason(s.id); }}>
                {s.short}
              </Button>
            ))}
            <Button variant="secondary" size="sm" onClick={toNow}>
              Now
            </Button>
          </div>

          {timed ? (
          <div className="fs-sun__time">
            <div className="fs-sun__time-head">
              <label htmlFor={ids.time} className="fs-row__label">
                Time
              </label>
              <span className="fs-sun__clock" aria-hidden="true">
                {formatTime(minutes)}
              </span>
            </div>
            <div className="fs-sun__time-controls">
              <IconButton label={`Back ${String(STEP)} minutes`} icon={<ChevronLeft />} size="sm" onClick={() => { step(-STEP); }} />
              <IconButton label={playing ? 'Pause' : 'Play the day'} icon={playing ? <Pause /> : <Play />} size="sm" pressed={playing} onClick={() => { sun.set({ playing: !playing, lapse: false }); }} />
              <IconButton label={`Forward ${String(STEP)} minutes`} icon={<ChevronRight />} size="sm" onClick={() => { step(STEP); }} />
              <input
                id={ids.time}
                className="fs-sun__slider"
                type="range"
                min={0}
                max={1439}
                step={1}
                value={minutes}
                aria-valuetext={formatTime(minutes)}
                aria-describedby={ids.status}
                onChange={(e) => { sun.setClock({ minutes: Number(e.target.value) }); }}
                onKeyDown={(e) => {
                  const by = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -(e.shiftKey ? 60 : STEP)
                    : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? (e.shiftKey ? 60 : STEP)
                      : e.key === 'PageDown' ? -60 : e.key === 'PageUp' ? 60 : null;
                  if (by !== null) {
                    e.preventDefault();
                    sun.setClock({ minutes: Math.min(1439, Math.max(0, Math.round(clock.minutes / STEP) * STEP + by)) });
                  } else if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    sun.setClock({ minutes: e.key === 'Home' ? 0 : 1439 });
                  }
                }}
              />
            </div>
            {dayLine !== null ? <p className="fs-note">{dayLine}</p> : null}
            {day !== null && day.sunrise !== null && day.sunset !== null ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Sunrise />}
                pressed={lapse && playing}
                onClick={() => {
                  if (lapse && playing) sun.set({ playing: false, lapse: false });
                  else sun.set({ playing: true, lapse: true, clock: { ...clock, minutes: sunrise } });
                }}
              >
                {lapse && playing ? 'Stop the timelapse' : 'Timelapse · sunrise to sunset'}
              </Button>
            ) : null}
          </div>
          ) : null}

          <Row label="Time zone" htmlFor={ids.zone}>
            <Select
              id={ids.zone}
              aria-label="Time zone"
              appearance="filled"
              options={zone}
              value={clock.offset === 'auto' ? 'auto' : String(clock.offset)}
              onValueChange={(v) => { sun.setClock({ offset: v === 'auto' ? 'auto' : Number(v) }); }}
            />
          </Row>
          <p className="fs-note">
            Floorspec records no time zone, so times are read at {formatOffset(offset)}
            {clock.offset === 'auto' ? ", this browser's offset on that date" : ''}. Pick the site's if it differs.
          </p>
        </>
      ) : null}

      {sky !== 'studio' ? <div className="fs-sun__site">
        <button type="button" className="fs-sun__disclosure" aria-expanded={siteOpen || !located} onClick={() => { setSiteOpen(!siteOpen); }} disabled={!located}>
          <ChevronRight aria-hidden="true" className="fs-sun__chev" />
          <span className="fs-overline">Site</span>
          <span className="fs-sun__site-line">{siteLine}</span>
        </button>
        {siteOpen || !located ? (
          <div className="fs-sun__site-fields">
            <SiteFields store={store} model={model} readOnly={readOnly} />
          </div>
        ) : null}
      </div> : null}
    </section>
  );
}
