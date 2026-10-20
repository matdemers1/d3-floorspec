import '../still/still.css';
import './compare.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, FormField, Modal, Select } from '@d3cloud/ui';
import { Camera, Download } from 'lucide-react';
import { messageOf } from '../../../lib/api';
import { lookRequest, QUALITIES, requestExport, SHOT_SIZES, shotWithinBudget, startDownload, untilFinished, type ExportJob, type ShotSize, type StillQuality } from '../../../exports/api';
import { useLook } from '../sun/study';
import { useEditor, type EditorStore } from '../../store';
import { viewsOf } from '../shot/views';
import { readStoredZip } from '../shot/zip';
import type { CompareSource } from './compare';
import { pairCameraOf, pairRequest } from './pair';

/**
 * Render pair… (FLR-T-14.4): A and B path-traced on the server from one camera — the view as it is
 * now, or a saved view — as a matched pair: the two pictures, and the swipe and side-by-side
 * composites, in one ZIP under Exports. The dialog follows the job and shows what it made.
 */

type Phase = { kind: 'options' } | { kind: 'rendering'; job: ExportJob } | { kind: 'done'; job: ExportJob; pictures: { name: string; url: string; alt: string }[] } | { kind: 'failed'; message: string };

const QUALITY_LABELS: Record<StillQuality, string> = { draft: 'Draft', standard: 'Standard', high: 'High' };
const SIZE_LABELS: Record<ShotSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
const THIS_VIEW = '__view';

