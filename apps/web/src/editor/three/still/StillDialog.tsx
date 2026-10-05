import './still.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, FormField, Modal, Select, useToast } from '@d3cloud/ui';
import { Download, Sparkles } from 'lucide-react';
import { messageOf } from '../../../lib/api';
import { QUALITIES, requestExport, SIZES, startDownload, stillWithinBudget as withinBudget, untilFinished, type ExportJob, type StillQuality as Quality, type StillRequest, type StillSize as Size } from '../../../exports/api';
import { useEditor, type EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { PRESET_ORDER, PRESETS, type PresetId } from '../camera';
import { useStudy, useSunState } from '../sun/study';

/**
 * Render a still (FLR-T-12.6, FLR-REQ-154; the board's "28 · Path-traced still"): a path-traced
 * picture of a view of main — one of the named views, or standing in a room — rendered offline by the
 * worker, polled here like an export, and downloaded as a PNG. Labelled for what it is: an offline
 * render with approximate lighting, one sun and a clear sky, which takes a while.
 */

type Phase = { kind: 'options' } | { kind: 'rendering'; job: ExportJob; started: number } | { kind: 'done'; job: ExportJob } | { kind: 'failed'; message: string };

const SIZE_LABELS: Record<Size, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
const QUALITY_LABELS: Record<Quality, string> = { draft: 'Draft', standard: 'Standard', high: 'High' };

export function StillButton({ store, preset, level }: { store: EditorStore; preset: PresetId | null; level: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fs-three__still">
      <Button size="sm" variant="secondary" icon={<Sparkles />} onClick={() => { setOpen(true); }}>
        Render still
      </Button>
      {open ? <StillDialog store={store} preset={preset} level={level} onClose={() => { setOpen(false); }} /> : null}
    </div>
  );
}

function StillDialog({ store, preset, level, onClose }: { store: EditorStore; preset: PresetId | null; level: string | null; onClose: () => void }) {
  const model = useEditor(store, (s) => s.model);
  const sun = useSunState(store, (s) => s);
  const study = useStudy(model, sun.on, sun.clock);
  const toast = useToast();
  const [view, setView] = useState<string>(preset ?? 'sw');
  const [size, setSize] = useState<Size>('medium');
  const [quality, setQuality] = useState<Quality>('standard');
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  const rooms = useMemo(() => roomsOf(model), [model]);
  const views = [
    ...PRESET_ORDER.map((p) => ({ value: p, label: `${PRESETS[p].label}${p === preset ? ' — the view you are looking at' : ''}` })),
    ...rooms.map((r) => ({ value: `room:${r.id}`, label: `Stand in ${r.name}`, description: 'From its doorway, as a walkthrough does' })),
  ];
  const useSun = study !== null && !study.night;
  const sunText = useSun
    ? `Sun from the sun study: ${String(Math.round(study.position.azimuth))}° azimuth, ${String(Math.round(study.position.altitude))}° up.`
    : 'Sun: mid-afternoon from the south-west (turn on the sun study to choose the date and time).';
  const tooBig = !withinBudget(size, quality);

  async function render() {
    if (model === null) return;
    const room = view.startsWith('room:') ? view.slice(5) : undefined;
    const still: StillRequest = {
      ...(room === undefined ? { camera: view as PresetId, ...(level === null ? {} : { level }) } : { room }),
      size,
      quality,
      ...(useSun ? { sun: { azimuth: Math.round(study.position.azimuth * 10) / 10, altitude: Math.round(study.position.altitude * 10) / 10 } } : {}),
    };
    const design = Object.keys(model.design).length > 0 ? { design: { ...model.design } } : {};
    try {
      const job = await requestExport(store.projectId, { kind: 'still', still, ...design });
      const started = Date.now();
      setPhase({ kind: 'rendering', job, started });
      stop.current = new AbortController();
      const done = await untilFinished(store.projectId, job, (j) => { setPhase((p) => (p.kind === 'rendering' ? { ...p, job: j } : p)); }, stop.current.signal, 1000);
      if (stop.current.signal.aborted) return;
      if (done.status === 'done') setPhase({ kind: 'done', job: done });
      else setPhase({ kind: 'failed', message: done.error ?? 'the worker gave no reason' });
    } catch (caught) {
      setPhase({ kind: 'failed', message: messageOf(caught) });
    }
  }

  function close() {
    if (phase.kind === 'rendering') toast.show({ message: 'The still keeps rendering: it will be under Exports on the dashboard.' });
    onClose();
  }

  if (phase.kind === 'rendering') {
    const p = phase.job.progress ?? null;
    const done = p === null ? 0 : p.pass / p.passes;
    const elapsed = (Date.now() - phase.started) / 1000;
    const left = p === null || p.pass === 0 ? null : Math.max(1, Math.round((elapsed / p.pass) * (p.passes - p.pass)));
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) close(); }}
        size="lg"
        title="Rendering a still…"
        description={`${describeView(phase.job, rooms)} · ${SIZE_LABELS[size]} ${String(SIZES[size][0])} × ${String(SIZES[size][1])} · ${QUALITY_LABELS[quality]}, ${String(QUALITIES[quality])} samples a pixel. It renders on the server: close this and keep working — the still waits under Exports for 7 days.`}
        footer={
          <Button variant="secondary" onClick={close}>
            Close — keep rendering
          </Button>
        }
      >
        <div className="fs-still">
          <progress className="fs-still__progress" max={1} value={done} aria-label="Rendering progress" />
          <div className="fs-still__row" role="status">
            <span>{p === null ? (phase.job.status === 'queued' ? 'Waiting for the worker…' : 'Starting…') : `Pass ${String(p.pass)} of ${String(p.passes)} · ${String(Math.round(done * 100))}%`}</span>
            <span className="fs-spacer" />
            <span>{left === null ? '' : `about ${formatSeconds(left)} left`}</span>
          </div>
          <p className="fs-caption">Each pass adds one sample to every pixel; the picture is ready after the last. Approximate lighting — one sun and a clear sky.</p>
        </div>
      </Modal>
    );
  }

  if (phase.kind === 'done') {
    const r = phase.job.result;
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) onClose(); }}
        size="lg"
        title="Your still is ready"
        description="Offline path-traced render — approximate lighting, not a daylight study."
        footer={
          <>
            <Button variant="secondary" onClick={() => { setPhase({ kind: 'options' }); }}>
              Render another
            </Button>
            <Button variant="primary" icon={<Download />} onClick={() => { startDownload(phase.job); }}>
              Download PNG
            </Button>
          </>
        }
      >
        <div className="fs-still">
          {phase.job.download === null ? null : <img className="fs-still__image" src={phase.job.download} alt={`Path-traced still: ${r?.camera ?? 'the house'}`} width={r?.width} height={r?.height} />}
          <p className="fs-caption">
            {[r?.camera, r?.width === undefined ? null : `${String(r.width)} × ${String(r.height ?? 0)}`, r?.samples === undefined ? null : `${String(r.samples)} samples a pixel`, r?.sun === undefined ? null : `sun ${String(Math.round(r.sun.azimuth))}°, ${String(Math.round(r.sun.altitude))}° up${r.sun.source === 'default' ? ' (default)' : ''}`, phase.job.versionSeq === null ? null : `v${String(phase.job.versionSeq)}`, r?.ms === undefined ? null : `rendered in ${formatSeconds(Math.round(r.ms / 1000))}`]
              .filter((x) => x !== null && x !== undefined)
              .join(' · ')}
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
      description="A path-traced picture of a view, rendered offline on the server from the same model. The lighting is approximate — one sun and a clear sky, no lamps — and it is not a daylight study. Medium at Standard takes a minute or two; Large, High or a room inside can take several."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Sparkles />} disabled={tooBig || model === null} onClick={() => { void render(); }}>
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
        <FormField label="View" help={level !== null && !view.startsWith('room:') ? 'Cut away above this level, as the 3D view is.' : 'Or a room: stand in its doorway, as a walkthrough does.'}>
          <Select options={views} value={view} onValueChange={setView} appearance="filled" />
        </FormField>
        <FormField label="Size" help={Object.entries(SIZES).map(([k, [w, h]]) => `${SIZE_LABELS[k as Size]} ${String(w)} × ${String(h)}`).join(' · ')}>
          <Select options={(Object.keys(SIZES) as Size[]).map((s) => ({ value: s, label: `${SIZE_LABELS[s]} · ${String(SIZES[s][0])} × ${String(SIZES[s][1])}` }))} value={size} onValueChange={(v) => { setSize(v as Size); }} appearance="filled" />
        </FormField>
        <FormField label="Quality" help="More samples a pixel: less grain, longer to render." error={tooBig ? 'Large at High is more work than a still may take: choose a smaller size or a lower quality.' : undefined}>
          <Select options={(Object.keys(QUALITIES) as Quality[]).map((q) => ({ value: q, label: `${QUALITY_LABELS[q]} · ${String(QUALITIES[q])} samples a pixel` }))} value={quality} onValueChange={(v) => { setQuality(v as Quality); }} appearance="filled" />
        </FormField>
        <p className="fs-caption">{`${sunText} The same version and choices always render the same picture.`}</p>
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

function describeView(job: ExportJob, rooms: { id: string; name: string }[]): string {
  const s = job.still;
  if (s?.room) return `Standing in ${rooms.find((r) => r.id === s.room)?.name ?? s.room}`;
  const camera = s?.camera ?? 'sw';
  return camera in PRESETS ? PRESETS[camera as PresetId].label : camera;
}

function formatSeconds(s: number): string {
  return s < 90 ? `${String(s)} s` : `${String(Math.round(s / 60))} min`;
}
