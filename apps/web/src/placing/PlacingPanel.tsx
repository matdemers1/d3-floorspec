import { Button } from '@d3cloud/ui';
import { RotateCcw, RotateCw } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { footprintText, kindText } from './catalog';
import { Thumb } from './LibraryPanel';
import { entryOf, placeHere, stopPlacing, turnGhost, usePlacing } from './state';

/**
 * The inspector while placing (FLR-T-18.7): what is being placed, where its ghost is, buttons that
 * turn it — a finger has no R key — place it and stop, and the keys that do the same.
 */
export function PlacingPanel({ store }: { store: EditorStore }) {
  const key = usePlacing(store, (s) => s.active);
  const ghost = usePlacing(store, (s) => s.ghost);
  const busy = usePlacing(store, (s) => s.busy > 0);
  const units = useEditor(store, () => store.units);
  useEditor(store, (s) => s.model);
  const entry = entryOf(store, key);
  if (entry === undefined) return null;
  const turns = entry.placement !== 'device' || (entry.source.kind === 'device' && entry.source.device.mount !== 'wall');
  return (
    <div className="fs-inspector__body">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon fs-place__thumb">
          <Thumb entry={entry} />
        </span>
        <div className="fs-inspector__title">
          <h2>Place {entry.name.charAt(0).toLowerCase()}{entry.name.slice(1)}</h2>
          <p>
            {kindText(entry)} · {footprintText(entry, units)}
          </p>
        </div>
      </div>
      <p className="fs-place__where" role="status">
        {ghost === null ? 'Point at where it goes.' : (ghost.problem ?? ghost.label)}
      </p>
      <div className="fs-place__actions">
        {turns ? (
          <>
            <Button size="sm" variant="secondary" icon={<RotateCcw />} onClick={() => { turnGhost(store, 90); }}>
              Turn left
            </Button>
            <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => { turnGhost(store, -90); }}>
              Turn right
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="primary" loading={busy} disabled={ghost === null} onClick={() => void placeHere(store)}>
          Place here
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { stopPlacing(store); }}>
          Done
        </Button>
      </div>
      <ul className="fs-keys" aria-label="Keys">
        <li>
          <kbd>Click</kbd> place one, and keep placing
        </li>
        <li>
          <kbd>R</kbd> <kbd>[</kbd> <kbd>]</kbd> turn 90° · <kbd>⇧[</kbd> <kbd>⇧]</kbd> 15°
        </li>
        <li>
          <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> move it · <kbd>Enter</kbd> place
        </li>
        <li>
          <kbd>⌥</kbd> no snapping · <kbd>Esc</kbd> done
        </li>
      </ul>
    </div>
  );
}
