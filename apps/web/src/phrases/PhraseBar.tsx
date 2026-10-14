import { useEffect, useRef } from 'react';
import { Button } from '@d3cloud/ui';
import { Check, MessageSquareText, X } from 'lucide-react';
import '../placing/placing.css';
import './phrases.css';
import type { LevelView, Ring } from '../editor/model';
import { labelOf } from '../editor/model';
import { useEditor, type EditorStore, type Viewport } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { describeOp } from '../editor/describe';
import { carryRiders } from '../editor/arrange/carry';
import { leftNormal } from '../editor/geometry';
import { EXAMPLES } from './grammar';
import { accept, choose, closePhrases, current, highlight, read, setText, usePhrases } from './state';

/**
 * The phrase bar (FLR-T-18.15): the quick-add bar's shell (the board's "18.7 · Quick add") with a
 * phrase in it — "push the island 6 inches north" — and under it what the phrase would do, in the
 * changeset review's terms ("09 · Changeset review"): a summary, its operations, Accept and Reject.
 * The ghost is on the plan meanwhile. A question ("which wall of the Pantry?") is a listbox, each
 * candidate lit on the plan as it is highlighted. A phrase the bar does not read gets "I can do: …"
 * and examples to start from. All of it works from the keyboard: Enter previews, then accepts; the
 * arrows move through a question's candidates; Esc rejects.
 */

/** The bar's size on screen, roughly: what it keeps clear of. */
const BAR_W = 480;
const BAR_H = 360;

/**
 * Where the bar stands: by the pointer, as quick add does — unless that covers what the phrase acts
 * on, when it moves to whichever side of the plan leaves the ghost in view.
 */
export function barPlace(view: Viewport, pointer: readonly [number, number], avoid: { x0: number; y0: number; x1: number; y1: number } | null): { left: number; top: number } {
  const clampX = (x: number) => Math.max(8, Math.min(view.w - BAR_W - 8, x));
  const clampY = (y: number) => Math.max(8, Math.min(view.h - BAR_H - 8, y));
  const at = { left: clampX(pointer[0] + 24), top: clampY(pointer[1] + 40) };
  if (avoid === null) return at;
  const pad = 16;
  const clear = (c: { left: number; top: number }) => c.left > avoid.x1 + pad || c.left + BAR_W < avoid.x0 - pad || c.top > avoid.y1 + pad || c.top + BAR_H < avoid.y0 - pad;
  const candidates = [
    at,
    { left: at.left, top: clampY(avoid.y1 + pad) },
    { left: at.left, top: clampY(avoid.y0 - pad - BAR_H) },
    { left: clampX(avoid.x1 + pad), top: at.top },
    { left: clampX(avoid.x0 - pad - BAR_W), top: at.top },
    { left: 8, top: 8 },
    { left: clampX(view.w), top: 8 },
    { left: 8, top: clampY(view.h) },
    { left: clampX(view.w), top: clampY(view.h) },
  ];
  return candidates.find(clear) ?? at;
}

/** The outlines a phrase lights for an element on a level: an item's footprint, a wall's band, a room's floor, an opening's cut. */
export function ringsOf(lv: LevelView, id: string): Ring[] {
  const d = lv.devices.find((x) => x.id === id);
  if (d !== undefined) return d.footprint.length > 2 ? [d.footprint] : [];
  const w = lv.walls.find((x) => x.id === id);
  if (w !== undefined) return [w.ring];
  const r = lv.rooms.find((x) => x.id === id);
  if (r !== undefined) return [r.outer];
  const o = lv.openings.find((x) => x.id === id);
  if (o !== undefined) {
    const host = lv.walls.find((x) => x.id === o.wall);
    const n = host === undefined ? [0, 0] : leftNormal(host.a, host.b);
    const t = (host?.thickness ?? 0) / 2 + 2_000;
    return [[[o.start[0] + n[0] * t, o.start[1] + n[1] * t], [o.end[0] + n[0] * t, o.end[1] + n[1] * t], [o.end[0] - n[0] * t, o.end[1] - n[1] * t], [o.start[0] - n[0] * t, o.start[1] - n[1] * t]]];
  }
  return [];
}

/** The elements a preview adds to a level: openings and items in it that are not in the level now. */
function addedOn(now: LevelView, next: LevelView | undefined): string[] {
  if (next === undefined) return [];
  const had = new Set([...now.openings.map((o) => o.id), ...now.devices.map((d) => d.id)]);
  return [...next.openings.map((o) => o.id), ...next.devices.map((d) => d.id)].filter((id) => !had.has(id));
}

