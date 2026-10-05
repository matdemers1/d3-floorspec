import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, IconButton, Input, Select } from '@d3cloud/ui';
import { GitBranch, Pencil, Trash2, X } from 'lucide-react';
import type { DerivedOptionSet } from '@floorspec/engine';
import { useEditor, type EditorStore, type Layers } from './store';
import { labelOf, readModel, type EditorModel, type OptionSetView } from './model';
import { Section } from './fields';
import { Outline, Plan } from './Canvas';
import { fit } from './viewport';
import { formatArea, twiceArea } from './units';
import { setProperty, unsetProperty } from './ops';
import { addOption, addOptionSet, mayBeInOption, optionLabel, optionTitle } from './optionOps';

export { addOption, addOptionSet, mayBeInOption, nextIds, optionTitle } from './optionOps';

/**
 * Design options in the editor (Core 0.3, chapter 19; Floorspec Ops 0.3, 2.8; FLR-T-8.4): option
 * sets and their options created with addElement under named IDs, the design shown, the option the
 * editor edits in (every batch carries it as `context.option`), the primary switched with
 * setProperty, an element moved into or out of an option, and two options of a set compared side
 * by side — the board's "25 · Design options — Kitchen A vs B".
 */

type Json = Record<string, unknown>;

// ─── The top bar's chip ──────────────────────────────────────────────────────────────────────

