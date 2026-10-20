import './compare.css';
import { lazy, Suspense, useState } from 'react';
import { Button, IconButton, Spinner } from '@d3cloud/ui';
import { ArrowLeftRight, Camera, Columns2, GitPullRequestArrow, X } from 'lucide-react';
import { useEditor, type EditorStore } from '../../store';
import { openReview } from '../../review';
import type { ChangeKind } from '../../diff';
import { threeOf, useThreeState } from '../mode';
import { choiceOf, type Side } from './compare';
import { toggleCompare, useCompareChoices } from './CompareOverlay';
import { comparisonDiff, useSourceModel } from './sources';

const PairDialog = lazy(() => import('./PairDialog'));

/** How many of B's changes the panel lists before it says how many more. */
const LISTED = 12;

const KIND_WORDS: Readonly<Record<ChangeKind, string>> = { added: 'Added', removed: 'Removed', moved: 'Moved', changed: 'Changed' };

/**
 * The Comparing panel (FLR-T-14.4), in the right column while Compare is open in 3D, as the board's
 * frames have it: what is compared with what, what B changes — each change outlined in B in the
 * accent colour, lit in both sides while it is pointed at here — and, for a changeset, the way to
 * Review where it is accepted or rejected; and Render pair…, the matched pair on the server.
 */
export function ComparePanel({ store }: { store: EditorStore }) {
  const three = threeOf(store);
  const c = useThreeState(store, (s) => s.compare);
  const choices = useCompareChoices(store);
  const units = useEditor(store, () => store.units);
  const aRead = useSourceModel(store, c.a);
  const bRead = useSourceModel(store, c.b);
  const [pairing, setPairing] = useState(false);
  const proposal = useEditor(store, (s) => (c.b?.kind === 'changeset' ? (s.proposals.find((p) => p.id === (c.b?.kind === 'changeset' ? c.b.id : '')) ?? null) : null));
  const a = choiceOf(choices, c.a);
  const b = c.b === null ? null : choiceOf(choices, c.b);
  const ready = aRead?.status === 'ready' && bRead?.status === 'ready' ? { a: aRead.model, b: bRead.model } : null;
  const diff = ready === null ? null : comparisonDiff(ready.a, ready.b, units);
  const changes = diff?.changes ?? [];
  const failed = [aRead, bRead].find((r) => r?.status === 'error');
  const focus = (id: string | null) => { three.setCompare({ focus: id }); };
  const named = (side: Side) => `${side.toUpperCase()} · ${(side === 'a' ? a : b)?.label ?? '—'}`;
  const count = proposal?.ops ?? null;
  const heading = count !== null ? `What B changes · ${String(count)} ${count === 1 ? 'op' : 'ops'}` : `What B changes · ${String(changes.length)} ${changes.length === 1 ? 'change' : 'changes'}`;

  return (
    <div className="fs-inspector__body fs-comparing" role="group" aria-label="Comparing">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <Columns2 />
        </span>
        <div className="fs-inspector__title">
          <h2>Comparing</h2>
          <p className="fs-comparing__pair">
            {named('a')}
            <ArrowLeftRight aria-label="with" />
            {b === null ? 'B · not chosen yet' : named('b')}
          </p>
        </div>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Close Compare" icon={<X />} onClick={() => { toggleCompare(store, choices, false); }} />
      </div>
      {b === null ? (
        <p className="fs-note">Choose B in the Compare bar under the view: a pending changeset, another option of a design option set, or an earlier version.</p>
      ) : failed?.status === 'error' ? (
        <p className="fs-note">{failed.message}</p>
      ) : diff === null ? (
        <Spinner label="Reading both sides" />
      ) : (
        <>
          <span className="fs-overline">{heading}</span>
          {diff.same || changes.length === 0 ? (
            <p className="fs-note">A and B are the same design: nothing differs between them.</p>
          ) : (
            <ul className="fs-comparing__changes" aria-label="What B changes">
              {changes.slice(0, LISTED).map((ch) => (
                <li key={`${ch.kind}:${ch.id}`}>
                  <button
                    type="button"
                    className="fs-comparing__change"
                    aria-pressed={c.focus === ch.id}
                    onMouseEnter={() => { focus(ch.id); }}
                    onMouseLeave={() => { if (three.get().compare.focus === ch.id) focus(null); }}
                    onFocus={() => { focus(ch.id); }}
                    onBlur={() => { if (three.get().compare.focus === ch.id) focus(null); }}
                    onClick={() => { focus(three.get().compare.focus === ch.id ? null : ch.id); }}
                  >
                    <span>{`${KIND_WORDS[ch.kind]} · ${ch.label}`}</span>
                    {ch.detail === undefined ? null : <span className="fs-comparing__change-detail">{ch.detail}</span>}
                  </button>
                </li>
              ))}
              {changes.length > LISTED ? <li className="fs-note">…and {String(changes.length - LISTED)} more</li> : null}
            </ul>
          )}
          <p className="fs-note">
            What B adds, moves or changes is outlined in the accent colour; point at a change here to find it in the view.
            {c.b?.kind === 'changeset' ? ' Accept or reject the changeset in Review.' : ''}
          </p>
          <div className="fs-comparing__actions">
            {c.b?.kind === 'changeset' ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<GitPullRequestArrow />}
                onClick={() => {
                  const id = c.b?.kind === 'changeset' ? c.b.id : null;
                  if (id === null) return;
                  toggleCompare(store, choices, false);
                  void openReview(store, id);
                }}
              >
                Open in Review
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={<Camera />} onClick={() => { setPairing(true); }}>
              Render pair…
            </Button>
          </div>
        </>
      )}
      {pairing && c.b !== null ? (
        <Suspense fallback={null}>
          <PairDialog store={store} a={c.a} b={c.b} labels={{ a: named('a'), b: named('b') }} onClose={() => { setPairing(false); }} />
        </Suspense>
      ) : null}
    </div>
  );
}
