import { lazy, Suspense, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, Menu, MenuContent, MenuItem, MenuTrigger, SegmentedControl, Select, Switch, Tooltip } from '@d3cloud/ui';
import { Camera, Crosshair, Ellipsis, Images, Plus, X } from 'lucide-react';
import { APERTURES, ASPECTS, fieldAcross, scenesOf, UNITS_PER_METRE, describeLens, type Aperture, type Aspect, type SavedView } from '@floorspec/mesh';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { eyeOf, type Orbit } from '../camera';
import { threeOf, useThreeState, DEFAULT_SHOT, type Shot } from '../mode';
import { sunOf } from '../sun/study';
import { houseLights, panelScenes, unchanged } from '../lighting/lighting';
import { FOCAL_SLIDER, focalToSlider, focusToSlider, frameRect, orbitOfView, shotOfView, sliderToFocal, sliderToFocus } from './lens';
import { cannotSaveViews, clockOfAt, deleteView, renameView, saveNewView, updateView, viewFromState, viewMeta, viewNameProblem, viewsOf } from './views';
import { FilmButton } from '../film/FilmTimeline';
import './camera.css';

/**
 * A camera for photographs (FLR-T-13.10, the board's "30 · Editor — 3D camera"): the toolbar's Camera
 * button, the panel it opens over the view — the project's saved views (FS_views, FLR-ADR-046), the
 * lens, two-point perspective, depth of field, exposure and the frame — the framing guides drawn over
 * the view, and the chip that stands for the camera when the panel is closed. The lens is view state
 * (mode.ts `Shot`); a view is kept in the document only when a person saves it, every save an Op on
 * `$document`.
 */

/** The shot list (FLR-T-13.10): its own chunk, loaded when it is opened. */
const ShotListDialog = lazy(() => import('./ShotListDialog'));

/** Where the 3D view is looking, and how to send it somewhere: the orbit in metres about the mesh's origin (base units). */
export interface CameraRig {
  readonly current: () => { orbit: Orbit; origin: readonly [number, number, number] } | null;
  readonly goTo: (orbit: Orbit) => void;
  /**
   * Where the camera is and what it looks at, metres about the origin — the orbit's eye and target,
   * or while walking the walker's eye and a point ahead of it (FLR-T-14.1, a film's keyframes).
   */
  readonly look: () => { eye: [number, number, number]; target: [number, number, number] } | null;
}

const PRESET_LENSES = [16, 24, 35, 50, 85] as const;
const ASPECT_ITEMS = ASPECTS.map((a) => ({ value: a, label: a }));
const APERTURE_ITEMS = APERTURES.map((a) => ({ value: a, label: a }));

/** "+0.3 EV", "0 EV", "−1.0 EV". */
export const evWords = (tenths: number): string => (tenths === 0 ? '0 EV' : `${tenths > 0 ? '+' : '−'}${(Math.abs(tenths) / 10).toFixed(1)} EV`);

// ─── The toolbar button and the chip ─────────────────────────────────────────────────────────

export function CameraButton({ store }: { store: EditorStore }) {
  const three = threeOf(store);
  const open = useThreeState(store, (s) => s.cameraOpen);
  return (
    <Tooltip content={open ? 'Close the camera' : 'Camera: saved views, lens, two-point perspective, exposure and the frame'}>
      <IconButton
        label="Camera"
        icon={<Camera />}
        size="sm"
        pressed={open}
        onClick={() => {
          if (!open) {
            sunOf(store).set({ open: false, playing: false, lapse: false });
            three.set({ lightingOpen: false });
          }
          three.toggleCamera(!open);
        }}
      />
    </Tooltip>
  );
}

