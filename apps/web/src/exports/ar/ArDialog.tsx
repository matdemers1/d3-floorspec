import './ar.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, StatusDot, useToast } from '@d3cloud/ui';
import { Copy, Download, MapPin, Table2 } from 'lucide-react';
import { messageOf } from '../../lib/api';
import { qrShape } from '../../lib/qr';
import { ViewInArIcon } from '../../editor/icons';
import { createShare } from '../../share/api';
import { requestExport, untilFinished, type ArRequest, type ArScale, type ExportJob } from '../api';
import { arFragment, quickLook } from './quicklook';

/**
 * Export ▸ View in AR… (FLR-T-14.3; the board's "14.3 · View in AR — USDZ export for Quick Look"):
 * the house as a USDZ for AR Quick Look on an iPhone or iPad — at true scale, to stand on the lot and
 * walk round it and through it, or on a table at 1:50 — with what it includes. Make it, and the
 * worker builds it (anchored on the floor the phone finds, the lowest floor on the ground, maps at
 * most 2K); then a QR code sends it to a phone (a link of its own, the model alone, revocable under
 * Share), it downloads, or — on an iPhone or iPad — it opens in AR Quick Look straight away.
 */

const LINK_DAYS = 30;
const MB = 1024 * 1024;

interface Made {
  readonly job: ExportJob;
  /** The model's link, shown now and never again: what the QR code holds. */
  readonly url: string | null;
}

export const SCALES: readonly { value: ArScale; title: string; detail: string }[] = [
  { value: 'true', title: 'True scale — on the lot', detail: '1:1. Stand where the house will go and walk around it, inside and out.' },
  { value: 'table', title: 'Table scale — 1:50', detail: 'A model on a table: 1′ of house is ¼″ of model. Pinch to turn.' },
];