export function OptionsChip({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const editOption = useEditor(store, (s) => s.editOption);
  const compare = useEditor(store, (s) => s.optionCompare);
  const open = useEditor(store, (s) => s.side === 'options');
  if (model === null) return null;
  const set = compare === null ? undefined : model.optionSets.find((s) => s.id === compare.set);
  const text =
    compare !== null && set !== undefined
      ? `Comparing ${set.name} ${optionLabel(set, compare.a)} ↔ ${optionLabel(set, compare.b)}`
      : editOption !== null
        ? `Editing ${optionTitle(model, editOption)}`
        : model.optionSets.length > 0
          ? `${String(model.optionSets.length)} option ${model.optionSets.length === 1 ? 'set' : 'sets'}`
          : 'Options';
  return (
    <button
      type="button"
      className={`fs-topbar__options${editOption !== null || compare !== null ? ' fs-topbar__options--on' : ''}`}
      aria-pressed={open}
      title="Design options: alternatives for one part of the design"
      onClick={() => { store.set({ side: open ? 'inspector' : 'options', findingsOpen: false }); }}
    >
      <GitBranch aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}

// ─── The right column: option sets ───────────────────────────────────────────────────────────

export function OptionsPanel({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const editOption = useEditor(store, (s) => s.editOption);
  const readOnly = useEditor(store, (s) => s.readOnly) !== null;
  if (model === null) return null;
  const close = () => { store.set({ side: 'inspector' }); };
  return (
    <div className="fs-inspector__body fs-options">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon"><GitBranch /></span>
        <div className="fs-inspector__title">
          <h2>Design options</h2>
          <p>{model.optionSets.length === 0 ? 'Alternatives for one part of the design' : `${String(model.optionSets.length)} option ${model.optionSets.length === 1 ? 'set' : 'sets'} · showing ${describeDesign(model)}`}</p>
        </div>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Close the design options" icon={<X />} onClick={close} />
      </div>
      <div className={`fs-options__editing${editOption === null ? '' : ' fs-options__editing--on'}`} role="status">
        <Pencil aria-hidden="true" />
        <span>{editOption === null ? 'Drawing in every design (common)' : `Drawing in ${optionTitle(model, editOption)} only`}</span>
        {editOption !== null ? (
          <Button size="sm" variant="ghost" onClick={() => { store.editIn(null); }}>
            Draw in common
          </Button>
        ) : null}
      </div>
      {model.optionSets.map((set) => (
        <OptionSetSection key={set.id} store={store} model={model} set={set} readOnly={readOnly} />
      ))}
      {!readOnly ? <NewOptionSet store={store} model={model} first={model.optionSets.length === 0} /> : null}
      <p className="fs-note">
        Elements belong to every design, or to exactly one option. Every design is checked against each set&rsquo;s primary; views, renders and exports pick one option per set.
      </p>
    </div>
  );
}

function describeDesign(model: EditorModel): string {
  return model.optionSets.map((s) => `${s.name} ${optionLabel(s, model.design[s.id] ?? s.primary)}`).join(', ');
}

function OptionSetSection({ store, model, set, readOnly }: { store: EditorStore; model: EditorModel; set: OptionSetView; readOnly: boolean }) {
  const editOption = useEditor(store, (s) => s.editOption);
  const shown = model.design[set.id] ?? set.primary;
  const derived = model.derived?.options?.[set.id];
  const [adding, setAdding] = useState('');
  const others = set.options.filter((o) => o.id !== set.primary);
  return (
    <Section
      title={`Option set · ${set.name}`}
      aside={
        !readOnly ? (
          <IconButton
            size="sm"
            variant="ghost"
            label={`Delete the option set ${set.name}`}
            icon={<Trash2 />}
            onClick={() => {
              store.set({
                prompt: { kind: 'remove', id: set.id, title: `Delete the option set ${set.name}?`, detail: `Its options and everything drawn in them go with it. The common design stays as it is. Undo brings them back.` },
              });
            }}
          />
        ) : undefined
      }
    >
      <ul className="fs-options__list" aria-label={`Options of ${set.name}`}>
        {set.options.map((o) => {
          const members = derived?.options[o.id]?.members.length;
          return (
            <li key={o.id} className={shown === o.id ? 'fs-options__option fs-options__option--shown' : 'fs-options__option'}>
              <label className="fs-options__show">
                <input type="radio" name={`show-${set.id}`} checked={shown === o.id} onChange={() => { store.showOption(set.id, o.id); }} aria-label={`Show ${o.name}`} />
                <span className="fs-options__name">{o.name}</span>
              </label>
              {o.id === set.primary ? <Badge tone="attention" size="sm">Primary</Badge> : null}
              <span className="fs-spacer" />
              <span className="fs-mono-small" title="Elements in this option">{members === undefined ? o.id : `${o.id} · ${String(members)}`}</span>
              {!readOnly ? (
                <Button
                  size="sm"
                  variant={editOption === o.id ? 'primary' : 'ghost'}
                  aria-pressed={editOption === o.id}
                  onClick={() => { store.editIn(editOption === o.id ? null : o.id); }}
                >
                  {editOption === o.id ? 'Editing' : 'Edit in'}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="fs-options__actions">
        {others.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => { store.set({ optionCompare: { set: set.id, a: set.primary, b: shown === set.primary ? (others[0]?.id ?? shown) : shown }, side: 'options' }); }}>
            Compare side by side
          </Button>
        ) : null}
        {!readOnly && shown !== set.primary ? (
          <Button size="sm" variant="secondary" onClick={() => void store.apply(`Make ${optionLabel(set, shown)} primary`, setProperty(set.id, '/primary', shown))}>
            Make {optionLabel(set, shown)} primary
          </Button>
        ) : null}
      </div>
      {!readOnly ? (
        <form
          className="fs-options__add"
          onSubmit={(e) => {
            e.preventDefault();
            void store.apply(`Add option to ${set.name}`, addOption(model, set.id, adding.trim()));
            setAdding('');
          }}
        >
          <Input aria-label={`Name of a new option of ${set.name}`} size="sm" value={adding} placeholder="New option name" onChange={(e) => { setAdding(e.target.value); }} />
          <Button size="sm" variant="ghost" type="submit">Add option</Button>
        </form>
      ) : null}
    </Section>
  );
}

function NewOptionSet({ store, model, first }: { store: EditorStore; model: EditorModel; first: boolean }) {
  const [name, setName] = useState('');
  const [a, setA] = useState('A');
  const [b, setB] = useState('B');
  const ok = a.trim() !== '' && b.trim() !== '' && a.trim() !== b.trim();
  return (
    <Section title={first ? 'Start an option set' : 'New option set'}>
      <form
        className="fs-options__new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          const label = name.trim() === '' ? 'Add an option set' : `Add option set ${name.trim()}`;
          void store.apply(label, addOptionSet(model, name.trim(), [a.trim(), b.trim()]));
          setName('');
        }}
      >
        <Input aria-label="Option set name" size="sm" value={name} placeholder="What it decides — Kitchen" onChange={(e) => { setName(e.target.value); }} />
        <div className="fs-options__pair">
          <Input aria-label="First option (primary)" size="sm" value={a} onChange={(e) => { setA(e.target.value); }} />
          <Input aria-label="Second option" size="sm" value={b} onChange={(e) => { setB(e.target.value); }} />
        </div>
        <Button size="sm" variant="primary" type="submit" disabled={!ok}>
          Create option set
        </Button>
      </form>
    </Section>
  );
}

// ─── The inspector: which option an element is in ────────────────────────────────────────────

export function OptionMembership({ store, model, id, element, readOnly }: { store: EditorStore; model: EditorModel; id: string; element: Json; readOnly: boolean }) {
  if (model.optionSets.length === 0 || !mayBeInOption(model, id)) return null;
  const current = typeof element['option'] === 'string' ? element['option'] : '';
  const options = [
    { value: '', label: 'Every design (common)' },
    ...model.optionSets.flatMap((s) => s.options.map((o) => ({ value: o.id, label: `${s.name} · ${o.name}` }))),
  ];
  return (
    <Section title="Design option">
      <Select
        aria-label="Design option"
        appearance="filled"
        options={options}
        value={current}
        disabled={readOnly}
        onValueChange={(v) => {
          if (v === current) return;
          const batch = v === '' ? unsetProperty(id, '/option') : setProperty(id, '/option', v);
          void store.apply(v === '' ? `Make ${labelOf(model, id)} common` : `Move ${labelOf(model, id)} to ${optionTitle(model, v)}`, batch, { select: () => id });
        }}
      />
      <p className="fs-note">{current === '' ? 'In every design.' : `Only in designs that choose ${optionTitle(model, current)}.`}</p>
    </Section>
  );
}

// ─── Side by side ────────────────────────────────────────────────────────────────────────────

interface Pane {
  option: string;
  label: string;
  model: EditorModel;
}

/** The two designs being compared, read from the head, and the derived `options` of the set (Core 19.6.3). */
function useComparison(store: EditorStore): { set: OptionSetView; panes: [Pane, Pane]; derived: DerivedOptionSet | undefined } | null {
  const model = useEditor(store, (s) => s.model);
  const compare = useEditor(store, (s) => s.optionCompare);
  return useMemo(() => {
    if (model === null || compare === null) return null;
    const set = model.optionSets.find((s) => s.id === compare.set);
    if (set === undefined) return null;
    const pane = (option: string): Pane => ({
      option,
      label: `${optionLabel(set, option)}${option === set.primary ? ' (primary)' : ''}`,
      model: readModel(model.hash, model.document, { ...model.design, [set.id]: option }),
    });
    return { set, panes: [pane(compare.a), pane(compare.b)], derived: model.derived?.options?.[set.id] };
  }, [model, compare]);
}

const QUIET: Layers = { walls: true, openings: true, rooms: true, dimensions: false, findings: false, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false };

/** The canvas while two options are compared: two plans, one per design, on one scale and one origin. */
export function OptionCompareCanvas({ store }: { store: EditorStore }) {
  const c = useComparison(store);
  const level = useEditor(store, (s) => s.level);
  const units = useEditor(store, () => store.units);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const o = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width / 2, h: r.height });
    });
    o.observe(el);
    return () => { o.disconnect(); };
  }, []);
  if (c === null) return null;
  const views = c.panes.map((p) => p.model.levels.find((l) => l.id === level));
  const bounds = views.reduce<{ minX: number; minY: number; maxX: number; maxY: number } | null>((acc, v) => {
    const b = v?.bounds ?? null;
    if (b === null) return acc;
    if (acc === null) return { ...b };
    return { minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) };
  }, null);
  const affected = new Set(c.panes.flatMap((p) => c.derived?.options[p.option]?.affected ?? []));
  return (
    <div className="fs-compare-options" ref={host} role="region" aria-label={`Comparing ${c.set.name}`}>
      {c.panes.map((p, i) => {
        const lv = views[i];
        const view = size === null ? null : fit(bounds, size.w, size.h, 48);
        const members = c.derived?.options[p.option]?.members ?? [];
        return (
          <section key={p.option} className="fs-compare-options__pane" aria-label={`Design ${p.label}`} data-option={p.option}>
            <span className={p.option === c.set.primary ? 'fs-compare-options__label fs-compare-options__label--primary' : 'fs-compare-options__label'}>{p.label}</span>
            {view !== null && lv !== undefined ? (
              <svg className="fs-canvas__svg" width={view.w} height={view.h} aria-hidden="true">
                <Plan view={view} level={lv} document={p.model.document} layers={QUIET} units={units} />
                <g className="fs-diffs">
                  {[...affected].map((id) => <Outline key={`a-${id}`} view={view} level={lv} id={id} className="fs-diff fs-diff--changed" />)}
                  {members.map((id) => <Outline key={`m-${id}`} view={view} level={lv} id={id} className="fs-diff fs-diff--added" />)}
                </g>
              </svg>
            ) : lv === undefined ? (
              <p className="fs-note fs-compare-options__none">{p.model.designDerives ? 'This level is not in this design.' : 'This design does not validate, so it has no plan.'}</p>
            ) : null}
          </section>
        );
      })}
      <div className="fs-legend fs-compare-options__legend" aria-hidden="true">
        <span className="fs-legend__item"><span className="fs-legend__dot fs-legend__dot--added" />In the option</span>
        <span className="fs-legend__item"><span className="fs-legend__dot fs-legend__dot--changed" />Common, changed by an option</span>
      </div>
    </div>
  );
}

