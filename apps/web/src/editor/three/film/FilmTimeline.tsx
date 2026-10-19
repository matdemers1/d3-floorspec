import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, SegmentedControl, Tooltip } from '@d3cloud/ui';
import { Clapperboard, Diamond, Film as FilmIcon, Footprints, Pause, Pencil, Play, Repeat, Square, Trash2, X } from 'lucide-react';
import { EASE_LABELS, EASES, FILM_MAX_MS, filmCameraAt, filmClock, filmDuration, filmProblem, MAX_FILM_KEYS, RECORDED_FOCAL, type Ease, type Film, type FilmKey } from '@floorspec/mesh';
import { clockWords, timelapseSchedule } from '@floorspec/mesh/sky';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { threeOf, useThreeState } from '../mode';
import type { CameraRig } from '../shot/CameraPanel';
import { viewMeta, viewsOf } from '../shot/views';
import { appended, deleteFilm, filmOf, keyLabel, orbitOfFilm, recordedKey, retimed, saveKeys, segmentWords, shotsOf, theFilm, thinWalk, trimSeconds, useFilmState, withKey } from './films';
import { atWords, siteOfModel, timelapseBands } from './light';
import './film.css';

/**
 * The film timeline (FLR-T-14.1, the board's "14.1 · Film — camera path over saved views"): docked at
 * the bottom of the 3D view — the film's keyframes on a camera track, each a saved view or a camera
 * recorded on a walk, the easing into each and the hold at each; the sun's track; a playhead that
 * plays and scrubs the 3D view along the path; and the way to add a view, record a walk and render.
 * Every change to the film is an Op on `$document` (its extras, FLR-ADR-051), so it is undone and
 * kept like the house.
 */

const FilmDialog = lazy(() => import('./FilmDialog'));

/** A frame of the timeline's preview, ms: the step `,` and `.` take. */
const FRAME_MS = 1000 / 30;
/** How often a walk is sampled while it is recorded, ms. */
const SAMPLE_MS = 500;

/** The ruler's span: the film's length, at least five seconds. */
const spanOf = (film: Film | null): number => Math.max(5000, film === null ? 0 : filmDuration(film));

export function FilmButton({ store }: { store: EditorStore }) {
  const three = threeOf(store);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<FilmIcon />}
      onClick={() => {
        three.toggleCamera(false);
        // A video's frame: the guides show what the film will.
        three.setShot({ aspect: '16:9' });
        filmOf(store).set({ open: true });
      }}
    >
      Film…
    </Button>
  );
}

