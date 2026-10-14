import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Checkbox, Select, Switch } from '@d3cloud/ui';
import { Check, ChevronDown, Magnet } from 'lucide-react';
import type { EditorStore } from '../store';
import { useEditor } from '../store';
import { useModes, modesOf } from '../modes';
import { prettyLen } from '../units';
import { ANGLE_STEPS, type SnapSettings } from '../snap';
import { gridStepOf, gridSteps, precisionOf, snapSummary, usePrecision } from './state';

/**
 * The status bar's snapping (FLR-T-18.9): what snaps, in words, and a menu to change it — the board's
 * "Snap" popover: a master switch; junctions and corners, wall faces and centre lines, midpoints,
 * smart guides and alignment, items, other levels; the grid with its step, and angles with theirs.
 * Kept per project and per mode; a mode starts from its own defaults (construction on 6", the
 * trades on 1"), and "Reset" returns to them.
 */

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const TOGGLES: readonly { key: keyof SnapSettings; label: string }[] = [
  { key: 'junctions', label: 'Junctions and corners' },
  { key: 'walls', label: 'Wall faces and centre lines' },
  { key: 'midpoints', label: 'Midpoints' },
  { key: 'guides', label: 'Smart guides and alignment' },
  { key: 'items', label: 'Items (furniture, fixtures)' },
  { key: 'ghosts', label: 'Other levels (ghost)' },
];

export function SnapStatus({ store }: { store: EditorStore }) {
  const open = usePrecision(store, (p) => p.menu);
  const snap = usePrecision(store, (p) => p.snap);
  const units = useEditor(store, () => store.units);
  const trigger = useRef<HTMLButtonElement>(null);
  const summary = snapSummary(snap, units, gridStepOf(store));
  return (
    <span className="fs-snapstatus">
      <button
        ref={trigger}
        type="button"
        className="fs-statusbar__mono fs-statusbar__wide fs-snapstatus__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Snap: ${summary}. Change the snapping`}
        data-off={snap.on ? undefined : 'true'}
        onClick={() => { precisionOf(store).set({ menu: !open }); }}
      >
        <Magnet aria-hidden="true" />
        <span>Snap · {summary}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <SnapMenu
          store={store}
          trigger={trigger}
          onClose={(refocus) => {
            precisionOf(store).set({ menu: false });
            if (refocus) trigger.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function SnapMenu({ store, trigger, onClose }: { store: EditorStore; trigger: React.RefObject<HTMLButtonElement | null>; onClose: (refocus: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const snap = usePrecision(store, (p) => p.snap);
  const units = useEditor(store, () => store.units);
  const mode = useModes(store, (m) => m.mode);
  const id = useId();
  const p = precisionOf(store);
  const set = (patch: Partial<SnapSettings>) => { p.setSnap(patch); };
  const step = gridStepOf(store);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('button[role="switch"]')?.focus();
  }, []);

  // A press outside the menu, its trigger and its pickers' lists closes it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t !== null && (panel.current?.contains(t) === true || trigger.current?.contains(t) === true || t.closest('[role="listbox"], [data-radix-popper-content-wrapper]') !== null)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, trigger]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  const steps = gridSteps(units);
  const stepOptions = (steps.includes(step) ? steps : [...steps, step].sort((a, b) => a - b)).map((s) => ({ value: String(s), label: prettyLen(s, units) }));
  const modeName = modesOf(store).nameOf(mode);
  return (
    <div ref={panel} className="fs-snapmenu" role="dialog" aria-label="Snapping" onKeyDown={onKey}>
      <div className="fs-snapmenu__head">
        <Magnet aria-hidden="true" />
        <span id={`${id}-title`}>Snap</span>
        <span className="fs-spacer" />
        <Switch checked={snap.on} aria-labelledby={`${id}-title`} onCheckedChange={(v) => { set({ on: v }); }} />
      </div>
      <fieldset className="fs-snapmenu__list" disabled={!snap.on}>
        <legend className="fs-visually-hidden">What snaps</legend>
        {TOGGLES.map((t) => (
          <Checkbox key={t.key} label={t.label} checked={snap[t.key] === true} disabled={!snap.on} checkIcon={<Check />} onCheckedChange={(v) => { set({ [t.key]: v === true }); }} />
        ))}
        <div className="fs-snapmenu__row">
          <Checkbox label="Grid" checked={snap.grid} disabled={!snap.on} checkIcon={<Check />} onCheckedChange={(v) => { set({ grid: v === true }); }} />
          <Select
            size="sm"
            aria-label="Grid step"
            className="fs-snapmenu__pick"
            disabled={!snap.on || !snap.grid}
            options={stepOptions}
            value={String(step)}
            onValueChange={(v) => { set({ step: Number(v) }); }}
          />
        </div>
        <div className="fs-snapmenu__row">
          <Checkbox label="Angles" checked={snap.angles} disabled={!snap.on} checkIcon={<Check />} onCheckedChange={(v) => { set({ angles: v === true }); }} />
          <Select
            size="sm"
            aria-label="Angle step"
            className="fs-snapmenu__pick"
            disabled={!snap.on || !snap.angles}
            options={ANGLE_STEPS.map((a) => ({ value: String(a), label: `${String(a)}°` }))}
            value={String(snap.angle)}
            onValueChange={(v) => { set({ angle: Number(v) }); }}
          />
        </div>
      </fieldset>
      <p className="fs-snapmenu__foot">
        Hold <kbd>{mac ? '⌘' : 'Ctrl'}</kbd> to ignore snaps while dragging
      </p>
      <p className="fs-snapmenu__foot">
        {p.isDefault() ? (
          <span>{mode === null ? 'The editor’s defaults' : `${modeName} mode’s defaults`}</span>
        ) : (
          <button type="button" className="fs-snapmenu__reset" onClick={() => { p.resetSnap(); }}>
            Reset to {mode === null ? 'the defaults' : `${modeName} mode’s defaults`}
          </button>
        )}
      </p>
    </div>
  );
}
