import './furniture.css';
import { useMemo } from 'react';
import { Button, Modal, SearchField, SegmentedControl, Select } from '@d3cloud/ui';
import { Plus, Upload } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { labelOf } from '../editor/model';
import { extensionVersion } from '../editor/systems/catalog';
import { categoryLabel, KINDS, LIBRARY, LIBRARY_LICENSE, libraryItem, matches, mountingOf, type FurnitureKind, type LibraryItem } from './library';
import { placeLibraryItem, targetRoom } from './actions';
import { ClearancePreview, reachText, sizeText } from './Preview';
import { furnitureOf, useFurniture } from './state';
import { bytesText } from './view';
import { UploadFurniture } from './Upload';
import { EXTENSION } from './ops';

/**
 * The furniture library (FLR-T-8.3, the board's frame "14 · Furniture & appliances"): the
 * FS_furniture starter library as cards — each with its plan symbol and its size — by kind and by
 * search, and the chosen item in detail: its symbol with its clearance envelopes, its size, each
 * envelope, how it is placed, its model and its fallback. "Place in <room>" copies its model and
 * symbol into the project and places it in one change; "Upload glTF" places a model of your own.
 */

const MOUNT_TEXT: Record<string, string> = {
  floor: 'stands on the floor, backed onto a wall',
  wall: 'hangs on a wall face, at its height',
  builtIn: 'set into casework, on a wall face at its height',
};
const FREE = new Set(['island', 'diningTable', 'coffeeTable', 'sideTable', 'chair', 'stool', 'bench', 'armchair', 'crib']);

export function hostText(category: string): string {
  if (FREE.has(category)) return 'stands free in the room';
  return MOUNT_TEXT[mountingOf(category)] ?? 'stands on the floor';
}

export function FurnitureLibrary({ store }: { store: EditorStore }) {
  const open = useFurniture(store, (s) => s.open);
  const uploading = useFurniture(store, (s) => s.uploading);
  if (!open) return null;
  return uploading ? <UploadFurniture store={store} /> : <LibraryModal store={store} />;
}

