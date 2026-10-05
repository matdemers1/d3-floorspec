import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, FormActions, FormField, Input, Modal, Select, Stack } from '@d3cloud/ui';
import { Plus, Sparkles } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { ROOM_FUNCTIONS } from '../editor/Inspector';
import { addItem, formatArea, parseAreaInput, upgrade, type ProgramView } from './model';
import type { Selection } from './Bubbles';

/**
 * The brief table (the board's "05 · Program & bubble diagram", left): one row per brief item —
 * what its owners call it, its function, the area each of its rooms is meant to have, how many,
 * and whether the plan meets it yet (NEED, from the engine's derived values).
 */
export function BriefPanel({ store, view, selection, onSelect }: { store: EditorStore; view: ProgramView; selection: Selection; onSelect: (s: Selection) => void }) {
  const readOnly = useEditor(store, (s) => s.readOnly);
  const pending = useEditor(store, (s) => s.pending);
  const units = useEditor(store, () => store.units);
  const [adding, setAdding] = useState(false);
  const old = view.version === '0.1';
  const editable = readOnly === null && !old;
  const summary = [
    `${String(view.items.length)} ${view.items.length === 1 ? 'item' : 'items'}`,
    view.target > 0 ? `${formatArea(view.target, units)} target` : null,
    view.items.length === 0 ? null : view.unmet.items === 0 && view.unmet.edges === 0 ? 'all met' : `${String(view.unmet.items + view.unmet.edges)} unmet`,
    'Floorspec program',
  ]
    .filter((x) => x !== null)
    .join(' · ');
  return (
    <div className="fs-brief">
      <div className="fs-brief__head">
        <div>
          <h2>Brief</h2>
          <p>{summary}</p>
        </div>
        <span className="fs-spacer" />
        <Button size="sm" variant="secondary" icon={<Plus />} disabled={!editable} onClick={() => { setAdding(true); }}>
          Add item
        </Button>
      </div>
      {old ? (
        <Alert tone="info" title={`This plan is Floorspec ${view.version}`}>
          <p>A brief is part of Floorspec 0.2 and later. Upgrading to 0.3 changes nothing else in the plan, and Undo takes it back.</p>
          <Button size="sm" variant="primary" loading={pending !== null} disabled={readOnly !== null} onClick={() => void store.apply('Upgrade to Floorspec 0.3', upgrade())}>
            Upgrade to Floorspec 0.3
          </Button>
        </Alert>
      ) : null}
      {readOnly !== null ? (
        <Alert tone="warning" title="View only">
          {readOnly}
        </Alert>
      ) : null}
      {view.items.length === 0 ? (
        <EmptyState
          kind="empty"
          size="inline"
          heading="No brief yet"
          action={
            editable ? (
              <Button variant="primary" icon={<Plus />} onClick={() => { setAdding(true); }}>
                Add the first item
              </Button>
            ) : undefined
          }
        >
          List what the house must have — each kind of room, how many and how large — then relate them on the diagram. The plan is checked against it.
        </EmptyState>
      ) : (
        <table className="fs-brief__table">
          <caption className="fs-visually-hidden">Brief items: function, target area, count and whether the plan meets each</caption>
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col" className="fs-brief__fn">Function</th>
              <th scope="col">Area</th>
              <th scope="col">
                <span aria-hidden="true">×</span>
                <span className="fs-visually-hidden">Count</span>
              </th>
              <th scope="col">Need</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => {
              const selected = selection?.kind === 'item' && selection.id === item.id;
              return (
                <tr key={item.id} className={selected ? 'is-selected' : undefined} onClick={() => { onSelect({ kind: 'item', id: item.id }); }}>
                  <th scope="row">
                    <button type="button" className="fs-brief__name" aria-pressed={selected} onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'item', id: item.id }); }}>
                      {item.label}
                    </button>
                  </th>
                  <td className="fs-brief__fn">
                    <Badge size="sm">{item.function}</Badge>
                  </td>
                  <td className="fs-brief__mono">{item.targetArea === undefined ? '—' : formatArea(item.targetArea, units)}</td>
                  <td className="fs-brief__mono">{item.count}</td>
                  <td>
                    <Badge size="sm" tone={item.need.tone} title={item.need.detail}>
                      {item.need.label}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="fs-brief__claude">
        <p className="fs-brief__claude-head">
          <Sparkles aria-hidden="true" />
          Draft it with Claude
        </p>
        <p>Describe the house in your own words. Claude writes the brief as operations — addProgramItem, setAdjacency — in a changeset you accept.</p>
      </div>
      <AddItemModal store={store} open={adding} onOpenChange={setAdding} onAdded={(id) => { onSelect({ kind: 'item', id }); }} />
    </div>
  );
}

function AddItemModal({ store, open, onOpenChange, onAdded }: { store: EditorStore; open: boolean; onOpenChange: (open: boolean) => void; onAdded: (id: string) => void }) {
  const units = useEditor(store, () => store.units);
  const [name, setName] = useState('');
  const [fn, setFn] = useState('sleeping');
  const [area, setArea] = useState('');
  const [count, setCount] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setFn('sleeping');
      setArea('');
      setCount('1');
      setError(null);
    }
  }, [open]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = area.trim() === '' ? null : parseAreaInput(area, units);
    if (parsed !== null && !parsed.ok) {
      setError(parsed.reason);
      return;
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      setError('The count is a whole number from 1 to 99.');
      return;
    }
    setBusy(true);
    let created: string | null = null;
    void store
      .apply(`Add ${name.trim() === '' ? 'a brief item' : name.trim()}`, addItem({ function: fn, name: name.trim(), count: n, targetArea: parsed?.value }), {
        select: (ids) => {
          created = ids[0] ?? null;
          return undefined;
        },
      })
      .then((ok) => {
        setBusy(false);
        if (!ok) {
          setError(store.get().rejection?.diagnostics.map((d) => d.message).join(' ') ?? 'The item was not added.');
          store.dismissRejection();
          return;
        }
        onOpenChange(false);
        if (created !== null) onAdded(created);
      });
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a brief item" description="A space the house must have. It is added to the plan as an operation, so Undo takes it back.">
      <form onSubmit={submit}>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" dynamic>
              {error}
            </Alert>
          )}
          <FormField label="Name" optional>
            <Input name="name" autoFocus maxLength={200} value={name} placeholder="Primary bedroom" onChange={(e) => { setName(e.target.value); }} />
          </FormField>
          <FormField label="Function">
            <Select options={ROOM_FUNCTIONS.filter(([v]) => v !== 'unspecified').map(([value, label]) => ({ value, label }))} value={fn} onValueChange={setFn} />
          </FormField>
          <FormField label="Target area" optional help={units === 'metric' ? 'Each room’s net area: 12 m2, or 130 sq ft' : 'Each room’s net area: 140 sq ft, or 13 m2'}>
            <Input name="targetArea" value={area} placeholder={units === 'metric' ? '12 m2' : '140 sq ft'} onChange={(e) => { setArea(e.target.value); }} />
          </FormField>
          <FormField label="How many">
            <Input name="count" type="number" min={1} max={99} value={count} onChange={(e) => { setCount(e.target.value); }} />
          </FormField>
          <FormActions>
            <Button type="button" variant="secondary" onClick={() => { onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Add item
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}
