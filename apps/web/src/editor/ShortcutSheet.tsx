import './elements.css';
import { useId, useMemo, useState } from 'react';
import { Modal, SearchField } from '@d3cloud/ui';
import { useEditor, type EditorStore } from './store';
import { onMac, sheetGroups, spokenKeys } from './shortcuts';

/** Where the focus was when the sheet opened: it goes back there when the sheet closes. */
let returnTo: HTMLElement | null = null;

/** Open the sheet (? or the palette's "Keyboard shortcuts"), remembering where the focus was. */
export function openShortcuts(store: EditorStore): void {
  if (typeof document !== 'undefined') returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  store.set({ shortcuts: true, palette: false });
}

/**
 * Closed: the focus back where it was — the dialog has no trigger to return it to. Once the dialog
 * has gone (it fades out first), within a second, unless something else took the focus meanwhile.
 */
function giveFocusBack(): void {
  const to = returnTo;
  returnTo = null;
  const start = performance.now();
  const back = () => {
    if (document.querySelector(`[role="dialog"][aria-label="${TITLE}"], [role="dialog"][aria-labelledby] .fs-keys`) !== null && performance.now() - start < 1000) {
      requestAnimationFrame(back);
      return;
    }
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost) return;
    if (to?.isConnected === true) to.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
  };
  requestAnimationFrame(back);
}

const TITLE = 'Keyboard shortcuts';

/**
 * The shortcut sheet (FLR-T-18.16): ? from the plan, or "Keyboard shortcuts" in the command palette.
 * A dialog of every command's keys, by group, drawn from the command registry the palette and the
 * keyboard dispatch through — so it never disagrees with them — and then the keys that work in
 * context. A search narrows it; Esc closes it and the focus goes back where it was. Each key is
 * shown as its glyphs and said in words ("Option H"), since a screen reader reads "⌥" poorly.
 */
export function ShortcutSheet({ store }: { store: EditorStore }) {
  const open = useEditor(store, (s) => s.shortcuts);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => (open ? sheetGroups(query) : []), [open, query]);
  const mac = onMac();
  const id = useId();
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        store.set({ shortcuts: next });
        if (!next) {
          setQuery('');
          giveFocusBack();
        }
      }}
      title={TITLE}
      description="Every command’s keys, as the command palette (⌘K) lists them, then the keys that work in context. ? opens this sheet from the plan."
      size="lg"
      className="fs-keys-modal"
    >
      <div className="fs-keys">
        <SearchField
          autoFocus
          aria-label="Search the shortcuts"
          placeholder="Search: undo, zoom, room, ⌥…"
          value={query}
          onChange={(e) => { setQuery(e.currentTarget.value); }}
          aria-describedby={`${id}-count`}
        />
        <p id={`${id}-count`} className="fs-visually-hidden" role="status">
          {query.trim() === '' ? '' : `${String(total)} ${total === 1 ? 'shortcut' : 'shortcuts'}`}
        </p>
        {groups.length === 0 ? (
          <p className="fs-keys__empty">Nothing matches “{query}”.</p>
        ) : (
          <div className="fs-keys__groups" data-testid="shortcut-groups">
            {groups.map((g) => (
              <section key={g.id} className="fs-keys__group" aria-labelledby={`${id}-${g.id}`}>
                <h3 id={`${id}-${g.id}`}>{g.label}</h3>
                <ul className="fs-keys__rows">
                  {g.rows.map((r) => (
                    <li key={r.id} className="fs-keys__row" data-command={r.id}>
                      <span className="fs-keys__label">{r.label}</span>
                      <span className="fs-keys__keys">
                        <kbd aria-hidden="true">{r.keys}</kbd>
                        <span className="fs-visually-hidden">: {spokenKeys(r.keys, mac)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
