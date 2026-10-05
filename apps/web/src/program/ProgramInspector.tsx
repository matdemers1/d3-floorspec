import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, IconButton, Input, SegmentedControl, Select } from '@d3cloud/ui';
import { Circle, Link2, Sparkles, Trash2, Waypoints, X } from 'lucide-react';
import { navigate } from '../lib/router';
import { useEditor, type EditorStore } from '../editor/store';
import { ROOM_FUNCTIONS } from '../editor/Inspector';
import { LengthField, ReadOnlyField, Row, Section, TextField } from '../editor/fields';
import { labelOf } from '../editor/model';
import {
  areaText,
  DEFAULT_KIND,
  DEFAULT_WEIGHT,
  edgeLabel,
  edgeState,
  formatArea,
  KIND_LABEL,
  KINDS,
  otherEnd,
  parseAreaInput,
  relate,
  relateRefusal,
  removeEdge,
  removeItem,
  setItem,
  setKind,
  setWeight,
  type AdjacencyKind,
  type EdgeRow,
  type ItemField,
  type ItemRow,
  type ProgramView,
} from './model';
import { runSolve } from './solve';
import type { Selection } from './Bubbles';

/**
 * The brief's inspector (the board's "05", right): the selected item's members, or the selected
 * line's kind and weight — each change a batch of Ops — and, always, the block that solves the
 * brief into layouts. The design's "Connection" and "Max walk" rows are left out: a Core 0.2
 * adjacency has only its pair, kind and weight (11.2).
 */
export function ProgramInspector({ store, view, selection, onSelect, onRelating }: { store: EditorStore; view: ProgramView; selection: Selection; onSelect: (s: Selection) => void; onRelating: (id: string | null) => void }) {
  const item = selection?.kind === 'item' ? view.items.find((i) => i.id === selection.id) : undefined;
  const edge = selection?.kind === 'edge' ? view.edges.find((e) => e.key === selection.key) : undefined;
  return (
    <div className="fs-inspector__body">
      {item !== undefined ? (
        <ItemPanel store={store} view={view} item={item} onSelect={onSelect} onRelating={onRelating} />
      ) : edge !== undefined ? (
        <EdgePanel store={store} view={view} edge={edge} onSelect={onSelect} />
      ) : view.items.length > 0 ? (
        <p className="fs-note">Select a bubble or a line to edit it. Drag one bubble onto another to relate them.</p>
      ) : null}
      <SolvePanel store={store} view={view} />
    </div>
  );
}

function useEditable(store: EditorStore, view: ProgramView): boolean {
  const readOnly = useEditor(store, (s) => s.readOnly);
  return readOnly === null && view.version === '0.2';
}

function Head({ icon, title, subtitle, onClose }: { icon: ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="fs-inspector__head">
      <span className="fs-inspector__icon">{icon}</span>
      <div className="fs-inspector__title">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <span className="fs-spacer" />
      <IconButton size="sm" label="Clear the selection" icon={<X />} onClick={onClose} />
    </div>
  );
}

// ─── An item ─────────────────────────────────────────────────────────────────────────────────

