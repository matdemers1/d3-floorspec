import '../still/still.css';
import './camera.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Checkbox, FormField, Modal, SegmentedControl, Select, useToast } from '@d3cloud/ui';
import { Check, Download, Images, X } from 'lucide-react';
import { pictureSize, type SavedView } from '@floorspec/mesh';
import { messageOf } from '../../../lib/api';
import { QUALITIES, requestExport, SHOT_SIZES, shotWithinBudget, startDownload, untilFinished, type ExportJob, type ShotSize, type StillQuality } from '../../../exports/api';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { webGpuDevice } from '../still/gpu/probe';
import { shootOnGpu } from './gpuShot';
import { viewMeta, viewsOf } from './views';
import { readStoredZip, storedZip } from './zip';

/**
 * The shot list (FLR-T-13.10, the board's "31 · Shot list"): every saved view — or those ticked — as a
 * still, in one go. On the server, one export job traces them one after another on the worker's CPU
 * and keeps going when this closes; on this device's GPU, each is traced here in turn, as the GPU
 * still is, and saved to the version's exports as it finishes. Either way each shot keeps its own frame.
 */

type Where = 'gpu' | 'server';
type Row = { status: 'waiting' } | { status: 'rendering'; done: number } | { status: 'done'; url: string | null } | { status: 'failed'; message: string };
type Phase =
  | { kind: 'options' }
  | { kind: 'rendering'; where: Where; rows: Row[]; job: ExportJob | null; started: number }
  | { kind: 'done'; where: Where; rows: Row[]; job: ExportJob | null; zip: Blob | null }
  | { kind: 'failed'; message: string };

const QUALITY_LABELS: Record<StillQuality, string> = { draft: 'Draft', standard: 'Standard', high: 'High' };
const SHOT_LABELS: Record<ShotSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
/** The GPU's sizes (long side) and samples a pixel: up to 4K, as the GPU still. */
const GPU_LONG = [1600, 2400, 3840] as const;
const GPU_SAMPLES = { draft: 64, standard: 256, high: 1024 } as const;

const formatSeconds = (s: number): string => (s < 90 ? `${String(s)} s` : `${String(Math.round(s / 60))} min`);

