import './film.css';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Input, Modal, SegmentedControl, Switch } from '@d3cloud/ui';
import { Clapperboard, Clock, Moon, Sparkles, Square } from 'lucide-react';
import { filmClock, filmDuration, filmFrameCount } from '@floorspec/mesh';
import { midsummer, timelapseAround, timelapseProblem, timelapseSchedule } from '@floorspec/mesh/sky';
import { messageOf } from '../../../lib/api';
import { FILM_RATES, FILM_SIZES, filmFinalSamples, MAX_FILM_FRAMES, requestExport, type FilmFormat, type FilmLight, type FilmQuality, type FilmRate, type FilmSize } from '../../../exports/api';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { viewsOf } from '../shot/views';
import { filmOf, shotsOf, theFilm } from './films';
import { atWords, siteOfModel, timelapseBands } from './light';

/**
 * Render film (FLR-T-14.1, the board's "14.1 · Film — render dialog"): draft or final, MP4 or WebM, its
 * size and frame rate, and its light — as the timeline has it, or day to night, the sun setting and
 * the lights coming on at dusk. The film renders on the server as an export job; the job card over
 * the 3D view counts its frames (never a time), and it lands in Exports.
 */

const SIZE_LABELS: Record<FilmSize, string> = { '720p': '720p', '1080p': '1080p', '4k': '4K' };

interface Card<T extends string> {
  readonly value: T;
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
}