export default function PairDialog({ store, a, b, labels, onClose }: { store: EditorStore; a: CompareSource; b: CompareSource; labels: { a: string; b: string }; onClose: () => void }) {
  const model = useEditor(store, (s) => s.model);
  // FLR-T-15.4: both sides in the Sky and sun panel's season, and its rain or snow.
  const look = lookRequest(useLook(store, model));
  const views = useMemo(() => (model === null ? [] : viewsOf(model)), [model]);
  const [camera, setCamera] = useState<string>(THIS_VIEW);
  const [size, setSize] = useState<ShotSize>('small');
  const [quality, setQuality] = useState<StillQuality>('draft');
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const stop = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => () => {
    stop.current?.abort();
    for (const u of urls.current) URL.revokeObjectURL(u);
  }, []);
  const tooBig = !shotWithinBudget(size, quality);

  async function render() {
    if (model === null) return;
    const shot = camera === THIS_VIEW ? pairCameraOf(store) : null;
    if (camera === THIS_VIEW && shot === null) {
      setPhase({ kind: 'failed', message: 'The 3D view has no camera yet: try again once the house is drawn.' });
      return;
    }
    try {
      const job = await requestExport(store.projectId, { kind: 'pair', pair: pairRequest({ a, b, main: model, camera: shot === null ? { view: camera } : { shot }, size, quality }), ...look });
      setPhase({ kind: 'rendering', job });
      stop.current = new AbortController();
      const done = await untilFinished(store.projectId, job, (j) => { setPhase((p) => (p.kind === 'rendering' ? { ...p, job: j } : p)); }, stop.current.signal, 1000);
      if (stop.current.signal.aborted) return;
      if (done.status !== 'done' || done.download === null) {
        setPhase({ kind: 'failed', message: done.error ?? 'the worker gave no reason' });
        return;
      }
      const res = await fetch(done.download, { credentials: 'same-origin' });
      const files = readStoredZip(new Uint8Array(await res.arrayBuffer()));
      const facts = done.result?.pair;
      const want = facts === undefined ? [] : [
        { name: facts.a.file, alt: `${labels.a}, rendered` },
        { name: facts.b.file, alt: `${labels.b}, rendered` },
        { name: facts.swipe, alt: `${labels.a} and ${labels.b}, swiped at the middle` },
      ];
      const pictures = want.flatMap((w) => {
        const f = files.find((x) => x.name === w.name);
        if (f === undefined) return [];
        const url = URL.createObjectURL(new Blob([f.bytes.slice()], { type: 'image/png' }));
        urls.current.push(url);
        return [{ ...w, url }];
      });
      setPhase({ kind: 'done', job: done, pictures });
    } catch (caught) {
      setPhase({ kind: 'failed', message: caught instanceof Error && !(caught instanceof TypeError) ? caught.message : messageOf(caught) });
    }
  }

  const close = () => {
    stop.current?.abort();
    onClose();
  };

  if (phase.kind === 'rendering') {
    const p = phase.job.progress ?? null;
    const side = p?.shot === 2 ? 'B' : 'A';
    return (
      <Modal open onOpenChange={(o) => { if (!o) close(); }} size="md" title="Rendering the pair…" description={`${labels.a} and ${labels.b}, from one camera, on the server. It keeps going if this closes, and lands in Exports.`} footer={<Button variant="primary" onClick={close}>Close — keep rendering</Button>}>
        <div className="fs-still">
          <div className="fs-still__row" role="status" aria-live="polite">
            <span>{p === null ? 'Waiting for the worker…' : `${side}: pass ${String(p.pass)} of ${String(p.passes)}`}</span>
          </div>
          <progress className="fs-still__progress" max={2} value={p === null ? 0 : (p.shot ?? 1) - 1 + (p.passes === 0 ? 0 : p.pass / p.passes)} aria-label="Pair progress" />
        </div>
      </Modal>
    );
  }

  if (phase.kind === 'done') {
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o) close(); }}
        size="lg"
        title="Your matched pair is ready"
        description={`${labels.a} and ${labels.b}, from one camera — with the swipe and side-by-side composites — saved to Exports.`}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            <Button variant="primary" icon={<Download />} onClick={() => { startDownload(phase.job); }}>
              Download the pair (.zip)
            </Button>
          </>
        }
      >
        <div className="fs-pair__pictures">
          {phase.pictures.map((p) => (
            <figure key={p.name} className="fs-pair__picture">
              <img src={p.url} alt={p.alt} />
              <figcaption>{p.name}</figcaption>
            </figure>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) close(); }}
      size="md"
      title="Render a matched pair"
      description={`${labels.a} and ${labels.b}, path-traced on the server from one camera, with a swipe and a side-by-side composite.`}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Camera />} disabled={tooBig || model === null} onClick={() => { void render(); }}>
            Render the pair
          </Button>
        </>
      }
    >
      <div className="fs-still">
        {phase.kind === 'failed' ? (
          <Alert tone="danger" title="The pair was not rendered" dynamic>
            {phase.message}
          </Alert>
        ) : null}
        <FormField label="Camera" help="Both sides are rendered through it: the same lens, frame, sky and light.">
          <Select appearance="filled" value={camera} onValueChange={setCamera} options={[{ value: THIS_VIEW, label: 'This view, as it is now' }, ...views.map((v) => ({ value: v.id, label: `Saved view · ${v.name}` }))]} />
        </FormField>
        <FormField label="Size" help="The long side of each picture; the view's frame sets the other.">
          <Select appearance="filled" options={(Object.keys(SHOT_SIZES) as ShotSize[]).map((k) => ({ value: k, label: `${SIZE_LABELS[k]} · long side ${String(SHOT_SIZES[k])} px` }))} value={size} onValueChange={(v) => { setSize(v as ShotSize); }} />
        </FormField>
        <FormField label="Quality" help="More samples a pixel: less grain, longer to render — twice, once for each side." error={tooBig ? `${SIZE_LABELS[size]} at ${QUALITY_LABELS[quality]} is more work than a still may take on the server: choose a smaller size or a lower quality.` : undefined}>
          <Select appearance="filled" options={(Object.keys(QUALITIES) as StillQuality[]).map((k) => ({ value: k, label: `${QUALITY_LABELS[k]} · ${String(QUALITIES[k])} samples a pixel` }))} value={quality} onValueChange={(v) => { setQuality(v as StillQuality); }} />
        </FormField>
      </div>
    </Modal>
  );
}