export function FilmTimeline({ store, model, rig }: { store: EditorStore; model: EditorModel; rig: CameraRig }) {
  const three = threeOf(store);
  const films = filmOf(store);
  const open = useFilmState(store, (s) => s.open);
  const time = useFilmState(store, (s) => s.time);
  const playing = useFilmState(store, (s) => s.playing);
  const loop = useFilmState(store, (s) => s.loop);
  const selected = useFilmState(store, (s) => s.selected);
  const recording = useFilmState(store, (s) => s.recording);
  const light = useFilmState(store, (s) => s.light);
  const timelapse = useFilmState(store, (s) => s.timelapse);
  const dialog = useFilmState(store, (s) => s.dialog);
  const walking = useThreeState(store, (s) => s.walking);
  const readOnly = useEditor(store, (s) => s.readOnly !== null || s.compare !== null);
  const film = useMemo(() => theFilm(model), [model]);
  const views = useMemo(() => viewsOf(model), [model]);
  const shots = useMemo(() => (film === null ? [] : shotsOf(film, views)), [film, views]);
  const duration = film === null ? 0 : filmDuration(film);
  const span = spanOf(film);
  const problem = film === null ? 'a film needs at least two keyframes' : filmProblem(film);
  const titleId = useId();
  const nameId = useId();
  const tracks = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const keyRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ index: number; at: number; moved: boolean } | null>(null);
  const [status, setStatus] = useState('');

  /**
   * Change the film as it is when the change is sent — edits are sent one after another, each against
   * the model the last one left — so two quick edits never undo each other.
   */
  const edit = useCallback(
    (label: string, change: (film: Film | null) => { keys: readonly FilmKey[]; name?: string } | 'delete' | null): Promise<boolean> =>
      store.apply(label, () => {
        const latest = store.get().model;
        if (latest === null) return [];
        const f = theFilm(latest);
        const next = change(f);
        if (next === null) return [];
        if (next === 'delete') return f === null ? [] : deleteFilm(f.id);
        return saveKeys(latest, f, next.keys, next.name).batch;
      }),
    [store],
  );

  /** Move the 3D view to where the film's camera is at `t`. */
  const preview = useCallback(
    (t: number) => {
      if (shots.length === 0 || three.get().walking) return;
      const at = rig.current();
      if (at === null) return;
      const cam = filmCameraAt(shots, t);
      rig.goTo(orbitOfFilm(cam, at.origin));
      const now = three.get().shot;
      const focal = Math.round(cam.focalLength * 10) / 10;
      const exposure = Math.round(cam.exposure);
      if (now === null || now.focalLength !== focal || now.twoPoint !== cam.twoPoint || now.aspect !== '16:9' || now.exposure !== exposure || now.dof) three.setShot({ focalLength: focal, twoPoint: cam.twoPoint, aspect: '16:9', exposure, dof: false });
      if (cam.level !== undefined && model.levels.some((l) => l.id === cam.level)) {
        if (store.get().level !== cam.level) store.setLevel(cam.level);
        const want = cam.levels === 'only' ? 'only' : 'cutaway';
        if (three.get().levels !== want) three.setLevels(want);
      } else if (three.get().levels !== 'house') three.setLevels('house');
    },
    [shots, rig, three, store, model],
  );
  const seek = useCallback(
    (t: number) => {
      const c = Math.min(Math.max(0, t), Math.max(0, duration));
      films.set({ time: c });
      preview(c);
    },
    [films, duration, preview],
  );

  // ── Playing: the playhead runs on, the 3D view following; at the end it stops, or loops.
  useEffect(() => {
    if (!playing) return;
    if (three.get().walking) three.stopWalking();
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      let t = films.get().time + dt;
      if (t >= duration) {
        if (films.get().loop && duration > 0) t = t % duration;
        else {
          films.set({ time: duration, playing: false });
          preview(duration);
          return;
        }
      }
      films.set({ time: t });
      preview(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); };
  }, [playing, duration, films, preview, three]);

  // ── Recording a walk: the camera sampled while it moves; saved as keyframes when it stops.
  const samples = useRef<{ t: number; eye: [number, number, number]; target: [number, number, number] }[]>([]);
  const stopRecording = useCallback(() => {
    const began = films.get().recording;
    films.set({ recording: null });
    if (began === null) return;
    const kept = thinWalk(samples.current);
    samples.current = [];
    const at = rig.current();
    if (kept.length < 2 || at === null) {
      setStatus('The walk was too short to keep: walk a few steps while it records.');
      return;
    }
    const t0 = kept[0]?.t ?? 0;
    let made = 0;
    void edit('Record a walk into the film', (f) => {
      const start = f === null || f.keys.length === 0 ? 0 : Math.min(FILM_MAX_MS, filmDuration(f) + 1000);
      const room = Math.max(0, MAX_FILM_KEYS - (f?.keys.length ?? 0));
      const n = (f?.keys.filter((k) => k.name?.startsWith('Walk') === true).length ?? 0) + 1;
      const recorded: FilmKey[] = kept
        .slice(0, room)
        .map((s, i) => ({ ...recordedKey(s.eye, s.target, at.origin, RECORDED_FOCAL, i === 0 ? `Walk ${String(n)}` : undefined), at: Math.round(start + (s.t - t0)) }))
        .filter((k) => k.at <= FILM_MAX_MS);
      made = recorded.length;
      return recorded.length === 0 ? null : { keys: [...(f?.keys ?? []), ...recorded] };
    }).then((ok) => { setStatus(ok ? `Recorded ${String(made)} keyframes from the walk.` : 'The walk was not kept: the film is full.'); });
  }, [films, rig, edit]);
  useEffect(() => {
    if (recording === null) return;
    const id = window.setInterval(() => {
      const look = rig.look();
      if (look !== null) samples.current.push({ t: performance.now(), eye: look.eye, target: look.target });
    }, SAMPLE_MS);
    return () => { window.clearInterval(id); };
  }, [recording, rig]);
  // A walk ended with Escape ends the recording too.
  const wasWalking = useRef(walking);
  useEffect(() => {
    if (wasWalking.current && !walking && films.get().recording !== null) stopRecording();
    wasWalking.current = walking;
  }, [walking, films, stopRecording]);

  if (!open) return dialog ? <Suspense fallback={null}><FilmDialog store={store} model={model} /></Suspense> : null;

  /** After adding a keyframe: the playhead at it. */
  const toLast = (ok: boolean) => {
    const m = store.get().model;
    const f = ok && m !== null ? theFilm(m) : null;
    if (f !== null) films.set({ time: f.keys.at(-1)?.at ?? 0 });
  };
  const addView = (viewId: string) => {
    void edit(`Add “${views.find((v) => v.id === viewId)?.name ?? viewId}” to the film`, (f) => ({ keys: appended(f, { view: viewId, ease: 'ease', hold: 0 }) })).then(toLast);
  };
  const addHere = () => {
    const at = rig.current();
    const look = rig.look();
    if (at === null || look === null) return;
    const focal = three.get().shot?.focalLength ?? RECORDED_FOCAL;
    const n = (film?.keys.length ?? 0) + 1;
    void edit('Add the camera to the film', (f) => ({ keys: appended(f, { ...recordedKey(look.eye, look.target, at.origin, focal, `View ${String(n)}`), ease: 'ease' }) })).then(toLast);
  };
  const close = () => {
    if (films.get().recording !== null) stopRecording();
    films.set({ open: false, playing: false, selected: null });
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const xOf = (t: number): string => `${String((Math.min(t, span) / span) * 100)}%`;
  const timeAt = (clientX: number): number => {
    const r = tracks.current?.getBoundingClientRect();
    if (r === undefined || r.width <= 0) return 0;
    return ((clientX - r.left) / r.width) * span;
  };

  // ── Keys: J K L, Space, , and . while the timeline has the focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.isContentEditable) return;
    if (e.key === 'Escape') {
      if (selected !== null) {
        e.preventDefault();
        films.set({ selected: null });
        keyRefs.current[selected]?.focus();
      } else close();
      e.stopPropagation();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = (by: number) => { films.set({ playing: false }); seek(films.get().time + by); };
    switch (e.key) {
      case ' ':
        if (target.tagName === 'BUTTON' && target !== e.currentTarget) return;
        films.set({ playing: !playing && duration > 0 });
        break;
      case 'k':
      case 'K':
        films.set({ playing: false });
        break;
      case 'l':
      case 'L':
        if (duration > 0) films.set({ playing: true });
        break;
      case 'j':
      case 'J':
        step(-1000);
        break;
      case ',':
        step(-FRAME_MS);
        break;
      case '.':
        step(FRAME_MS);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const sel = selected === null || film === null ? null : (film.keys[selected] ?? null);
  const site = siteOfModel(model);
  const firstView = shots.find((s) => s.view !== undefined)?.view;
  const sunWords = (() => {
    if (light === 'day-to-night' && timelapse !== null) {
      const s = timelapseSchedule(timelapse, site);
      return `${clockWords(minutesOfClock(timelapse.from))} → ${s.sunset === null ? 'no sunset' : `sunset ${s.clockOf(s.sunset)}`} → ${clockWords(minutesOfClock(timelapse.to))}${timelapse.lightsAtDusk ? ' · lights on at dusk' : ''}`;
    }
    return `${firstView?.at === undefined ? 'Default sun' : atWords(firstView.at)} · fixed — choose “Day to night” in the render dialog to move it`;
  })();
  const bands = light === 'day-to-night' && timelapse !== null ? timelapseBands(timelapse, site) : null;
  const clockNow = light === 'day-to-night' && timelapse !== null && duration > 0 ? timelapseSchedule(timelapse, site).at(time / duration).clock : null;

  const ticks: { t: number; major: boolean }[] = [];
  const stepMs = span <= 60_000 ? 1000 : 5000;
  const majorEvery = span <= 60_000 ? 5000 : 10_000;
  for (let t = 0; t <= span + 1; t += stepMs) ticks.push({ t, major: t % majorEvery === 0 });

  return (
    <>
      <section ref={section} className="fs-film" aria-labelledby={titleId} onKeyDown={onKeyDown} data-recording={recording !== null ? 'true' : undefined}>
        <header className="fs-film__head">
          <FilmIcon aria-hidden="true" className="fs-film__icon" />
          {naming === null ? (
            <h2 id={titleId} className="fs-film__title">{`Film · ${film?.name ?? 'New film'}`}</h2>
          ) : (
            <form
              className="fs-film__naming"
              onSubmit={(e) => {
                e.preventDefault();
                const n = naming.trim();
                if (n !== '' && film !== null && n !== film.name) void edit(`Rename the film “${film.name}” to “${n}”`, (f) => (f === null ? null : { keys: f.keys, name: n }));
                setNaming(null);
              }}
            >
              <h2 id={titleId} className="fs-visually-hidden">Film</h2>
              <label htmlFor={nameId} className="fs-visually-hidden">Film name</label>
              <Input id={nameId} appearance="filled" value={naming} autoFocus maxLength={200} onChange={(e) => { setNaming(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} onBlur={(e) => { e.currentTarget.form?.requestSubmit(); }} />
            </form>
          )}
          <span className="fs-film__length">{filmClock(duration)}</span>
          {film !== null && !readOnly && naming === null ? (
            <Tooltip content="Rename the film">
              <IconButton label="Rename the film" icon={<Pencil />} size="sm" variant="ghost" onClick={() => { setNaming(film.name); }} />
            </Tooltip>
          ) : null}
          <span className="fs-spacer" />
          {!readOnly ? (
            <>
              <Menu>
                <MenuTrigger>
                  <Button size="sm" variant="ghost" icon={<Diamond />} disabled={recording !== null || (film?.keys.length ?? 0) >= MAX_FILM_KEYS}>
                    Add view
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {views.length > 0 ? <MenuLabel>Saved views</MenuLabel> : null}
                  {views.map((v) => (
                    <MenuItem key={v.id} onSelect={() => { addView(v.id); }}>
                      {`${v.name} · ${viewMeta(model, v)}`}
                    </MenuItem>
                  ))}
                  {views.length > 0 ? <MenuSeparator /> : null}
                  <MenuItem onSelect={addHere}>Where the camera is now</MenuItem>
                </MenuContent>
              </Menu>
              <Button
                size="sm"
                variant="ghost"
                icon={recording !== null ? <Square /> : <Footprints />}
                aria-pressed={recording !== null}
                onClick={() => {
                  if (recording !== null) {
                    stopRecording();
                    return;
                  }
                  samples.current = [];
                  films.set({ recording: performance.now(), playing: false });
                  if (!three.get().walking) three.walk(null);
                  setStatus('Recording: walk through the house, then stop.');
                }}
              >
                {recording !== null ? 'Stop recording' : 'Record walk'}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="primary" icon={<Clapperboard />} disabled={problem !== null || recording !== null} onClick={() => { films.set({ dialog: true, playing: false }); }}>
            Render film…
          </Button>
          <Tooltip content="Close the timeline (Esc)">
            <IconButton label="Close the timeline" icon={<X />} size="sm" variant="ghost" onClick={close} />
          </Tooltip>
        </header>

        <div className="fs-film__transport">
          <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} icon={playing ? <Pause /> : <Play />} size="sm" pressed={playing} disabled={duration <= 0} onClick={() => { films.set({ playing: !playing }); }} />
          <IconButton label="Loop" icon={<Repeat />} size="sm" variant="ghost" pressed={loop} onClick={() => { films.set({ loop: !loop }); }} />
          <span className="fs-film__time" aria-live="off">{`${filmClock(time, true)} / ${filmClock(duration, true)}${clockNow === null ? '' : ` · ${clockNow}`}`}</span>
          <span className="fs-spacer" />
          <span className="fs-film__hint">{recording !== null ? 'Recording — walk, then Stop recording' : 'Space play · J K L scrub · , . step a frame'}</span>
        </div>

        <div className="fs-film__tracks">
          <span className="fs-film__track-label fs-film__track-label--camera" aria-hidden="true">Camera</span>
          <span className="fs-film__track-label fs-film__track-label--sun" aria-hidden="true">Sun</span>
          <div
            ref={tracks}
            className="fs-film__lane"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('.fs-film__key') !== null) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              films.set({ playing: false, selected: null });
              seek(timeAt(e.clientX));
            }}
            onPointerMove={(e) => {
              if (drag === null && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) seek(timeAt(e.clientX));
            }}
            onPointerUp={(e) => {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            }}
          >
            <div
              className="fs-film__ruler"
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration / 100) / 10}
              aria-valuenow={Math.round(time / 100) / 10}
              aria-valuetext={`${filmClock(time, true)} of ${filmClock(duration, true)}`}
              onKeyDown={(e) => {
                const by = e.key === 'ArrowLeft' ? -100 : e.key === 'ArrowRight' ? 100 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
                if (by === 0) return;
                e.preventDefault();
                e.stopPropagation();
                films.set({ playing: false });
                seek(Number.isFinite(by) ? films.get().time + (e.shiftKey ? by * 10 : by) : by < 0 ? 0 : duration);
              }}
            >
              {ticks.map(({ t, major }) => (
                <span key={t} className="fs-film__tick" data-major={major ? 'true' : undefined} style={{ left: xOf(t) }}>
                  {major ? <span className="fs-film__tick-label">{`${String(t / 1000)}s`}</span> : null}
                </span>
              ))}
            </div>
            <div className="fs-film__camera" role="group" aria-label="Camera keyframes">
              <span className="fs-film__line" aria-hidden="true" />
              {film?.keys.map((k, i) => {
                const next = film.keys[i + 1];
                const at = drag?.index === i ? drag.at : k.at;
                const label = keyLabel(k, i, views);
                const named = k.view !== undefined || k.name !== undefined;
                return (
                  <span key={i} className="fs-film__key-at" style={{ left: xOf(at) }}>
                    {k.hold > 0 ? <span className="fs-film__hold" aria-hidden="true" style={{ width: `${String((k.hold / span) * 100)}cqw` }} /> : null}
                    <button
                      ref={(el) => { keyRefs.current[i] = el; }}
                      type="button"
                      className="fs-film__key"
                      data-selected={selected === i ? 'true' : undefined}
                      data-recorded={k.view === undefined ? 'true' : undefined}
                      aria-label={`Keyframe ${String(i + 1)}, ${label}, at ${filmClock(k.at, true)}${k.hold > 0 ? `, holds ${trimSeconds(k.hold)} s` : ''}`}
                      aria-expanded={selected === i}
                      aria-haspopup="dialog"
                     
                      onPointerDown={(e) => {
                        if (readOnly) return;
                        e.stopPropagation();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        setDrag({ index: i, at: k.at, moved: false });
                      }}
                      onPointerMove={(e) => {
                        if (drag === null || drag.index !== i) return;
                        const t = retimed(film, i, timeAt(e.clientX));
                        if (t !== drag.at) setDrag({ ...drag, at: t, moved: true });
                      }}
                      onPointerUp={() => {
                        const d = drag;
                        setDrag(null);
                        if (d !== null && d.moved && d.at !== k.at) {
                          void edit(`Move keyframe ${String(i + 1)} to ${filmClock(d.at, true)}`, (f) => {
                            const was = f?.keys[i];
                            return f === null || was === undefined ? null : { keys: withKey(f, i, { ...was, at: retimed(f, i, d.at) }) };
                          });
                          return;
                        }
                        films.set({ selected: selected === i ? null : i, playing: false });
                        seek(k.at);
                      }}
                      onKeyDown={(e) => {
                        if (readOnly || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const by = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100);
                        const t = retimed(film, i, k.at + by);
                        if (t !== k.at)
                          void edit(`Move keyframe ${String(i + 1)} to ${filmClock(t, true)}`, (f) => {
                            const was = f?.keys[i];
                            return f === null || was === undefined ? null : { keys: withKey(f, i, { ...was, at: retimed(f, i, was.at + by) }) };
                          }).then(() => { keyRefs.current[i]?.focus(); });
                      }}
                    />
                    {named ? (
                      <span
                        className="fs-film__key-label"
                        data-selected={selected === i ? 'true' : undefined}
                        aria-hidden="true"
                        // As wide as the run to the next named keyframe (the last: back to the one before), so labels never overlap.
                        style={{ maxWidth: `max(48px, calc(${String((labelRoom(film.keys, i) / span) * 100)}cqw - 12px))` }}
                      >
                        {label}
                      </span>
                    ) : null}
                    {next !== undefined && (next.view !== undefined || next.name !== undefined || next.ease !== 'linear' || k.hold > 0) ? (
                      <span className="fs-film__ease" aria-hidden="true" style={{ width: `${String(((next.at - at) / span) * 100)}cqw` }}>
                        {segmentWords(k, next, EASE_LABELS)}
                      </span>
                    ) : null}
                  </span>
                );
              })}
              {film === null || film.keys.length === 0 ? <span className="fs-film__empty">No keyframes yet: add a saved view, or record a walk.</span> : null}
            </div>
            <div className="fs-film__sun" data-light={light}>
              {bands !== null ? (
                <span className="fs-film__bands" aria-hidden="true">
                  <span className="fs-film__band fs-film__band--day" style={{ width: `${String(bands.day * 100)}%` }} />
                  <span className="fs-film__band fs-film__band--dusk" style={{ width: `${String(bands.dusk * 100)}%` }} />
                  <span className="fs-film__band fs-film__band--night" style={{ width: `${String(bands.night * 100)}%` }} />
                </span>
              ) : null}
              <span className="fs-film__sun-words">{sunWords}</span>
            </div>
            <span className="fs-film__playhead" aria-hidden="true" style={{ left: xOf(time) }} />
          </div>
        </div>
        <p className="fs-visually-hidden" role="status" aria-live="polite">{status}</p>

        {sel !== null && selected !== null && film !== null ? (
          <KeyPopover
            key={selected}
            index={selected}
            film={film}
            keyframe={sel}
            label={keyLabel(sel, selected, views)}
            meta={sel.view === undefined ? `${String(sel.focalLength ?? RECORDED_FOCAL)} mm · a camera recorded in the 3D view.` : (() => {
              const v = views.find((x) => x.id === sel.view);
              return v === undefined ? 'Its saved view is gone: replace it, or remove it.' : `${viewMeta(model, v)} — from the saved view “${v.name}”. Edit the view to change it everywhere.`;
            })()}
            left={(sel.at / span) * 100}
            readOnly={readOnly}
            onClose={() => {
              films.set({ selected: null });
              keyRefs.current[selected]?.focus();
            }}
            onChange={(change, words) => {
              void edit(words, (f) => {
                const was = f?.keys[selected];
                return f === null || was === undefined ? null : { keys: withKey(f, selected, change(was)) };
              });
            }}
            onReplace={() => {
              const at = rig.current();
              const look = rig.look();
              if (at === null || look === null) return;
              const focal = three.get().shot?.focalLength ?? RECORDED_FOCAL;
              const label = keyLabel(sel, selected, views);
              void edit(`Replace keyframe ${String(selected + 1)} with the camera now`, (f) => {
                const was = f?.keys[selected];
                return f === null || was === undefined ? null : { keys: withKey(f, selected, { ...recordedKey(look.eye, look.target, at.origin, focal, label), at: was.at, ease: was.ease, hold: was.hold }) };
              });
            }}
            onRemove={() => {
              const at = selected;
              films.set({ selected: null });
              void edit(film.keys.length <= 1 ? `Delete the film “${film.name}”` : `Remove keyframe ${String(at + 1)} from the film`, (f) => {
                if (f === null) return null;
                const keys = f.keys.filter((_, i) => i !== at);
                return keys.length === 0 ? 'delete' : { keys };
              });
            }}
          />
        ) : null}
      </section>
      {dialog ? (
        <Suspense fallback={null}>
          <FilmDialog store={store} model={model} />
        </Suspense>
      ) : null}
    </>
  );
}

