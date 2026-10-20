import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, SegmentedControl, Select, Switch, Tooltip } from '@d3cloud/ui';
import { ChevronLeft, ChevronRight, Pause, Play, Sun, SunDim, Sunrise, X } from 'lucide-react';
import { DEFAULT_SITE, LOOK_SEASONS, SEASON_LABELS, SKY_LABELS, WEATHER_LABELS, WEATHERS, type Look, type LookSeason, type SkyPreset, type Weather } from '@floorspec/mesh/sky';
import { useEditor, type EditorStore } from '../../store';
import { threeOf } from '../mode';
import type { EditorModel } from '../../model';
import { Row } from '../../fields';
import { browserOffset, clockAt, formatDate, formatOffset, formatTime, formatTimeShort, nowIn, OFFSETS, parseDate, type Clock } from './clock';
import { compassPoint, seasonInstant, SEASONS, type Season, type SunDay } from './solar';
import { dayOf, placedSite, seasonOf, siteOf, studyOf, sunOf, useLook, useStudy, useSunState, type Site, type Study } from './study';
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

/**
 * `Clear day · Oct 4 · 3 pm`, `Dusk · Oct 4`, `Studio`: the chip's and the inspector's summary of the
 * sky — with the weather and the season when they are not a summer's day (FLR-T-15.4): `Light snow ·
 * Winter · Jan 15 · 1 pm`, `Overcast · Autumn · Oct 20 · 3:30 pm`.
 */
export function skySummary(sky: SkyPreset, clock: Clock, look?: Look): string {
  if (sky === 'studio') return SKY_LABELS.studio;
  const season = look === undefined || look.season === 'summer' ? [] : [SEASON_LABELS[look.season]];
  if (sky === 'dusk' || sky === 'night') return [SKY_LABELS[sky], ...season, formatDate(clock.date)].join(' · ');
  const weather = look !== undefined && (look.weather === 'rain' || look.weather === 'snow') ? WEATHER_LABELS[look.weather] : SKY_LABELS[sky];
  return [weather, ...season, formatDate(clock.date), formatTimeShort(clock.minutes)].join(' · ');
}

/** What a weather does, in words: the panel's status under a clear sky is the sun's place instead. */
export const WEATHER_WORDS: Readonly<Record<Exclude<Weather, 'clear'>, string>> = {
  overcast: 'Overcast: the sun is behind cloud, so light comes evenly from the whole sky and shadows soften to contact shadows.',
  rain: 'Rain-wet: an overcast sky, and everything outside wet — darker roofs, paving and lawn with a sheen that mirrors the sky.',
  snow: 'Light snow: an overcast sky, and snow on the roofs, the lawn, the beds and the evergreens; the walks stay cleared.',
};

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
      <IconButton label="Sky and sun" icon={<Sun />} size="sm" pressed={open} onClick={() => { if (!open) threeOf(store).set({ lightingOpen: false, cameraOpen: false }); sunOf(store).toggle(); }} />
    </Tooltip>
  );
}

// ─── The chip, when the panel is closed ──────────────────────────────────────────────────────

export function SunChip({ store }: { store: EditorStore }) {
  const sky = useSunState(store, (s) => s.sky);
  const open = useSunState(store, (s) => s.open);
  const clock = useSunState(store, (s) => s.clock);
  const look = useLook(store, useEditor(store, (s) => s.model));
  if (sky === 'studio' || open) return null;
  const summary = skySummary(sky, clock, look);
  return (
    <button type="button" className="fs-three__chip fs-sun__chip" onClick={() => { threeOf(store).set({ lightingOpen: false, cameraOpen: false }); sunOf(store).set({ open: true }); }} aria-label={`${summary}. Open the sky and sun`}>
      {sky === 'night' || sky === 'dusk' ? <SunDim aria-hidden="true" /> : <Sun aria-hidden="true" />}
      {summary}
    </button>
  );
}

// ─── The inspector's row ─────────────────────────────────────────────────────────────────────

