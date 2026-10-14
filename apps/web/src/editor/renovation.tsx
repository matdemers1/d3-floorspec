import './renovation.css';
import { useMemo, useSyncExternalStore } from 'react';
import { Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select } from '@d3cloud/ui';
import { Check, ChevronDown, Hammer } from 'lucide-react';
import { renovation as R, type FloorspecDocument } from '@floorspec/engine';
import {
  RENOVATION_FILTERS,
  RENOVATION_FILTER_LABELS,
  RENOVATION_STATUS_LABELS,
  filteredDocument,
  isRenovationFilter,
  renovationStyles,
  type RenovationFilter,
  type RenovationStatus,
  type RenovationStyle,
} from '@floorspec/render2d';
import type { EditorStore } from './store';
import { readModel, type EditorModel, type LevelView } from './model';
import type { Batch } from './ops';
import { Row, Section } from './fields';

/**
 * Renovation plans in the editor (FLR-T-18.13, FS_renovation 0.1.0): which filter the plan is drawn
 * in — Existing, Demolition, Proposed or Combined — kept per project like the plan style (the
 * view-state pattern of FLR-T-13.2: never in the model), the model each filter draws, the style each
 * element is drawn in, a status field for one element or many, and the top bar's menu.
 */

const NAME = 'FS_renovation';
const VERSION = '0.1.0';

export interface RenovationState {
  filter: RenovationFilter;
}

export const renovationKey = (projectId: string): string => `floorspec.renovation.${projectId}`;

function read(projectId: string): RenovationState {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(renovationKey(projectId));
    const o = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    return { filter: isRenovationFilter(o?.['filter']) ? o['filter'] : 'combined' };
  } catch {
    return { filter: 'combined' };
  }
}

/** Does the document describe a remodel — declare FS_renovation? */
export const isRemodel = (doc: FloorspecDocument | null | undefined): boolean => doc !== null && doc !== undefined && R.usesRenovation(doc);

const CREATORS = new Set(['addWall', 'addSeparator', 'drawWall', 'drawSeparator', 'addOpening', 'addRoom']);

/**
 * FS_renovation 6.1.3: what is drawn in a remodel is new — in the Proposed and Combined plans. What
 * is drawn in the Existing or Demolition plan is the house as it stands, and gets no status. An
 * extension element's status is the document's (1.3), so it is set from the inspector.
 */
export function markNew(batch: Batch): Batch {
  return batch.map((op) => {
    const o = op as unknown as Record<string, unknown>;
    const name = o['op'] as string;
    const status = { [NAME]: { status: 'new' } };
    if (CREATORS.has(name)) {
      const ext = (o['extensions'] ?? {}) as Record<string, unknown>;
      return Object.hasOwn(ext, NAME) ? op : ({ ...o, extensions: { ...ext, ...status } } as unknown as typeof op);
    }
    if (name === 'addElement' && typeof o['collection'] === 'string' && (R.RENOVATION_COLLECTIONS as readonly string[]).includes(o['collection'])) {
      const el = (o['element'] ?? {}) as Record<string, unknown>;
      const ext = (el['extensions'] ?? {}) as Record<string, unknown>;
      return Object.hasOwn(ext, NAME) ? op : ({ ...o, element: { ...el, extensions: { ...ext, ...status } } } as unknown as typeof op);
    }
    return op;
  });
}

export class RenovationStore {
  private state: RenovationState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: EditorStore) {
    this.state = read(editor.projectId);
    // What is drawn while the plan shows the work is the work (6.1.3).
    editor.batchFilters.push((batch) => {
      const model = editor.get().model;
      return isRemodel(model?.document) && (this.state.filter === 'proposed' || this.state.filter === 'combined') ? markNew(batch) : batch;
    });
  }

  get = (): RenovationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  choose(filter: RenovationFilter): void {
    this.state = { ...this.state, filter };
    for (const l of this.listeners) l();
    try {
      localStorage.setItem(renovationKey(this.editor.projectId), JSON.stringify(this.state));
    } catch {
      // Storage refused (a private window): the filter lasts for this session.
    }
  }

  /** Start a remodel: declare FS_renovation, so the house as drawn is what stands today. */
  start(): Promise<boolean> {
    return this.editor.apply('Start a remodel', [{ op: 'setProperty', id: '$document', path: `/extensionsUsed/${NAME}`, value: VERSION }] as unknown as Batch);
  }
}

const stores = new WeakMap<EditorStore, RenovationStore>();

export function renovationOf(store: EditorStore): RenovationStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new RenovationStore(store);
    stores.set(store, s);
  }
  return s;
}

export function useRenovation<T>(store: EditorStore, selector: (s: RenovationState) => T): T {
  const s = renovationOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}