export function CameraChip({ store, model }: { store: EditorStore; model: EditorModel }) {
  const three = threeOf(store);
  const shot = useThreeState(store, (s) => s.shot);
  const open = useThreeState(store, (s) => s.cameraOpen);
  const chosen = useThreeState(store, (s) => s.savedView);
  if (shot === null) return null;
  const name = viewsOf(model).find((v) => v.id === chosen)?.name ?? `${String(shot.focalLength)} mm · ${shot.aspect}`;
  return (
    <span className="fs-camera__chip" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="fs-three__chip fs-camera__chip-open"
        onClick={() => {
          sunOf(store).set({ open: false, playing: false, lapse: false });
          three.set({ lightingOpen: false });
          three.toggleCamera(true);
        }}
        aria-label={`Camera · ${name}. Open the camera`}
      >
        <Camera aria-hidden="true" />
        Camera · {name}
      </button>
      <Tooltip content="Back to the free view: no lens, no frame">
        <IconButton label="Back to the free view" icon={<X />} size="sm" variant="ghost" onClick={() => { three.clearShot(); }} />
      </Tooltip>
    </span>
  );
}

/**
 * The framing guides (the board's frame 30): the picture's shape centred in the view, everything
 * outside it dimmed, the rule of thirds and a centre mark inside it, and what the shot is in words.
 * Drawn over the canvas; never part of a render.
 */
export function Framing({ store, model, width, height }: { store: EditorStore; model: EditorModel; width: number; height: number }) {
  const shot = useThreeState(store, (s) => s.shot);
  const chosen = useThreeState(store, (s) => s.savedView);
  if (shot === null || width < 2 || height < 2) return null;
  const f = frameRect(width, height, shot.aspect);
  const name = viewsOf(model).find((v) => v.id === chosen)?.name;
  const words = [name, describeLens({ focalLength: shot.focalLength, aspect: shot.aspect, twoPoint: shot.twoPoint, exposure: shot.exposure, ...(shot.dof && shot.aperture !== null ? { aperture: shot.aperture } : {}) })].filter((x) => x !== undefined).join(' · ');
  return (
    <div className="fs-camera__framing" aria-hidden="true" data-guides={shot.guides ? 'on' : undefined}>
      <div className="fs-camera__scrim" style={{ left: 0, top: 0, width, height: f.y }} />
      <div className="fs-camera__scrim" style={{ left: 0, top: f.y + f.height, width, height: height - f.y - f.height }} />
      <div className="fs-camera__scrim" style={{ left: 0, top: f.y, width: f.x, height: f.height }} />
      <div className="fs-camera__scrim" style={{ left: f.x + f.width, top: f.y, width: width - f.x - f.width, height: f.height }} />
      <div className="fs-camera__frame" style={{ left: f.x, top: f.y, width: f.width, height: f.height }}>
        {shot.guides ? (
          <>
            <span className="fs-camera__third" style={{ left: '33.333%', top: 0, bottom: 0, width: 1 }} />
            <span className="fs-camera__third" style={{ left: '66.667%', top: 0, bottom: 0, width: 1 }} />
            <span className="fs-camera__third" style={{ top: '33.333%', left: 0, right: 0, height: 1 }} />
            <span className="fs-camera__third" style={{ top: '66.667%', left: 0, right: 0, height: 1 }} />
            <span className="fs-camera__cross" />
          </>
        ) : null}
        <span className="fs-three__chip fs-camera__caption">{words}</span>
      </div>
    </div>
  );
}

// ─── The panel ───────────────────────────────────────────────────────────────────────────────

