import '../../editor/three/film/film.css';
import './tour.css';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Modal, Select, Spinner, useToast } from '@d3cloud/ui';
import { Copy, Download, ExternalLink, Link2, QrCode, Rotate3d } from 'lucide-react';
import { messageOf } from '../../lib/api';
import { qrShape } from '../../lib/qr';
import { fetchHead } from '../../editor/api';
import { cancelExport, getExport, listExports, requestExport, startDownload, tourProgress, type ExportJob, type TourRequest } from '../../exports/api';
import { createShare } from '../api';
import { doorwaysLinked, EYE_HEIGHTS, PANORAMAS, tourPlanOf, type TourPlan } from './make';

/**
 * Share ▸ Virtual tour… (FLR-T-14.2; the board's "14.2 · Make a virtual tour"): the rooms to tour —
 * those a tour visits by default ticked, the first opening it — where each is seen from (its centre,
 * or a saved view standing in it), the eye height, the panoramas' size, and the one light every room
 * is seen in. Render makes the tour a job on the server and, at once, a share link of its own: view
 * only, the tour alone, revocable under Share like any link. The job card that follows counts the
 * panoramas made — never a time — with the link to copy or scan.
 */

const LINK_DAYS = 365;
/** "Stands at": the room's centre, rather than a saved view (whose IDs never have a space). */
const CENTRE = 'room centre';
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

interface Made {
  readonly job: ExportJob;
  /** The tour's link: shown now, never again (the server keeps only its hash). */
  readonly url: string | null;
}