export default function ShotListDialog({ store, model, onClose }: { store: EditorStore; model: EditorModel; onClose: () => void }) {
  const toast = useToast();
  const views = useMemo(() => viewsOf(model), [model]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(views.map((v) => v.id)));
  // undefined while asking the browser; null when it has no usable WebGPU.
  const [device, setDevice] = useState<string | null | undefined>(undefined);
  const [where, setWhere] = useState<Where>('server');
  const [size, setSize] = useState<ShotSize>('medium');
  const [gpuLong, setGpuLong] = useState<number>(2400);
  const [quality, setQuality] = useState<StillQuality>('standard');
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const canvas = useRef<HTMLCanvasElement>(null);
  const stop = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => {
    let live = true;
    void webGpuDevice()
      .catch(() => null)
      .then((d) => { if (live) setDevice(d); });
    return () => {
      live = false;
      stop.current?.abort();
      for (const u of urls.current) URL.revokeObjectURL(u);
    };
  }, []);

  const chosen = views.filter((v) => ticked.has(v.id));
  const tooBig = where === 'server' && !shotWithinBudget(size, quality);
  const long = where === 'server' ? SHOT_SIZES[size] : gpuLong;
  const keep = (blob: Blob): string => {
    const u = URL.createObjectURL(blob);
    urls.current.push(u);
    return u;
  };

  async function onServer(list: readonly SavedView[]) {
    const all = list.length === views.length;
    const design = Object.keys(model.design).length > 0 ? { design: { ...model.design } } : {};
    const job = await requestExport(store.projectId, { kind: 'shots', shots: { ...(all ? {} : { views: list.map((v) => v.id) }), size, quality }, ...design });
    const started = Date.now();
    const rows = (j: ExportJob): Row[] => list.map((_, i) => {
      const p = j.progress ?? null;
      const at = p?.shot === undefined ? 0 : p.shot - 1;
      return i < at ? { status: 'done', url: null } : i === at && j.status === 'running' ? { status: 'rendering', done: p === null || p.passes === 0 ? 0 : p.pass / p.passes } : { status: 'waiting' };
    });
    setPhase({ kind: 'rendering', where: 'server', rows: rows(job), job, started });
    stop.current = new AbortController();
    const done = await untilFinished(store.projectId, job, (j) => { setPhase((p) => (p.kind === 'rendering' ? { ...p, job: j, rows: rows(j) } : p)); }, stop.current.signal, 1000);
    if (stop.current.signal.aborted) return;
    if (done.status !== 'done' || done.download === null) {
      setPhase({ kind: 'failed', message: done.error ?? 'the worker gave no reason' });
      return;
    }
    // The archive back into its stills, to show them here.
    const res = await fetch(done.download, { credentials: 'same-origin' });
    const zip = new Uint8Array(await res.arrayBuffer());
    const files = readStoredZip(zip);
    const named = done.result?.shots ?? [];
    const out: Row[] = list.map((v) => {
      const file = named.find((s) => s.view === v.id)?.file;
      const f = files.find((x) => x.name === file);
      return { status: 'done', url: f === undefined ? null : keep(new Blob([f.bytes.slice()], { type: 'image/png' })) };
    });
    setPhase({ kind: 'done', where: 'server', rows: out, job: done, zip: null });
  }

  async function onGpu(list: readonly SavedView[]) {
    if (device === null || device === undefined) return;
    const controller = new AbortController();
    stop.current = controller;
    const started = Date.now();
    const rows: Row[] = list.map(() => ({ status: 'waiting' }));
    const show = () => { setPhase({ kind: 'rendering', where: 'gpu', rows: [...rows], job: null, started }); };
    show();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const exports = new Map<string, { job: ExportJob; glb: ArrayBuffer }>();
    const aborted = (): boolean => controller.signal.aborted;
    const pngs: { name: string; png: Blob }[] = [];
    for (const [i, view] of list.entries()) {
      if (controller.signal.aborted) break;
      rows[i] = { status: 'rendering', done: 0 };
      show();
      const el = canvas.current;
      if (el === null) throw new Error('the shot list has nowhere to draw');
      const [w, h] = pictureSize(gpuLong, view.aspect);
      el.width = w;
      el.height = h;
      try {
        const shot = await shootOnGpu({
          projectId: store.projectId,
          model,
          view,
          width: w,
          height: h,
          samples: GPU_SAMPLES[quality],
          canvas: el,
          device,
          signal: controller.signal,
          exports,
          onProgress: (p) => {
            rows[i] = { status: 'rendering', done: p.target === 0 ? 0 : p.samples / p.target };
            show();
          },
        });
        rows[i] = { status: 'done', url: keep(shot.png) };
        pngs.push({ name: `${String(i + 1).padStart(2, '0')}-${view.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'view'}.png`, png: shot.png });
        if (shot.saveError !== null) toast.show({ message: `“${view.name}” was not saved to the exports: ${shot.saveError}` });
      } catch (caught) {
        if (aborted()) break;
        rows[i] = { status: 'failed', message: caught instanceof Error ? caught.message : messageOf(caught) };
      }
      show();
    }
    const zip = pngs.length === 0 ? null : new Blob([storedZip(await Promise.all(pngs.map(async (p) => ({ name: p.name, bytes: new Uint8Array(await p.png.arrayBuffer()) })))).slice().buffer], { type: 'application/zip' });
    setPhase({ kind: 'done', where: 'gpu', rows: rows.map((r) => (r.status === 'waiting' || r.status === 'rendering' ? { status: 'failed', message: 'cancelled' } : r)), job: null, zip });
  }

  async function render() {
    const list = chosen;
    if (list.length === 0) return;
    try {
      if (where === 'server') await onServer(list);
      else await onGpu(list);
    } catch (caught) {
      setPhase({ kind: 'failed', message: caught instanceof Error && !(caught instanceof TypeError) ? caught.message : messageOf(caught) });
    }
  }

  function close() {
    if (phase.kind === 'rendering') {
      if (phase.where === 'server') toast.show({ message: 'The shot list keeps rendering: it will be under Exports on the dashboard.' });
      else {
        stop.current?.abort();
        toast.show({ message: 'The rest of the shot list was cancelled.' });
      }
    }
    onClose();
  }

  const list = phase.kind === 'rendering' || phase.kind === 'done' ? chosen : [];

  if (phase.kind === 'rendering') {
    const done = phase.rows.filter((r) => r.status === 'done').length;
    const current = phase.rows.reduce((n, r) => n + (r.status === 'done' ? 1 : r.status === 'rendering' ? r.done : 0), 0);
    const elapsed = (Date.now() - phase.started) / 1000;
    const left = current < 0.05 ? null : Math.max(1, Math.round((elapsed / current) * (phase.rows.length - current)));
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) close(); }}
        size="lg"
        title="Rendering the shot list…"
        description={`Rendering ${String(phase.rows.length)} shot${phase.rows.length === 1 ? '' : 's'} ${phase.where === 'server' ? 'on the server' : `on this device’s GPU (${device ?? ''})`} at long side ${String(long)} px, ${QUALITY_LABELS[quality]} quality. Each is saved to the version’s exports.`}
        footer={
          phase.where === 'server' ? (
            <Button variant="primary" onClick={close}>
              Close — keep rendering
            </Button>
          ) : (
            <Button variant="secondary" icon={<X />} onClick={() => { stop.current?.abort(); }}>
              Cancel the rest
            </Button>
          )
        }
      >
        <div className="fs-still fs-shots">
          <div className="fs-still__row" role="status" aria-live="polite">
            <span>{`${String(done)} of ${String(phase.rows.length)}${left === null ? '' : ` · about ${formatSeconds(left)} left`}`}</span>
            <span className="fs-spacer" />
            <Badge>{phase.where === 'server' ? 'The server' : 'This device'}</Badge>
          </div>
          <progress className="fs-still__progress" max={phase.rows.length} value={current} aria-label="Shot list progress" />
          <ShotRows views={list} rows={phase.rows} model={model} />
          {phase.where === 'gpu' ? <canvas ref={canvas} className="fs-shots__canvas" aria-hidden="true" /> : null}
          <p className="fs-caption">{phase.where === 'server' ? 'Closing keeps the server rendering: the shots land in Exports.' : 'Keep this open: the shots are traced here, one after another.'}</p>
        </div>
      </Modal>
    );
  }

  if (phase.kind === 'done') {
    const made = phase.rows.filter((r) => r.status === 'done').length;
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) onClose(); }}
        size="lg"
        title="Your shots are ready"
        description={`${String(made)} shot${made === 1 ? '' : 's'} rendered and saved to the version’s exports.`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              icon={<Download />}
              disabled={phase.job === null && phase.zip === null}
              onClick={() => {
                if (phase.job !== null) startDownload(phase.job);
                else if (phase.zip !== null) {
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(phase.zip);
                  a.download = 'shots.zip';
                  a.click();
                  urls.current.push(a.href);
                }
              }}
            >
              Download all (.zip)
            </Button>
          </>
        }
      >
        <div className="fs-still fs-shots">
          <div className="fs-shots__grid">
            {list.map((v, i) => {
              const r = phase.rows[i];
              const [w, h] = pictureSize(long, v.aspect);
              return (
                <figure key={v.id} className="fs-shots__still">
                  {r?.status === 'done' && r.url !== null ? (
                    <a href={r.url} target="_blank" rel="noreferrer">
                      <img src={r.url} alt={`${v.name}, rendered`} style={{ aspectRatio: `${String(w)} / ${String(h)}` }} />
                    </a>
                  ) : (
                    <div className="fs-shots__missing" style={{ aspectRatio: `${String(w)} / ${String(h)}` }}>{r?.status === 'failed' ? r.message : 'Not shown'}</div>
                  )}
                  <figcaption>
                    <span className="fs-shots__name">{v.name}</span>
                    <span className="fs-shots__size">{`${v.aspect} · ${String(w)} × ${String(h)}`}</span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
          <p className="fs-caption">Open one to see it full size, or find them all in Exports.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="lg"
      title="Shot list"
      description="Render every saved view as a still, in one go. Each is saved to the version’s exports."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Images />} disabled={chosen.length === 0 || tooBig || (where === 'gpu' && !device)} onClick={() => { void render(); }}>
            {`Render ${String(chosen.length)} shot${chosen.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="fs-still fs-shots">
        {phase.kind === 'failed' ? (
          <Alert tone="danger" title="The shot list was not rendered" dynamic>
            {phase.message}
          </Alert>
        ) : null}
        <div className="fs-shots__list" role="group" aria-label="Saved views">
          <div className="fs-shots__head">
            <Checkbox
              label="All saved views"
              checked={chosen.length === views.length ? true : chosen.length === 0 ? false : 'indeterminate'}
              onCheckedChange={(on) => { setTicked(new Set(on === true ? views.map((v) => v.id) : [])); }}
            />
            <span className="fs-shots__count">{`${String(chosen.length)} of ${String(views.length)}`}</span>
          </div>
          {views.map((v) => (
            <div key={v.id} className="fs-shots__item">
              <Checkbox
                label={v.name}
                checked={ticked.has(v.id)}
                onCheckedChange={(on) => {
                  const next = new Set(ticked);
                  if (on === true) next.add(v.id);
                  else next.delete(v.id);
                  setTicked(next);
                }}
              />
              <span className="fs-shots__meta">{viewMeta(model, v)}</span>
              <Badge>{v.lights === 'on' ? 'Lamps' : v.sky === 'studio' ? 'Studio' : 'Sun'}</Badge>
            </div>
          ))}
        </div>
        <FormField label="Render on" help={device === null ? 'This browser has no WebGPU: the server renders them.' : 'The server keeps going when you close this; this device needs the tab left open.'}>
          <SegmentedControl
            aria-label="Render on"
            value={where}
            onValueChange={(v) => { setWhere(v === 'gpu' ? 'gpu' : 'server'); }}
            items={[
              { value: 'gpu', label: 'This device’s GPU', disabled: !device },
              { value: 'server', label: 'The server' },
            ]}
          />
        </FormField>
        {where === 'server' ? (
          <FormField label="Size" help="Each shot keeps its own frame: the long side is this many pixels.">
            <Select options={(Object.keys(SHOT_SIZES) as ShotSize[]).map((s) => ({ value: s, label: `${SHOT_LABELS[s]} · long side ${String(SHOT_SIZES[s])} px` }))} value={size} onValueChange={(v) => { setSize(v as ShotSize); }} appearance="filled" />
          </FormField>
        ) : (
          <FormField label="Size" help="Each shot keeps its own frame: the long side is this many pixels.">
            <Select options={GPU_LONG.map((n) => ({ value: String(n), label: `Long side ${String(n)} px` }))} value={String(gpuLong)} onValueChange={(v) => { setGpuLong(Number(v)); }} appearance="filled" />
          </FormField>
        )}
        <FormField label="Quality" help="More samples a pixel: less grain, longer to render." error={tooBig ? `${SHOT_LABELS[size]} at ${QUALITY_LABELS[quality]} is more work than a still may take on the server: choose a smaller size or a lower quality.` : undefined}>
          <Select
            options={(Object.keys(QUALITIES) as StillQuality[]).map((q) => ({ value: q, label: `${QUALITY_LABELS[q]} · ${String(where === 'server' ? QUALITIES[q] : GPU_SAMPLES[q])} samples a pixel` }))}
            value={quality}
            onValueChange={(v) => { setQuality(v as StillQuality); }}
            appearance="filled"
          />
        </FormField>
      </div>
    </Modal>
  );
}

function ShotRows({ views, rows, model }: { views: readonly SavedView[]; rows: readonly Row[]; model: EditorModel }) {
  return (
    <ul className="fs-shots__rows">
      {views.map((v, i) => {
        const r = rows[i] ?? { status: 'waiting' };
        return (
          <li key={v.id} className="fs-shots__row" data-status={r.status}>
            {r.status === 'done' && r.url !== null ? <img className="fs-shots__thumb" src={r.url} alt="" /> : <span className="fs-shots__thumb" aria-hidden="true" />}
            <span className="fs-shots__label">
              <span className="fs-shots__name">{v.name}</span>
              <span className="fs-shots__meta">{viewMeta(model, v)}</span>
            </span>
            <span className="fs-shots__state">
              {r.status === 'done' ? (
                <>
                  <Check aria-hidden="true" /> Done
                </>
              ) : r.status === 'rendering' ? (
                <>
                  {`Rendering ${String(Math.round(r.done * 100))} %`}
                  <progress className="fs-shots__bar" max={1} value={r.done} aria-label={`${v.name} progress`} />
                </>
              ) : r.status === 'failed' ? (
                `Failed: ${r.message}`
              ) : (
                'Waiting'
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
