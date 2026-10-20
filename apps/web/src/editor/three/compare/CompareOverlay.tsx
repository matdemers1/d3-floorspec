import './compare.css';
import { useMemo, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, SegmentedControl, Spinner, Tooltip } from '@d3cloud/ui';
import { Check, ChevronDown, Columns2, Link2, Link2Off, TriangleAlert, X } from 'lucide-react';
import { proposerOf } from '../../api';
import { authorOf, refreshLog } from '../../history';
import { refreshProposals } from '../../review';
import { timeAgo } from '../../../projects/model';
import { useEditor, type EditorStore } from '../../store';
import { filmOf } from '../film/films';
import { sunOf } from '../sun/study';
import { threeOf, useThreeState } from '../mode';
import {
  chipText,
  choiceOf,
  choicesOf,
  defaultB,
  dividerAt,
  dividerByKey,
  dividerX,
  GROUP_LABELS,
  leftSide,
  sameSource,
  type CompareSource,
  type Side,
  type SideStatus,
  type SourceChoice,
} from './compare';

/**
 * Compare's chrome over the 3D view (FLR-T-14.4), the board's "14.4 · Compare in 3D" frames: the bar
 * at the bottom — A and B, each a menu grouping pending changesets, option sets and versions; Swipe or
 * Side by side; Flip; the cameras' link; close — the divider with its handle, dragged or moved by the
 * keys as a slider is, and a chip over each side saying what it shows.
 */

/** Every source a side can show, as the B picker lists them. */
export function useCompareChoices(store: EditorStore): SourceChoice[] {
  const model = useEditor(store, (s) => s.model);
  const proposals = useEditor(store, (s) => s.proposals);
  const log = useEditor(store, (s) => s.log);
  const seq = useEditor(store, (s) => s.history.seq);
  const tokens = useEditor(store, (s) => s.tokenNames);
  return useMemo(
    () => choicesOf({ model, proposals, log, seq, proposer: proposerOf, ago: (iso) => timeAgo(iso), author: (e) => authorOf(e, tokens).name }),
    [model, proposals, log, seq, tokens],
  );
}

/**
 * Open Compare (⌥C, the cluster's button) or close it. Opening it puts away what shares the view's
 * places — the sun's panel and a film's timeline — reads the proposals and the history again for the
 * pickers, and chooses a B when none is: the newest pending changeset, else another option, else the
 * version before now.
 */
export function toggleCompare(store: EditorStore, choices: readonly SourceChoice[], open?: boolean): void {
  const three = threeOf(store);
  const now = three.get().compare;
  const opening = open ?? !now.open;
  if (!opening) {
    three.toggleCompare(false);
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
    return;
  }
  sunOf(store).set({ open: false, playing: false, lapse: false });
  filmOf(store).set({ open: false, playing: false });
  three.toggleCompare(true);
  if (now.b === null || sameSource(now.a, now.b)) three.setCompare({ b: defaultB(choices, now.a) });
  void refreshProposals(store);
  if (store.get().log === null) void refreshLog(store);
}