/** Two or more choices as cards: a radio group, arrow keys moving between them. */
function RadioCards<T extends string>({ label, value, cards, onChange }: { label: string; value: T; cards: readonly Card<T>[]; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="fs-film-dialog__cards" role="radiogroup" aria-label={label}>
      {cards.map((c, i) => {
        const checked = c.value === value;
        return (
          <button
            key={c.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="fs-film-dialog__card"
            data-checked={checked ? 'true' : undefined}
            onClick={() => { onChange(c.value); }}
            onKeyDown={(e) => {
              const by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (by === 0) return;
              e.preventDefault();
              const at = (i + by + cards.length) % cards.length;
              const next = cards[at];
              if (next === undefined) return;
              onChange(next.value);
              refs.current[at]?.focus();
            }}
          >
            <span className="fs-film-dialog__card-head">
              <span className="fs-film-dialog__dot" aria-hidden="true" />
              {c.icon}
              <span className="fs-film-dialog__card-title">{c.title}</span>
            </span>
            <span className="fs-film-dialog__card-body">{c.body}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function FilmDialog({ store, model }: { store: EditorStore; model: EditorModel }) {
  const films = filmOf(store);
  const film = useMemo(() => theFilm(model), [model]);
  const views = useMemo(() => viewsOf(model), [model]);
  const site = useMemo(() => siteOfModel(model), [model]);
  const last = films.get();
  const [quality, setQuality] = useState<FilmQuality>('draft');
  const [format, setFormat] = useState<FilmFormat>('mp4');
  const [size, setSize] = useState<FilmSize>('1080p');
  const [fps, setFps] = useState<FilmRate>(30);
  const [light, setLight] = useState<FilmLight>(last.light);
  const [plan, setPlan] = useState(() => last.timelapse ?? timelapseAround(midsummer(new Date().getFullYear()), site));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const dateId = useId();
  const fromId = useId();
  const toId = useId();
  if (film === null) return null;
  const close = () => { films.set({ dialog: false }); };

  const duration = filmDuration(film);
  const frames = filmFrameCount(duration, fps);
  const samples = filmFinalSamples(size);
  const shots = shotsOf(film, views);
  const first = shots.find((s) => s.view !== undefined)?.view;
  const planProblem = light === 'day-to-night' ? timelapseProblem(plan) : null;
  const schedule = planProblem === null && light === 'day-to-night' ? timelapseSchedule(plan, site) : null;
  const bands = schedule === null ? null : timelapseBands(plan, site);
  const tooBig = quality === 'final' && samples === null ? '4K is for drafts: a final is path-traced frame by frame — choose 1080p or 720p.' : frames > MAX_FILM_FRAMES ? `A film is at most ${String(MAX_FILM_FRAMES)} frames: choose a lower frame rate.` : null;
  const mcp = `floorspec_render { film: "${film.name}"${light === 'day-to-night' ? ', preset: "day-to-night"' : ''}${quality === 'final' ? ', quality: "final"' : ''} }`;

  async function render() {
    if (film === null || tooBig !== null || planProblem !== null) return;
    setBusy(true);
    setFailed(null);
    try {
      const job = await requestExport(store.projectId, {
        kind: 'film',
        film: { film: film.id, quality, format, size, fps, light, ...(light === 'day-to-night' ? { timelapse: { ...plan } } : {}) },
        ...(Object.keys(model.design).length > 0 ? { design: { ...model.design } } : {}),
      });
      films.set({ job, folded: false, dialog: false, light, timelapse: light === 'day-to-night' ? { ...plan } : last.timelapse });
    } catch (caught) {
      setFailed(caught instanceof Error && !(caught instanceof TypeError) ? caught.message : messageOf(caught));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) close(); }}
      size="lg"
      title="Render film"
      description={`${film.name} · ${String(film.keys.length)} keyframes · ${filmClock(duration)}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Clapperboard />} loading={busy} disabled={tooBig !== null || planProblem !== null} onClick={() => { void render(); }}>
            Render film
          </Button>
        </>
      }
    >
      <div className="fs-film-dialog">
        {failed !== null ? (
          <Alert tone="danger" title="The film was not started" dynamic>
            {failed}
          </Alert>
        ) : null}
        <span className="fs-overline">Quality</span>
        <RadioCards
          label="Quality"
          value={quality}
          onChange={setQuality}
          cards={[
            { value: 'draft', icon: <Square aria-hidden="true" />, title: 'Draft — raster', body: 'Drawn by the server’s rasterizer, a frame at a time: for checking timing and framing.' },
            { value: 'final', icon: <Sparkles aria-hidden="true" />, title: 'Final — path-traced', body: `On the server, as path-traced stills: ${samples === null ? 'up to 128' : String(samples)} samples a pixel, denoised.` },
          ]}
        />
        <div className="fs-film-dialog__row">
          <div className="fs-film-dialog__field">
            <span className="fs-overline" aria-hidden="true">Format</span>
            <SegmentedControl aria-label="Format" size="sm" value={format} onValueChange={(v) => { setFormat(v as FilmFormat); }} items={[{ value: 'mp4', label: 'MP4' }, { value: 'webm', label: 'WebM' }]} />
          </div>
          <div className="fs-film-dialog__field">
            <span className="fs-overline" aria-hidden="true">Size</span>
            <SegmentedControl aria-label="Size" size="sm" value={size} onValueChange={(v) => { setSize(v as FilmSize); }} items={(Object.keys(FILM_SIZES) as FilmSize[]).map((s) => ({ value: s, label: SIZE_LABELS[s], disabled: quality === 'final' && filmFinalSamples(s) === null }))} />
          </div>
          <div className="fs-film-dialog__field">
            <span className="fs-overline" aria-hidden="true">Frame rate</span>
            <SegmentedControl aria-label="Frame rate" size="sm" value={String(fps)} onValueChange={(v) => { setFps(Number(v) as FilmRate); }} items={FILM_RATES.map((r) => ({ value: String(r), label: String(r) }))} />
          </div>
        </div>
        <span className="fs-overline">Light</span>
        <RadioCards
          label="Light"
          value={light}
          onChange={setLight}
          cards={[
            { value: 'timeline', icon: <Clock aria-hidden="true" />, title: 'As the timeline', body: `${first?.at === undefined ? 'The default sun' : atWords(first.at)}, fixed for the whole film.` },
            { value: 'day-to-night', icon: <Moon aria-hidden="true" />, title: 'Day to night', body: 'A timelapse: the sun sets, the sky follows, the lights come on at dusk.' },
          ]}
        />
        {light === 'day-to-night' ? (
          <div className="fs-film-dialog__lapse">
            <div className="fs-film-dialog__clocks">
              <label htmlFor={dateId} className="fs-row__label">Day</label>
              <Input id={dateId} type="date" appearance="filled" className="fs-film-dialog__date" value={plan.date} onChange={(e) => { setPlan({ ...plan, date: e.target.value }); }} />
              <span className="fs-spacer" />
              <span className="fs-film-dialog__sunset">{schedule === null ? '' : schedule.sunset === null ? 'no sunset that day' : `sunset ${schedule.clockOf(schedule.sunset)}`}</span>
            </div>
            <div className="fs-film-dialog__clocks">
              <label htmlFor={fromId} className="fs-row__label">From</label>
              <Input id={fromId} type="time" appearance="filled" className="fs-film-dialog__clock" value={plan.from} onChange={(e) => { setPlan({ ...plan, from: e.target.value.slice(0, 5) }); }} />
              <label htmlFor={toId} className="fs-row__label">to</label>
              <Input id={toId} type="time" appearance="filled" className="fs-film-dialog__clock" value={plan.to} onChange={(e) => { setPlan({ ...plan, to: e.target.value.slice(0, 5) }); }} />
              <span className="fs-film-dialog__zone">at the site, by its longitude</span>
            </div>
            {bands !== null ? (
              <div className="fs-film-dialog__bands" aria-hidden="true">
                {(['day', 'dusk', 'night'] as const).map((b) =>
                  bands[b] > 0 ? (
                    <span key={b} className={`fs-film__band fs-film__band--${b}`} style={{ width: `${String(bands[b] * 100)}%` }}>
                      {bands[b] >= 0.08 ? b : ''}
                    </span>
                  ) : null,
                )}
              </div>
            ) : null}
            {planProblem !== null ? <p className="fs-lighting__problem">{`The timelapse is not valid: ${planProblem}.`}</p> : null}
            <Switch checked={plan.lightsAtDusk} onCheckedChange={(on) => { setPlan({ ...plan, lightsAtDusk: on }); }}>
              Lights come on at dusk — each fixture fades up over 10 min after sunset
            </Switch>
          </div>
        ) : null}
        {tooBig !== null ? <p className="fs-lighting__problem">{tooBig}</p> : null}
        <p className="fs-film-dialog__summary">
          {`${String(frames)} frames. Renders on the server, so you can keep editing; the film appears here and in Exports when it’s done. Over MCP: `}
          <code>{mcp}</code>.
        </p>
      </div>
    </Modal>
  );
}