export function ArDialog({ open, onOpenChange, projectId, projectName, levels }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; projectName: string; levels: readonly { id: string; name: string }[] }) {
  const toast = useToast();
  const [scale, setScale] = useState<ArScale>('true');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(levels.map((l) => l.id)));
  const [include, setInclude] = useState({ roofs: true, furniture: true, fixtures: true, site: false });
  const [made, setMade] = useState<Made | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setChosen(new Set(levels.map((l) => l.id)));
      return;
    }
    abort.current?.abort();
    setMade(null);
    setAsked(null);
    setBusy(false);
    setError(null);
  }, [open, levels]);

  const request: ArRequest = { scale, ...include };
  const key = JSON.stringify([request, [...chosen].sort()]);
  // The choices moved since the model was made: make it again.
  const stale = made !== null && asked !== key;
  const lowest = levels.find((l) => chosen.has(l.id));

  const make = async () => {
    if (chosen.size === 0) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setError(null);
    try {
      const all = chosen.size === levels.length;
      const job = await requestExport(projectId, { kind: 'usdz', ar: request, ...(all ? {} : { levels: levels.filter((l) => chosen.has(l.id)).map((l) => l.id) }) });
      setAsked(key);
      // The link first: it works as soon as the model is made, and the QR code holds it.
      const { url } = await createShare(projectId, { ar: job.id, expiresInDays: LINK_DAYS, label: `AR model · ${scale === 'true' ? 'true scale' : '1:50'}` });
      setMade({ job, url });
      const finished = await untilFinished(projectId, job, (j) => { setMade((m) => (m === null || m.job.id !== j.id ? m : { ...m, job: j })); }, abort.current.signal);
      setMade((m) => (m === null || m.job.id !== finished.id ? m : { ...m, job: finished }));
      if (finished.status === 'failed') setError(finished.error ?? 'The worker gave no reason.');
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => { toast.show({ message: 'Link copied. It is shown only now — revoke it under Share.' }); },
      () => { toast.show({ message: 'Copy did not work here: select the link and copy it.' }); },
    );
  };

  const done = made?.job.status === 'done' && !stale;
  const size = made?.job.result?.size;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      className="fs-ar-modal"
      title="View in AR"
      description={`${projectName} · USDZ · AR Quick Look on an iPhone or iPad`}
      footer={
        <>
          <span className="fs-ar__status" aria-live="polite">
            {error !== null ? (
              <StatusDot tone="danger">{error}</StatusDot>
            ) : made === null ? (
              <span className="fs-note">Made on the server from this version; a link of its own sends it to a phone.</span>
            ) : stale ? (
              <StatusDot tone="attention">The choices changed: make it again.</StatusDot>
            ) : made.job.status === 'done' ? (
              <StatusDot tone="neutral">Ready · send it to a phone</StatusDot>
            ) : made.job.status === 'failed' ? (
              <StatusDot tone="danger">Not made</StatusDot>
            ) : (
              <StatusDot tone="neutral">{made.job.status === 'queued' ? 'Waiting for the worker' : 'Building the model'}</StatusDot>
            )}
          </span>
          {made === null || stale ? (
            <Button variant="primary" icon={<ViewInArIcon />} loading={busy} disabled={chosen.size === 0} onClick={() => { void make(); }}>
              {made === null ? 'Make the AR model' : 'Make it again'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => { onOpenChange(false); }}>
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="fs-ar">
        <span className="fs-overline" id="fs-ar-scale">
          Scale
        </span>
        <div role="radiogroup" aria-labelledby="fs-ar-scale" className="fs-ar__scales">
          {SCALES.map((s) => (
            <button key={s.value} type="button" role="radio" aria-checked={scale === s.value} className="fs-ar__scale" data-selected={scale === s.value ? 'true' : undefined} disabled={busy} onClick={() => { setScale(s.value); }}>
              <span className="fs-ar__scale-head">
                <span className="fs-ar__radio" aria-hidden="true" />
                {s.value === 'true' ? <MapPin aria-hidden="true" /> : <Table2 aria-hidden="true" />}
                <span className="fs-ar__scale-title">{s.title}</span>
              </span>
              <span className="fs-ar__scale-detail">{s.detail}</span>
            </button>
          ))}
        </div>
        <span className="fs-overline">Include</span>
        <div className="fs-ar__include">
          {levels.map((l) => (
            <Checkbox
              key={l.id}
              label={l.name}
              checked={chosen.has(l.id)}
              disabled={busy}
              onCheckedChange={(v) => {
                const next = new Set(chosen);
                if (v === true) next.add(l.id);
                else next.delete(l.id);
                setChosen(next);
              }}
            />
          ))}
          <Checkbox label="Roofs" checked={include.roofs} disabled={busy} onCheckedChange={(v) => { setInclude({ ...include, roofs: v === true }); }} />
          <Checkbox label="Furniture" checked={include.furniture} disabled={busy} onCheckedChange={(v) => { setInclude({ ...include, furniture: v === true }); }} />
          <Checkbox label="Fixtures and lights" checked={include.fixtures} disabled={busy} onCheckedChange={(v) => { setInclude({ ...include, fixtures: v === true }); }} />
          <Checkbox label="The lawn and site" checked={include.site} disabled={busy} onCheckedChange={(v) => { setInclude({ ...include, site: v === true }); }} />
        </div>
        <dl className="fs-ar__facts">
          <div>
            <dt className="fs-overline">Materials</dt>
            <dd>Physically based · maps ≤ 2K</dd>
          </div>
          <div>
            <dt className="fs-overline">Grounded</dt>
            <dd>{lowest === undefined ? '—' : `${lowest.name} on the ground`}</dd>
          </div>
          <div>
            <dt className="fs-overline">File</dt>
            <dd>{done && size !== undefined ? `${(size / MB).toFixed(1)} MB` : 'Once it is made'}</dd>
          </div>
        </dl>
        <span className="fs-overline">Send it to a phone</span>
        <Phone made={stale ? null : made} scale={scale} onCopy={copy} />
        {error === null ? null : (
          <Alert tone="danger" title="The AR model was not made" dynamic>
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

/** The QR code of the model's link, its download — or on an iPhone or iPad, AR Quick Look at once — and its link to copy. */
function Phone({ made, scale, onCopy }: { made: Made | null; scale: ArScale; onCopy: (url: string) => void }) {
  const url = made?.url ?? null;
  const shape = useMemo(() => (url === null ? null : qrShape(url)), [url]);
  const job = made?.job ?? null;
  const ready = job?.status === 'done' && job.download !== null;
  const fragment = arFragment(scale);
  return (
    <div className="fs-ar__phone" data-ready={ready ? 'true' : undefined}>
      {shape === null ? (
        <div className="fs-ar__qr fs-ar__qr--empty" aria-hidden="true" />
      ) : (
        // Dark on light to scan: a light-theme island in either theme, as the TOTP code is.
        <div className="fs-totp-qr fs-ar__qr" data-theme="light">
          <svg viewBox={`0 0 ${String(shape.size)} ${String(shape.size)}`} role="img" aria-label="QR code of the AR model’s link" shapeRendering="crispEdges">
            <rect width={shape.size} height={shape.size} className="fs-totp-qr__light" />
            <path d={shape.path} className="fs-totp-qr__dark" />
          </svg>
        </div>
      )}
      <div className="fs-ar__send">
        <p className="fs-ar__how">{url === null ? 'Make the model, and its code appears here: point an iPhone or iPad camera at it and it opens in AR Quick Look.' : 'Point the iPhone or iPad camera at the code; it opens in AR Quick Look. Or:'}</p>
        <div className="fs-ar__actions">
          {ready && job.download !== null && quickLook() ? (
            // AR Quick Look takes a link whose one child is an image.
            <a className="fs-ar__quicklook" rel="ar" href={`${job.download}?inline=1${fragment}`}>
              <img src="/icon-192.png" alt="View in AR" width={36} height={36} />
            </a>
          ) : null}
          {ready && job.download !== null ? (
            <a className="fs-ar__download" href={job.download} download data-testid="ar-download">
              <Download aria-hidden="true" />
              Download .usdz
            </a>
          ) : (
            <span className="fs-ar__download" aria-disabled="true">
              <Download aria-hidden="true" />
              Download .usdz
            </span>
          )}
          {url === null ? null : (
            <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => { onCopy(url); }}>
              Copy share link
            </Button>
          )}
        </div>
        {url === null ? null : <input className="fs-ar__url" aria-label="The AR model’s link" readOnly value={url} onFocus={(e) => { e.currentTarget.select(); }} data-testid="ar-url" />}
      </div>
    </div>
  );
}
