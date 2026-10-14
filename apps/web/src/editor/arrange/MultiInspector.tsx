import { useState, type ReactNode } from 'react';
import { RenovationField } from '../renovation';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Select, Switch } from '@d3cloud/ui';
import { Layers, Trash2, X } from 'lucide-react';
import { useEditor, type EditorStore } from '../store';
import { kindOf, labelOf, sortedLevels, type EditorModel, type LevelView } from '../model';
import { faceAt } from '../geometry';
import { IntField, LengthField, ReadOnlyField, Row, Section, TextField } from '../fields';
import { typeChoices, type Batch } from '../ops';
import { moveDevice, rotateDevice, setMember, type HostRef } from '../systems/ops';
import { memberSpecs, type MemberSpec } from '../systems/schema';
import { anchorOf, type DeviceView } from '../systems/view';
import { api } from '../../lib/api';
import { SofaIcon } from '../icons';
import type { UnitSystem } from '../units';
import { copyToLevel, copyToProject, deleteSelection, describeMany, editable, respaceSelection, rowOf } from './actions';

/**
 * The inspector across a selection (FLR-T-18.8): the fields the selected elements share, each
 * showing its value where they agree and "Mixed" where they differ — and an edit to one is one batch
 * across all of them, so one undo takes it back. Below, copying them to another level or project.
 */

type Json = Record<string, unknown>;
const MIXED = 'Mixed';

/** The one value every element gives, or `undefined` when they differ (or none has one). */
function common<T>(values: readonly T[]): T | undefined {
  const first = values[0];
  return values.every((v) => JSON.stringify(v) === JSON.stringify(first)) ? first : undefined;
}

