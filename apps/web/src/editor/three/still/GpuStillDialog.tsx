import './still.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, FormField, Modal, Select, Switch, useToast } from '@d3cloud/ui';
import { Download, Sparkles, X } from 'lucide-react';
import { messageOf } from '../../../lib/api';
import { requestExport, startDownload, untilFinished, uploadStill, type ExportJob } from '../../../exports/api';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { PRESET_ORDER, PRESETS, type PresetId } from '../camera';
import { siteOf, useStudy, useSunState } from '../sun/study';
import type { PerspectiveCamera } from 'three';
import type { StillCamera } from './gpu/cameras';
import { DEFAULT_SUN, type TimeOfDay } from './gpu/sky';

/**
 * Render a still on this device's GPU (FLR-T-13.13, FLR-ADR-040; the board's "28 · Path-traced
 * still", the same three steps as the server's): the version's glTF export — what Blender gets,
 * lamps, glass and lit lenses included — path-traced in a renderer of its own with WebGPU, at up to
 * 4K, denoised, and saved to the version's exports. A view the person is looking at, a named view,
 * or standing in a room; the luminaires on or off; day, dusk or night.
 *
 * Loaded only when the browser has WebGPU (StillDialog.tsx); the tracer itself (gpu/tracer.ts) only
 * when a still is rendered, so neither is in the editor's main bundle.
 */

type Phase =
  | { kind: 'options' }
  | { kind: 'exporting'; job: ExportJob | null }
  | { kind: 'tracing'; samples: number; target: number; rate: number | null; denoising: boolean; started: number }
  | { kind: 'saving' }
  | { kind: 'done'; job: ExportJob | null; url: string; width: number; height: number; label: string; ms: number; saveError: string | null }
  | { kind: 'failed'; message: string };

/** Sizes, pixels: up to 4K. 1600 × 1200 is the server's Large, for comparing the two. */
export const GPU_SIZES = {
  '1280x960': { w: 1280, h: 960, label: '1280 × 960 · 4:3' },
  '1600x1200': { w: 1600, h: 1200, label: '1600 × 1200 · 4:3' },
  '1920x1080': { w: 1920, h: 1080, label: '1920 × 1080 · HD' },
  '2560x1440': { w: 2560, h: 1440, label: '2560 × 1440 · QHD' },
  '3840x2160': { w: 3840, h: 2160, label: '3840 × 2160 · 4K' },
} as const;
type GpuSize = keyof typeof GPU_SIZES;
/** Samples a pixel: fewer is quicker and grainier before the denoiser; more, cleaner. */
export const GPU_SAMPLES = [64, 256, 512, 1024] as const;
const SAMPLE_LABELS: Record<number, string> = { 64: 'Preview', 256: 'Standard', 512: 'High', 1024: 'Very high' };

const TIMES: { value: TimeOfDay; label: string }[] = [
  { value: 'day', label: 'Day — the sun and a clear sky' },
  { value: 'dusk', label: 'Dusk — the sun down, a deep blue sky' },
  { value: 'night', label: 'Night — dark outside' },
];

const DOORS: { value: 'closed' | 'open'; label: string }[] = [
  { value: 'closed', label: 'Closed' },
  { value: 'open', label: 'Open' },
];

export interface GpuStillDialogProps {
  readonly store: EditorStore;
  readonly preset: PresetId | null;
  /** Cut away above this level, as the 3D view is (FLR-T-13.2's "Levels in 3D"). */
  readonly level: string | null;
  /** That level alone, not it and those below. */
  readonly only: boolean;
  /** The whole house drawn with its roofs. */
  readonly roof: boolean;
  /** Where the 3D view is looking, in the export's frame; null when it cannot say. */
  readonly current: (() => StillCamera | null) | null;
  /** The GPU, as the browser names it. */
  readonly device: string;
  readonly onClose: () => void;
}