/** The filter the plan is in — Combined for a document that is not a remodel. */
export function useRenovationFilter(store: EditorStore, model: EditorModel | null): RenovationFilter | null {
  const filter = useRenovation(store, (s) => s.filter);
  return isRemodel(model?.document) ? filter : null;
}

// ─── What a filter draws ─────────────────────────────────────────────────────────────────────

const filtered = new WeakMap<EditorModel, Map<RenovationFilter, EditorModel>>();

/**
 * The model a filter draws (FS_renovation 3.1): the existing state for Existing and Demolition, the
 * proposed state for Proposed, the model itself for Combined — the state read as FS_renovation 2.4
 * checks it, without known extensions, so another extension's records about what the state leaves
 * out do not stop it drawing.
 */
export function filteredModel(model: EditorModel, filter: RenovationFilter | null): EditorModel {
  if (filter === null || filter === 'combined' || !isRemodel(model.document)) return model;
  let byFilter = filtered.get(model);
  if (byFilter === undefined) {
    byFilter = new Map();
    filtered.set(model, byFilter);
  }
  const cached = byFilter.get(filter);
  if (cached !== undefined) return cached;
  const next = readModel(`${model.hash}~${filter}`, filteredDocument(model.view, filter), {}, { knownExtensions: [] });
  byFilter.set(filter, next);
  return next;
}

const styled = new WeakMap<EditorModel, Map<RenovationFilter, Map<string, RenovationStyle> | null>>();

/** The style each element is drawn in under the filter, by ID; null when the plan is not a remodel's. */
export function stylesFor(model: EditorModel | null, filter: RenovationFilter | null): Map<string, RenovationStyle> | null {
  if (model === null || filter === null) return null;
  let by = styled.get(model);
  if (by === undefined) {
    by = new Map();
    styled.set(model, by);
  }
  if (!by.has(filter)) by.set(filter, renovationStyles(model.view, filter));
  return by.get(filter) ?? null;
}

/** The styles of the model the store holds, under the filter the plan is in. */
export function storeStyles(store: EditorStore): Map<string, RenovationStyle> | null {
  const model = store.get().model;
  return isRemodel(model?.document) ? stylesFor(model, renovationOf(store).get().filter) : null;
}

export function useRenovationStyles(model: EditorModel | null, filter: RenovationFilter | null): Map<string, RenovationStyle> | null {
  return useMemo(() => stylesFor(model, filter), [model, filter]);
}

/** The level as a click picks from it under a filter: what the filter hides is not there to pick. */
export function pickableUnder(level: LevelView, styles: ReadonlyMap<string, RenovationStyle> | null): LevelView {
  if (styles === null) return level;
  const hidden = (id: string): boolean => styles.get(id) === 'hidden';
  return {
    ...level,
    walls: level.walls.filter((w) => !hidden(w.id)),
    separators: level.separators.filter((s) => !hidden(s.id)),
    openings: level.openings.filter((o) => !hidden(o.id)),
    faces: level.faces.map((f) => (f.room !== null && hidden(f.room) ? { ...f, room: null } : f)),
    slabs: level.slabs.filter((s) => !hidden(s.id)),
    devices: level.devices.filter((d) => !hidden(d.id)),
  };
}

const quote = (id: string): string => `"${id.replace(/["\\]/g, '\\$&')}"`;
const TARGETS = ['data-opening', 'data-furniture', 'data-device', 'data-slab', 'data-separator', 'data-room-face'];

/**
 * The canvas's per-element renovation styles (3.1) as one stylesheet, by ID: existing work subdued,
 * demolished work dashed in the demolition ink, new work in the new ink. Walls draw their own (they
 * are one poché, StyledWalls).
 */
export function RenovationCss({ styles }: { styles: ReadonlyMap<string, RenovationStyle> | null }) {
  const css = useMemo(() => {
    if (styles === null) return '';
    const by: Record<'existing' | 'demolished' | 'new', string[]> = { existing: [], demolished: [], new: [] };
    for (const [id, s] of styles) if (s === 'existing' || s === 'demolished' || s === 'new') by[s].push(id);
    const sel = (ids: string[]): string => ids.flatMap((id) => TARGETS.map((t) => `.fs-canvas [${t}=${quote(id)}]`)).join(',');
    let out = '';
    if (by.existing.length) out += `${sel(by.existing)}{opacity:var(--fs-reno-existing-opacity)}`;
    if (by.demolished.length) {
      const s = sel(by.demolished);
      out += `${s}{opacity:.9}`;
      out += `:is(${s}) :is(path,polygon,polyline,line,rect,circle,ellipse){stroke:var(--fs-reno-demolish)!important;stroke-dasharray:5 3}`;
      out += `:is(${s}) :is(image){opacity:.35}`;
    }
    if (by.new.length) out += `:is(${sel(by.new)}) :is(path,polygon,polyline,line,rect,circle,ellipse){stroke:var(--fs-reno-new)!important}`;
    return out;
  }, [styles]);
  return css === '' ? null : <style data-renovation-css="">{css}</style>;
}