function ItemPanel({ store, view, item, onSelect, onRelating }: { store: EditorStore; view: ProgramView; item: ItemRow; onSelect: (s: Selection) => void; onRelating: (id: string | null) => void }) {
  const model = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  const editable = useEditable(store, view);
  const [refusal, setRefusal] = useState<string | null>(null);
  const edit = (field: ItemField, value: string | number | undefined, label: string) => {
    const batch = setItem(item, field, value);
    if (batch.length > 0) void store.apply(label, batch);
  };
  const lines = view.edges.filter((e) => e.a === item.id || e.b === item.id);
  const others = view.items.filter((i) => i.id !== item.id && !lines.some((e) => otherEnd(e, item.id) === i.id));
  const levels = model?.levels ?? [];
  return (
    <>
      <Head icon={<Circle />} title={item.label} subtitle={`Brief item ${item.id}`} onClose={() => { onSelect(null); }} />
      <Section title="Item">
        <TextField label="Name" value={item.name ?? ''} placeholder="No name" disabled={!editable} onCommit={(v) => { edit('name', v, `Rename ${item.label}`); }} />
        <Row label="Function">
          <Select
            aria-label="Function"
            appearance="filled"
            options={ROOM_FUNCTIONS.map(([value, label]) => ({ value, label }))}
            value={ROOM_FUNCTIONS.some(([v]) => v === item.function) ? item.function : 'unspecified'}
            disabled={!editable}
            onValueChange={(v) => { if (v !== item.function) edit('function', v, `Set the function of ${item.label}`); }}
          />
        </Row>
        <AreaField label="Target area" value={item.targetArea} units={units} disabled={!editable} hint="Each room’s net area" onCommit={(v) => { edit('targetArea', v, `Set the target area of ${item.label}`); }} />
        <AreaField label="Least area" value={item.minArea} units={units} disabled={!editable} hint="Below it, a room is too small" onCommit={(v) => { edit('minArea', v, `Set the least area of ${item.label}`); }} />
        <CountField value={item.count} disabled={!editable} onCommit={(v) => { edit('count', v, `Ask for ${String(v)} of ${item.label}`); }} />
        <Row label="Level">
          <Select
            aria-label="Preferred level"
            appearance="filled"
            options={[{ value: '', label: 'Any level' }, ...levels.map((l) => ({ value: l.id, label: l.name }))]}
            value={item.level ?? ''}
            disabled={!editable || (levels.length === 0 && item.level === undefined)}
            onValueChange={(v) => { if (v !== (item.level ?? '')) edit('level', v === '' ? undefined : v, `Set the level of ${item.label}`); }}
          />
        </Row>
      </Section>
      <Section title="In the plan">
        <p className="fs-note">{item.need.detail}.</p>
        {item.rooms.length > 0 ? (
          <ul className="fs-program__rooms">
            {item.rooms.map((room) => (
              <li key={room}>{model === null ? room : labelOf(model, room)}</li>
            ))}
          </ul>
        ) : (
          <p className="fs-note">A room fulfils it when the room’s Brief, in the plan’s inspector, names it — or solve layouts below.</p>
        )}
      </Section>
      <Section title="Related">
        {lines.length === 0 ? <p className="fs-note">No lines yet.</p> : null}
        {lines.map((e) => (
          <button key={e.key} type="button" className="fs-hosted" onClick={() => { onSelect({ kind: 'edge', key: e.key }); }}>
            <Waypoints aria-hidden="true" />
            <span>{view.items.find((i) => i.id === otherEnd(e, item.id))?.label ?? otherEnd(e, item.id)}</span>
            <span className="fs-spacer" />
            <span className="fs-mono-small">{KIND_LABEL[e.kind]}</span>
          </button>
        ))}
        {editable && others.length > 0 ? (
          <Row label="Relate to">
            <Select
              aria-label={`Relate ${item.label} to`}
              appearance="filled"
              placeholder="Choose an item…"
              options={others.map((o) => ({ value: o.id, label: o.label }))}
              value=""
              onValueChange={(other) => {
                onRelating(null);
                const refused = relateRefusal(view, item.id, other, DEFAULT_KIND);
                if (refused !== null) {
                  setRefusal(refused);
                  return;
                }
                setRefusal(null);
                void store.apply(`Relate ${item.label} and ${view.items.find((i) => i.id === other)?.label ?? other}`, relate(item.id, other)).then((ok) => {
                  if (ok) onSelect({ kind: 'edge', key: item.id < other ? `${item.id}|${other}|${DEFAULT_KIND}` : `${other}|${item.id}|${DEFAULT_KIND}` });
                });
              }}
            />
          </Row>
        ) : null}
        {refusal === null ? null : <p className="fs-field-error" role="alert">{refusal}</p>}
      </Section>
      {editable ? (
        <div className="fs-inspector__actions">
          <Button
            variant="danger-ghost"
            size="sm"
            icon={<Trash2 />}
            onClick={() => {
              void store.apply(`Remove ${item.label} from the brief`, removeItem(item)).then((ok) => { if (ok) onSelect(null); });
            }}
          >
            Delete item{item.rooms.length > 0 ? ' and unlink its rooms' : ''}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** An area, typed in the Ops area grammar or as a bare number in the display unit; empty clears it. */
function AreaField({ label, value, units, onCommit, disabled, hint }: { label: string; value: number | undefined; units: 'imperial' | 'metric'; onCommit: (v: number | undefined) => void; disabled: boolean; hint: string }) {
  const id = useId();
  const shown = value === undefined ? '' : formatArea(value, units);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setText(shown);
      setError(null);
    }
  }, [shown]);
  const commit = () => {
    editing.current = false;
    if (text.trim() === shown) return;
    if (text.trim() === '') {
      setError(null);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = parseAreaInput(text, units);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    setText(formatArea(parsed.value, units));
    if (parsed.value !== value) onCommit(parsed.value);
  };
  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        value={text}
        placeholder={units === 'metric' ? 'e.g. 12 m2' : 'e.g. 140 sq ft'}
        disabled={disabled}
        invalid={error !== null}
        aria-describedby={`${id}-help`}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          editing.current = true;
          if (value !== undefined) setText(areaText(value, units));
        }}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
          if (error !== null) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            editing.current = false;
            setText(shown);
            setError(null);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {error !== null ? (
        <p id={`${id}-help`} className="fs-field-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="fs-field-hint">
          {hint}
        </p>
      )}
    </Row>
  );
}

function CountField({ value, onCommit, disabled }: { value: number; onCommit: (v: number) => void; disabled: boolean }) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      setError('A whole number from 1 to 99');
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <Row label="How many" htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        type="number"
        min={1}
        max={99}
        value={text}
        disabled={disabled}
        invalid={error !== null}
        onChange={(e) => { setText(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          e.stopPropagation();
        }}
      />
      {error === null ? null : (
        <p className="fs-field-error" role="alert">
          {error}
        </p>
      )}
    </Row>
  );
}

// ─── A line ──────────────────────────────────────────────────────────────────────────────────