export function CameraPanel({ store, model, rig }: { store: EditorStore; model: EditorModel; rig: CameraRig }) {
  const three = threeOf(store);
  const open = useThreeState(store, (s) => s.cameraOpen);
  const shot = useThreeState(store, (s) => s.shot) ?? DEFAULT_SHOT;
  const chosen = useThreeState(store, (s) => s.savedView);
  const readOnly = useEditor(store, (s) => s.readOnly !== null || s.compare !== null);
  const views = useMemo(() => viewsOf(model), [model]);
  const [naming, setNaming] = useState<{ mode: 'new' } | { mode: 'rename'; id: string; was: string } | null>(null);
  const [name, setName] = useState('');
  const [shots, setShots] = useState(false);
  const nameId = useId();
  const focalId = useId();
  const focusId = useId();
  const evId = useId();
  const statusId = useId();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  if (!open) return shots ? <Suspense fallback={null}><ShotListDialog store={store} model={model} onClose={() => { setShots(false); }} /></Suspense> : null;

  const blocked = cannotSaveViews(model);
  const set = (patch: Partial<Shot>) => { three.setShot(patch); };
  const close = () => {
    three.toggleCamera(false);
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  /** The view now, as it would be saved. */
  const now = (n: string): Omit<SavedView, 'id'> | null => {
    const at = rig.current();
    if (at === null) return null;
    const t = three.get();
    const scenes = panelScenes(model);
    const scene = scenes.find((s) => s.id !== null && s.id === t.scene.id);
    return viewFromState({ name: n, orbit: at.orbit, origin: at.origin, three: t, level: store.get().level, sun: sunOf(store).get(), sceneUnchanged: unchanged(t.lighting, scene, houseLights(model)) });
  };
  /** Go to a saved view: its camera, lens and frame, levels, sky and time, and lights. */
  const goTo = (v: SavedView) => {
    const at = rig.current();
    if (at === null) return;
    const o = at.origin.map((u) => u / UNITS_PER_METRE) as [number, number, number];
    const m = (p: readonly [number, number, number]): [number, number, number] => [p[0] / UNITS_PER_METRE - o[0], p[1] / UNITS_PER_METRE - o[1], p[2] / UNITS_PER_METRE - o[2]];
    if (v.level !== undefined && model.levels.some((l) => l.id === v.level)) {
      store.setLevel(v.level);
      three.setLevels(v.levels === 'only' ? 'only' : 'cutaway');
    } else three.setLevels('house');
    const sun = sunOf(store);
    sun.setSky(v.sky);
    const clock = v.at === undefined ? null : clockOfAt(v.at);
    if (clock !== null) sun.setClock(clock);
    if (v.lights === 'off') three.toggleLights(false);
    else {
      const scene = scenesOf(model.view).find((s) => (v.scene === undefined ? s.id === null && 'all' in s.lighting : s.id === v.scene));
      if (scene !== undefined) three.chooseScene(scene);
      else three.toggleLights(true);
    }
    three.set({ shot: shotOfView(v), savedView: v.id });
    rig.goTo(orbitOfView(m(v.eye), m(v.target)));
  };
  const pick = (i: number) => {
    const next = views[(i + views.length) % views.length];
    if (next === undefined) return;
    goTo(next);
    radios.current[views.indexOf(next)]?.focus();
  };
  const problem = naming === null ? null : viewNameProblem(model, name, naming.mode === 'rename' ? naming.id : null);
  const submit = () => {
    if (naming === null || problem !== null) return;
    const n = name.trim();
    if (naming.mode === 'rename') void store.apply(`Rename the view “${naming.was}” to “${n}”`, renameView(naming.id, n));
    else {
      const view = now(n);
      if (view === null) return;
      let id = '';
      void store
        .apply(`Save the view “${n}”`, (attempt) => {
          const made = saveNewView(model, view, attempt);
          id = made.id;
          return made.batch;
        })
        .then((ok) => { if (ok) three.set({ savedView: id }); });
    }
    setNaming(null);
  };
  const focusAtTarget = (): number => {
    const at = rig.current();
    if (at === null) return 5;
    const e = eyeOf(at.orbit);
    const t = at.orbit.target;
    return shot.twoPoint ? Math.hypot(t[0] - e[0], t[1] - e[1]) : at.orbit.distance;
  };
  const focus = shot.focus ?? focusAtTarget();

  return (
    <>
      <section
        className="fs-sun fs-lighting fs-camera"
        aria-label="Camera"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && naming === null) {
            e.preventDefault();
            close();
          }
          e.stopPropagation();
        }}
      >
        <header className="fs-sun__head">
          <Camera aria-hidden="true" />
          <h2 className="fs-sun__title">Camera</h2>
          <IconButton label="Close the camera" icon={<X />} size="sm" onClick={close} />
        </header>

        <div className="fs-camera__body">
          <span className="fs-overline">Saved views</span>
          {views.length === 0 ? (
            <p id={statusId} className="fs-lighting__hint">No saved views yet. Frame a shot and save it: it is kept in the model, and agents can render it by name.</p>
          ) : (
            <div className="fs-lighting__scenes" role="radiogroup" aria-label="Saved view">
              {views.map((v, i) => {
                const checked = chosen === v.id;
                return (
                  <div key={v.id} className="fs-lighting__scene fs-camera__view" data-checked={checked ? 'true' : undefined}>
                    <button
                      ref={(el) => { radios.current[i] = el; }}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked || (chosen === null && i === 0) ? 0 : -1}
                      className="fs-lighting__radio fs-camera__radio"
                      onClick={() => { goTo(v); }}
                      onKeyDown={(e) => {
                        const by = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
                        if (by !== 0) {
                          e.preventDefault();
                          pick(i + by);
                        }
                      }}
                    >
                      <span className="fs-lighting__dot" aria-hidden="true" />
                      <span className="fs-camera__view-text">
                        <span className="fs-lighting__name">{v.name}</span>
                        <span className="fs-camera__meta">{viewMeta(model, v)}</span>
                      </span>
                    </button>
                    {!readOnly ? (
                      <Menu>
                        <MenuTrigger>
                          <IconButton variant="ghost" size="sm" icon={<Ellipsis />} label={`More for ${v.name}`} />
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem
                            disabled={blocked !== null}
                            onSelect={() => {
                              const view = now(v.name);
                              if (view !== null) void store.apply(`Update the view “${v.name}”`, updateView(v.id, view)).then((ok) => { if (ok) three.set({ savedView: v.id }); });
                            }}
                          >
                            Update to this view
                          </MenuItem>
                          <MenuItem
                            onSelect={() => {
                              setNaming({ mode: 'rename', id: v.id, was: v.name });
                              setName(v.name);
                            }}
                          >
                            Rename…
                          </MenuItem>
                          <MenuItem
                            tone="danger"
                            onSelect={() => {
                              void store.apply(`Delete the view “${v.name}”`, deleteView(v.id)).then((ok) => { if (ok && chosen === v.id) three.set({ savedView: null }); });
                            }}
                          >
                            Delete
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {!readOnly ? (
            naming === null ? (
              <div className="fs-lighting__save">
                <Button size="sm" variant="secondary" icon={<Plus />} disabled={blocked !== null} onClick={() => { setNaming({ mode: 'new' }); setName(''); }}>
                  Save view…
                </Button>
              </div>
            ) : (
              <form
                className="fs-lighting__naming"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setNaming(null);
                  }
                }}
              >
                <label htmlFor={nameId} className="fs-row__label">
                  {naming.mode === 'new' ? 'Name' : `Rename “${naming.was}”`}
                </label>
                <Input id={nameId} appearance="filled" value={name} autoFocus maxLength={200} placeholder="Hero exterior" onChange={(e) => { setName(e.target.value); }} aria-invalid={problem !== null && name !== '' ? true : undefined} />
                {problem !== null && name !== '' ? <p className="fs-lighting__problem">{problem}</p> : null}
                <div className="fs-lighting__save">
                  <Button size="sm" variant="primary" type="submit" disabled={problem !== null}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setNaming(null); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            )
          ) : null}
          {blocked !== null && !readOnly ? <p className="fs-lighting__hint">{blocked}</p> : null}

          <hr className="fs-camera__rule" />
          <span className="fs-overline">Lens</span>
          <div className="fs-lighting__slider-row">
            <label htmlFor={focalId} className="fs-row__label">
              Focal length
            </label>
            <span className="fs-lighting__value" aria-hidden="true">{`${String(shot.focalLength)} mm · ${String(Math.round(fieldAcross(shot.focalLength)))}° across`}</span>
          </div>
          <input
            id={focalId}
            className="fs-sun__slider fs-lighting__slider"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(focalToSlider(shot.focalLength) * 1000)}
            aria-valuetext={`${String(shot.focalLength)} millimetres, ${String(Math.round(fieldAcross(shot.focalLength)))} degrees across`}
            onChange={(e) => { set({ focalLength: sliderToFocal(Number(e.target.value) / 1000) }); }}
          />
          <div className="fs-camera__range" aria-hidden="true">
            <span>{FOCAL_SLIDER.min} mm</span>
            <span>{FOCAL_SLIDER.max} mm</span>
          </div>
          <div className="fs-camera__presets" role="group" aria-label="Lens">
            {PRESET_LENSES.map((mm) => (
              <Button key={mm} size="sm" variant="secondary" className="fs-camera__preset" data-current={shot.focalLength === mm ? 'true' : undefined} aria-pressed={shot.focalLength === mm} onClick={() => { set({ focalLength: mm }); }}>
                {mm} mm
              </Button>
            ))}
          </div>

          <hr className="fs-camera__rule" />
          <Switch checked={shot.twoPoint} onCheckedChange={(on) => { set({ twoPoint: on }); }}>
            Two-point perspective
          </Switch>
          <p className="fs-lighting__hint">Keep verticals vertical: the camera is held level and the lens shifted.</p>

          <hr className="fs-camera__rule" />
          <Switch checked={shot.dof} onCheckedChange={(on) => { set({ dof: on, aperture: shot.aperture ?? 'f/2.8' }); }}>
            Depth of field
          </Switch>
          {shot.dof ? (
            <>
              <div className="fs-camera__field">
                <span className="fs-row__label">Aperture</span>
                <Select aria-label="Aperture" options={APERTURE_ITEMS} value={shot.aperture ?? 'f/2.8'} onValueChange={(v) => { set({ aperture: v as Aperture }); }} appearance="filled" />
              </div>
              <div className="fs-lighting__slider-row">
                <label htmlFor={focusId} className="fs-row__label">
                  Focus distance
                </label>
                <span className="fs-lighting__value" aria-hidden="true">{`${focus.toFixed(1)} m${shot.focus === null ? ' · target' : ''}`}</span>
              </div>
              <input
                id={focusId}
                className="fs-sun__slider fs-lighting__slider"
                type="range"
                min={0}
                max={1000}
                step={1}
                value={Math.round(Math.max(0, Math.min(1, focusToSlider(focus))) * 1000)}
                aria-valuetext={`${focus.toFixed(1)} metres`}
                onChange={(e) => { set({ focus: sliderToFocus(Number(e.target.value) / 1000) }); }}
              />
              <Button size="sm" variant="ghost" icon={<Crosshair />} disabled={shot.focus === null} onClick={() => { set({ focus: null }); }}>
                Focus on target
              </Button>
              <p className="fs-lighting__hint">Depth of field is drawn in stills and shot lists; the live view stays sharp.</p>
            </>
          ) : null}

          <hr className="fs-camera__rule" />
          <div className="fs-lighting__slider-row">
            <label htmlFor={evId} className="fs-row__label">
              Exposure
            </label>
            <span className="fs-lighting__value" aria-hidden="true">{evWords(shot.exposure)}</span>
          </div>
          <input
            id={evId}
            className="fs-sun__slider fs-lighting__slider"
            type="range"
            min={-30}
            max={30}
            step={1}
            list={`${evId}-ticks`}
            value={shot.exposure}
            aria-valuetext={evWords(shot.exposure)}
            onChange={(e) => { set({ exposure: Number(e.target.value) }); }}
          />
          <datalist id={`${evId}-ticks`}>
            <option value={0} />
          </datalist>
          <div className="fs-camera__range" aria-hidden="true">
            <span>−3</span>
            <span>0</span>
            <span>+3</span>
          </div>

          <hr className="fs-camera__rule" />
          <span className="fs-overline">Frame</span>
          <SegmentedControl aria-label="Aspect" size="sm" value={shot.aspect} items={ASPECT_ITEMS} onValueChange={(v) => { set({ aspect: v as Aspect }); }} />
          <Switch checked={shot.guides} onCheckedChange={(on) => { set({ guides: on }); }}>
            Framing guides
          </Switch>
          <p className="fs-lighting__hint">Rule of thirds and a centre mark; outside the frame is dimmed.</p>
        </div>

        <footer className="fs-camera__foot">
          <Button size="sm" variant="primary" icon={<Images />} disabled={views.length === 0} onClick={() => { setShots(true); }}>
            Shot list…
          </Button>
          <FilmButton store={store} />
          <span className="fs-caption">Stills, or a film</span>
        </footer>
      </section>
      {shots ? (
        <Suspense fallback={null}>
          <ShotListDialog store={store} model={model} onClose={() => { setShots(false); }} />
        </Suspense>
      ) : null}
    </>
  );
}

