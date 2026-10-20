import { useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Alert, Button, IconButton, Input, SegmentedControl, Spinner, Switch, Tooltip } from '@d3cloud/ui';
import { Columns2, Info, Pause, Play, Sun, SunMedium, X } from 'lucide-react';
import {
  DAYLIGHT_ADVISORY,
  DAYLIGHT_BANDS,
  glareText,
  glareZones,
  grouped,
  rangeText,
  SUN_BAND_COLOUR,
  SUN_BANDS,
  type DaylightBand,
  type DaylightRoom,
  type GlareFlag,
} from '@floorspec/analysis';
import { useEditor, type EditorStore, type Viewport } from '../store';
import { toScreen } from '../viewport';
import type { LevelView } from '../model';
import { formatDate, formatTime, parseDate } from '../three/sun/clock';
import { sunOf, useSunState } from '../three/sun/study';
import { threeOf, useThreeState } from '../three/mode';
import { DAYS, dayIn, daylightOf, otherSolstice, useDaylight, type DaylightMeasure, type Study } from './state';
import { declutter, paintGrid, useBandColours } from './paint';
import './daylight.css';

/**
 * Daylight you can see (FLR-T-14.7) — the board's frames "14.7 · Daylight in 3D" and "14.7 · Daylight
 * on the plan", the P14/Legend band and P14/Glare flag components: the Daylight panel over the 3D
 * view, the legend that is always on screen while daylight shows, the glare flags pinned to desks and
 * beds, the plan's overlay and its June-against-December card, and the room inspector's daylight rows.
 * Advisory, always (FLR-ADR-011): the panel says so first, and nothing here passes or fails a room.
 */

const UNITS = 1_280_000;
const WORK_PLANE_WORDS = '2′-6″';

// ─── Pieces ──────────────────────────────────────────────────────────────────────────────────

/** One band of the legend: its swatch (patterned as the overlay is), its name, its range in mono. */
export function LegendBand({ band, label, range }: { band: DaylightBand; label: string; range: string }) {
  return (
    <li className="fs-daylight__band">
      <span className={`fs-daylight__swatch fs-daylight__swatch--${band}`} aria-hidden="true" />
      <span className="fs-daylight__band-label">{label}</span>
      <span className="fs-daylight__band-range">{range}</span>
    </li>
  );
}

/** The four bands of what is shown, brightest first. */
export function Legend({ measure, title }: { measure: DaylightMeasure; title?: string }) {
  const id = useId();
  const items = measure === 'illuminance' ? DAYLIGHT_BANDS.map((b) => ({ band: b.id, label: b.label, range: b.range })) : SUN_BANDS.map((b) => ({ band: SUN_BAND_COLOUR[b.id], label: b.label, range: b.range }));
  return (
    <div className="fs-daylight__legend">
      {title === undefined ? null : (
        <span className="fs-overline" id={id}>
          {title}
        </span>
      )}
      <ul className="fs-daylight__bands" aria-label={title ?? (measure === 'illuminance' ? 'Illuminance bands' : 'Sun-hours bands')} {...(title === undefined ? {} : { 'aria-labelledby': id })}>
        {items.map((b) => (
          <LegendBand key={b.band} {...b} />
        ))}
      </ul>
    </div>
  );
}

/** Where a flag is, in words: "Den", "Primary" for the primary bedroom's bed. */
export function flagPlace(flag: GlareFlag): string | undefined {
  const name = flag.roomName;
  if (name === undefined) return undefined;
  const short = name.replace(/\s*bedroom$/i, '').trim();
  return flag.kind === 'bed' && short !== '' ? short : name;
}