/** A side's source: a menu of every choice, grouped, the one shown ticked, the other side's not offered. */
function SourceMenu({ side, value, other, choices, onChange }: { side: Side; value: CompareSource | null; other: CompareSource | null; choices: readonly SourceChoice[]; onChange: (s: CompareSource) => void }) {
  const current = value === null ? null : choiceOf(choices, value);
  const groups = (['main', 'changesets', 'options', 'versions'] as const).map((g) => ({ g, list: choices.filter((c) => c.group === g && !sameSource(c.source, other)) })).filter((x) => x.list.length > 0);
  const letter = side.toUpperCase();
  return (
    <Menu>
      <MenuTrigger>
        <Button size="sm" variant="secondary" className="fs-compare__source" iconAfter={<ChevronDown />} aria-label={`${letter}: ${current?.label ?? `Choose ${letter}…`}`}>
          <span className="fs-compare__source-label">{current?.label ?? `Choose ${letter}…`}</span>
        </Button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="fs-compare__menu">
        {groups.length === 0 ? <MenuLabel>Nothing else to compare yet: a pending changeset, a design option or an earlier version</MenuLabel> : null}
        {groups.map(({ g, list }) => (
          <div key={g} role="group" aria-label={GROUP_LABELS[g]}>
            <MenuLabel>{GROUP_LABELS[g]}</MenuLabel>
            {list.map((c) => (
              <MenuItem key={c.key} onSelect={() => { onChange(c.source); }} className="fs-compare__item">
                <span className="fs-compare__item-text">
                  <span className="fs-compare__item-label">{c.label}</span>
                  {c.detail === '' ? null : <span className="fs-compare__item-detail">{c.detail}</span>}
                </span>
                {current?.key === c.key ? (
                  <>
                    <Check aria-hidden="true" className="fs-compare__tick" />
                    <span className="fs-compare__sr"> (shown)</span>
                  </>
                ) : null}
              </MenuItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function CompareOverlay({ store, choices, width, height, statuses }: { store: EditorStore; choices: readonly SourceChoice[]; width: number; height: number; statuses: Record<Side, SideStatus> }) {
  const three = threeOf(store);
  const c = useThreeState(store, (s) => s.compare);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const left = leftSide(c.flipped);
  const right: Side = left === 'a' ? 'b' : 'a';
  const sourceOf = (side: Side) => (side === 'a' ? c.a : c.b);
  const chip = (side: Side): string | null => {
    const src = sourceOf(side);
    return src === null ? null : chipText(side, choiceOf(choices, src));
  };
  const x = c.mode === 'side' ? Math.floor(width / 2) : dividerX(c.divider, width);
  const comparing = c.b !== null;

  const setDivider = (clientX: number) => {
    const r = root.current?.getBoundingClientRect();
    if (r === undefined) return;
    three.setCompare({ divider: dividerAt(clientX - r.left, r.width) });
  };
  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDivider(e.clientX);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    if (dragging.current) setDivider(e.clientX);
  };
  const up = () => { dragging.current = false; };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const next = dividerByKey(c.divider, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    three.setCompare({ divider: next });
  };
  const percent = Math.round(c.divider * 100);
  const leftName = chip(left);
  const rightName = chip(right);

  // What is on its way, or why a side is not drawn.
  const waiting = (['a', 'b'] as const).flatMap((side): { side: Side; text: string; tone: 'busy' | 'error' }[] => {
    const s = statuses[side];
    if (s.status === 'loading') return [{ side, text: `${s.doing} ${side.toUpperCase()}…`, tone: 'busy' }];
    if (s.status === 'error') return [{ side, text: `${side.toUpperCase()} is not drawn: ${s.message}`, tone: 'error' }];
    return [];
  });

  // The chips sit either side of the divider, kept inside the view.
  const CHIP_GAP = 12;
  return (
    <div className="fs-compare" ref={root} data-mode={c.mode}>
      {comparing ? (
        <>
          {leftName !== null ? (
            <div className={`fs-compare__chip fs-compare__chip--${left}`} style={c.mode === 'side' ? { left: CHIP_GAP } : { right: Math.max(CHIP_GAP, width - x + CHIP_GAP) }} role="note">
              {leftName}
            </div>
          ) : null}
          {rightName !== null ? (
            <div className={`fs-compare__chip fs-compare__chip--${right}`} style={{ left: Math.min(Math.max(CHIP_GAP, x + CHIP_GAP), Math.max(CHIP_GAP, width - 160)) }} role="note">
              {rightName}
            </div>
          ) : null}
          {c.mode === 'swipe' ? (
            <>
              <div className="fs-compare__line" style={{ left: x }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden="true" />
              <div
                className="fs-compare__handle"
                style={{ left: x, top: height / 2 }}
                role="slider"
                tabIndex={0}
                aria-label="Swipe divider"
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${String(percent)} % of the view shows ${left.toUpperCase()}, the rest ${right.toUpperCase()}`}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onKeyDown={key}
              >
                <Columns2 aria-hidden="true" />
              </div>
            </>
          ) : (
            <>
              <div className="fs-compare__line fs-compare__line--fixed" style={{ left: x }} aria-hidden="true" />
              <div className="fs-compare__linked" role="note">
                {c.linked ? <Link2 aria-hidden="true" /> : <Link2Off aria-hidden="true" />}
                {c.linked ? 'Cameras linked' : 'Cameras unlinked: each half orbits on its own'}
              </div>
            </>
          )}
        </>
      ) : null}
      {waiting.length > 0 ? (
        <div className="fs-compare__status" role="status">
          {waiting.map((w) => (
            <span key={w.side} className={`fs-compare__status-item fs-compare__status-item--${w.tone}`}>
              {w.tone === 'busy' ? <Spinner size="sm" /> : <TriangleAlert aria-hidden="true" />}
              {w.text}
            </span>
          ))}
        </div>
      ) : (
        <div className="fs-three__sr" role="status">
          {comparing ? `Comparing ${leftName ?? ''} on the left with ${rightName ?? ''} on the right.` : ''}
        </div>
      )}
      <div className="fs-compare__bar" role="toolbar" aria-label="Compare">
        <Columns2 aria-hidden="true" className="fs-compare__icon" />
        <span className="fs-compare__letter" aria-hidden="true">A</span>
        <SourceMenu side="a" value={c.a} other={c.b} choices={choices} onChange={(a) => { three.setCompare({ a, focus: null }); }} />
        <span className="fs-compare__letter" aria-hidden="true">B</span>
        <SourceMenu side="b" value={c.b} other={c.a} choices={choices} onChange={(b) => { three.setCompare({ b, focus: null }); }} />
        <SegmentedControl
          aria-label="Compare as"
          size="sm"
          value={c.mode}
          onValueChange={(v) => { three.setCompare({ mode: v === 'side' ? 'side' : 'swipe' }); }}
          items={[
            { value: 'swipe', label: 'Swipe' },
            { value: 'side', label: 'Side by side' },
          ]}
        />
        <Tooltip content={c.flipped ? 'Put A back on the left' : 'Flip: B on the left, A on the right'}>
          <Button size="sm" variant="ghost" pressed={c.flipped} onClick={() => { three.setCompare({ flipped: !c.flipped }); }}>
            Flip
          </Button>
        </Tooltip>
        <Tooltip content={c.mode === 'swipe' ? 'A swipe shows both through one camera' : c.linked ? 'Unlink the cameras: orbit each half on its own' : 'Link the cameras: one camera drives both halves'}>
          <IconButton label="Link the cameras" icon={c.linked || c.mode === 'swipe' ? <Link2 /> : <Link2Off />} size="sm" pressed={c.linked || c.mode === 'swipe'} disabled={c.mode === 'swipe'} onClick={() => { three.setCompare({ linked: !c.linked }); }} />
        </Tooltip>
        <Tooltip content="Close Compare (⌥C)">
          <IconButton label="Close Compare" icon={<X />} size="sm" aria-keyshortcuts="Alt+C" onClick={() => { toggleCompare(store, choices, false); }} />
        </Tooltip>
      </div>
    </div>
  );
}