export function ShadowsRow({ store }: { store: EditorStore }) {
  const sky = useSunState(store, (s) => s.sky);
  const clock = useSunState(store, (s) => s.clock);
  const look = useLook(store, useEditor(store, (s) => s.model));
  return (
    <Row label="Sky">
      <span className="fs-three-section__value">{skySummary(sky, clock, look)}</span>
    </Row>
  );
}

/** Each weather's swatch: its sky over its ground, as the board's "P15/Weather tile" draws it — pictures of weather, not interface colour. */
const SWATCHES: Readonly<Record<Weather, string>> = {
  clear: 'radial-gradient(circle at 76% 24%, #f6d77a 0 9%, transparent 10%), linear-gradient(#3f73b8, #a9c6e4 60%, #6a8a3f 62%, #557633)', // d3-allow: a clear sky, its sun, over a lawn
  overcast: 'radial-gradient(ellipse at 30% 28%, #e3e6ea 0 16%, transparent 17%), radial-gradient(ellipse at 66% 22%, #dde1e5 0 14%, transparent 15%), linear-gradient(#8d97a3, #d2d7dc 60%, #6f805a 62%, #5a6b47)', // d3-allow: an overcast sky over a lawn
  rain: 'repeating-linear-gradient(105deg, transparent 0 5px, #c9d2dc 5px 6px), linear-gradient(#5d6670, #8f99a3 60%, #3f4c3a 62%, #34402f)', // d3-allow: rain from a dark overcast over a wet lawn
  snow: 'radial-gradient(circle, #ffffff 0 1px, transparent 1.5px) 0 0 / 9px 9px, linear-gradient(#c3cad2, #e8ecf0 60%, #f4f6f8 62%, #e4e8ec)', // d3-allow: light snow falling on a snowy field
};

/**
 * The weather (FLR-T-15.4), the board's "P15/Weather tile": a radiogroup of four — Clear, Overcast,
 * Rain-wet, Light snow — each a swatch of that weather over its ground and its name. They replace
 * FLR-T-13.4's sky tiles: dusk and night are times (the clock below), the studio a backdrop (the
 * Camera panel's). Arrow keys move the choice, as a radiogroup's do.
 */