export function TourDialog({ projectId, projectName, open, onOpenChange }: { projectId: string; projectName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<TourPlan | null | 'loading'>('loading');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [stands, setStands] = useState<Readonly<Record<string, string>>>({});
  const [eye, setEye] = useState<number>(EYE_HEIGHTS[1].value);
  const [panorama, setPanorama] = useState<string>(PANORAMAS[0].value);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState(false);

  // Opened: the model's rooms, read afresh; and a tour already rendering for this project, followed.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPlan('loading');
    setError(null);
    setQr(false);
    void fetchHead(projectId)
      .then((head) => {
        if (!live) return;
        const read = head === null ? null : tourPlanOf(head.text);
        setPlan(read);
        if (read === null) return;
        setChosen(new Set(read.rooms.filter((r) => r.byDefault).map((r) => r.id)));
        setStands(Object.fromEntries(read.rooms.flatMap((r) => (r.views[0] === undefined ? [] : [[r.id, r.views[0].id]]))));
      })
      .catch((caught: unknown) => { if (live) { setPlan(null); setError(messageOf(caught)); } });
    void listExports(projectId)
      .then((jobs) => {
        const running = jobs.find((j) => j.kind === 'tour' && (j.status === 'queued' || j.status === 'running'));
        if (live && running !== undefined) setMade((m) => m ?? { job: running, url: null });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open, projectId]);

  // The job, followed while it renders.
  const jobId = made?.job.id ?? null;
  const pending = made !== null && (made.job.status === 'queued' || made.job.status === 'running');
  useEffect(() => {
    if (jobId === null || !pending || !open) return;
    let live = true;
    const timer = window.setInterval(() => {
      void getExport(projectId, jobId)
        .then((job) => {
          // A look that left before a cancel landed never puts a stopped tour back to rendering.
          if (live) setMade((m) => (m === null || m.job.id !== job.id || ((m.job.status === 'done' || m.job.status === 'failed') && (job.status === 'queued' || job.status === 'running')) ? m : { ...m, job }));
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [jobId, pending, open, projectId]);

  const rows = plan === 'loading' || plan === null ? [] : plan.rooms;
  const order = rows.filter((r) => chosen.has(r.id));
  const doorways = plan === 'loading' || plan === null ? 0 : doorwaysLinked(plan, chosen);
  const [size, quality] = panorama.split(':') as [NonNullable<TourRequest['size']>, NonNullable<TourRequest['quality']>];
  const sizeWords = PANORAMAS.find((p) => p.value === panorama)?.label ?? '';

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  const render = async () => {
    if (order.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const job = await requestExport(projectId, {
        kind: 'tour',
        tour: { rooms: order.map((r) => ({ room: r.id, ...(stands[r.id] === undefined || stands[r.id] === CENTRE ? {} : { view: stands[r.id] }) })), eyeHeight: eye, size, quality },
      });
      const { url } = await createShare(projectId, { tour: job.id, expiresInDays: LINK_DAYS, label: 'Virtual tour' });
      setMade({ job, url });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => { toast.show({ message: 'Link copied. It is shown only now — keep it somewhere safe.' }); },
      () => { toast.show({ message: 'Copy did not work here: select the link and copy it.' }); },
    );
  };

  const cancel = async () => {
    if (made === null) return;
    setBusy(true);
    try {
      setMade({ ...made, job: await cancelExport(projectId, made.job.id) });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    made !== null ? (
      <>
        <Button variant="ghost" onClick={() => { setMade(null); }} disabled={pending}>
          Make another tour
        </Button>
        <Button variant="primary" onClick={() => { onOpenChange(false); }}>
          Done
        </Button>
      </>
    ) : (
      <>
        <span className="fs-tour-dialog__tally">{`${plural(order.length, 'panorama')} · ${plural(doorways, 'doorway')} linked`}</span>
        <Button variant="ghost" onClick={() => { onOpenChange(false); }}>
          Cancel
        </Button>
        <Button variant="primary" icon={<Rotate3d />} loading={busy} disabled={order.length === 0 || plan === 'loading' || plan === null} onClick={() => { void render(); }}>
          {`Render ${plural(order.length, 'panorama')} and share`}
        </Button>
      </>
    );

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title="Make a virtual tour" description="A 360° panorama from every room, linked at the doorways, shared as one link. It opens on a phone." footer={footer} className="fs-tour-modal">
      <div className="fs-tour-dialog">
        {error === null ? null : (
          <Alert tone="danger" title="That did not work" dynamic>
            {error}
          </Alert>
        )}
        {made !== null ? (
          <TourJobCard made={made} busy={busy} qr={qr} onQr={() => { setQr(!qr); }} onCopy={copy} onCancel={() => { void cancel(); }} projectName={projectName} />
        ) : plan === 'loading' ? (
          <Spinner label="Reading the rooms" />
        ) : plan === null ? (
          <p className="fs-note">This model cannot be toured yet: it is not valid, or it has no rooms.</p>
        ) : (
          <>
            <div className="fs-tour-dialog__head" aria-hidden="true">
              <span className="fs-overline">{`Rooms · ${String(order.length)} of ${String(rows.length)}`}</span>
              <span className="fs-overline">Stands at</span>
            </div>
            <ul className="fs-tour-rooms" aria-label={`Rooms · ${String(order.length)} of ${String(rows.length)}`}>
              {rows.map((r) => {
                const on = chosen.has(r.id);
                const first = order[0]?.id === r.id;
                return (
                  <li key={r.id} className="fs-tour-rooms__row" data-on={on}>
                    <Checkbox label={r.name} checked={on} onCheckedChange={(v) => { toggle(r.id, v === true); }} />
                    <span className="fs-tour-rooms__level">{r.levelName}</span>
                    {first ? <Badge tone="attention" size="sm">Starts here</Badge> : null}
                    <span className="fs-spacer" />
                    {on ? (
                      <span className="fs-tour-rooms__stands">
                        <Select
                          size="sm"
                          aria-label={`Where ${r.name} is seen from`}
                          value={stands[r.id] ?? CENTRE}
                          onValueChange={(v) => { setStands({ ...stands, [r.id]: v }); }}
                          options={[{ value: CENTRE, label: 'Room centre' }, ...r.views.map((v) => ({ value: v.id, label: `Saved view · ${v.name}` }))]}
                        />
                      </span>
                    ) : (
                      <span className="fs-tour-rooms__off" aria-hidden="true">—</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="fs-tour-dialog__facts">
              <div className="fs-tour-dialog__fact">
                <span className="fs-overline" aria-hidden="true">Eye height</span>
                <Select size="sm" aria-label="Eye height" value={String(eye)} onValueChange={(v) => { setEye(Number(v)); }} options={EYE_HEIGHTS.map((e) => ({ value: String(e.value), label: e.label }))} />
              </div>
              <div className="fs-tour-dialog__fact">
                <span className="fs-overline" aria-hidden="true">Panorama</span>
                <Select size="sm" aria-label="Panorama" value={panorama} onValueChange={setPanorama} options={PANORAMAS.map((p) => ({ value: p.value, label: p.label }))} />
              </div>
              <div className="fs-tour-dialog__fact">
                <span className="fs-overline">Light</span>
                <span className="fs-tour-dialog__value">Jun 21 · 3:00 pm</span>
              </div>
            </div>
            <div className="fs-tour-dialog__share">
              <span className="fs-overline">Share</span>
              <p className="fs-note">
                {`The link is made with the tour and shown once, here: anyone with it can look around — view only, the tour alone (no model or plans to download). Revoke it under Share. Expires in a year. ${sizeWords}.`}
              </p>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function TourJobCard({ made, busy, qr, onQr, onCopy, onCancel, projectName }: { made: Made; busy: boolean; qr: boolean; onQr: () => void; onCopy: (url: string) => void; onCancel: () => void; projectName: string }) {
  const { job, url } = made;
  const p = tourProgress(job);
  const panos = job.tour?.panos ?? p?.panos ?? 0;
  const done = job.status === 'done' ? panos : Math.max(0, (p?.pano ?? 1) - 1);
  const state = job.status === 'queued' ? 'queued' : job.status === 'running' ? 'rendering' : job.status === 'done' ? 'done' : 'failed';
  const title = job.status === 'running' ? 'Rendering the tour' : job.status === 'queued' ? 'Tour queued' : job.status === 'done' ? 'Tour ready' : job.cancelled === true ? 'Tour cancelled' : 'Tour failed';
  const shape = useMemo(() => (url === null ? null : qrShape(url)), [url]);
  const doorways = job.result?.doorways;
  return (
    <section className="fs-film-job fs-film-job--inline" aria-label="Tour job" data-state={state}>
      <header className="fs-film-job__head">
        <Rotate3d aria-hidden="true" />
        <h2 className="fs-film-job__title">{title}</h2>
      </header>
      <progress className="fs-film-job__bar" max={Math.max(1, panos)} value={done} aria-label="Panoramas made" />
      <div className="fs-film-job__count" role="status" aria-live="polite">
        <span className="fs-film-job__dot" aria-hidden="true" />
        <span>{job.status === 'done' ? `${plural(panos, 'panorama')}${doorways === undefined ? '' : ` · ${plural(doorways, 'doorway')} linked`}` : job.status === 'queued' ? plural(panos, 'panorama') : `Panorama ${String(Math.min(panos, done + 1))} of ${String(panos)}${p?.room === null || p?.room === undefined || job.status !== 'running' ? '' : ` · ${p.room}`}`}</span>
      </div>
      <p className="fs-film-job__meta">
        {job.status === 'queued'
          ? `Waiting for the renderer — one tour, film or still at a time per project. ${projectName}.`
          : job.status === 'running'
            ? 'Path-traced on the server, so you can keep editing. The link already works: it shows the tour as soon as it is made.'
            : job.status === 'done'
              ? 'Every room is up. The link opens the tour on a phone or a computer.'
              : job.cancelled === true
                ? `Cancelled after ${plural(done, 'panorama')}. The link shows that the tour was not made.`
                : (job.error ?? 'The worker gave no reason.')}
      </p>
      {url === null ? (
        <p className="fs-note">This tour’s link was shown when it was made. Revoke it, or make another, under Share.</p>
      ) : (
        <div className="fs-tour-job__link">
          <div className="fs-tour-job__url">
            <Link2 aria-hidden="true" />
            <input className="fs-tour-job__input" aria-label="The tour’s link" readOnly value={url} onFocus={(e) => { e.currentTarget.select(); }} data-testid="tour-url" />
          </div>
          <Button size="sm" variant="secondary" icon={<Copy />} onClick={() => { onCopy(url); }}>
            Copy link
          </Button>
          <Button size="sm" variant="ghost" icon={<QrCode />} aria-pressed={qr} onClick={onQr}>
            QR code
          </Button>
          <a className="fs-tour-job__open" href={url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            Open the tour
          </a>
        </div>
      )}
      {qr && shape !== null ? (
        // Dark on light to scan: a light-theme island in either theme, as the TOTP code is.
        <div className="fs-totp-qr fs-tour-job__qr" data-theme="light">
          <svg viewBox={`0 0 ${String(shape.size)} ${String(shape.size)}`} role="img" aria-label="QR code of the tour’s link" shapeRendering="crispEdges">
            <rect width={shape.size} height={shape.size} className="fs-totp-qr__light" />
            <path d={shape.path} className="fs-totp-qr__dark" />
          </svg>
        </div>
      ) : null}
      <div className="fs-film-job__actions">
        {job.status === 'queued' || job.status === 'running' ? (
          <Button size="sm" variant="ghost" loading={busy} onClick={onCancel}>
            Cancel render
          </Button>
        ) : job.status === 'done' ? (
          <Button size="sm" variant="secondary" icon={<Download />} onClick={() => { startDownload(job); }}>
            Download panoramas
          </Button>
        ) : null}
      </div>
    </section>
  );
}

