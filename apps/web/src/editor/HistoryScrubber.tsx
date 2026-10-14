import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@d3cloud/ui';
import { GitBranch, History as HistoryIcon, RotateCcw } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import type { HistoryEntry } from './api';
import { labelOf } from './model';
import { summarizeBatch } from './describe';
import { authorOf, branchFrom, closeHistory, endCompare, restoredFrom, restoreTo, scrubTo } from './history';
import { openReview, refreshProposals } from './review';
import { useDiff } from './Canvas';
import type { UnitSystem } from './units';
import './scrubber.css';

/**
 * The history scrubber (FLR-T-18.14, the board's "18.14 · History slider"), docked at the foot of
 * the plan while the history is open (⌥H). A slider over main's op log, oldest to now: scrubbed back,
 * the plan is drawn as it was at that version, with what has been added since in green and what has
 * been removed since in red. From there, Restore writes one new op that returns main to it (history
 * is appended to, never rewritten — undo takes it back), and Branch opens a changeset at it.
 */

/** What one op did, in a few words — as the history panel says it. */
export function opSummary(entry: HistoryEntry, log: readonly HistoryEntry[], units: UnitSystem, name: (id: string) => string): string {
  if (entry.kind === 'create') return 'Created the project';
  if (entry.kind === 'undo') return `Undid v${String(entry.undoOf ?? '?')}`;
  if (entry.kind === 'redo') return `Redid v${String(entry.undoOf ?? '?')}`;
  const back = restoredFrom(entry, log);
  if (back !== null) return `Returned the plan to v${String(back)}`;
  return `${entry.changeset !== null ? `Accepted “${entry.changeset.name}” · ` : ''}${summarizeBatch(entry.ops, units, name)}`;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `today ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
};
const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function HistoryScrubber({ store }: { store: EditorStore }) {
  const log = useEditor(store, (s) => s.log);
  const model = useEditor(store, (s) => s.model);
  const scrub = useEditor(store, (s) => (s.compare?.scrub === true ? s.compare : null));
  const readOnly = useEditor(store, (s) => s.readOnly);
  const pending = useEditor(store, (s) => s.pending);
  const tokens = useEditor(store, (s) => s.tokenNames);
  const units = useEditor(store, () => store.units);
  const d = useDiff(store);
  const ids = { slider: useId(), status: useId() };
  // Oldest first; the newest is now.
  const versions = useMemo(() => [...(log ?? [])].reverse(), [log]);
  const [at, setAt] = useState<number | null>(null);
  const last = versions.length - 1;
  const index = at === null || at > last ? last : at;
  const entry = versions[index];
  // A comparison ended elsewhere (Esc, the comparison's close) puts the scrubber back at now.
  useEffect(() => {
    if (scrub === null && at !== null && at !== last) setAt(null);
  }, [scrub, at, last]);

  if (log === null || model === null || entry === undefined) return null;
  const name = (id: string) => (model.index.has(id) ? labelOf(model, id) : id);
  const now = index === last;
  const who = authorOf(entry, tokens);
  const what = opSummary(entry, log, units, name);
  const ops = entry.ops.length;
  const go = (i: number) => {
    const next = Math.max(0, Math.min(last, i));
    setAt(next === last ? null : next);
    void scrubTo(store, next === last ? null : (versions[next] ?? null));
  };
  const counts = scrub !== null && d !== null ? d.diff.counts : null;
  const busy = pending !== null || scrub?.loading === true;
  const first = versions[0];
  const percent = last <= 0 ? 100 : (index / last) * 100;
  return (
    <section className="fs-scrubber" aria-label="History scrubber" data-testid="history-scrubber">
      <div className="fs-scrubber__head">
        <HistoryIcon className="fs-scrubber__icon" aria-hidden="true" />
        <span className="fs-scrubber__v">v{entry.seq}</span>
        <span className="fs-scrubber__what">
          {who.name} · “{what}” · {String(ops)} {ops === 1 ? 'op' : 'ops'} · {when(entry.at)}
        </span>
        <span className="fs-scrubber__legend">
          <span className="fs-scrubber__key fs-scrubber__key--added" aria-hidden="true" />
          added since
          <span className="fs-scrubber__key fs-scrubber__key--removed" aria-hidden="true" />
          removed since
        </span>
      </div>
      <div className="fs-scrubber__track">
        <div className="fs-scrubber__ticks" aria-hidden="true">
          {versions.map((v, i) => (
            <span
              key={v.seq}
              className={`fs-scrubber__tick${i === index ? ' is-current' : ''}${i > index ? ' is-after' : ''}`}
              style={{ left: `${String(last <= 0 ? 100 : (i / last) * 100)}%`, height: `${String(Math.min(16, 4 + v.ops.length * 2))}px` }}
            />
          ))}
        </div>
        <input
          id={ids.slider}
          className="fs-scrubber__slider"
          type="range"
          min={0}
          max={Math.max(0, last)}
          step={1}
          value={index}
          aria-label="Version"
          aria-valuetext={now ? `v${String(entry.seq)}, now` : `v${String(entry.seq)}: ${what}`}
          aria-describedby={ids.status}
          onChange={(e) => { go(Number(e.target.value)); }}
        />
      </div>
      <div className="fs-scrubber__scale">
        <span>{first === undefined ? '' : `v${String(first.seq)} · ${day(first.at)}`}</span>
        <span className="fs-scrubber__here" style={{ left: `${String(percent)}%` }}>
          v{entry.seq}
        </span>
        <span>{`v${String(versions[last]?.seq ?? '')} · now`}</span>
      </div>
      <div className="fs-scrubber__foot">
        <span id={ids.status} className="fs-scrubber__counts" role="status" data-testid="scrubber-counts">
          {now
            ? 'Now — drag back to see the plan as it was'
            : scrub?.loading === true || counts === null
              ? `Reading v${String(entry.seq)}…`
              : `${String(counts.added)} added · ${String(counts.removed)} removed · ${String(counts.moved)} moved since v${String(entry.seq)}`}
        </span>
        <span className="fs-spacer" />
        <Button
          size="sm"
          variant="secondary"
          icon={<GitBranch />}
          disabled={now || busy}
          onClick={() => {
            void branchFrom(store, entry.seq).then(async (id) => {
              if (id === null) return;
              endCompare(store);
              setAt(null);
              await refreshProposals(store);
              void openReview(store, id);
            });
          }}
        >
          Branch from v{entry.seq}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCcw />}
          disabled={now || busy || readOnly !== null}
          onClick={() => {
            setAt(null);
            void restoreTo(store, entry.seq);
          }}
        >
          Restore v{entry.seq}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setAt(null);
            closeHistory(store);
          }}
        >
          Done
        </Button>
      </div>
    </section>
  );
}