function WeatherPicker({ store, weather }: { store: EditorStore; weather: Weather }) {
  const sun = sunOf(store);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (i: number) => {
    const next = WEATHERS[(i + WEATHERS.length) % WEATHERS.length] ?? 'clear';
    sun.setWeather(next);
    refs.current[WEATHERS.indexOf(next)]?.focus();
  };
  return (
    <div className="fs-sky__presets" role="radiogroup" aria-label="Weather">
      {WEATHERS.map((w, i) => (
        <button
          key={w}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={w === weather}
          tabIndex={w === weather ? 0 : -1}
          className="fs-sky__preset"
          data-weather={w}
          onClick={() => { sun.setWeather(w); }}
          onKeyDown={(e) => {
            const by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            if (by !== 0) {
              e.preventDefault();
              pick(i + by);
            }
          }}
        >
          <span className="fs-sky__swatch" aria-hidden="true" style={{ background: SWATCHES[w] }} />
          <span className="fs-sky__label">{WEATHER_LABELS[w]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The season (FLR-T-15.4): Spring, Summer, Autumn, Winter — and "Follow the date", which takes the
 * clock's date at the site instead. A look: nothing is written to the model.
 */
function SeasonPicker({ store, season, followDate, date }: { store: EditorStore; season: LookSeason; followDate: boolean; date: string }) {
  const sun = sunOf(store);
  return (
    <>
      <SegmentedControl
        aria-label="Season"
        size="sm"
        items={LOOK_SEASONS.map((s) => ({ value: s, label: SEASON_LABELS[s] }))}
        value={season}
        onValueChange={(v) => { sun.setSeason(v as LookSeason); }}
      />
      <Switch className="fs-sun__follow" checked={followDate} onCheckedChange={(on) => { sun.setFollowDate(on, season); }}>
        {`Follow the date · ${formatDate(date)} is ${SEASON_LABELS[season].toLowerCase()}`}
      </Switch>
    </>
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
  const weather = useSunState(store, (s) => s.weather);
  const followDate = useSunState(store, (s) => s.followDate);
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
  // Dusk and night (a saved view's) are times too: moving the clock leaves them for the sky that follows the sun.
  const timed = sky !== 'studio';
  const season = useSunState(store, (s) => seasonOf(s, placed.latitude ?? DEFAULT_SITE.latitude));
  const toClock = (patch: Partial<Clock>) => {
    if (sky === 'dusk' || sky === 'night') sun.setSky('clear');
    sun.setClock(patch);
  };
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
  const step = (by: number) => { toClock({ minutes: wrap(Math.round(clock.minutes / STEP) * STEP + by) }); };
  const toSeason = (season: Season) => {
    const year = parseDate(clock.date)?.y ?? new Date().getFullYear();
    sun.setClock({ date: clockAt(seasonInstant(year, season), offset).date });
  };
  const toNow = () => {
    const now = nowIn(clock.offset);
    sun.setClock({ date: now.date, minutes: now.minutes });
  };
  const status =
    sky === 'studio'
      ? 'Studio backdrop: even light, with no sun, sky or lawn — for reading the model rather than the light. Camera ▸ Backdrop goes back to the site.'
      : sky === 'night'
        ? 'Night: moonlight, no sun.'
        : sky === 'dusk'
          ? `Dusk: just after sunset${day?.sunset === undefined || day.sunset === null ? '' : ` on ${formatDate(clock.date)}, ${formatTime(sunset)}`}.`
          : weather !== 'clear' && study?.night !== true
            ? WEATHER_WORDS[weather]
            : describeSun(study, site);
  const dayLine = describeDay(day, offset);
  const zone = [{ value: 'auto', label: `This browser · ${formatOffset(browserOffset(clock.date))}` }, ...OFFSETS.map((o) => ({ value: String(o), label: formatOffset(o) }))];
  const siteLine = located ? `${formatDegrees(site.latitude ?? 0, 'latitude')}, ${formatDegrees(site.longitude ?? 0, 'longitude')} · true north ${formatDegrees(site.trueNorth, 'north')}` : 'No location · assumed 40° N, 75° W';

  return (
    <section
      className="fs-sun"
      aria-label="Sky and sun"
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

      <span className="fs-overline">Season</span>
      <SeasonPicker store={store} season={season} followDate={followDate} date={clock.date} />

      <span className="fs-overline">Weather</span>
      <WeatherPicker store={store} weather={weather} />
      <p className="fs-note">Dusk and night follow the time below; the Studio backdrop moved to Camera ▸ Backdrop.</p>

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
              <IconButton label={playing ? 'Pause' : 'Play the day'} icon={playing ? <Pause /> : <Play />} size="sm" pressed={playing} onClick={() => { if (sky === 'dusk' || sky === 'night') sun.setSky('clear'); sun.set({ playing: !playing, lapse: false }); }} />
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
                onChange={(e) => { toClock({ minutes: Number(e.target.value) }); }}
                onKeyDown={(e) => {
                  const by = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -(e.shiftKey ? 60 : STEP)
                    : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? (e.shiftKey ? 60 : STEP)
                      : e.key === 'PageDown' ? -60 : e.key === 'PageUp' ? 60 : null;
                  if (by !== null) {
                    e.preventDefault();
                    toClock({ minutes: Math.min(1439, Math.max(0, Math.round(clock.minutes / STEP) * STEP + by)) });
                  } else if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    toClock({ minutes: e.key === 'Home' ? 0 : 1439 });
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
                  else {
                    if (sky === 'dusk' || sky === 'night') sun.setSky('clear');
                    sun.set({ playing: true, lapse: true, clock: { ...clock, minutes: sunrise } });
                  }
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
      <p className="fs-sun__uses">
        Renders and films use these <code>season</code> · <code>weather</code>
      </p>
    </section>
  );
}