export function MultiInspector({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const selected = useEditor(store, (s) => s.selected);
  const levelId = useEditor(store, (s) => s.level);
  const canEdit = useEditor(store, (s) => editable(s));
  const units = useEditor(store, () => store.units);
  if (model === null) return null;
  const level = model.levels.find((l) => l.id === levelId);
  const ids = [...selected];
  const devices = ids.map((id) => level?.devices.find((d) => d.id === id)).filter((d): d is DeviceView => d !== undefined);
  const allDevices = devices.length === ids.length;
  const kinds = new Set(ids.map((id) => kindOf(model, id)));
  const edit = (label: string, batch: Batch) => {
    if (batch.length > 0) void store.apply(label, batch, { selectMany: () => ids });
  };
  const what = describeMany(model, ids);

  // The header: what they are, and what they have in common.
  const catalogue = allDevices ? common(devices.map((d) => d.element['catalogue'])) : undefined;
  const rooms = level === undefined ? [] : devices.map((d) => faceAt(level, anchorOf(d))?.room ?? null);
  const room = allDevices ? common(rooms) : undefined;
  const category = allDevices ? common(devices.map((d) => d.element['category'])) : undefined;
  const collection = allDevices ? common(devices.map((d) => `${d.extension}/${d.collection}`)) : undefined;
  const traits = [
    typeof catalogue === 'string'
      ? `Same catalogue item · ${catalogue}`
      : typeof category === 'string'
        ? `Same category · ${category}`
        : collection !== undefined
          ? `All ${collection.split('/')[1] ?? 'items'}`
          : kinds.size === 1
            ? 'All the same kind'
            : 'Mixed kinds',
    typeof room === 'string' ? labelOf(model, room) : null,
    level === undefined ? null : labelOf(model, level.id),
  ].filter((x): x is string => x !== null);

  const fields: ReactNode[] = [];
  if (typeof catalogue === 'string') fields.push(<ReadOnlyField key="item" label="Item" value={typeof devices[0]?.element['name'] === 'string' ? devices[0].element['name'] : catalogue} />);
  // Name: one for all.
  const names = ids.map((id) => {
    const e = elementJson(model, id);
    return typeof e?.['name'] === 'string' ? e['name'] : '';
  });
  const name = common(names);
  fields.push(
    <TextField
      key="name"
      label="Name"
      value={name ?? ''}
      placeholder={name === undefined ? MIXED : 'None'}
      disabled={!canEdit}
      onCommit={(v) => {
        edit(`Name ${what} “${v}”`, ids.flatMap((id): Batch => (v === '' ? (elementJson(model, id)?.['name'] === undefined ? [] : [{ op: 'unsetProperty', id, path: '/name' }]) : [{ op: 'setProperty', id, path: '/name', value: v }])));
      }}
    />,
  );
  // On a floor or standing free: their facing.
  const turnable = allDevices && devices.every((d) => d.host?.['mode'] === 'surface' || d.host?.['mode'] === 'free');
  if (turnable) {
    const rotation = common(devices.map((d) => Math.round((typeof d.host?.['rotation'] === 'number' ? d.host['rotation'] : 0) / 1_000_000)));
    fields.push(
      <IntField
        key="rotation"
        label="Rotation"
        unit="°"
        value={rotation === undefined ? undefined : ((rotation % 360) + 360) % 360}
        placeholder={rotation === undefined ? MIXED : '0'}
        min={-360}
        max={360}
        disabled={!canEdit}
        onCommit={(v) => {
          if (v !== null) edit(`Turn ${what} to ${String(v)}°`, devices.flatMap((d) => rotateDevice(d.id, v * 1_000_000)));
        }}
      />,
    );
  }
  // On a wall face: their height.
  const onWalls = allDevices && devices.every((d) => d.host?.['mode'] === 'wallFace');
  if (onWalls) {
    const height = common(devices.map((d) => Number(d.host?.['height'])));
    fields.push(
      <LengthField
        key="height"
        label="Height"
        value={height}
        units={units}
        {...(height === undefined ? { placeholder: MIXED } : {})}
        nonNegative
        disabled={!canEdit}
        onCommit={(v) => {
          if (v === null) return;
          edit(`Set ${what} ${String(v)} high`, devices.flatMap((d) => {
            const h = d.host as Json;
            const host: HostRef = { mode: 'wallFace', wall: String(h['wall']), side: h['side'] === 'left' ? 'left' : 'right', at: Number(h['offset']), height: v };
            return moveDevice(d.id, host);
          }));
        }}
      />,
    );
  }
  // In a row: the spacing, centre to centre.
  const row = level === undefined ? null : rowOf(level, ids);
  if (row !== null && allDevices) {
    fields.push(
      <LengthField
        key="spacing"
        label="Spacing"
        value={row.spacing ?? undefined}
        units={units}
        {...(row.spacing === null ? { placeholder: MIXED } : {})}
        positive
        disabled={!canEdit}
        onCommit={(v) => {
          if (v !== null) respaceSelection(store, v);
        }}
      />,
    );
  }
  // The same kind of extension element: its own members, from its schema.
  const kindKey = allDevices ? common(devices.map((d) => `${d.extension}/${d.collection}`)) : undefined;
  if (kindKey !== undefined && devices[0] !== undefined) {
    const specs = memberSpecs(devices[0].extension, devices[0].collection).filter((s) => s.type === 'enum' || s.type === 'int' || s.type === 'bool' || s.type === 'text' || s.type === 'length');
    for (const spec of specs) fields.push(<SharedMember key={`m-${spec.name}`} spec={spec} devices={devices} units={units} disabled={!canEdit} edit={(label, batch) => { edit(`${label} of ${what}`, batch); }} />);
  }
  // Walls, doors and windows: their type.
  if (kinds.size === 1 && (kinds.has('wall') || kinds.has('opening'))) {
    const isWall = kinds.has('wall');
    const member = isWall ? 'type' : 'fill';
    const values = ids.map((id) => elementJson(model, id)?.[member]);
    const value = common(values);
    const kind = isWall ? 'wallType' : value !== undefined && typeof value === 'string' && model.document.types?.[value]?.kind === 'windowType' ? 'windowType' : 'doorType';
    const choices = typeChoices(model.document, kind).filter((c) => !c.starter);
    if (choices.length > 0)
      fields.push(
        <Row key="type" label={isWall ? 'Wall type' : 'Type'}>
          <Select
            aria-label={isWall ? 'Wall type' : 'Type'}
            appearance="filled"
            options={[...(value === undefined ? [{ value: '', label: MIXED }] : []), ...choices.map((c) => ({ value: c.id, label: c.name }))]}
            value={typeof value === 'string' ? value : ''}
            disabled={!canEdit}
            onValueChange={(v) => {
              if (v !== '') edit(`Set the type of ${what}`, ids.map((id) => ({ op: 'setProperty' as const, id, path: `/${member}`, value: v })));
            }}
          />
        </Row>,
      );
  }

  return (
    <div className="fs-inspector__body" data-testid="multi-inspector">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">{allDevices ? <SofaIcon /> : <Layers aria-hidden="true" />}</span>
        <div className="fs-inspector__title">
          <h2>{what}</h2>
          <p>{traits.join(' · ')}</p>
        </div>
        <span className="fs-spacer" />
        <IconButton size="sm" label="Clear the selection" icon={<X />} onClick={() => { store.select(null); }} />
      </div>
      <Section title={`Shared fields · ${String(ids.length)} items`}>
        {fields}
        <RenovationField store={store} model={model} ids={ids} readOnly={!canEdit} />
        <p className="fs-multi__note">Edits apply to {ids.length === 2 ? 'both' : `all ${String(ids.length)}`} as one op. “Mixed” shows where they differ; typing replaces it for all.</p>
      </Section>
      {canEdit && level !== undefined ? <CopySection store={store} model={model} level={level} /> : null}
      {canEdit ? (
        <div className="fs-inspector__actions">
          <Button variant="danger-ghost" size="sm" icon={<Trash2 />} onClick={() => { deleteSelection(store); }}>
            Delete {String(ids.length)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function elementJson(model: EditorModel, id: string): Json | undefined {
  const c = model.index.get(id);
  if (c === 'extension') return model.levels.flatMap((l) => l.devices).find((d) => d.id === id)?.element;
  if (c === undefined || c === 'items' || c === 'record') return undefined;
  return ((model.document as unknown as Json)[c] as Record<string, Json | undefined> | undefined)?.[id];
}

/** One schema member across several elements of a kind: their common value, or Mixed. */
function SharedMember({ spec, devices, units, disabled, edit }: { spec: MemberSpec; devices: DeviceView[]; units: UnitSystem; disabled: boolean; edit: (label: string, batch: Batch) => void }) {
  const values = devices.map((d) => d.element[spec.name]);
  const value = common(values);
  const mixed = value === undefined && values.some((v) => v !== undefined);
  const set = (v: unknown) => { edit(`Set ${spec.label.toLowerCase()}`, devices.flatMap((d) => setMember(d.id, spec.name, v, d.element[spec.name] !== undefined))); };
  switch (spec.type) {
    case 'enum':
      return (
        <Row label={spec.label}>
          <Select
            aria-label={spec.label}
            appearance="filled"
            options={[...(mixed ? [{ value: '\u0000', label: MIXED }] : []), ...(spec.required ? [] : [{ value: '', label: 'Not stated' }]), ...spec.options.map((o) => ({ value: o, label: o }))]}
            value={mixed ? '\u0000' : typeof value === 'string' ? value : ''}
            disabled={disabled}
            onValueChange={(v) => {
              if (v !== '\u0000') set(v === '' ? undefined : v);
            }}
          />
        </Row>
      );
    case 'int':
      return <IntField label={spec.label} value={typeof value === 'number' ? value : undefined} unit={spec.unit} min={spec.min} max={spec.max} placeholder={mixed ? MIXED : 'Not stated'} allowEmpty={!spec.required} disabled={disabled} onCommit={(v) => { set(v ?? undefined); }} />;
    case 'length':
      return <LengthField label={spec.label} value={typeof value === 'number' ? value : undefined} units={units} placeholder={mixed ? MIXED : 'Not stated'} allowEmpty={!spec.required} positive disabled={disabled} onCommit={(v) => { set(v ?? undefined); }} />;
    case 'text':
      return <TextField label={spec.label} value={typeof value === 'string' ? value : ''} placeholder={mixed ? MIXED : 'None'} disabled={disabled} onCommit={(v) => { set(v === '' ? undefined : v); }} />;
    case 'bool':
      return (
        <Switch checked={mixed ? false : value === true} disabled={disabled} onCheckedChange={(on) => { set(on ? true : undefined); }}>
          {mixed ? `${spec.label} (mixed)` : spec.label}
        </Switch>
      );
    default:
      return null;
  }
}

/** Copy to another level of this project (in place), or into another project. */
function CopySection({ store, model, level }: { store: EditorStore; model: EditorModel; level: LevelView }) {
  const others = sortedLevels(model.document).filter((l) => l.id !== level.id);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <Section title="Copy">
      <div className="fs-multi__copy">
        {others.map((l) => (
          <Button key={l.id} variant="secondary" size="sm" icon={<Layers />} onClick={() => { copyToLevel(store, l.id); }}>
            Copy to {labelOf(model, l.id)}
          </Button>
        ))}
        <Menu
          onOpenChange={(open) => {
            if (open && projects === null)
              api.get<{ projects: { id: string; name: string }[] }>('/api/projects').then(
                (r) => { setProjects(r.projects.filter((p) => p.id !== store.projectId)); },
                () => { setFailed(true); },
              );
          }}
        >
          <MenuTrigger>
            <Button variant="ghost" size="sm">Copy to project…</Button>
          </MenuTrigger>
          <MenuContent align="end" aria-label="Copy to project">
            {projects === null ? <MenuItem disabled>{failed ? 'The projects could not be listed' : 'Loading projects…'}</MenuItem> : null}
            {projects?.length === 0 ? <MenuItem disabled>No other project</MenuItem> : null}
            {(projects ?? []).map((p) => (
              <MenuItem key={p.id} onSelect={() => { void copyToProject(store, p); }}>
                {p.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
    </Section>
  );
}
