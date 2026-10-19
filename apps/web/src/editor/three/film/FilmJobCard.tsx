import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Tooltip, useToast } from '@d3cloud/ui';
import { Clapperboard, Download, Link, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';
import { filmClock } from '@floorspec/mesh';
import { messageOf } from '../../../lib/api';
import { cancelExport, filmProgress, getExport, listExports, requestExport, startDownload, type ExportJob } from '../../../exports/api';
import type { EditorStore } from '../../store';
import { filmOf, useFilmState } from './films';

/**
 * A film rendering on the server (FLR-T-14.1, the board's "14.1 · Film — rendering on the server" and
 * "Film · states"): the job card over the 3D view — queued, rendering (the frame just made, the frames
 * done of all of them and, day to night, the clock at the site in it — never a time left), done (the
 * film itself, to play, download or link to) or failed (why, and a retry). Folded away, it is a small
 * pill, and the film keeps rendering; reopening the 3D view finds a film still rendering.
 */

const SIZE_WORDS: Record<string, string> = { '720p': '720p', '1080p': '1080p', '4k': '4K' };
const megabytes = (n: number): string => (n >= 1048576 ? `${String(Math.round(n / 104857.6) / 10)} MB` : `${String(Math.max(1, Math.round(n / 1024)))} KB`);

/** What a film job is, in a line: "Courtyard walk-in · 1080p · 30 fps · MP4 · Day to night". */
export function filmJobWords(job: ExportJob): string {
  const f = job.film;
  if (f === null || f === undefined) return '';
  return [f.name ?? 'Film', SIZE_WORDS[f.size] ?? f.size, `${String(f.fps)} fps`, f.format.toUpperCase(), f.light === 'day-to-night' ? 'Day to night' : null].filter((x) => x !== null).join(' · ');
}

export function FilmJobCard({ store }: { store: EditorStore }) {
  const films = filmOf(store);
  const toast = useToast();
  const job = useFilmState(store, (s) => s.job);
  const folded = useFilmState(store, (s) => s.folded);
  const [busy, setBusy] = useState(false);
  const looked = useRef(false);

  // A film already rendering for this project when the 3D view opens: found once, and followed.
  useEffect(() => {
    if (looked.current || films.get().job !== null) return;
    looked.current = true;
    let live = true;
    void listExports(store.projectId)
      .then((jobs) => {
        const running = jobs.find((j) => j.kind === 'film' && (j.status === 'queued' || j.status === 'running'));
        if (live && running !== undefined && films.get().job === null) films.set({ job: running, folded: true });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [films, store]);

  // Following it: a look a second while it is queued or running.
  const id = job?.id ?? null;
  const pending = job !== null && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (id === null || !pending) return;
    let live = true;
    const timer = window.setInterval(() => {
      void getExport(store.projectId, id)
        .then((j) => {
          const now = films.get().job;
          // A look that left before a cancel landed never puts a stopped film back to rendering.
          const stale = now !== null && (now.status === 'done' || now.status === 'failed') && (j.status === 'queued' || j.status === 'running');
          if (live && now?.id === j.id && !stale) films.set({ job: j });
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id, pending, films, store]);

  if (job === null || job.kind !== 'film') return null;
  const f = job.film;
  const p = filmProgress(job);
  const frames = p?.frames ?? f?.frames ?? 0;
  const done = job.status === 'done' ? frames : (p?.frame ?? 0);
  const state = job.status === 'queued' ? 'Queued' : job.status === 'running' ? 'Rendering' : job.status === 'done' ? 'Done' : job.cancelled === true ? 'Cancelled' : 'Failed';
  const quality = f?.quality === 'final' ? 'Final' : 'Draft';

  const cancel = async () => {
    setBusy(true);
    try {
      films.set({ job: await cancelExport(store.projectId, job.id) });
    } catch (caught) {
      toast.show({ message: `The film was not cancelled: ${messageOf(caught)}` });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (f === null || f === undefined || f.id === null) return;
    setBusy(true);
    try {
      const again = await requestExport(store.projectId, { kind: 'film', film: { film: f.id, quality: f.quality, format: f.format, size: f.size, fps: f.fps as 24 | 30 | 60, light: f.light, ...(f.timelapse === null ? {} : { timelapse: f.timelapse }) }, ...(job.design === null ? {} : { design: job.design }) });
      films.set({ job: again, folded: false });
    } catch (caught) {
      toast.show({ message: `The film was not started again: ${messageOf(caught)}` });
    } finally {
      setBusy(false);
    }
  };

  if (folded) {
    return (
      <div className="fs-film-job fs-film-job--folded" role="status" aria-label="Film">
        <Clapperboard aria-hidden="true" />
        <span>{job.status === 'running' ? `Film · frame ${String(done)} of ${String(frames)}` : `Film · ${state.toLowerCase()}`}</span>
        <Tooltip content="Show the film’s card">
          <IconButton label="Show the film’s card" icon={<Maximize2 />} size="sm" variant="ghost" onClick={() => { films.set({ folded: false }); }} />
        </Tooltip>
      </div>
    );
  }

  const title = job.status === 'running' ? `Rendering film · ${quality}` : job.status === 'queued' ? `Film queued · ${quality}` : job.status === 'done' ? 'Film ready' : job.cancelled === true ? 'Film cancelled' : 'Film failed';
  return (
    <section className="fs-film-job" aria-label="Film job" data-state={state.toLowerCase()}>
      <header className="fs-film-job__head">
        <Clapperboard aria-hidden="true" />
        <h2 className="fs-film-job__title">{title}</h2>
        <span className="fs-spacer" />
        {job.status === 'queued' || job.status === 'running' ? (
          <Tooltip content="Fold the card away: the film keeps rendering">
            <IconButton label="Fold the film’s card" icon={<Minimize2 />} size="sm" variant="ghost" onClick={() => { films.set({ folded: true }); }} />
          </Tooltip>
        ) : (
          <Tooltip content="Close">
            <IconButton label="Close the film’s card" icon={<X />} size="sm" variant="ghost" onClick={() => { films.set({ job: null }); }} />
          </Tooltip>
        )}
      </header>
      {job.status === 'done' && job.download !== null ? (
        <video className="fs-film-job__picture" src={job.download} controls muted playsInline preload="metadata" aria-label={`${f?.name ?? 'The film'}, rendered`} />
      ) : p?.preview !== undefined && p.preview !== null ? (
        <img className="fs-film-job__picture" src={p.preview} alt={`Frame ${String(done)} of ${f?.name ?? 'the film'}`} />
      ) : (
        <div className="fs-film-job__picture fs-film-job__picture--empty" aria-hidden="true" />
      )}
      <progress className="fs-film-job__bar" max={Math.max(1, frames)} value={done} aria-label="Frames done" />
      <div className="fs-film-job__count" role="status" aria-live="polite">
        <span className="fs-film-job__dot" aria-hidden="true" />
        <span>{job.status === 'queued' ? `${String(frames)} frames` : `Frame ${String(done)} of ${String(frames)}`}</span>
        <span className="fs-spacer" />
        {p?.clock !== undefined && p.clock !== null && job.status === 'running' ? <span className="fs-film-job__clock">{`${p.clock} in the film`}</span> : null}
      </div>
      <p className="fs-film-job__meta">
        {job.status === 'queued'
          ? `Waiting for the renderer — one film at a time per project. ${filmJobWords(job)}`
          : job.status === 'done'
            ? `${job.result?.name ?? 'film'} · ${filmClock((job.result?.seconds ?? 0) * 1000)} · ${SIZE_WORDS[f?.size ?? ''] ?? ''} · ${megabytes(job.result?.size ?? 0)}`
            : job.status === 'failed'
              ? job.cancelled === true
                ? `Cancelled at frame ${String(done)} of ${String(frames)}. ${filmJobWords(job)}`
                : `${job.error ?? 'The worker gave no reason.'} ${filmJobWords(job)}`
              : filmJobWords(job)}
      </p>
      <div className="fs-film-job__actions">
        {job.status === 'queued' || job.status === 'running' ? (
          <>
            <Button size="sm" variant="ghost" className="fs-film__remove" loading={busy} onClick={() => { void cancel(); }}>
              Cancel
            </Button>
            <span className="fs-spacer" />
            <Button size="sm" variant="secondary" onClick={() => { films.set({ folded: true }); }}>
              Keep editing
            </Button>
          </>
        ) : job.status === 'done' ? (
          <>
            <Button size="sm" variant="primary" icon={<Download />} onClick={() => { startDownload(job); }}>
              Download
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Link />}
              onClick={() => {
                const url = new URL(job.download ?? '', window.location.origin).toString();
                void navigator.clipboard.writeText(url).then(
                  () => { toast.show({ message: 'Link copied: it opens for anyone signed in to this project.' }); },
                  () => { toast.show({ message: url }); },
                );
              }}
            >
              Copy link
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" icon={<RotateCcw />} loading={busy} onClick={() => { void retry(); }}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { films.set({ dialog: true, open: true }); }}>
              Change size…
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
