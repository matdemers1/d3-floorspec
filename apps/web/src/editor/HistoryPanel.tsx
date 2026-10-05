import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Avatar, Badge, Button, IconButton, Select, Spinner } from '@d3cloud/ui';
import { GitCompareArrows, Redo2, Undo2, X } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import type { HistoryEntry } from './api';
import { labelOf } from './model';
import { summarizeBatch } from './describe';
import { diffModels, groupChanges } from './diff';
import { authorOf, closeHistory, compare, compareOp, endCompare, versionsOf } from './history';
import { timeAgo } from '../projects/model';
import { useDiff } from './Canvas';

/**
 * The history (FLR-T-3.6), in the left column where the project tree is — the board's "10 ·
 * History & compare". Each op: its version, who wrote it, what kind, when, and what it did.
 * Selecting one compares the version before it with the version after; Shift extends a comparison
 * to any two versions. Undo appends the inverse of the newest op still in effect; the log is never
 * rewritten.
 */
export function HistoryPanel({ store, you }: { store: EditorStore; you: string }) {
  const log = useEditor(store, (s) => s.log);
  const tokens = useEditor(store, (s) => s.tokenNames);
  const history = useEditor(store, (s) => s.history);
  const cmp = useEditor(store, (s) => s.compare);
  const model = useEditor(store, (s) => s.model);
  const pending = useEditor(store, (s) => s.pending);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const units = useEditor(store, () => store.units);
  const [focused, setFocused] = useState(0);
  const rows = useRef(new Map<number, HTMLDivElement>());

  const seqOf = useMemo(() => new Map((log ?? []).map((e) => [e.after, e.seq])), [log]);
  if (log === null) return <Spinner label="Loading the history" />;

  const name = (id: string) => (model?.index.has(id) === true ? labelOf(model, id) : id);
  // What redo would bring back: the op the newest undo took back.
  const redoEntry = history.redo === null ? undefined : log.find((e) => e.seq === history.redo);
  const redoOf = redoEntry === undefined ? null : (redoEntry.undoOf ?? redoEntry.seq);
  const inRange = (e: HistoryEntry) => {
    if (cmp === null) return false;
    const from = seqOf.get(cmp.from) ?? -Infinity;
    const to = seqOf.get(cmp.to) ?? Infinity;
    const [lo, hi] = from < to ? [from, to] : [to, from];
    return e.seq > lo && e.seq <= hi;
  };
  const pick = (e: HistoryEntry, extend: boolean) => {
    if (extend && cmp !== null && e.before !== null) {
      // Extend: from the older end of what is shown to this op, either way.
      const a = seqOf.get(cmp.from) ?? 0;
      void (e.seq > a ? compare(store, cmp.from, e.after) : compare(store, e.before, cmp.to));
    } else compareOp(store, e);
  };
  const move = (i: number) => {
    const next = Math.max(0, Math.min(log.length - 1, i));
    setFocused(next);
    rows.current.get(next)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number, entry: HistoryEntry) => {
    const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(log.length - 1);
    else pick(entry, e.shiftKey);
  };

  return (
    <nav className="fs-history" aria-label="History">
      <div className="fs-panel-head">
        <span className="fs-overline">History</span>
        <Badge tone="neutral">append-only</Badge>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Back to the project tree" icon={<X />} onClick={() => { closeHistory(store); }} />
      </div>
      {/* Undo and redo sit above the versions, not on a row: a button inside an option is an
          interactive control nested in another, which a screen reader cannot reach (axe
          nested-interactive). */}
      {history.undo !== null || redoOf !== null ? (
        <div className="fs-history__actions">
          {history.undo !== null ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Undo2 />}
              disabled={pending !== null || readOnly !== null}
              onClick={() => {
                endCompare(store);
                void store.undo('undo');
              }}
            >
              Undo v{String(history.undo)}
            </Button>
          ) : null}
          {redoOf !== null ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Redo2 />}
              disabled={pending !== null || readOnly !== null}
              onClick={() => {
                endCompare(store);
                void store.undo('redo');
              }}
            >
              Redo v{String(redoOf)}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div role="listbox" aria-label="Versions, newest first" className="fs-history__rows">
        {log.map((entry, i) => {
          const who = authorOf(entry, tokens);
          const kind = entry.kind === 'apply' ? null : entry.kind;
          const what =
            entry.kind === 'create'
              ? 'Created the project'
              : entry.kind === 'undo'
                ? `Undid v${String(entry.undoOf ?? '?')} — ${lowerFirst(summarizeBatch(entry.ops, units, name))}`
                : entry.kind === 'redo'
                  ? `Redid v${String(entry.undoOf ?? '?')}`
                  : `${entry.changeset !== null ? `Accepted “${entry.changeset.name}” · ` : ''}${summarizeBatch(entry.ops, units, name)}`;
          const selected = cmp !== null && inRange(entry);
          return (
            <div
              key={entry.seq}
              ref={(el) => {
                if (el === null) rows.current.delete(i);
                else rows.current.set(i, el);
              }}
              role="option"
              aria-selected={selected}
              tabIndex={i === focused ? 0 : -1}
              className={['fs-history__row', selected ? 'is-selected' : ''].join(' ')}
              onClick={(e) => { setFocused(i); pick(entry, e.shiftKey); }}
              onKeyDown={(e) => { onKey(e, i, entry); }}
            >
              <span className="fs-history__v">v{entry.seq}</span>
              <Avatar name={who.kind === 'you' ? you : who.name} size="xs" />
              <span className="fs-history__text">
                <span className="fs-history__what">{what}</span>
                <span className="fs-history__meta">
                  {who.name}
                  {who.kind === 'token' ? ' · token' : who.kind === 'agent' ? ' · agent' : ''}
                  {kind === null ? '' : ` · ${kind}`} · {timeAgo(entry.at)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="fs-note fs-history__note">Enter compares an op’s before and after; Shift+Enter extends to any two versions. Undo appends the inverse as a new version — nothing is rewritten.</p>
    </nav>
  );
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** The comparison, in the right column: the two versions, the legend's counts, and every change. */
export function ComparePanel({ store }: { store: EditorStore }) {
  const cmp = useEditor(store, (s) => s.compare);
  const log = useEditor(store, (s) => s.log);
  const history = useEditor(store, (s) => s.history);
  const pending = useEditor(store, (s) => s.pending);
  const d = useDiff(store);
  if (cmp === null) return null;
  const versions = versionsOf(log ?? []);
  const label = (hash: string) => versions.find((v) => v.hash === hash)?.label ?? hash.slice(0, 7);
  const groups = d === null ? [] : groupChanges(d.diff);
  const authors = new Set((log ?? []).filter((e) => {
    const lo = versions.find((v) => v.hash === cmp.from)?.seq ?? 0;
    const hi = versions.find((v) => v.hash === cmp.to)?.seq ?? 0;
    return e.seq > Math.min(lo, hi) && e.seq <= Math.max(lo, hi);
  }).map((e) => `${e.author.kind}:${e.author.name ?? e.author.token ?? ''}`));
  const options = versions.map((v) => ({ value: v.hash, label: v.label }));
  return (
    <div className="fs-inspector__body fs-compare" role="group" aria-label="Compare versions">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <GitCompareArrows />
        </span>
        <div className="fs-inspector__title">
          <h2>
            Compare {label(cmp.from)} → {label(cmp.to)}
          </h2>
          <p>
            {d === null ? 'Loading…' : `${String(d.diff.changes.length)} ${d.diff.changes.length === 1 ? 'change' : 'changes'} · ${String(authors.size)} ${authors.size === 1 ? 'author' : 'authors'}`}
          </p>
        </div>
        <IconButton size="sm" label="Close the comparison" icon={<X />} onClick={() => { endCompare(store); }} />
      </div>
      <div className="fs-compare__pick">
        <Select aria-label="From version" appearance="filled" options={options} value={cmp.from} onValueChange={(v) => void compare(store, v, cmp.to)} />
        <span aria-hidden="true">→</span>
        <Select aria-label="To version" appearance="filled" options={options} value={cmp.to} onValueChange={(v) => void compare(store, cmp.from, v)} />
      </div>
      {cmp.loading ? <Spinner label="Reading both versions" /> : null}
      {cmp.error !== null ? <p className="fs-note">{cmp.error}</p> : null}
      {d !== null && d.diff.changes.length === 0 ? <p className="fs-note">No differences: these versions hold the same model.</p> : null}
      {groups.map((g) => (
        <div key={g.kind} className="fs-changes">
          <h4 className={`fs-changes__title fs-changes__title--${g.kind}`}>
            {g.title} · {String(g.changes.length)}
          </h4>
          <ul>
            {g.changes.map((c) => (
              <li key={c.id}>
                <span>{c.label}</span>
                {c.detail === undefined ? null : <span className="fs-changes__detail">{c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="fs-review__actions">
        <Button variant="secondary" icon={<Undo2 />} disabled={history.undo === null || pending !== null} onClick={() => { endCompare(store); void store.undo('undo'); }}>
          Undo v{String(history.undo ?? '')}
        </Button>
        <Button variant="ghost" onClick={() => { endCompare(store); }}>
          Back to the plan
        </Button>
      </div>
      <p className="fs-note">Undo never rewrites history: it appends the inverse of the newest op still in effect as a new version.</p>
      {d === null ? null : <SummaryLine counts={d.diff.counts} />}
    </div>
  );
}

function SummaryLine({ counts }: { counts: ReturnType<typeof diffModels>['counts'] }) {
  return (
    <p className="fs-note fs-compare__sum">
      {String(counts.added)} added · {String(counts.removed)} removed · {String(counts.moved)} moved · {String(counts.changed)} changed
    </p>
  );
}