/** How much time a key's label may take: to the next named key, or for the last, back to the one before. */
function labelRoom(keys: readonly FilmKey[], i: number): number {
  const named = (k: FilmKey) => k.view !== undefined || k.name !== undefined;
  const k = keys[i];
  if (k === undefined) return 0;
  // The last key's label reads leftwards from it: it and the one before share the run between them.
  const last = keys.length - 1;
  const next = keys.slice(i + 1).find(named);
  if (next !== undefined) return keys.indexOf(next) === last ? (next.at - k.at) / 2 : next.at - k.at;
  const before = [...keys.slice(0, i)].reverse().find(named);
  return before === undefined ? 10_000 : (k.at - before.at) / 2;
}

const minutesOfClock = (c: string): number => Number(c.slice(0, 2)) * 60 + Number(c.slice(3, 5));

const EASE_ITEMS = EASES.map((e) => ({ value: e, label: EASE_LABELS[e] }));

/** The keyframe's popover (the board's "Keyframe popover · Kitchen"): easing into it, the hold, its lens, replace and remove. */
function KeyPopover({ index, film, keyframe, label, meta, left, readOnly, onClose, onChange, onReplace, onRemove }: {
  index: number;
  film: Film;
  keyframe: FilmKey;
  label: string;
  meta: string;
  /** Percent across the lane. */
  left: number;
  readOnly: boolean;
  onClose: () => void;
  onChange: (change: (key: FilmKey) => FilmKey, words: string) => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const titleId = useId();
  const holdId = useId();
  const [hold, setHold] = useState(trimSeconds(keyframe.hold));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], button')?.focus(); }, []);
  const next = film.keys[index + 1];
  const commitHold = () => {
    const s = Number(hold);
    if (!Number.isFinite(s) || s < 0) {
      setHold(trimSeconds(keyframe.hold));
      return;
    }
    const most = Math.max(0, (next === undefined ? FILM_MAX_MS - keyframe.at : next.at - keyframe.at - 100) / 1000);
    const ms = Math.round(Math.min(most, s) * 10) * 100;
    setHold(trimSeconds(ms));
    if (ms !== keyframe.hold) onChange((k) => ({ ...k, hold: ms }), `Hold keyframe ${String(index + 1)} for ${trimSeconds(ms)} s`);
  };
  return (
    <div
      ref={ref}
      className="fs-film__popover"
      role="dialog"
      aria-labelledby={titleId}
      style={{ ['--at' as string]: String(left) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="fs-film__popover-head">
        <span className="fs-film__diamond" aria-hidden="true" />
        <h3 id={titleId} className="fs-film__popover-title">{`${String(index + 1)} · ${label}`}</h3>
        <span className="fs-spacer" />
        <span className="fs-film__popover-time">{filmClock(keyframe.at, true)}</span>
      </div>
      <span className="fs-overline">Into this keyframe</span>
      <SegmentedControl aria-label={`Easing into keyframe ${String(index + 1)}`} size="sm" value={keyframe.ease} items={EASE_ITEMS} onValueChange={(v) => { if (!readOnly && v !== keyframe.ease) onChange((k) => ({ ...k, ease: v as Ease }), `Ease into keyframe ${String(index + 1)}: ${EASE_LABELS[v as Ease]}`); }} />
      <div className="fs-film__hold-row">
        <label htmlFor={holdId} className="fs-row__label">Hold here</label>
        <span className="fs-spacer" />
        <Input
          id={holdId}
          className="fs-film__hold-input"
          appearance="filled"
          inputMode="decimal"
          value={hold}
          disabled={readOnly}
          aria-describedby={`${holdId}-unit`}
          onChange={(e) => { setHold(e.target.value); }}
          onBlur={commitHold}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitHold();
            }
          }}
        />
        <span id={`${holdId}-unit`} className="fs-film__unit">s</span>
      </div>
      <p className="fs-film__popover-meta">{meta}</p>
      {!readOnly ? (
        <div className="fs-film__popover-actions">
          <Button size="sm" variant="secondary" onClick={onReplace}>
            Replace with current view
          </Button>
          <Button size="sm" variant="ghost" className="fs-film__remove" icon={<Trash2 />} onClick={onRemove}>
            Remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}