function EdgePanel({ store, view, edge, onSelect }: { store: EditorStore; view: ProgramView; edge: EdgeRow; onSelect: (s: Selection) => void }) {
  const editable = useEditable(store, view);
  const label = edgeLabel(view, edge);
  return (
    <>
      <Head icon={<Waypoints />} title={label} subtitle={`Adjacency · ${KIND_LABEL[edge.kind].toLowerCase()}`} onClose={() => { onSelect(null); }} />
      <SegmentedControl
        aria-label="Kind"
        size="sm"
        value={edge.kind}
        items={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], disabled: !editable }))}
        onValueChange={(v) => {
          const kind = v as AdjacencyKind;
          if (kind === edge.kind || !editable) return;
          void store.apply(`Make ${label} ${kind}`, setKind(view, edge, kind)).then((ok) => {
            if (ok) onSelect({ kind: 'edge', key: edge.a < edge.b ? `${edge.a}|${edge.b}|${kind}` : `${edge.b}|${edge.a}|${kind}` });
          });
        }}
      />
      <Section title="Adjacency">
        <Row label="Weight">
          <Select
            aria-label="Weight"
            appearance="filled"
            options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: i + 1 === DEFAULT_WEIGHT ? `${String(i + 1)} of 10 (default)` : `${String(i + 1)} of 10` }))}
            value={String(edge.weight)}
            disabled={!editable}
            onValueChange={(v) => { void store.apply(`Weigh ${label} ${v}`, setWeight(edge, Number(v))); }}
          />
        </Row>
        <ReadOnlyField label="In the plan" value={edgeState(edge).split(':')[0] ?? ''} />
        <p className="fs-note">{edgeState(edge)}. How much it matters, for a layout solver trading one line against another.</p>
      </Section>
      {editable ? (
        <div className="fs-inspector__actions">
          <Button variant="danger-ghost" size="sm" icon={<Trash2 />} onClick={() => { void store.apply(`Remove the line ${label}`, removeEdge(edge)).then((ok) => { if (ok) onSelect(null); }); }}>
            Delete line
          </Button>
        </div>
      ) : null}
    </>
  );
}

// ─── Solve ───────────────────────────────────────────────────────────────────────────────────

function SolvePanel({ store, view }: { store: EditorStore; view: ProgramView }) {
  const model = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  const pending = useEditor(store, (s) => s.pending);
  const editable = useEditable(store, view);
  const [width, setWidth] = useState<number | null>(null);
  const [depth, setDepth] = useState<number | null>(null);
  const [level, setLevel] = useState('');
  const [count, setCount] = useState('3');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const levels = model?.levels ?? [];
  const empty = (l: (typeof levels)[number]) => l.walls.length === 0 && l.rooms.length === 0 && l.junctions.length === 0 && l.separators.length === 0;
  const solve = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await runSolve(store, {
      count: Number(count),
      ...(level === '' ? {} : { level }),
      ...(width !== null && depth !== null ? { footprint: { width, depth } } : {}),
    });
    setBusy(false);
    if (outcome.status === 'solved') navigate(`/projects/${store.projectId}/layouts`);
    else setProblem(outcome.message);
  };
  return (
    <section className="fs-solve" aria-label="Solve layouts">
      <h3 className="fs-overline">Solve layouts</h3>
      <LengthField label="Width" value={width ?? undefined} units={units} allowEmpty positive placeholder="From the brief" hint="East–west; empty sizes it from the brief" disabled={!editable} onCommit={(v) => { setWidth(v); }} />
      <LengthField label="Depth" value={depth ?? undefined} units={units} allowEmpty positive placeholder="From the brief" hint="North–south; give both to fix the footprint" disabled={!editable} onCommit={(v) => { setDepth(v); }} />
      <Row label="Level">
        <Select
          aria-label="Level to lay out on"
          appearance="filled"
          options={[
            { value: '', label: levels.length === 0 ? 'Level 1 (added first)' : 'The first empty level' },
            ...levels.map((l) => ({ value: l.id, label: l.name, ...(empty(l) ? {} : { disabled: true, description: 'Already drawn on' }) })),
          ]}
          value={level}
          disabled={!editable}
          onValueChange={setLevel}
        />
      </Row>
      <Row label="Candidates">
        <Select aria-label="Candidates" appearance="filled" options={['3', '4', '5', '6'].map((n) => ({ value: n, label: n }))} value={count} disabled={!editable} onValueChange={setCount} />
      </Row>
      <p className="fs-note">The solver is a tool, not part of the standard — it only emits Floorspec Ops, so every candidate arrives as a changeset you can inspect.</p>
      {problem === null ? null : (
        <Alert tone="warning" title="No layouts" dynamic>
          {problem}
        </Alert>
      )}
      <Button variant="primary" icon={<Sparkles />} loading={busy} disabled={!editable || view.items.length === 0 || pending !== null} onClick={() => void solve()}>
        Solve {count} layouts
      </Button>
      {view.items.length === 0 ? <p className="fs-note">Add brief items first: the solver lays out the brief.</p> : null}
      <Button variant="ghost" size="sm" icon={<Link2 />} onClick={() => { navigate(`/projects/${store.projectId}/layouts`); }}>
        See the candidates
      </Button>
    </section>
  );
}