export function PhraseBar({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const open = usePhrases(store, (s) => s.open);
  const text = usePhrases(store, (s) => s.text);
  const outcome = usePhrases(store, (s) => s.outcome);
  const index = usePhrases(store, (s) => s.index);
  const at = usePhrases(store, (s) => s.at);
  const upToDate = usePhrases(store, current);
  const preview = useEditor(store, (s) => s.preview);
  const model = useEditor(store, (s) => s.model);
  const pending = useEditor(store, (s) => s.pending);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open || model === null || at === null) return null;
  const ready = outcome?.status === 'ready' && upToDate ? outcome : null;
  const question = outcome?.status === 'choose' && upToDate ? outcome : null;
  // Keep clear of what the phrase acts on, so its ghost is seen.
  const lit = ready !== null ? ready.targets : question !== null ? question.options.flatMap((c) => c.highlight) : [];
  const points = lit.flatMap((id) => ringsOf(level, id).flat()).map((p) => toScreen(view, p));
  const avoid = points.length === 0 ? null : { x0: Math.min(...points.map((p) => p[0])), y0: Math.min(...points.map((p) => p[1])), x1: Math.max(...points.map((p) => p[0])), y1: Math.max(...points.map((p) => p[1])) };
  const { left, top } = barPlace(view, toScreen(view, at), avoid);
  const failed = outcome?.status === 'fail' && upToDate ? outcome : null;
  const refused = ready !== null && ready.batch !== undefined && preview !== null && preview.model === null ? preview.diagnostics : [];
  const back = () => {
    window.document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
  };
  const reject = () => {
    closePhrases(store, ready === null ? '' : `Rejected: ${ready.summary}`);
    back();
  };
  const ok = () => {
    void accept(store);
    back();
  };
  const ops = ready?.batch === undefined ? [] : carryRiders(model, typeof ready.batch === 'function' ? ready.batch(0) : ready.batch);
  const name = (id: string) => labelOf(model, id);
  const optionId = (i: number) => `fs-phrase-option-${String(i)}`;
  return (
    <div className="fs-quick fs-phrase" style={{ left, top }} role="dialog" aria-label="Say it on the plan" data-testid="phrase-bar">
      <div className="fs-quick__bar">
        <MessageSquareText className="fs-phrase__icon" aria-hidden="true" />
        <input
          ref={input}
          className="fs-quick__input"
          role="combobox"
          aria-label="Say an edit in plain words"
          aria-expanded={question !== null}
          aria-controls={question !== null ? 'fs-phrase-options' : undefined}
          aria-activedescendant={question !== null ? optionId(index) : undefined}
          aria-autocomplete="none"
          aria-describedby="fs-phrase-result"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder="push the island 6 inches north"
          data-testid="phrase-input"
          onChange={(e) => { setText(store, e.currentTarget.value); }}
          onBlur={(e) => {
            // Leaving the bar for anything but its own controls rejects what it shows.
            if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('.fs-phrase') !== null)) closePhrases(store);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              reject();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (question !== null) {
                const c = question.options[index];
                if (c !== undefined) choose(store, c.value);
              } else if (ready !== null) ok();
              else read(store);
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && question !== null) {
              e.preventDefault();
              const n = question.options.length;
              let i = index;
              // Past the candidates that cannot be chosen.
              for (let k = 0; k < n; k++) {
                i = (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
                if (question.options[i]?.disabled === undefined) break;
              }
              highlight(store, i);
            }
          }}
        />
        <span className="fs-quick__where">Offline · no AI</span>
      </div>

      <div id="fs-phrase-result" className="fs-phrase__result" role="status" aria-live="polite" data-testid="phrase-result">
        {ready !== null ? (
          <div className="fs-phrase__card" data-testid="phrase-preview">
            <p className="fs-phrase__summary">{ready.summary}</p>
            {ready.notes.length > 0 ? <p className="fs-phrase__note">{ready.notes.join(' · ')}</p> : null}
            {refused.length > 0 ? (
              <p className="fs-phrase__refused" data-testid="phrase-refused">
                The plan would refuse it: {refused[0]?.message ?? ''}
              </p>
            ) : (
              <p className="fs-phrase__hint">Enter to accept, Escape to reject.</p>
            )}
          </div>
        ) : question !== null ? (
          <p className="fs-phrase__question" data-testid="phrase-question">{question.question}</p>
        ) : failed !== null ? (
          <p className="fs-phrase__fail" data-testid="phrase-help">{failed.message}</p>
        ) : null}
      </div>

      {ready !== null && ops.length > 0 ? (
        <ul className="fs-review__ops fs-phrase__ops" aria-label="Operations">
          {ops.map((op, i) => {
            const [k, what] = describeOp(op as unknown as Record<string, unknown>, store.units, name);
            return (
              <li key={i} className="fs-review__op">
                <span className="fs-review__opname">{k}</span>
                <span className="fs-review__optarget">{what}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {ready !== null ? (
        <div className="fs-phrase__actions">
          <Button size="sm" variant="primary" icon={<Check />} disabled={refused.length > 0 || pending !== null} onClick={ok} data-testid="phrase-accept">
            Accept ⏎
          </Button>
          <Button size="sm" variant="secondary" icon={<X />} onClick={reject} data-testid="phrase-reject">
            Reject Esc
          </Button>
        </div>
      ) : null}

      {question !== null ? (
        <ul id="fs-phrase-options" className="fs-quick__results" role="listbox" aria-label={question.question} data-testid="phrase-options">
          {question.options.map((c, i) => (
            <li
              key={c.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              aria-disabled={c.disabled !== undefined}
              className="fs-quick__result fs-phrase__option"
              data-value={c.value}
              onPointerDown={(ev) => { ev.preventDefault(); }}
              onPointerEnter={() => { highlight(store, i); }}
              onClick={() => { choose(store, c.value); }}
            >
              <span className="fs-quick__text">
                <span className="fs-quick__name">{c.label}</span>
                {c.detail === undefined ? null : <span className="fs-quick__sub">{c.disabled ?? c.detail}</span>}
              </span>
              {i === index ? (
                <kbd className="fs-quick__enter" aria-hidden="true">
                  ↵
                </kbd>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {failed !== null || text.trim() === '' ? (
        <div className="fs-phrase__examples">
          <p className="fs-phrase__try">Try</p>
          <ul aria-label="Examples">
            {EXAMPLES.slice(0, 6).map((x) => (
              <li key={x}>
                <button
                  type="button"
                  className="fs-phrase__example"
                  onClick={() => {
                    setText(store, x);
                    input.current?.focus();
                  }}
                >
                  {x}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="fs-quick__foot" aria-hidden="true">
        <kbd>↵</kbd> <span>{ready !== null ? 'accept' : question !== null ? 'choose' : 'preview'}</span> {question !== null ? (<><kbd>↑↓</kbd> <span>which</span></>) : null} <kbd>Esc</kbd> <span>reject</span>
      </div>
    </div>
  );
}

/** Once the bar has gone: what was applied or rejected, for a screen reader. */
export function PhraseAnnouncer({ store }: { store: EditorStore }) {
  const said = usePhrases(store, (s) => (s.open ? '' : s.said));
  return (
    <div className="fs-phrase__announce" role="status" aria-live="polite">
      {said}
    </div>
  );
}

const f1 = (n: number) => n.toFixed(1);
const pts = (view: Viewport, ring: Ring) => ring.map((p) => toScreen(view, p).map(f1).join(',')).join(' ');

/**
 * On the plan: the candidates of a question, the highlighted one lit; what a ready phrase acts on,
 * outlined; and each item it moves or resizes where it would be — drawn from the store's preview, as
 * the drag's ghost is (rigid.ts), so the cooktop is seen riding with the island.
 */
export function PhraseLayer({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const open = usePhrases(store, (s) => s.open);
  const outcome = usePhrases(store, (s) => s.outcome);
  const hover = usePhrases(store, (s) => s.hover);
  const previewed = useEditor(store, (s) => s.preview?.model ?? null);
  if (!open || outcome === null) return null;
  const lit = outcome.status === 'choose' ? outcome.options.flatMap((c) => c.highlight) : outcome.status === 'ready' ? outcome.targets : [];
  const next = previewed?.levels.find((l) => l.id === level.id);
  const shapes = (id: string, ghost: boolean): Ring[] => {
    const lv = ghost ? next : level;
    return lv === undefined ? [] : ringsOf(lv, id);
  };
  // What it moves or resizes, where it would be; and what it adds — a door, an item — where it would go.
  const moved = outcome.status === 'ready' ? [...outcome.targets.filter((id) => level.devices.some((d) => d.id === id)), ...addedOn(level, next)] : [];
  return (
    <g className="fs-phrase-layer" aria-hidden="true" data-testid="phrase-ghost">
      {lit.flatMap((id) =>
        shapes(id, false).map((ring, i) => (
          <polygon key={`lit-${id}-${String(i)}`} className={`fs-phrase-layer__lit${hover.includes(id) ? ' is-hover' : ''}`} points={pts(view, ring)} data-phrase-target={id} data-hover={hover.includes(id) ? 'true' : undefined} />
        )),
      )}
      {previewed === null
        ? null
        : moved.flatMap((id) =>
            shapes(id, true).map((ring, i) => <polygon key={`ghost-${id}-${String(i)}`} className="fs-phrase-layer__ghost" points={pts(view, ring)} data-phrase-item={id} />),
          )}
    </g>
  );
}