// ─── The top bar's menu ──────────────────────────────────────────────────────────────────────

/** The renovation filter's dropdown, beside the plan style's: the four plans, or "Start a remodel". */
export function RenovationMenu({ store }: { store: EditorStore }) {
  const model = useEditorModel(store);
  const filter = useRenovation(store, (s) => s.filter);
  const reno = renovationOf(store);
  const remodel = isRemodel(model?.document);
  return (
    <Menu>
      <MenuTrigger>
        <Button className="fs-reno-menu__trigger" size="sm" variant="secondary" icon={<Hammer />} aria-label={remodel ? `Renovation plan: ${RENOVATION_FILTER_LABELS[filter]}` : 'Renovation'}>
          <span className="fs-reno-menu__label">{remodel ? RENOVATION_FILTER_LABELS[filter] : 'Remodel'}</span>
          <ChevronDown className="fs-reno-menu__chevron" aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="fs-reno-menu">
        {remodel ? (
          <>
            <MenuLabel>Renovation plan</MenuLabel>
            {RENOVATION_FILTERS.map((f) => (
              <MenuItem key={f} icon={f === filter ? <Check /> : <span className="fs-reno-menu__blank" />} onSelect={() => { reno.choose(f); }}>
                <span className="fs-reno-menu__row">
                  <span>{RENOVATION_FILTER_LABELS[f]}</span>
                  <span className="fs-reno-menu__summary">{FILTER_SUMMARY[f]}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuLabel>What you draw in Proposed and Combined is new</MenuLabel>
          </>
        ) : (
          <>
            <MenuLabel>A remodel marks what stands, what goes and what is new</MenuLabel>
            <MenuItem onSelect={() => { void reno.start(); }}>Start a remodel</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

const FILTER_SUMMARY: Readonly<Record<RenovationFilter, string>> = {
  existing: 'The house as it stands',
  demolition: 'What comes down, dashed',
  proposed: 'The house when the work is done',
  combined: 'Everything at once',
};

function useEditorModel(store: EditorStore): EditorModel | null {
  return useSyncExternalStore(store.subscribe, () => store.get().model, () => store.get().model);
}

// ─── The inspector's field ───────────────────────────────────────────────────────────────────

export const STATUS_OPTIONS: readonly { value: RenovationStatus; label: string }[] = (['existing', 'demolish', 'new'] as const).map((s) => ({ value: s, label: RENOVATION_STATUS_LABELS[s] }));

/** Can this element have a status (FS_renovation 1.3)? */
export function hasStatus(model: EditorModel, id: string): boolean {
  const c = model.index.get(id);
  return c === 'extension' || (R.RENOVATION_COLLECTIONS as readonly string[]).includes(c ?? '');
}

/** An element's status, existing by default; null for one that has none. */
export function statusIn(model: EditorModel, id: string): RenovationStatus | null {
  return R.statusOf(model.document, id) ?? null;
}

/**
 * The batch that gives `ids` the status (6.1): on each core element its own data — "existing" by
 * removing it — and each extension element's in the document's `elements`. 6.1.1: a wall's openings
 * and what is hosted on it follow it, so a wall marked to be demolished takes its door with it.
 */
export function statusBatch(model: EditorModel, ids: readonly string[], status: RenovationStatus): Batch {
  const doc = model.document as unknown as Record<string, Record<string, Record<string, unknown>> | undefined>;
  const all = new Set(ids);
  for (const id of ids) {
    if (model.index.get(id) !== 'walls') continue;
    for (const [oid, o] of Object.entries(doc['openings'] ?? {})) if (o['wall'] === id) all.add(oid);
    for (const e of model.ext.keys()) {
      const el = extElementOf(model, e);
      const h = el?.['host'] as { wall?: string } | undefined;
      if (h?.wall === id) all.add(e);
    }
  }
  const ops: Record<string, unknown>[] = [];
  if (!isRemodel(model.document)) ops.push({ op: 'setProperty', id: '$document', path: `/extensionsUsed/${NAME}`, value: VERSION });
  for (const id of [...all].sort()) {
    if (!hasStatus(model, id)) continue;
    const current = statusIn(model, id);
    if (current === status && (status !== 'existing' || !recorded(model, id))) continue;
    if (model.index.get(id) === 'extension') {
      ops.push(status === 'existing' ? { op: 'unsetProperty', id: '$document', path: `/extensions/${NAME}/elements/${id}` } : { op: 'setProperty', id: '$document', path: `/extensions/${NAME}/elements/${id}`, value: status });
    } else {
      ops.push(status === 'existing' ? { op: 'unsetProperty', id, path: `/extensions/${NAME}` } : { op: 'setProperty', id, path: `/extensions/${NAME}/status`, value: status });
    }
  }
  return ops as unknown as Batch;
}

/** Does the element record a status of its own (rather than existing by default)? */
function recorded(model: EditorModel, id: string): boolean {
  if (model.index.get(id) === 'extension') {
    const data = (model.document.extensions as Record<string, { elements?: Record<string, unknown> }> | undefined)?.[NAME];
    return data?.elements?.[id] !== undefined;
  }
  const c = model.index.get(id);
  const el = c === undefined ? undefined : ((model.document as unknown as Record<string, Record<string, { extensions?: Record<string, unknown> }> | undefined>)[c]?.[id]);
  return el?.extensions?.[NAME] !== undefined;
}

function extElementOf(model: EditorModel, id: string): Record<string, unknown> | undefined {
  const where = model.ext.get(id);
  if (where === undefined) return undefined;
  const data = (model.document.extensions as Record<string, { collections?: Record<string, Record<string, Record<string, unknown>>> }> | undefined)?.[where.extension];
  return data?.collections?.[where.collection]?.[id];
}

/** The inspector's Renovation field, for one element or a selection of many (FLR-T-18.8's `selected`). */
export function RenovationField({ store, model, ids, readOnly }: { store: EditorStore; model: EditorModel; ids: readonly string[]; readOnly: boolean }) {
  const carriers = ids.filter((id) => hasStatus(model, id));
  if (carriers.length === 0) return null;
  const statuses = new Set(carriers.map((id) => statusIn(model, id) ?? 'existing'));
  const value = statuses.size === 1 ? ([...statuses][0] ?? '') : '';
  const label = carriers.length === 1 ? (carriers[0] ?? '') : `${String(carriers.length)} elements`;
  return (
    <Row label="Renovation">
      <Select
        aria-label="Renovation"
        appearance="filled"
        value={value}
        {...(value === '' ? { placeholder: 'Mixed' } : {})}
        disabled={readOnly}
        options={STATUS_OPTIONS.map((o) => ({ ...o }))}
        onValueChange={(v) => {
        const batch = statusBatch(model, carriers, v as RenovationStatus);
        if (batch.length === 0) return;
          void store.apply(`Mark ${label} ${RENOVATION_STATUS_LABELS[v as RenovationStatus].toLowerCase()}`, batch, carriers.length > 1 ? { selectMany: () => [...ids] } : { select: () => carriers[0] });
        }}
      />
    </Row>
  );
}

/** The inspector's Renovation section for one element: its status, and what the field does to a wall's openings. */
export function RenovationSection({ store, model, id, readOnly }: { store: EditorStore; model: EditorModel; id: string; readOnly: boolean }) {
  if (!hasStatus(model, id)) return null;
  return (
    <Section title="Renovation">
      <RenovationField store={store} model={model} ids={[id]} readOnly={readOnly} />
      {model.index.get(id) === 'walls' ? <p className="fs-reno-note">A wall’s doors, windows and what hangs on it are marked with it.</p> : null}
    </Section>
  );
}

/** The class of an unstyled wall's polygon (no plan style): its status's look. */
export function renoWallClass(style: RenovationStyle | undefined): string | undefined {
  return style === 'demolished' ? 'fs-plan2__wall--demolished' : style === 'new' ? 'fs-plan2__wall--new' : style === 'existing' ? 'fs-reno-existing' : undefined;
}

/** The canvas's legend for a renovation plan: what is existing, to be demolished and new. */
export function RenovationLegend({ filter }: { filter: RenovationFilter }) {
  const rows: ['existing' | 'demolish' | 'new', string][] = [['existing', RENOVATION_STATUS_LABELS.existing]];
  if (filter !== 'proposed') rows.push(['demolish', RENOVATION_STATUS_LABELS.demolish]);
  if (filter !== 'demolition') rows.push(['new', RENOVATION_STATUS_LABELS.new]);
  return (
    <div className="fs-reno-legend" role="note" aria-label={`${RENOVATION_FILTER_LABELS[filter]} plan legend`}>
      <span className="fs-reno-legend__title">{RENOVATION_FILTER_LABELS[filter]} plan</span>
      {rows.map(([k, label]) => (
        <span key={k} className="fs-reno-legend__row" data-legend={k}>
          <span className={`fs-reno-legend__swatch fs-reno-legend__swatch--${k}`} aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  );
}
