import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, Select, Switch, Tooltip } from '@d3cloud/ui';
import { ChevronLeft, ChevronRight, Pause, Play, Sun, SunDim, X } from 'lucide-react';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { Row } from '../../fields';
import { browserOffset, clockAt, formatOffset, formatTime, nowIn, OFFSETS, parseDate, summaryOf } from './clock';
import { compassPoint, seasonInstant, SEASONS, type Season, type SunDay } from './solar';
import { dayOf, siteOf, sunOf, useStudy, useSunState, type Site, type Study } from './study';
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

/** The sun's place in words. */
export function describeSun(study: Study | null, site: Site): string {
  if (site.latitude === null || site.longitude === null) return 'The site has no location yet: add its latitude and longitude to place the sun.';
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
  const on = useSunState(store, (s) => s.on);
  return (
    <Tooltip content={on ? 'Turn the sun off' : 'Sun and shadow: place the sun by date and time'}>
      <IconButton label="Sun and shadow" icon={<Sun />} size="sm" pressed={on} onClick={() => { sunOf(store).toggle(); }} />
    </Tooltip>
  );
}

// ─── The chip, when the panel is closed ──────────────────────────────────────────────────────

export function SunChip({ store }: { store: EditorStore }) {
  const on = useSunState(store, (s) => s.on);
  const open = useSunState(store, (s) => s.open);
  const clock = useSunState(store, (s) => s.clock);
  if (!on || open) return null;
  return (
    <button type="button" className="fs-three__chip fs-sun__chip" onClick={() => { sunOf(store).set({ open: true }); }} aria-label={`${summaryOf(clock)}. Open the sun panel`}>
      <Sun aria-hidden="true" />
      {summaryOf(clock)}
    </button>
  );
}

// ─── The inspector's row ─────────────────────────────────────────────────────────────────────

export function ShadowsRow({ store }: { store: EditorStore }) {
  const on = useSunState(store, (s) => s.on);
  const clock = useSunState(store, (s) => s.clock);
  return (
    <Row label="Shadows">
      <span className="fs-three-section__value">{on ? summaryOf(clock) : 'Off'}</span>
    </Row>
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
  const on = useSunState(store, (s) => s.on);
  const open = useSunState(store, (s) => s.open);
  const clock = useSunState(store, (s) => s.clock);
  const playing = useSunState(store, (s) => s.playing);
  const readOnly = useEditor(store, (s) => s.readOnly !== null);
  const sun = sunOf(store);
  const site = siteOf(model);
  const study = useStudy(model, on, clock);
  const located = site.latitude !== null && site.longitude !== null;
  const offset = clock.offset === 'auto' ? browserOffset(clock.date) : clock.offset;
  const dayKey = `${clock.date}|${String(offset)}|${String(site.latitude)}|${String(site.longitude)}`;
  // Recomputed per date and place, not per minute.
  const day = useMemo(() => dayOf(site, { ...clock, offset }), [dayKey]);
  const reduced = useReducedMotion();
  const ids = { date: useId(), time: useId(), zone: useId(), status: useId() };
  const [siteOpen, setSiteOpen] = useState(!located);

  // Play: a day in 24 seconds, or with reduced motion a quarter-hour each second. Stops when the panel goes.
  const clockRef = useRef(clock);
  clockRef.current = clock;
  useEffect(() => {
    if (!playing) return;
    if (reduced) {
      const timer = window.setInterval(() => { sun.setClock({ minutes: wrap(Math.round(clockRef.current.minutes / STEP) * STEP + STEP) }); }, 1000);
      return () => { window.clearInterval(timer); };
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      sun.setClock({ minutes: wrap(clockRef.current.minutes + dt / 1000 * 60) });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); };
  }, [playing, reduced, sun]);
  useEffect(() => () => { sun.set({ playing: false }); }, [sun]);

  if (!on || !open) return null;

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
  const status = describeSun(study, site);
  const dayLine = describeDay(day, offset);
  const zone = [{ value: 'auto', label: `This browser · ${formatOffset(browserOffset(clock.date))}` }, ...OFFSETS.map((o) => ({ value: String(o), label: formatOffset(o) }))];
  const siteLine = located ? `${formatDegrees(site.latitude ?? 0, 'latitude')}, ${formatDegrees(site.longitude ?? 0, 'longitude')} · true north ${formatDegrees(site.trueNorth, 'north')}` : 'No location';

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
        {study?.night === true ? <SunDim aria-hidden="true" /> : <Sun aria-hidden="true" />}
        <h2 className="fs-sun__title">Sun and shadow</h2>
        <Switch checked={on} onCheckedChange={(v) => { if (!v) sun.toggle(); }} aria-label="Sun on" />
        <IconButton label="Close the sun panel" icon={<X />} size="sm" onClick={() => { sun.set({ open: false, playing: false }); }} />
      </header>

      <p id={ids.status} className="fs-sun__status" role="status" aria-live={playing ? 'off' : 'polite'} data-night={study?.night === true ? 'on' : undefined}>
        {status}
      </p>

      {located ? (
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
              <IconButton label={playing ? 'Pause' : 'Play the day'} icon={playing ? <Pause /> : <Play />} size="sm" pressed={playing} onClick={() => { sun.set({ playing: !playing }); }} />
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
          </div>

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

      <div className="fs-sun__site">
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
      </div>
    </section>
  );
}