/** A glare flag: direct sun on a desk or a bed, and when. */
export function GlareFlagChip({ flag, compact = false }: { flag: GlareFlag; compact?: boolean }) {
  const text = glareText(flag, flagPlace(flag));
  return (
    <span className="fs-daylight__flag" data-now={flag.now ? 'on' : undefined} data-compact={compact ? 'on' : undefined} data-glare={flag.id} title={flag.now ? `${text} — including the time shown` : text}>
      <Sun aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

/** A room's work plane in its bands, as a bar: the shares, brightest first, named for a screen reader. */
export function BandBar({ room }: { room: DaylightRoom }) {
  const words = DAYLIGHT_BANDS.filter((b) => room.shares[b.id] > 0).map((b) => `${String(Math.round(room.shares[b.id] * 100))} % ${b.label.toLowerCase()}`).join(', ');
  return (
    <span className="fs-daylight__bar" role="img" aria-label={words === '' ? 'No light measured' : words}>
      {DAYLIGHT_BANDS.map((b) => (room.shares[b.id] > 0 ? <span key={b.id} className={`fs-daylight__bar-part fs-daylight__swatch--${b.id}`} style={{ flexGrow: room.shares[b.id] }} /> : null))}
    </span>
  );
}

const pct = (x: number): string => `${String(Math.round(x * 100))} %`;

/** "Jun 21 · 3:00 pm". */
function whenOf(study: Study | null, fallback: { date: string; minutes: number }): string {
  if (study === null) return `${formatDate(fallback.date)} · ${formatTime(fallback.minutes)}`;
  const [date = '', time = '00:00'] = study.at.split('T');
  const [h = 0, m = 0] = time.split(':').map(Number);
  return `${formatDate(date)} · ${formatTime(h * 60 + m)}`;
}

// ─── The 3D view's cluster button and panel ──────────────────────────────────────────────────

/** Open daylight over the 3D view (⌥D): its panel, and the overlay; again, close both. */
export function toggleDaylightPanel(store: EditorStore): void {
  const d = daylightOf(store);
  if (d.get().open) {
    d.toggle(false);
    return;
  }
  // The panels share one place over the view: the others step aside.
  sunOf(store).set({ open: false, playing: false, lapse: false });
  const three = threeOf(store);
  three.set({ lightingOpen: false, cameraOpen: false, sectionOpen: false });
  // X-ray fades the house and Compare draws two: daylight is studied on the house as it stands.
  three.toggleXray(false);
  three.toggleCompare(false);
  d.set({ on: true, open: true });
}

export function DaylightButton({ store, disabled }: { store: EditorStore; disabled: boolean }) {
  const on = useDaylight(store, (s) => s.on);
  const open = useDaylight(store, (s) => s.open);
  return (
    <Tooltip content={open ? 'Close daylight (⌥D)' : 'Daylight: light on the floors, sun-hours and glare (⌥D)'}>
      <IconButton label="Daylight" icon={<SunMedium />} size="sm" pressed={on || open} disabled={disabled} aria-keyshortcuts="Alt+D" onClick={() => { toggleDaylightPanel(store); }} />
    </Tooltip>
  );
}

/** What the study is doing, in words: tracing, failed, or how it was made. */
function Status({ store }: { store: EditorStore }) {
  const status = useDaylight(store, (s) => s.status);
  const error = useDaylight(store, (s) => s.error);
  const study = useDaylight(store, (s) => s.study);
  if (status === 'error') {
    return (
      <Alert tone="danger" title="No daylight study" dynamic>
        {error ?? 'The study could not be made.'}
      </Alert>
    );
  }
  return (
    <span className="fs-daylight__status" role="status" aria-live="polite">
      {status === 'loading' ? <Spinner size="sm" /> : null}
      {status === 'loading' ? 'Tracing the daylight…' : study === null ? '' : `Path tracer · ${String(study.samples)} spp`}
    </span>
  );
}

export function DaylightPanel({ store }: { store: EditorStore }) {
  const d = daylightOf(store);
  const sun = sunOf(store);
  const open = useDaylight(store, (s) => s.open);
  const measure = useDaylight(store, (s) => s.measure);
  const sky = useDaylight(store, (s) => s.sky);
  const glare = useDaylight(store, (s) => s.glare);
  const compare = useDaylight(store, (s) => s.compare);
  const clock = useSunState(store, (s) => s.clock);
  const ids = { title: useId(), date: useId(), time: useId() };
  // The panels share one place over the view: another opened, this one goes (the overlay stays).
  const other = useThreeState(store, (s) => s.cameraOpen || s.lightingOpen || s.sectionOpen || s.xray.on || s.compare.open);
  const sunOpen = useSunState(store, (s) => s.open);
  useEffect(() => {
    if (other || sunOpen) d.set({ open: false });
  }, [other, sunOpen, d]);
  // Play the day an hour at a time: each hour studied, then the next; it stops at 8 pm or on an error.
  const playing = useDaylight(store, (s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (d.get().status === 'loading') return;
      if (d.get().status === 'error') {
        d.set({ playing: false });
        return;
      }
      const next = Math.floor(sun.get().clock.minutes / 60) * 60 + 60;
      if (next > 20 * 60) d.set({ playing: false });
      else sun.setClock({ minutes: next });
    }, 1200);
    return () => { window.clearInterval(timer); };
  }, [playing, d, sun]);
  if (!open) return null;
  const close = () => {
    d.toggle(false);
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const minutes = Math.round(clock.minutes);
  const otherDay = formatDate(otherSolstice(clock.date));
  return (
    <section
      className="fs-sun fs-daylight"
      aria-labelledby={ids.title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
        e.stopPropagation();
      }}
    >
      <header className="fs-sun__head">
        <SunMedium aria-hidden="true" />
        <h2 className="fs-sun__title" id={ids.title}>
          Daylight
        </h2>
        <IconButton label="Close daylight" icon={<X />} size="sm" onClick={close} />
      </header>
      <div className="fs-daylight__body">
        <SegmentedControl
          aria-label="Show"
          size="sm"
          items={[
            { value: 'illuminance', label: 'Illuminance' },
            { value: 'sunHours', label: 'Sun-hours · year' },
          ]}
          value={measure}
          onValueChange={(v) => { d.set({ measure: v === 'sunHours' ? 'sunHours' : 'illuminance' }); }}
        />
        <div className="fs-daylight__when">
          <Input
            id={ids.date}
            aria-label="Date at the site"
            type="date"
            appearance="filled"
            value={clock.date}
            onChange={(e) => { if (parseDate(e.target.value) !== null) sun.setClock({ date: e.target.value }); }}
          />
          <span className="fs-daylight__clock" aria-hidden="true">
            {formatTime(minutes)}
          </span>
          <IconButton label={playing ? 'Pause the day' : 'Play the day, an hour at a time'} icon={playing ? <Pause /> : <Play />} size="sm" pressed={playing} onClick={() => { d.set({ playing: !playing }); }} />
        </div>
        <div className="fs-daylight__days" role="group" aria-label="Days">
          {DAYS.map((day) => {
            const date = dayIn(clock.date, day.month, day.day);
            return (
              <Button key={day.label} size="sm" variant={date === clock.date ? 'primary' : 'ghost'} aria-pressed={date === clock.date} onClick={() => { sun.setClock({ date }); }}>
                {day.label}
              </Button>
            );
          })}
        </div>
        <label className="fs-row__label fs-daylight__sr" htmlFor={ids.time}>
          Time of day
        </label>
        <input
          id={ids.time}
          className="fs-sun__slider fs-daylight__slider"
          type="range"
          min={0}
          max={1439}
          step={15}
          value={minutes}
          aria-valuetext={formatTime(minutes)}
          onChange={(e) => { sun.setClock({ minutes: Number(e.target.value) }); }}
        />
        <div className="fs-section__row">
          <span className="fs-section__key">Sky</span>
          <span className="fs-spacer" />
          <div className="fs-section__choices" role="group" aria-label="Sky">
            {(['clear', 'overcast'] as const).map((s) => (
              <Button key={s} size="sm" variant={sky === s ? 'primary' : 'secondary'} aria-pressed={sky === s} onClick={() => { d.set({ sky: s }); }}>
                {s === 'clear' ? 'Clear' : 'Overcast'}
              </Button>
            ))}
          </div>
        </div>
        <Legend measure={measure} title={measure === 'illuminance' ? `On the work plane · ${WORK_PLANE_WORDS}` : 'Direct sun on the work plane · a year'} />
        <Switch checked={glare} onCheckedChange={(on) => { d.set({ glare: on }); }} className="fs-section__switch">
          Glare flags at desks and beds
        </Switch>
        <Alert tone="info" title={DAYLIGHT_ADVISORY} icon={<Info />}>
          A simulation of this model under a standard {sky} sky — real light depends on trees, neighbours, blinds and the glass. It describes the light; it never passes or fails a room.
        </Alert>
      </div>
      <div className="fs-section__foot">
        <Button size="sm" variant="secondary" icon={<Columns2 />} pressed={compare} onClick={() => { d.set({ compare: !compare }); }}>
          {compare ? 'Stop comparing' : `Compare with ${otherDay}…`}
        </Button>
        <Status store={store} />
      </div>
    </section>
  );
}

