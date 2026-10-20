import { useId, useMemo } from 'react';
import { Alert, Button, IconButton, Select, StatusDot, Switch, Tooltip } from '@d3cloud/ui';
import { X } from 'lucide-react';
import type { HouseMesh } from '@floorspec/mesh';
import { labelOf, type EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { prettyLen } from '../../units';
import { HeadsetIcon, TeleportIcon } from '../../icons';
import { sunOf } from '../sun/study';
import { daylightOf } from '../../daylight/state';
import { threeOf, useThreeState } from '../mode';
import { roomAt, type World } from '../walk';
import { headsetBrowser, startOf } from './xr';
import { enterVr, exitVr, useXr, useXrSupport, xrOf } from './state';
import './xr.css';

/**
 * Walk it in VR (FLR-T-14.3; the board's "14.3 · Walk it in VR — entering WebXR from the 3D view"):
 * "Enter VR" at the end of the Experiences cluster (the read-me's "Enter VR when offered") — shown only
 * when this browser offers immersive VR (`navigator.xr.isSessionSupported('immersive-vr')`), never a
 * dead button — and the panel it opens:
 * that the headset is ready, where the walk starts and at what eye height, the comfort options, what
 * each gesture does in the headset, and Enter VR. VR is read-only: edit in 2D or 3D.
 *
 * While the headset shows the house, the screen beside it (a computer tethered to a headset, or the
 * page behind the headset's browser) says where the person is and can send them to a level or end it.
 */

const UNITS = 1_280_000;

export function EnterVrButton({ store }: { store: EditorStore }) {
  const supported = useXrSupport(store);
  const open = useXr(store, (s) => s.open);
  if (!supported) return null;
  return (
    <Tooltip content={open ? 'Close Walk it in VR' : 'Walk it in VR: the house at 1:1 in your headset'}>
      <IconButton
        label="Enter VR"
        icon={<HeadsetIcon />}
        size="sm"
        pressed={open}
        aria-haspopup="dialog"
        onClick={() => {
          const x = xrOf(store);
          if (!x.get().open) {
            // The panels over the view share one place.
            sunOf(store).set({ open: false, playing: false, lapse: false });
            daylightOf(store).set({ open: false });
            threeOf(store).set({ lightingOpen: false, cameraOpen: false, sectionOpen: false });
          }
          x.set({ open: !x.get().open, error: null });
        }}
      />
    </Tooltip>
  );
}

export function VrPanel({ store, model, world, mesh }: { store: EditorStore; model: EditorModel; world: World; mesh: HouseMesh }) {
  const x = xrOf(store);
  const s = useXr(store, (v) => v);
  const eye = useThreeState(store, (t) => t.eyeHeight);
  const ids = { title: useId(), start: useId(), eye: useId() };
  // Where the walkthrough starts (its room), and every room to start in instead.
  const rooms = useMemo(() => {
    const start = startOf(world, model, mesh, null, null);
    const entry = start === null ? null : roomAt(world, start.x, start.y, start.floor);
    const all = model.levels.flatMap((l) => l.rooms.map((r) => ({ value: r.id, label: `${labelOf(model, r.id)} · ${l.name}` })));
    return { entry: entry === null ? null : labelOf(model, entry.id), all };
  }, [model, world, mesh]);
  if (!s.open || s.session !== null) return null;
  const close = () => {
    x.set({ open: false });
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const browser = headsetBrowser(navigator.userAgent);
  return (
    <section
      className="fs-sun fs-section fs-vr"
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
        <HeadsetIcon />
        <h2 className="fs-sun__title" id={ids.title}>
          Walk it in VR
        </h2>
        <IconButton label="Close Walk it in VR" icon={<X />} size="sm" onClick={close} />
      </header>
      <div className="fs-section__body">
        <div className="fs-vr__ready">
          <StatusDot tone="neutral">{`Headset ready · ${browser} · immersive-vr`}</StatusDot>
        </div>
        {s.error === null ? null : (
          <Alert tone="danger" title="VR did not start" dynamic>
            {s.error}
          </Alert>
        )}
        <span className="fs-overline">Start</span>
        <div className="fs-vr__field">
          <label className="fs-section__label" htmlFor={ids.start}>
            Start in
          </label>
          <Select
            id={ids.start}
            size="sm"
            value={s.start ?? 'entry'}
            onValueChange={(v) => { x.set({ start: v === 'entry' ? null : v }); }}
            options={[{ value: 'entry', label: rooms.entry === null ? 'The walkthrough start' : `${rooms.entry} (the walkthrough start)` }, ...rooms.all]}
          />
        </div>
        <div className="fs-vr__field">
          <label className="fs-section__label" htmlFor={ids.eye}>
            Eye height
          </label>
          <Select
            id={ids.eye}
            size="sm"
            value={s.seated ? 'seated' : 'standing'}
            onValueChange={(v) => { x.set({ seated: v === 'seated' }); }}
            options={[
              { value: 'standing', label: 'From the headset (standing)' },
              { value: 'seated', label: `Seated · eye at ${prettyLen(Math.round(eye * UNITS), store.units)}` },
            ]}
          />
        </div>
        <span className="fs-overline">Comfort</span>
        <Switch checked={s.snap} onCheckedChange={(on) => { x.set({ snap: on }); }} className="fs-section__switch">
          Snap turn · 30°
        </Switch>
        <Switch checked={s.vignette} onCheckedChange={(on) => { x.set({ vignette: on }); }} className="fs-section__switch">
          Vignette while moving
        </Switch>
        <span className="fs-overline">In the headset</span>
        <dl className="fs-vr__gestures">
          <dt>Teleport</dt>
          <dd>Point, pull the trigger · Vision Pro: look and pinch · floors and stairs only, never through a wall</dd>
          <dt>Turn</dt>
          <dd>{s.snap ? 'Stick left/right (snap) · or turn your body' : 'Stick left/right (smooth) · or turn your body'}</dd>
          <dt>Level</dt>
          <dd>The menu at your side · Level 1 / Level 2 · or teleport up a stair</dd>
          <dt>Exit</dt>
          <dd>Exit VR on the menu · or take the headset off</dd>
        </dl>
      </div>
      <footer className="fs-section__foot">
        <Button variant="primary" size="sm" icon={<HeadsetIcon />} loading={s.starting} onClick={() => { enterVr(store); }}>
          Enter VR
        </Button>
        <span className="fs-section__caption">Read-only in VR — edit in 2D or 3D.</span>
      </footer>
    </section>
  );
}

/** While the headset shows the house: where the person is, a level to send them to, and the way out. */
export function VrStatus({ store, model, world }: { store: EditorStore; model: EditorModel; world: World }) {
  const session = useXr(store, (s) => s.session);
  const level = useXr(store, (s) => s.level);
  const room = useXr(store, (s) => s.room);
  const x = xrOf(store);
  if (session === null) return null;
  const levels = [...world.levels].sort((a, b) => b.elevation - a.elevation);
  const levelName = levels.find((l) => l.id === level)?.name ?? null;
  const where = [room === null ? null : labelOf(model, room), levelName].filter((p) => p !== null).join(' · ');
  return (
    <div className="fs-vr-status" role="status" aria-live="polite">
      <span className="fs-vr-status__title">
        <TeleportIcon />
        {`In VR${where === '' ? '' : ` · ${where}`}`}
      </span>
      <span className="fs-vr-status__note">Read-only: the headset walks the house at 1:1.</span>
      <span className="fs-spacer" />
      {levels.length > 1
        ? levels.map((l) => (
            <Button key={l.id} size="sm" variant={l.id === level ? 'secondary' : 'ghost'} aria-pressed={l.id === level} onClick={() => { x.set({ goTo: l.id }); }}>
              {l.name}
            </Button>
          ))
        : null}
      <Button size="sm" variant="secondary" icon={<X />} onClick={() => { exitVr(store); }}>
        Exit VR
      </Button>
    </div>
  );
}