/** The right column while two options are compared: what each design's rooms measure, and what it changes. */
export function OptionComparePanel({ store }: { store: EditorStore }) {
  const c = useComparison(store);
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly) !== null;
  const units = useEditor(store, () => store.units);
  if (c === null || model === null) return null;
  const [a, b] = c.panes;
  const rows = [...new Set([...Object.keys(c.derived?.options[a.option]?.rooms ?? {}), ...Object.keys(c.derived?.options[b.option]?.rooms ?? {})])].sort((x, y) =>
    labelOf(model, x).localeCompare(labelOf(model, y)),
  );
  const area = (option: string, room: string): string => {
    const v = c.derived?.options[option]?.rooms[room];
    return v === undefined ? '—' : formatArea(twiceArea(v), units);
  };
  const end = () => { store.set({ optionCompare: null }); };
  const set = model.optionSets.find((s) => s.id === c.set.id) ?? c.set;
  const row = (label: string, x: ReactNode, y: ReactNode, key = label) => (
    <tr key={key}>
      <th scope="row">{label}</th>
      <td>{x}</td>
      <td>{y}</td>
    </tr>
  );
  return (
    <div className="fs-inspector__body fs-options">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon"><GitBranch /></span>
        <div className="fs-inspector__title">
          <h2>Option set · {set.name}</h2>
          <p>{set.id} · {String(set.options.length)} options · primary {optionLabel(set, set.primary)}</p>
        </div>
        <span className="fs-spacer" />
        <IconButton size="sm" label="End the comparison" icon={<X />} onClick={end} />
      </div>
      {c.derived === undefined ? (
        <p className="fs-note">The model does not validate, so its options cannot be compared. Fix it first.</p>
      ) : (
        <table className="fs-compare-table" aria-label={`${set.name}: ${a.label} and ${b.label}`}>
          <thead>
            <tr>
              <th scope="col"><span className="fs-visually-hidden">Measure</span></th>
              <th scope="col">{optionLabel(set, a.option)}</th>
              <th scope="col">{optionLabel(set, b.option)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => row(`${labelOf(model, r)} area`, area(a.option, r), area(b.option, r), r))}
            {row('Elements in option', String(c.derived.options[a.option]?.members.length ?? 0), String(c.derived.options[b.option]?.members.length ?? 0))}
            {row('Common elements changed', String(c.derived.options[a.option]?.affected.length ?? 0), String(c.derived.options[b.option]?.affected.length ?? 0))}
          </tbody>
        </table>
      )}
      <p className="fs-note">Each option is compared with the primary design. Areas are net, inside the finished faces (Core 6.4).</p>
      <div className="fs-options__actions fs-options__actions--stack">
        {!readOnly && b.option !== set.primary ? (
          <Button variant="secondary" onClick={() => void store.apply(`Make ${optionLabel(set, b.option)} primary`, setProperty(set.id, '/primary', b.option))}>
            Make {optionLabel(set, b.option)} primary
          </Button>
        ) : null}
        {!readOnly && a.option !== set.primary ? (
          <Button variant="secondary" onClick={() => void store.apply(`Make ${optionLabel(set, a.option)} primary`, setProperty(set.id, '/primary', a.option))}>
            Make {optionLabel(set, a.option)} primary
          </Button>
        ) : null}
        <div className="fs-options__pair">
          <Select
            aria-label="Left design"
            appearance="filled"
            options={set.options.map((o) => ({ value: o.id, label: o.name }))}
            value={a.option}
            onValueChange={(v) => { store.set({ optionCompare: { set: set.id, a: v, b: b.option } }); }}
          />
          <Select
            aria-label="Right design"
            appearance="filled"
            options={set.options.map((o) => ({ value: o.id, label: o.name }))}
            value={b.option}
            onValueChange={(v) => { store.set({ optionCompare: { set: set.id, a: a.option, b: v } }); }}
          />
        </div>
        <Button variant="ghost" onClick={end}>End comparison</Button>
      </div>
    </div>
  );
}