// ─── The comparison: June against December ───────────────────────────────────────────────────

/** The rooms worth comparing: those with a desk or a bed, and the selected room first. */
function compareRooms(store: EditorStore, study: Study): DaylightRoom[] {
  const model = store.get().model;
  const selected = store.get().selection;
  const ids = new Set(glareZones(model?.document).flatMap((z) => (z.room === undefined ? [] : [z.room])));
  const rooms = study.rooms.filter((r) => ids.has(r.id) || r.id === selected);
  return rooms.sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : a.level.localeCompare(b.level) || (a.name ?? a.id).localeCompare(b.name ?? b.id)));
}

function compareLine(room: DaylightRoom | undefined, study: Study): string {
  if (room === undefined) return '—';
  const flags = study.glare.filter((g) => g.room === room.id);
  const glare = flags.length === 0 ? 'no glare' : flags.map((f) => `${f.kind} ${f.hours.map(rangeText).join(', ')}`).join('; ');
  return `${pct(room.shares.useful)} useful · ${glare}`;
}

export function CompareCard({ store }: { store: EditorStore }) {
  const compare = useDaylight(store, (s) => s.compare);
  const study = useDaylight(store, (s) => s.study);
  const other = useDaylight(store, (s) => s.other);
  const clock = useSunState(store, (s) => s.clock);
  const id = useId();
  if (!compare || study === null || other === null) return null;
  const summer = (parseDate(clock.date)?.m ?? 6) >= 4 && (parseDate(clock.date)?.m ?? 6) <= 9;
  const [june, december] = summer ? [study, other] : [other, study];
  const rooms = compareRooms(store, june);
  return (
    <section className="fs-daylight__compare" aria-labelledby={id}>
      <header className="fs-daylight__compare-head">
        <h3 id={id}>
          {formatDate(june.at.slice(0, 10))} vs {formatDate(december.at.slice(0, 10))} · {formatTime(clock.minutes)}
        </h3>
        <span className="fs-spacer" />
        <Button size="sm" variant="ghost" onClick={() => { sunOf(store).setClock({ date: otherSolstice(clock.date) }); }}>
          Swap
        </Button>
        <IconButton size="sm" label="Stop comparing" icon={<X />} onClick={() => { daylightOf(store).set({ compare: false }); }} />
      </header>
      <table className="fs-daylight__compare-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="fs-daylight__sr">Room</span>
            </th>
            <th scope="col">June</th>
            <th scope="col">December</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => {
            const j = june.rooms.find((x) => x.id === r.id);
            const dec = december.rooms.find((x) => x.id === r.id);
            return (
              <tr key={r.id} data-room={r.id}>
                <th scope="row">{r.name ?? r.id}</th>
                <td>
                  {j === undefined ? null : <BandBar room={j} />}
                  <span className="fs-daylight__compare-line">{compareLine(j, june)}</span>
                </td>
                <td>
                  {dec === undefined ? null : <BandBar room={dec} />}
                  <span className="fs-daylight__compare-line">{compareLine(dec, december)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="fs-note">Share of each room&apos;s work plane in each band at {formatTime(clock.minutes)}, {study.sky} sky.</p>
    </section>
  );
}

// ─── On the plan ─────────────────────────────────────────────────────────────────────────────

/** The study's grid for a level, painted, as an image the plan can place. */
function usePainted(store: EditorStore, level: string | undefined): { url: string; grid: NonNullable<Study['levels'][number]> } | null {
  const on = useDaylight(store, (s) => s.on);
  const study = useDaylight(store, (s) => s.study);
  const measure = useDaylight(store, (s) => s.measure);
  const colours = useBandColours();
  return useMemo(() => {
    if (!on || study === null || level === undefined) return null;
    const grid = study.levels.find((l) => l.level === level);
    if (grid === undefined) return null;
    return { url: paintGrid(grid, measure, colours).toDataURL('image/png'), grid };
  }, [on, study, level, measure, colours]);
}

/** The overlay on the plan's floors: under the walls' labels, over the floors. */
export function DaylightLayer({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const painted = usePainted(store, level.id);
  if (painted === null) return null;
  const { grid } = painted;
  const [x0, y0] = grid.origin;
  const nw = toScreen(view, [x0 * UNITS, (y0 + grid.rows * grid.spacing) * UNITS]);
  const w = grid.columns * grid.spacing * UNITS * view.s;
  const h = grid.rows * grid.spacing * UNITS * view.s;
  return (
    <g className="fs-daylight-layer" aria-hidden="true" data-daylight={level.id}>
      <image href={painted.url} x={nw[0]} y={nw[1]} width={w} height={h} preserveAspectRatio="none" />
    </g>
  );
}

/** The glare flags on the plan, each over its desk or bed, no two pills overlapping. */
function PlanFlags({ flags, view }: { flags: readonly GlareFlag[]; view: Viewport }) {
  const host = useRef<HTMLDivElement>(null);
  const points = flags.map((f) => toScreen(view, [f.at[0] * UNITS, f.at[1] * UNITS]));
  useLayoutEffect(() => {
    const el = host.current;
    if (el === null) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('.fs-daylight__pin')];
    const lifts = declutter(nodes.map((n, i) => {
      const chip = n.querySelector<HTMLElement>('.fs-daylight__flag');
      const [x, y] = points[i] ?? [0, 0];
      return { x, y, w: chip?.offsetWidth ?? 160, h: chip?.offsetHeight ?? 24 };
    }));
    nodes.forEach((n, i) => { n.style.setProperty('--lift', `${String(lifts[i] ?? 0)}px`); });
  });
  return (
    <div className="fs-daylight__flags" aria-label="Glare at desks and beds" role="list" ref={host}>
      {flags.map((f, i) => {
        const [x, y] = points[i] ?? [0, 0];
        return (
          <span key={f.id} role="listitem" className="fs-daylight__pin" style={{ transform: `translate(${String(x)}px, ${String(y)}px)` }}>
            <span className="fs-daylight__leader" aria-hidden="true" />
            <span className="fs-daylight__dot" aria-hidden="true" />
            <GlareFlagChip flag={f} />
          </span>
        );
      })}
    </div>
  );
}

/** Over the plan while daylight shows: what is shown (a chip), the legend, the glare flags, the comparison. */
export function PlanDaylight({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const d = daylightOf(store);
  const on = useDaylight(store, (s) => s.on);
  const study = useDaylight(store, (s) => s.study);
  const measure = useDaylight(store, (s) => s.measure);
  const sky = useDaylight(store, (s) => s.sky);
  const glare = useDaylight(store, (s) => s.glare);
  const compare = useDaylight(store, (s) => s.compare);
  const status = useDaylight(store, (s) => s.status);
  const error = useDaylight(store, (s) => s.error);
  const clock = useSunState(store, (s) => s.clock);
  if (!on) return null;
  const flags = glare && study !== null ? study.glare.filter((g) => g.level === level.id) : [];
  return (
    <>
      <div className="fs-daylight__chip" role="group" aria-label="Daylight">
        <SunMedium aria-hidden="true" />
        <span>
          Daylight · {whenOf(null, clock)} · {sky}
          {measure === 'sunHours' ? ' · sun-hours a year' : ''}
        </span>
        {status === 'loading' ? <Spinner size="sm" label="Tracing the daylight" /> : null}
        <IconButton size="sm" label="Hide daylight" icon={<X />} onClick={() => { d.toggle(false); }} />
      </div>
      {status === 'error' ? (
        <div className="fs-daylight__plan-error">
          <Alert tone="danger" title="No daylight study" dynamic>
            {error ?? 'The study could not be made.'}
          </Alert>
        </div>
      ) : null}
      <div className="fs-daylight__plan-legend">
        <Legend measure={measure} title={measure === 'illuminance' ? `Work plane ${WORK_PLANE_WORDS} · advisory` : 'Direct sun a year · advisory'} />
        <Button size="sm" variant="ghost" icon={<Columns2 />} pressed={compare} onClick={() => { d.set({ compare: !compare }); }}>
          {compare ? 'Stop comparing' : `Compare with ${formatDate(otherSolstice(clock.date))}`}
        </Button>
      </div>
      <PlanFlags flags={flags} view={view} />
      <div className="fs-daylight__plan-compare">
        <CompareCard store={store} />
      </div>
    </>
  );
}

// ─── The room inspector ──────────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fs-daylight__row">
      <span className="fs-daylight__row-key">{label}</span>
      <span className="fs-spacer" />
      <span className="fs-daylight__row-value">{value}</span>
    </div>
  );
}

/** A room's daylight while it shows: its bands, its median, its sun-hours, its glare. */
export function DaylightRoomSection({ store, room }: { store: EditorStore; room: string }) {
  const on = useDaylight(store, (s) => s.on);
  const study = useDaylight(store, (s) => s.study);
  const clock = useSunState(store, (s) => s.clock);
  const id = useId();
  const model = useEditor(store, (s) => s.model);
  if (!on || study === null || model === null) return null;
  const r = study.rooms.find((x) => x.id === room);
  if (r === undefined) return null;
  const flags = study.glare.filter((g) => g.room === room);
  return (
    <section className="fs-daylight__room" aria-labelledby={id}>
      <h3 id={id} className="fs-daylight__room-title">
        Daylight at {whenOf(study, clock).replace(' · ', ', ')} · {study.sky} sky
      </h3>
      <BandBar room={r} />
      <Row label="Useful daylight" value={`${pct(r.shares.useful)} of the floor`} />
      <Row label="Median" value={`${grouped(r.median)} lx`} />
      <Row label="Sun-hours that day" value={`${r.sunToday.toFixed(1)} h on the floor`} />
      <Row label="Sun-hours a year" value={`${grouped(r.sunYear)} h on the floor`} />
      <Row label="Glare" value={flags.length === 0 ? 'None at desks or beds' : flags.map((f) => `${f.kind === 'desk' ? 'Desk' : 'Bed'} · ${f.hours.map(rangeText).join(', ')}`).join('; ')} />
      {flags.length > 0 ? (
        <p className="fs-note">
          Direct sun reaches the {flags.map((f) => f.kind).join(' and the ')} {flags[0]?.low === true ? 'from a low sun' : ''} at those hours. Options to try: an exterior shade, moving the {flags[0]?.kind ?? 'piece'}, or glass that lets less sun through — each a change you can preview, not a verdict.
        </p>
      ) : null}
      <p className="fs-note">{DAYLIGHT_ADVISORY} A simulation of this model; real light depends on trees, neighbours and the glass.</p>
    </section>
  );
}