function LibraryModal({ store }: { store: EditorStore }) {
  const f = furnitureOf(store);
  const kind = useFurniture(store, (s) => s.kind);
  const query = useFurniture(store, (s) => s.query);
  const chosenId = useFurniture(store, (s) => s.chosen);
  const busy = useFurniture(store, (s) => s.busy);
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly) !== null;
  const units = useEditor(store, () => store.units);
  // Re-read when the selection or level changes: they decide the default room.
  useEditor(store, (s) => `${s.selection ?? ''}|${s.level ?? ''}`);
  const room = useFurniture(store, (s) => s.room);
  const shown = useMemo(() => LIBRARY.filter((i) => (kind === 'all' || i.kind === kind) && matches(i, query)), [kind, query]);
  const chosen: LibraryItem | undefined = libraryItem(chosenId ?? '') ?? shown[0];
  if (model === null) return null;
  const level = store.levelView;
  const target = chosen === undefined ? null : (room !== null && level?.rooms.some((r) => r.id === room) ? room : targetRoom(store, chosen.kind));
  const close = () => { f.set({ open: false }); };
  const counts = (k: FurnitureKind | 'all') => LIBRARY.filter((i) => (k === 'all' || i.kind === k) && matches(i, query)).length;

  return (
    <Modal
      open
      size="lg"
      className="fs-furn"
      onOpenChange={(o) => { if (!o) close(); }}
      title="Furniture & appliances"
      description="FS_furniture items: a 2D symbol, a glTF model and clearance envelopes the rules can check."
      footer={<Button variant="ghost" onClick={close}>Close</Button>}
    >
      <div className="fs-furn__bar">
        <SearchField className="fs-furn__search" aria-label="Search the library" placeholder="Search: fridge, sofa, cabinet…" value={query} onChange={(e) => { f.set({ query: e.currentTarget.value }); }} />
        <SegmentedControl
          aria-label="Kind"
          size="sm"
          value={kind}
          items={[{ value: 'all', label: 'All', count: counts('all') }, ...KINDS.map((k) => ({ value: k.kind, label: k.label, count: counts(k.kind) }))]}
          onValueChange={(v) => { f.set({ kind: v as FurnitureKind | 'all' }); }}
        />
        <span className="fs-spacer" />
        {!readOnly ? (
          <Button variant="primary" size="sm" icon={<Upload />} onClick={() => { f.set({ uploading: true }); }}>
            Upload glTF
          </Button>
        ) : null}
      </div>
      <div className="fs-furn__body">
        {shown.length === 0 ? (
          <p className="fs-note fs-furn__none" role="status">Nothing in the library matches “{query}”.</p>
        ) : (
          <ul className="fs-furn__grid" aria-label="Library items">
            {shown.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="fs-furn-card"
                  aria-pressed={chosen?.id === item.id}
                  onClick={() => { f.set({ chosen: item.id }); }}
                  onDoubleClick={() => {
                    if (!readOnly && target !== null && busy === null) void placeLibraryItem(store, item, target);
                  }}
                >
                  <span className="fs-furn-card__symbol">
                    <img className="fs-furn__symbol" src={item.symbol.url} alt="" />
                  </span>
                  <span className="fs-furn-card__name">{item.name}</span>
                  <span className="fs-furn-card__size">{sizeText(item.box, units)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {chosen !== undefined ? (
          <section className="fs-furn__detail" aria-label={`${chosen.name}, in detail`}>
            <h3 className="fs-furn__title">{chosen.name}</h3>
            <p className="fs-furn__sub">
              {EXTENSION} {extensionVersion(EXTENSION)} RC · {KINDS.find((k) => k.kind === chosen.kind)?.singular.toLowerCase()} · {categoryLabel(chosen.category).toLowerCase()}
            </p>
            <div className="fs-furn__stage">
              <ClearancePreview box={chosen.box} clearances={chosen.clearances} symbol={chosen.symbol.url} units={units} label={`${chosen.name}: plan symbol and clearance envelopes`} />
            </div>
            <dl className="fs-furn__facts">
              <div><dt>Size</dt><dd>{sizeText(chosen.box, units)}</dd></div>
              {Object.entries(chosen.clearances).map(([name, e]) => (
                <div key={name}>
                  <dt>{name === 'door' ? 'Door swing' : name.charAt(0).toUpperCase() + name.slice(1)}</dt>
                  <dd>{reachText(chosen.box, e, units)} · envelope “{name}”, {e.purpose}</dd>
                </div>
              ))}
              {Object.keys(chosen.clearances).length === 0 ? <div><dt>Clearance</dt><dd>none by default</dd></div> : null}
              <div><dt>Host</dt><dd>{hostText(chosen.category)}</dd></div>
              {chosen.seats !== undefined ? <div><dt>Seats</dt><dd>{chosen.seats}</dd></div> : null}
              <div><dt>Model</dt><dd>{chosen.model.path.split('/').at(-1)} · {bytesText(chosen.model.byteLength)}</dd></div>
              <div><dt>Fallback</dt><dd>box + model + symbol, for readers without {EXTENSION}</dd></div>
              <div><dt>Licence</dt><dd>{LIBRARY_LICENSE}, starter library</dd></div>
            </dl>
            {!readOnly ? (
              <div className="fs-furn__place">
                {level !== undefined && level.rooms.length > 0 ? (
                  <Select
                    aria-label="Room to place in"
                    appearance="filled"
                    options={level.rooms.map((r) => ({ value: r.id, label: labelOf(model, r.id) }))}
                    value={target ?? ''}
                    onValueChange={(v) => { f.set({ room: v }); }}
                  />
                ) : null}
                <Button
                  variant="primary"
                  icon={<Plus />}
                  loading={busy !== null}
                  disabled={target === null || busy !== null}
                  onClick={() => { if (target !== null) void placeLibraryItem(store, chosen, target); }}
                >
                  {target === null ? 'Name a room first' : `Place in ${labelOf(model, target)}`}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