export default function GpuStillDialog({ store, preset, level, only, roof, current, device, onClose }: GpuStillDialogProps) {
  const model = useEditor(store, (s) => s.model);
  const sunState = useSunState(store, (s) => s);
  const study = useStudy(model, sunState.on, sunState.clock);
  const toast = useToast();
  const [view, setView] = useState<string>(current === null ? (preset ?? 'sw') : 'current');
  const [size, setSize] = useState<GpuSize>('1600x1200');
  const [samples, setSamples] = useState<number>(256);
  const [lights, setLights] = useState(false);
  const [time, setTime] = useState<TimeOfDay>('day');
  const [doors, setDoors] = useState<'closed' | 'open'>('closed');
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const canvas = useRef<HTMLCanvasElement>(null);
  const stop = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      stop.current?.abort();
      if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const rooms = useMemo(() => roomsOf(model), [model]);
  const views = [
    ...(current === null ? [] : [{ value: 'current', label: 'The view you are looking at' }]),
    ...PRESET_ORDER.map((p) => ({ value: p, label: PRESETS[p].label })),
    ...rooms.map((r) => ({ value: `room:${r.id}`, label: `Stand in ${r.name}`, description: 'From its doorway, as a walkthrough does' })),
  ];
  const useSun = study !== null && !study.night;
  const sun = useSun ? { azimuth: study.position.azimuth, altitude: study.position.altitude } : DEFAULT_SUN;
  const { w, h } = GPU_SIZES[size];

  async function render() {
    if (model === null) return;
    const controller = new AbortController();
    stop.current = controller;
    const room = view.startsWith('room:') ? view.slice(5) : null;
    const cut = room === null ? level : null;
    const design = Object.keys(model.design).length > 0 ? { ...model.design } : undefined;
    try {
      // The version's glTF export: the scene the still is made from, as every glTF consumer gets it.
      setPhase({ kind: 'exporting', job: null });
      const levels = cut === null ? undefined : only ? [cut] : levelsUpTo(model, cut);
      const queued = await requestExport(store.projectId, { kind: 'gltf', doors, ...(levels === undefined ? {} : { levels }), ...(design === undefined ? {} : { design }) });
      setPhase({ kind: 'exporting', job: queued });
      const exported = await untilFinished(store.projectId, queued, (j) => { setPhase({ kind: 'exporting', job: j }); }, controller.signal);
      if (controller.signal.aborted) return;
      if (exported.status !== 'done' || exported.download === null) throw new Error(`the model was not exported: ${exported.error ?? 'the worker gave no reason'}`);
      const res = await fetch(exported.download, { credentials: 'same-origin', signal: controller.signal });
      if (!res.ok) throw new Error(`the model could not be read (${String(res.status)})`);
      const glb = await res.arrayBuffer();

      const [{ GLTFLoader }, scenes, { traceStill, TraceCancelled }] = await Promise.all([import('three/examples/jsm/loaders/GLTFLoader.js'), import('./gpu/scene'), import('./gpu/tracer')]);
      const gltf = await new GLTFLoader().parseAsync(glb, '');
      const house = scenes.prepareHouse(gltf.scene, { lights, cut, roofs: room !== null || cut !== null || roof });
      const chosen: StillCamera | null =
        room !== null
          ? scenes.roomCamera(gltf.cameras.filter((c): c is PerspectiveCamera => (c as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true), room)
          : view === 'current'
            ? (current?.() ?? null)
            : house.bounds === null
              ? null
              : scenes.presetCamera(view as PresetId, house.bounds, w / h);
      if (chosen === null) throw new Error(room !== null ? 'the export has no camera in that room' : 'there is nothing to look at');
      const { scene, dispose } = scenes.stillScene(gltf.scene, house.bounds, { lights, time, sun, trueNorth: siteOf(model).trueNorth });
      const camera = scenes.perspectiveOf(chosen, w / h);

      const started = Date.now();
      setPhase({ kind: 'tracing', samples: 0, target: samples, rate: null, denoising: false, started });
      // The canvas is drawn with the tracing phase: wait for it.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const el = canvas.current;
      if (el === null) throw new Error('the still has nowhere to draw');
      let traced;
      try {
        traced = await traceStill({
          canvas: el,
          scene,
          camera,
          width: w,
          height: h,
          samples,
          time,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === 'tracing' || p.phase === 'denoising') setPhase({ kind: 'tracing', samples: p.samples, target: p.target, rate: p.rate, denoising: p.phase === 'denoising', started });
          },
        });
      } catch (error) {
        if (error instanceof TraceCancelled) {
          setPhase({ kind: 'options' });
          return;
        }
        throw error;
      } finally {
        dispose();
      }

      setPhase({ kind: 'saving' });
      if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(traced.png);
      let job: ExportJob | null = null;
      let saveError: string | null = null;
      try {
        job = await uploadStill(store.projectId, traced.png, { version: exported.version, view: chosen.label, samples, ms: traced.ms, lights: lights ? 'on' : 'off', time, device, ...(design === undefined ? {} : { design }) });
      } catch (caught) {
        saveError = messageOf(caught);
      }
      setPhase({ kind: 'done', job, url: objectUrl.current, width: w, height: h, label: chosen.label, ms: traced.ms, saveError });
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPhase({ kind: 'failed', message: caught instanceof Error && !(caught instanceof TypeError) ? caught.message : messageOf(caught) });
    }
  }

  function cancel() {
    stop.current?.abort();
    setPhase({ kind: 'options' });
  }

  function close() {
    if (phase.kind === 'exporting' || phase.kind === 'tracing') {
      stop.current?.abort();
      toast.show({ message: 'The still was cancelled.' });
    }
    onClose();
  }

  const busy = phase.kind === 'exporting' || phase.kind === 'tracing' || phase.kind === 'saving';

  if (busy) {
    const tracing = phase.kind === 'tracing' ? phase : null;
    const done = tracing === null ? 0 : tracing.samples / Math.max(1, tracing.target);
    const elapsed = tracing === null ? 0 : (Date.now() - tracing.started) / 1000;
    const left = tracing === null || tracing.samples === 0 || tracing.denoising ? null : Math.max(1, Math.round((elapsed / tracing.samples) * (tracing.target - tracing.samples)));
    const status =
      phase.kind === 'exporting'
        ? 'Exporting the model as glTF…'
        : phase.kind === 'saving'
          ? 'Saving the still to the version’s exports…'
          : tracing === null || tracing.samples === 0
            ? 'Building the scene on the GPU…'
            : tracing.denoising
              ? 'Denoising…'
              : `${String(tracing.samples)} of ${String(tracing.target)} samples a pixel · ${String(Math.round(done * 100))}%`;
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) close(); }}
        size="lg"
        title="Rendering a still…"
        description={`${views.find((v) => v.value === view)?.label ?? view} · ${GPU_SIZES[size].label} · ${String(samples)} samples a pixel · ${lights ? 'lights on' : 'lights off'}, ${time}, doors ${doors}. Path-traced on this device’s GPU (${device}): keep this open until it is done.`}
        footer={
          <Button variant="secondary" icon={<X />} disabled={phase.kind === 'saving'} onClick={cancel}>
            Cancel
          </Button>
        }
      >
        <div className="fs-still">
          <canvas ref={canvas} className="fs-still__canvas" width={w} height={h} style={{ aspectRatio: `${String(w)} / ${String(h)}` }} aria-label="The still as it is traced" role="img" />
          <progress className="fs-still__progress" max={1} value={phase.kind === 'saving' ? 1 : done} aria-label="Rendering progress" />
          <div className="fs-still__row" role="status">
            <span>{status}</span>
            <span className="fs-spacer" />
            <span>{left === null ? (tracing?.rate === null || tracing === null ? '' : `${tracing.rate.toFixed(1)} samples a pixel a second`) : `about ${formatSeconds(left)} left`}</span>
          </div>
        </div>
      </Modal>
    );
  }

  if (phase.kind === 'done') {
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) onClose(); }}
        size="lg"
        title="Your still is ready"
        description={`Path-traced on this device’s GPU (${device}) and denoised. The same choices on this device render the same picture; another device may differ a little.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setPhase({ kind: 'options' }); }}>
              Render another
            </Button>
            {phase.job !== null ? (
              <Button variant="primary" icon={<Download />} onClick={() => { if (phase.job !== null) startDownload(phase.job); }}>
                Download PNG
              </Button>
            ) : (
              <Button variant="primary" icon={<Download />} onClick={() => { saveLocally(phase.url, `still-${phase.label.replace(/[^\w-]+/g, '-')}.png`); }}>
                Download PNG
              </Button>
            )}
          </>
        }
      >
        <div className="fs-still">
          {phase.saveError === null ? null : (
            <Alert tone="warning" title="The still was not saved to the exports" dynamic>
              {phase.saveError} — download it from here instead.
            </Alert>
          )}
          <img className="fs-still__image" src={phase.url} alt={`Path-traced still: ${phase.label}`} width={phase.width} height={phase.height} />
          <p className="fs-caption">
            {[phase.label, `${String(phase.width)} × ${String(phase.height)}`, `${String(samples)} samples a pixel`, lights ? 'lights on' : 'lights off', time, `rendered in ${formatSeconds(Math.round(phase.ms / 1000))}`, phase.job === null ? null : 'saved under Exports'].filter((x) => x !== null).join(' · ')}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="lg"
      title="Render a still"
      description={`A path-traced picture of a view, rendered here on this device’s GPU (${device}) from the version’s glTF export — its lamps, glass and lit lenses included — then denoised and saved to the version’s exports. Keep this open while it renders: 1600 × 1200 at Standard takes a minute or two on a laptop.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Sparkles />} disabled={model === null} onClick={() => { void render(); }}>
            Render still
          </Button>
        </>
      }
    >
      <div className="fs-still">
        {phase.kind === 'failed' ? (
          <Alert tone="danger" title="The still was not rendered" dynamic>
            {phase.message}
          </Alert>
        ) : null}
        <FormField label="View" help={level !== null && !view.startsWith('room:') ? (only ? 'This level alone, as the 3D view shows it.' : 'Cut away above this level, as the 3D view is.') : 'Or a room: stand in its doorway, as a walkthrough does.'}>
          <Select options={views} value={view} onValueChange={setView} appearance="filled" />
        </FormField>
        <FormField label="Size" help="Up to 4K. The picture is traced at this size.">
          <Select options={(Object.keys(GPU_SIZES) as GpuSize[]).map((s) => ({ value: s, label: GPU_SIZES[s].label }))} value={size} onValueChange={(v) => { setSize(v as GpuSize); }} appearance="filled" />
        </FormField>
        <FormField label="Samples" help="Samples a pixel: more is less grain before the denoiser, and longer to render.">
          <Select options={GPU_SAMPLES.map((n) => ({ value: String(n), label: `${SAMPLE_LABELS[n] ?? ''} · ${String(n)} samples a pixel` }))} value={String(samples)} onValueChange={(v) => { setSamples(Number(v)); }} appearance="filled" />
        </FormField>
        <FormField label="Doors" help="Open: swung to a right angle, slid or folded away, so a still sees through the doorways.">
          <Select options={DOORS} value={doors} onValueChange={(v) => { setDoors(v as 'closed' | 'open'); }} appearance="filled" />
        </FormField>
        <FormField label="Time of day">
          <Select options={TIMES} value={time} onValueChange={(v) => { setTime(v as TimeOfDay); }} appearance="filled" />
        </FormField>
        <Switch checked={lights} onCheckedChange={setLights}>
          Lights on — the luminaires’ lamps lit and their shades glowing
        </Switch>
        <p className="fs-caption">
          {time === 'day'
            ? useSun
              ? `Sun from the sun study: ${String(Math.round(sun.azimuth))}° azimuth, ${String(Math.round(sun.altitude))}° up.`
              : 'Sun: mid-afternoon from the south-west (turn on the sun study to choose the date and time).'
            : 'After sunset: the sky and, with the lights on, the lamps.'}
        </p>
      </div>
    </Modal>
  );
}

function roomsOf(model: EditorModel | null): { id: string; name: string }[] {
  const rooms = (model?.view.rooms ?? {}) as Record<string, { name?: string } | undefined>;
  return Object.entries(rooms)
    .filter((e): e is [string, { name?: string }] => e[1] !== undefined)
    .map(([id, r]) => ({ id, name: r.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The level a cutaway is at and every level below it, by elevation. */
function levelsUpTo(model: EditorModel, cut: string): string[] | undefined {
  const at = model.levels.find((l) => l.id === cut);
  if (at === undefined) return undefined;
  return model.levels.filter((l) => l.elevation <= at.elevation).map((l) => l.id);
}

/** Save a picture held in the page (an object URL) under a name: when it could not be saved to the exports. */
function saveLocally(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function formatSeconds(s: number): string {
  return s < 90 ? `${String(s)} s` : `${String(Math.round(s / 60))} min`;
}
