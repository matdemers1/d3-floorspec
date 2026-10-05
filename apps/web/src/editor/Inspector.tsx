import type { ReactNode } from 'react';
import { Button, IconButton, SegmentedControl, Select, Switch } from '@d3cloud/ui';
import { Trash2, X } from 'lucide-react';
import type { FloorspecDocument } from '@floorspec/engine';
import { useEditor, type EditorStore } from './store';
import { elementOf, effectiveLayers, kindOf, labelOf, type EditorModel, type Kind, type Layer, type LevelView } from './model';
import { dist, roomsBeside } from './geometry';
import { LengthField, ReadOnlyField, Row, Section, TextField } from './fields';
import { formatArea, formatLen, prettyLen, type UnitSystem } from './units';
import {
  moveJunction,
  moveOpening,
  moveWall,
  setOrUnset,
  setProperty,
  setRoomFinish,
  typeChoices,
  unsetProperty,
  useType,
  type Batch,
  type BatchBuilder,
  type TypeChoice,
} from './ops';
import { requestRemove, switchUnits } from './actions';
import { DoorIcon, JunctionIcon, RoofIcon, RoomIcon, SeparatorIcon, WallIcon, WindowIcon } from './icons';
import { FindingsList } from './Diagnostics';
import { Layers as LayersIcon, Palette, House } from 'lucide-react';
import type { ToolController } from './tools';
import { DeviceBody, DevicePanel, RecordBody, SystemIcon, SystemsSummary } from './systems/Panels';
import { systemOfExtension } from './systems/catalog';
import { ClearOpeningFields, CoreUpgradeNotice } from './OpeningFields';
import {
  clearOpeningOf,
  clearOpeningText,
  CURRENT_CORE,
  hingeApplies,
  holdsClearOpenings,
  operationLabel,
  operationOptions,
  setClearOpening,
  setOperation,
  swingApplies,
  type ClearOpening,
} from './openings';

/**
 * The inspector (FLR-T-3.3): every element kind's members, each edit a setProperty/unsetProperty
 * or the composite that means it — a wall's length moves its end junction, its offset is moveWall,
 * an opening's position is moveOpening. Lengths are typed in the reference grammar (FLR-T-3.4).
 */

type Json = Record<string, unknown>;

export const ROOM_FUNCTIONS: readonly [string, string][] = [
  ['unspecified', 'Unspecified'],
  ['sleeping', 'Sleeping'],
  ['bath', 'Bath'],
  ['kitchen', 'Kitchen'],
  ['living', 'Living'],
  ['dining', 'Dining'],
  ['office', 'Office'],
  ['laundry', 'Laundry'],
  ['utility', 'Utility'],
  ['storage', 'Storage'],
  ['circulation', 'Circulation'],
  ['mechanical', 'Mechanical'],
  ['garage', 'Garage'],
  ['exterior', 'Exterior'],
];

interface Ctx {
  store: EditorStore;
  model: EditorModel;
  id: string;
  element: Json;
  units: UnitSystem;
  level: LevelView | undefined;
  readOnly: boolean;
  edit: (label: string, batch: Batch | BatchBuilder) => void;
}

export function Inspector({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const model = useEditor(store, (s) => s.model);
  const selection = useEditor(store, (s) => s.selection);
  const tool = useEditor(store, (s) => s.tool);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const focus = useEditor(store, (s) => s.focus);
  const levelId = useEditor(store, (s) => s.level);
  const units = useEditor(store, () => store.units);
  if (model === null) return null;
  if (tool === 'device' && readOnly === null) return <DevicePanel store={store} tools={tools} model={model} />;
  if (tool !== 'select' && readOnly === null) return <DrawPanel store={store} model={model} />;
  const element = selection === null ? undefined : elementOf(model, selection);
  const kind = selection === null ? null : kindOf(model, selection);
  if (selection === null || element === undefined || kind === null) return <ProjectPanel store={store} model={model} units={units} readOnly={readOnly !== null} />;
  const ctx: Ctx = {
    store,
    model,
    id: selection,
    element,
    units,
    level: model.levels.find((l) => l.id === levelId),
    readOnly: readOnly !== null,
    edit: (label, batch) => {
      void store.apply(label, batch, { select: () => selection });
    },
  };
  const body = bodyFor(kind, ctx, focus);
  return (
    <div className="fs-inspector__body">
      <Header ctx={ctx} kind={kind} />
      {body}
      {!ctx.readOnly ? (
        <div className="fs-inspector__actions">
          <Button variant="danger-ghost" size="sm" icon={<Trash2 />} onClick={() => { requestRemove(store, selection); }}>
            Delete {noun(kind)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function noun(kind: Kind): string {
  switch (kind) {
    case 'wallType':
    case 'doorType':
    case 'windowType':
      return 'type';
    case 'item':
      return 'brief item';
    case 'extensionElement':
      return 'device';
    case 'gasSource':
      return 'gas source';
    default:
      return kind;
  }
}

function kindIcon(kind: Kind): ReactNode {
  switch (kind) {
    case 'wall':
    case 'wallType':
      return <WallIcon />;
    case 'opening':
    case 'doorType':
      return <DoorIcon />;
    case 'windowType':
      return <WindowIcon />;
    case 'room':
      return <RoomIcon />;
    case 'separator':
      return <SeparatorIcon />;
    case 'junction':
      return <JunctionIcon />;
    case 'level':
      return <LayersIcon />;
    case 'building':
      return <RoofIcon />;
    case 'material':
      return <Palette />;
    case 'circuit':
      return <SystemIcon system="electrical" />;
    case 'stack':
      return <SystemIcon system="plumbing" />;
    case 'gasSource':
      return <SystemIcon system="mechanical" />;
    default:
      return <House />;
  }
}

function Header({ ctx, kind }: { ctx: Ctx; kind: Kind }) {
  const { model, id, level } = ctx;
  const device = kind === 'extensionElement' ? model.levels.flatMap((l) => l.devices).find((d) => d.id === id) : undefined;
  const record = model.records.get(id);
  let subtitle: string =
    kind === 'wallType' ? 'Wall type' : kind === 'doorType' ? 'Door type' : kind === 'windowType' ? 'Window type' : kind === 'item' ? 'Brief item'
      : kind === 'extensionElement' ? `${device?.kindLabel ?? 'Element'} · ${ctx.model.ext.get(ctx.id)?.extension ?? 'extension'}`
        : record !== undefined ? `${kind === 'circuit' ? 'Circuit' : kind === 'stack' ? 'Stack' : 'Gas source'} · ${record.extension}`
          : kind.charAt(0).toUpperCase() + kind.slice(1);
  if ((kind === 'wall' || kind === 'separator') && level !== undefined) {
    const sides = roomsBeside(level, id);
    const name = (r: string | null) => (r === null ? 'Outside' : labelOf(model, r));
    subtitle = `${name(sides.left)} | ${name(sides.right)}${kind === 'wall' ? (sides.left === null || sides.right === null ? ' · exterior' : ' · interior') : ''}`;
  }
  const title = kind === 'room' ? labelOf(model, id) : `${labelOf(model, id)}${labelOf(model, id).includes(id) ? '' : ` · ${id}`}`;
  return (
    <div className="fs-inspector__head">
      <span className="fs-inspector__icon">{kind === 'opening' && level?.openings.find((o) => o.id === id)?.kind === 'window' ? <WindowIcon /> : kind === 'extensionElement' ? <SystemIcon system={systemOfExtension(model.ext.get(id)?.extension ?? '')} /> : kindIcon(kind)}</span>
      <div className="fs-inspector__title">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <span className="fs-spacer" />
      <IconButton size="sm" label="Clear the selection" icon={<X />} onClick={() => { ctx.store.select(null); }} />
    </div>
  );
}

function bodyFor(kind: Kind, ctx: Ctx, focus: string | null): ReactNode {
  switch (kind) {
    case 'wall':
      return <WallBody ctx={ctx} />;
    case 'separator':
      return <SeparatorBody ctx={ctx} />;
    case 'junction':
      return <JunctionBody ctx={ctx} />;
    case 'opening':
      return <OpeningBody ctx={ctx} />;
    case 'room':
      return <RoomBody ctx={ctx} focusName={focus === 'room-name'} />;
    case 'level':
      return <LevelBody ctx={ctx} />;
    case 'building':
      return <NameOnly ctx={ctx} />;
    case 'wallType':
      return <WallTypeBody ctx={ctx} />;
    case 'doorType':
    case 'windowType':
      return <FillTypeBody ctx={ctx} />;
    case 'material':
      return <MaterialBody ctx={ctx} />;
    case 'extensionElement':
      return <DeviceBody ctx={ctx} device={ctx.model.levels.flatMap((l) => l.devices).find((d) => d.id === ctx.id)} />;
    case 'circuit':
    case 'stack':
    case 'gasSource':
      return <RecordBody ctx={ctx} />;
    default:
      return <NameOnly ctx={ctx} />;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function NameField({ ctx, autoFocus }: { ctx: Ctx; autoFocus?: boolean }) {
  const name = str(ctx.element['name']) ?? '';
  return (
    <TextField
      label="Name"
      value={name}
      disabled={ctx.readOnly}
      autoFocus={autoFocus}
      placeholder="No name"
      onCommit={(v) => { ctx.edit(`Rename ${ctx.id}`, setOrUnset(ctx.id, '/name', v, name !== '')); }}
    />
  );
}

function NameOnly({ ctx }: { ctx: Ctx }) {
  return (
    <Section title="Identity">
      <NameField ctx={ctx} />
    </Section>
  );
}

/** A type picker: the document's types and the starters, a starter added in the same batch. */
function TypePicker({ ctx, kind, value, label, path, allowNone }: { ctx: Ctx; kind: TypeChoice['kind']; value: string | undefined; label: string; path: string; allowNone?: string | undefined }) {
  const choices = typeChoices(ctx.model.document, kind);
  const options = [
    ...(allowNone === undefined ? [] : [{ value: '', label: allowNone }]),
    ...choices.map((c) => ({ value: c.id, label: c.starter ? `${c.name} (add from library)` : c.name, ...(c.starter ? { description: 'Added to this project with the change' } : {}) })),
  ];
  return (
    <Select
      aria-label={label}
      appearance="filled"
      options={options}
      value={value ?? ''}
      disabled={ctx.readOnly}
      onValueChange={(next) => {
        if (next === '') {
          ctx.edit(`Clear ${label.toLowerCase()} of ${ctx.id}`, unsetProperty(ctx.id, path));
          return;
        }
        const choice = choices.find((c) => c.id === next);
        ctx.edit(`Set ${label.toLowerCase()} of ${ctx.id}`, (attempt) => {
          const used = useType(ctx.model.document, choice, attempt);
          return [...used.ops, ...setProperty(ctx.id, path, used.id)];
        });
      }}
    />
  );
}

function describeLayers(layers: readonly Layer[] | undefined, units: UnitSystem): string {
  if (layers === undefined || layers.length === 0) return 'No layers';
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  return `${prettyLen(total, units)} total · ${String(layers.length)} ${layers.length === 1 ? 'layer' : 'layers'}`;
}

function WallBody({ ctx }: { ctx: Ctx }) {
  const { element, model, id, units, level, readOnly } = ctx;
  const wall = level?.walls.find((w) => w.id === id);
  const layers = effectiveLayers(model.document, element);
  const own = element['layers'] !== undefined;
  const justification = str(element['justification']) ?? 'center';
  const start = model.document.junctions?.[String(element['start'])];
  const end = model.document.junctions?.[String(element['end'])];
  const a = start?.position as [number, number] | undefined;
  const b = end?.position as [number, number] | undefined;
  const length = a !== undefined && b !== undefined ? dist(a, b) : 0;
  const base = element['base'] as Json | undefined;
  const top = element['top'] as Json | undefined;
  const levelHeight = model.document.levels?.[String(element['level'])]?.height ?? 0;
  const hosted = level?.openings.filter((o) => o.wall === id) ?? [];
  const devices = (level?.devices ?? [])
    .filter((d) => d.host?.['mode'] === 'wallFace' && d.host['wall'] === id)
    .sort((x, y) => Number(x.host?.['offset']) - Number(y.host?.['offset']));
  const sides = level === undefined ? { left: null, right: null } : roomsBeside(level, id);
  const point = (p: [number, number] | undefined, j: string) => (p === undefined ? j : `${j} · ${formatLen(p[0], units)}, ${formatLen(p[1], units)}`);
  return (
    <>
      <Section title="Type">
        <TypePicker ctx={ctx} kind="wallType" value={str(element['type'])} label="Wall type" path="/type" allowNone={own ? 'Own layers only' : undefined} />
        <p className="fs-note">{describeLayers(layers, units)}{own ? ' · own layers' : ''}</p>
      </Section>
      <Section title="Geometry">
        <LengthField
          label="Length"
          value={Math.round(length)}
          units={units}
          positive
          disabled={readOnly || a === undefined || b === undefined}
          hint="Moves the end junction along the wall"
          onCommit={(v) => {
            if (v === null || a === undefined || b === undefined || length === 0) return;
            const k = v / length;
            const to: [number, number] = [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k)];
            ctx.edit(`Set length of ${id}`, moveJunction(String(element['end']), to));
          }}
        />
        <ReadOnlyField label="Start" value={point(a, String(element['start']))} />
        <ReadOnlyField label="End" value={point(b, String(element['end']))} />
        <Row label="Justify">
          <SegmentedControl
            aria-label="Justification"
            size="sm"
            value={justification}
            items={[
              { value: 'center', label: 'Center' },
              { value: 'exteriorFace', label: 'Exterior' },
              { value: 'interiorFace', label: 'Interior' },
              ...(justification === 'coreFace' ? [{ value: 'coreFace', label: 'Core' }] : []),
            ]}
            onValueChange={(v) => {
              if (readOnly || v === justification) return;
              ctx.edit(`Justify ${id}`, v === 'center' ? unsetProperty(id, '/justification') : setProperty(id, '/justification', v));
            }}
          />
        </Row>
        <LengthField
          label="Move by"
          value={undefined}
          units={units}
          disabled={readOnly}
          placeholder={units === 'metric' ? '600mm or -50mm' : `2' or -6"`}
          hint="Sideways; positive towards the exterior side"
          onCommit={(v) => {
            if (v !== null && v !== 0) ctx.edit(`Move ${id}`, moveWall(id, v));
          }}
        />
      </Section>
      <Section title="Vertical">
        <LengthField
          label="Base offset"
          value={num(base?.['offset']) ?? 0}
          units={units}
          disabled={readOnly}
          onCommit={(v) => {
            if (v === null || v === 0) {
              if (base !== undefined) ctx.edit(`Reset base of ${id}`, base['level'] === undefined ? unsetProperty(id, '/base') : unsetProperty(id, '/base/offset'));
            } else ctx.edit(`Set base of ${id}`, setProperty(id, '/base/offset', v));
          }}
        />
        <LengthField
          label="Height"
          value={num(top?.['height'])}
          units={units}
          allowEmpty
          positive
          disabled={readOnly || top?.['level'] !== undefined}
          placeholder={`Level height (${formatLen(levelHeight, units)})`}
          hint={top?.['level'] !== undefined ? `Top follows ${labelOf(model, str(top['level']) ?? '')}` : 'Empty follows the level height'}
          onCommit={(v) => { ctx.edit(`Set height of ${id}`, v === null ? (top === undefined ? [] : unsetProperty(id, '/top')) : setProperty(id, '/top', { height: v })); }}
        />
      </Section>
      <Section title="Layers" aside={own && !readOnly ? <Button size="sm" variant="ghost" onClick={() => { ctx.edit(`Use type layers on ${id}`, unsetProperty(id, '/layers')); }}>Use type’s</Button> : undefined}>
        <ul className="fs-layer-list">
          {(layers ?? []).map((l, i) => (
            <li key={i}>
              <span>{l.function}</span>
              <span className="fs-spacer" />
              <span className="fs-mono-small">{prettyLen(l.thickness, units)}</span>
            </li>
          ))}
        </ul>
      </Section>
      {hosted.length > 0 ? (
        <Section title="Hosted on this wall">
          {hosted.map((o) => (
            <button key={o.id} type="button" className="fs-hosted" onClick={() => { ctx.store.select(o.id); }}>
              {o.kind === 'window' ? <WindowIcon /> : <DoorIcon />}
              <span>{labelOf(model, o.id)}</span>
              <span className="fs-spacer" />
              <span className="fs-mono-small">at {formatLen(o.offset, units)}</span>
            </button>
          ))}
        </Section>
      ) : null}
      {devices.length > 0 ? (
        <Section title="Devices on its faces">
          {devices.map((d) => (
            <button key={d.id} type="button" className="fs-hosted" onClick={() => { ctx.store.select(d.id); }}>
              <SystemIcon system={d.system} />
              <span>{labelOf(model, d.id)}</span>
              <span className="fs-spacer" />
              <span className="fs-mono-small">{d.host?.['side'] === 'left' ? 'left' : 'right'} · {formatLen(Number(d.host?.['offset']), units)}</span>
            </button>
          ))}
        </Section>
      ) : null}
      <Section title="Faces">
        <FaceRow ctx={ctx} side="Left (exterior)" room={sides.left} />
        <FaceRow ctx={ctx} side="Right" room={sides.right} />
      </Section>
      {wall === undefined ? null : null}
    </>
  );
}

function FaceRow({ ctx, side, room }: { ctx: Ctx; side: string; room: string | null }) {
  const finish = room === null ? undefined : str(ctx.model.document.rooms?.[room]?.wallFinish);
  return (
    <div className="fs-face">
      <span className="fs-face__side">{side}</span>
      {room === null ? <span className="fs-face__room">Outside</span> : (
        <button type="button" className="fs-face__room fs-linkish" onClick={() => { ctx.store.select(room); }}>
          {labelOf(ctx.model, room)}
        </button>
      )}
      <span className="fs-spacer" />
      <span className="fs-face__finish">{finish === undefined ? '' : labelOf(ctx.model, finish)}</span>
    </div>
  );
}

function SeparatorBody({ ctx }: { ctx: Ctx }) {
  const { element, model, units } = ctx;
  const a = model.document.junctions?.[String(element['start'])]?.position as [number, number] | undefined;
  const b = model.document.junctions?.[String(element['end'])]?.position as [number, number] | undefined;
  return (
    <>
      <Section title="Geometry">
        <ReadOnlyField label="Length" value={a !== undefined && b !== undefined ? formatLen(Math.round(dist(a, b)), units) : '—'} />
        <ReadOnlyField label="Start" value={String(element['start'])} />
        <ReadOnlyField label="End" value={String(element['end'])} />
      </Section>
      <NameOnly ctx={ctx} />
    </>
  );
}

function JunctionBody({ ctx }: { ctx: Ctx }) {
  const { element, id, units, level, readOnly } = ctx;
  const p = element['position'] as [number, number];
  const edges = level?.junctions.find((j) => j.id === id)?.edges ?? 0;
  const join = element['join'] as Json | undefined;
  return (
    <>
      <Section title="Position">
        <LengthField label="East (x)" value={p[0]} units={units} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Move ${id}`, moveJunction(id, [v, p[1]])); }} />
        <LengthField label="North (y)" value={p[1]} units={units} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Move ${id}`, moveJunction(id, [p[0], v])); }} />
        <ReadOnlyField label="Edges" value={`${String(edges)} ${edges === 1 ? 'wall or separator' : 'walls and separators'}`} />
      </Section>
      <Section title="Join" aside={join !== undefined && !readOnly ? <Button size="sm" variant="ghost" onClick={() => { ctx.edit(`Reset join at ${id}`, unsetProperty(id, '/join')); }}>Reset to mitre</Button> : undefined}>
        <p className="fs-note">{join === undefined ? 'Mitre (the default)' : `Butt — ${((join['through'] as string[] | undefined) ?? []).join(', ')} through`}</p>
      </Section>
    </>
  );
}

function OpeningBody({ ctx }: { ctx: Ctx }) {
  const { element, model, id, units, level, readOnly } = ctx;
  const fill = str(element['fill']);
  const fillType = fill === undefined ? undefined : (model.document.types?.[fill] as Json | undefined);
  const isDoor = fillType?.['kind'] === 'doorType';
  const wall = level?.walls.find((w) => w.id === String(element['wall']));
  const wallLength = wall === undefined ? 0 : dist(wall.a, wall.b);
  const width = num(element['width']) ?? num(fillType?.['width']);
  const kind: TypeChoice['kind'] = fillType?.['kind'] === 'windowType' ? 'windowType' : 'doorType';
  const v03 = holdsClearOpenings(model.document);
  const operation = str(fillType?.['operation']);
  const dim = (key: 'width' | 'height' | 'sill', label: string) => (
    <LengthField
      label={label}
      value={num(element[key])}
      units={units}
      allowEmpty
      positive={key !== 'sill'}
      nonNegative={key === 'sill'}
      disabled={readOnly}
      placeholder={num(fillType?.[key]) === undefined ? (key === 'sill' ? `${formatLen(0, units)} (default)` : 'Required') : `${formatLen(num(fillType?.[key]) as number, units)} from type`}
      onCommit={(v) => { ctx.edit(`Set ${key} of ${id}`, v === null ? (element[key] === undefined ? [] : unsetProperty(id, `/${key}`)) : setProperty(id, `/${key}`, v)); }}
    />
  );
  return (
    <>
      <Section title="Fill">
        <TypePicker ctx={ctx} kind={kind} value={fill} label="Fill" path="/fill" allowNone="Empty opening" />
        {fill === undefined ? null : (
          <Row label="Kind">
            <SegmentedControl
              aria-label="Door or window"
              size="sm"
              value={kind}
              items={[{ value: 'doorType', label: 'Door' }, { value: 'windowType', label: 'Window' }]}
              onValueChange={(v) => {
                if (readOnly || v === kind) return;
                const choice = typeChoices(model.document, v as TypeChoice['kind'])[0];
                ctx.edit(`Set fill of ${id}`, (attempt) => {
                  const used = useType(model.document, choice, attempt);
                  return [...used.ops, ...setProperty(id, '/fill', used.id), ...(v === 'windowType' ? [...(element['hinge'] === undefined ? [] : unsetProperty(id, '/hinge')), ...(element['swing'] === undefined ? [] : unsetProperty(id, '/swing'))] : [])];
                });
              }}
            />
          </Row>
        )}
      </Section>
      <Section title="Size">
        {dim('width', 'Width')}
        {dim('height', 'Height')}
        {dim('sill', 'Sill')}
      </Section>
      <Section title="Position" aside={!readOnly ? <Button size="sm" variant="ghost" onClick={() => { ctx.edit(`Centre ${id}`, moveOpening(id, 'centered')); }}>Centre on wall</Button> : undefined}>
        <ReadOnlyField label="Wall" value={`${String(element['wall'])} · ${formatLen(Math.round(wallLength), units)}`} />
        <LengthField
          label="From start"
          value={num(element['offset'])}
          units={units}
          nonNegative
          disabled={readOnly}
          onCommit={(v) => { if (v !== null) ctx.edit(`Move ${id}`, moveOpening(id, v)); }}
        />
        <LengthField
          label="From end"
          value={width === undefined ? undefined : Math.round(wallLength - Number(element['offset']) - width)}
          units={units}
          nonNegative
          disabled={readOnly || width === undefined}
          hint="Typed values are sent as “… from end” and resolved by the server"
          onCommit={(v) => { if (v !== null) ctx.edit(`Move ${id}`, moveOpening(id, `${formatLen(v, units)} from end`)); }}
        />
      </Section>
      {fill !== undefined && v03 ? (
        <Section title="Operation">
          <ReadOnlyField label="How it opens" value={operation === undefined ? `Not declared on ${labelOf(model, fill)}` : `${operationLabel(operation) ?? operation} · from ${labelOf(model, fill)}`} />
          {isDoor && hingeApplies(operation) ? <HingeRow ctx={ctx} /> : null}
          {isDoor && swingApplies(operation) ? <SwingRow ctx={ctx} /> : null}
        </Section>
      ) : isDoor ? (
        <Section title="Operation">
          <HingeRow ctx={ctx} />
          <SwingRow ctx={ctx} />
        </Section>
      ) : null}
      {v03 ? <OpeningClearSection ctx={ctx} fillType={fillType} /> : fill !== undefined ? (
        <Section title="Clear opening">
          <CoreUpgradeNotice store={ctx.store} model={model} what="A door's or window's operation and its declared net clear opening" />
        </Section>
      ) : null}
      <NameOnly ctx={ctx} />
    </>
  );
}

/** Core 7.1: the jamb a single swinging leaf hangs from. */
function HingeRow({ ctx }: { ctx: Ctx }) {
  const { element, id, readOnly } = ctx;
  return (
          <Row label="Hinge">
            <SegmentedControl
              aria-label="Hinge"
              size="sm"
              value={str(element['hinge']) ?? 'start'}
              items={[{ value: 'start', label: 'Start jamb' }, { value: 'end', label: 'End jamb' }]}
              onValueChange={(v) => { if (!readOnly) ctx.edit(`Hinge ${id}`, v === 'start' ? unsetProperty(id, '/hinge') : setProperty(id, '/hinge', v)); }}
            />
          </Row>
  );
}

/** Core 7.1: the side of the wall a door's leaves open into. */
function SwingRow({ ctx }: { ctx: Ctx }) {
  const { element, id, readOnly } = ctx;
  return (
          <Row label="Swing">
            <SegmentedControl
              aria-label="Swing"
              size="sm"
              value={str(element['swing']) ?? 'right'}
              items={[{ value: 'left', label: 'Left side' }, { value: 'right', label: 'Right side' }]}
              onValueChange={(v) => { if (!readOnly) ctx.edit(`Swing ${id}`, v === 'right' ? unsetProperty(id, '/swing') : setProperty(id, '/swing', v)); }}
            />
          </Row>
  );
}

/**
 * Core 0.3, 7.1–7.4: the opening's clear opening — its type's, as declared, or its own, which
 * replaces the type's whole. An empty opening states its own or has none; only a window's has an
 * area (FS-INV-308).
 */
function OpeningClearSection({ ctx, fillType }: { ctx: Ctx; fillType: Json | undefined }) {
  const { element, model, id, units, readOnly } = ctx;
  const own = element['clearOpening'] as ClearOpening | undefined;
  const fromType = fillType?.['clearOpening'] as ClearOpening | undefined;
  const effective = clearOpeningOf(model.document, element as never);
  const isWindow = fillType?.['kind'] === 'windowType';
  const fill = str(element['fill']);
  const set = (next: ClearOpening | undefined, label: string) => {
    ctx.edit(`${label} of ${id}`, setClearOpening(id, next, own !== undefined));
  };
  return (
    <Section title="Clear opening">
      {fill !== undefined ? (
        <Row label="Own clear opening">
          <Switch
            checked={own !== undefined}
            disabled={readOnly || (own === undefined && fromType === undefined)}
            onCheckedChange={(on) => {
              if (on) {
                // Start from the type's, as declared (an area only for a window); with none, type both.
                if (fromType !== undefined) set({ width: fromType.width, height: fromType.height, ...(isWindow && fromType.area !== undefined ? { area: fromType.area } : {}) }, 'Override the clear opening');
              } else set(undefined, 'Use the type’s clear opening');
            }}
          >
            {own !== undefined ? 'Overrides the type’s' : fromType !== undefined ? 'Uses the type’s' : 'None declared on the type'}
          </Switch>
        </Row>
      ) : null}
      {fill !== undefined && own === undefined ? (
        <ReadOnlyField label="From type" value={fromType === undefined ? 'None declared' : clearOpeningText(fromType, units)} />
      ) : (
        <ClearOpeningFields draftKey={`${id}/own`} value={own} isWindow={isWindow} units={units} disabled={readOnly} onSet={set} />
      )}
      {fill !== undefined && own === undefined && fromType === undefined ? (
        <ClearOpeningFields draftKey={`${id}/own`} value={undefined} isWindow={false} units={units} disabled={readOnly} onSet={set} labelPrefix="Own clear" />
      ) : null}
      <p className="fs-note">
        {effective === undefined
          ? 'No clear opening is declared, so a check that needs one reports it as not stated. Floorspec never computes one from the opening’s size.'
          : 'The net clear opening as declared — what a person or an object can pass through, open as far as it goes. Never computed.'}
      </p>
    </Section>
  );
}

function materialOptions(document: FloorspecDocument): { value: string; label: string }[] {
  return [
    { value: '', label: 'None' },
    ...Object.entries((document.materials ?? {}) as Record<string, Json | undefined>).map(([id, m]) => ({ value: id, label: str(m?.['name']) ?? id })),
  ];
}

function RoomBody({ ctx, focusName }: { ctx: Ctx; focusName: boolean }) {
  const { element, model, id, units, level, readOnly } = ctx;
  const room = level?.rooms.find((r) => r.id === id);
  const fn = str(element['function']) ?? 'unspecified';
  const materials = materialOptions(model.document);
  const anchor = element['anchor'] as [number, number];
  const finish = (surface: 'wall' | 'floor' | 'ceiling', label: string) => {
    const key = `${surface}Finish`;
    const value = str(element[key]);
    return (
      <Row label={label}>
        <Select
          aria-label={`${label} finish`}
          appearance="filled"
          options={materials}
          value={value ?? ''}
          disabled={readOnly || materials.length === 1}
          {...(materials.length === 1 ? { placeholder: 'No materials in this project' } : {})}
          onValueChange={(v) => { ctx.edit(`Set ${surface} finish of ${labelOf(model, id)}`, setRoomFinish(id, surface, v === '' ? null : v, value !== undefined)); }}
        />
      </Row>
    );
  };
  return (
    <>
      <Section title="Room">
        <TextField
          label="Name"
          value={str(element['name']) ?? ''}
          disabled={readOnly}
          autoFocus={focusName}
          placeholder="No name"
          onCommit={(v) => {
            ctx.store.set({ focus: null });
            ctx.edit(`Rename ${id}`, setOrUnset(id, '/name', v, element['name'] !== undefined));
          }}
        />
        <Row label="Function">
          <Select
            aria-label="Function"
            appearance="filled"
            options={ROOM_FUNCTIONS.map(([value, label]) => ({ value, label }))}
            value={ROOM_FUNCTIONS.some(([v]) => v === fn) ? fn : 'unspecified'}
            disabled={readOnly}
            onValueChange={(v) => { ctx.edit(`Set function of ${labelOf(model, id)}`, v === 'unspecified' ? (element['function'] === undefined ? [] : unsetProperty(id, '/function')) : setProperty(id, '/function', v)); }}
          />
        </Row>
        <BriefRow ctx={ctx} />
        <ReadOnlyField label="Net area" value={room === undefined ? '—' : formatArea(room.area2, units)} />
        <ReadOnlyField label="Anchor" value={`${formatLen(anchor[0], units)}, ${formatLen(anchor[1], units)}`} />
      </Section>
      <Section title="Finishes">
        {finish('floor', 'Floor')}
        {finish('wall', 'Walls')}
        {finish('ceiling', 'Ceiling')}
      </Section>
    </>
  );
}

/**
 * Which brief item the room fulfils (Core 0.2, 6.5 and 11.3): setRoomBrief, or unsetting `brief`.
 * A Core 0.1 plan has no brief to link to, so the row is only there on a 0.2 or 0.3 one.
 */
function BriefRow({ ctx }: { ctx: Ctx }) {
  const { element, model, id, readOnly } = ctx;
  if (model.document.floorspec === '0.1') return null;
  const items = Object.entries((model.document.program?.items ?? {}) as Record<string, Json | undefined>);
  const brief = str(element['brief']);
  return (
    <Row label="Brief">
      <Select
        aria-label="Brief item"
        appearance="filled"
        options={[{ value: '', label: 'None' }, ...items.map(([item, it]) => ({ value: item, label: str(it?.['name']) ?? `Item ${item}` }))]}
        value={brief ?? ''}
        disabled={readOnly || (items.length === 0 && brief === undefined)}
        {...(items.length === 0 ? { placeholder: 'No brief yet' } : {})}
        onValueChange={(v) => {
          if (v === (brief ?? '')) return;
          ctx.edit(`Link ${labelOf(model, id)} to the brief`, v === '' ? unsetProperty(id, '/brief') : [{ op: 'setRoomBrief', room: id, item: v }]);
        }}
      />
    </Row>
  );
}

function LevelBody({ ctx }: { ctx: Ctx }) {
  const { element, id, units, readOnly, model } = ctx;
  return (
    <>
      <Section title="Level">
        <NameField ctx={ctx} />
        <LengthField label="Elevation" value={num(element['elevation'])} units={units} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set elevation of ${labelOf(model, id)}`, setProperty(id, '/elevation', v)); }} />
        <LengthField label="Height" value={num(element['height'])} units={units} positive disabled={readOnly} hint="Floor to floor: walls without a top follow it" onCommit={(v) => { if (v !== null) ctx.edit(`Set height of ${labelOf(model, id)}`, setProperty(id, '/height', v)); }} />
        <ReadOnlyField label="Building" value={labelOf(model, String(element['building']))} />
      </Section>
    </>
  );
}

function WallTypeBody({ ctx }: { ctx: Ctx }) {
  const { element, id, units, readOnly, model } = ctx;
  const layers = (element['layers'] as Layer[] | undefined) ?? [];
  const users = Object.values((model.document.walls ?? {}) as Record<string, Json | undefined>).filter((w) => w?.['type'] === id).length;
  const setLayers = (next: Layer[]) => { ctx.edit(`Set layers of ${labelOf(model, id)}`, setProperty(id, '/layers', next)); };
  return (
    <>
      <NameOnly ctx={ctx} />
      <Section title="Layers">
        <p className="fs-note">Exterior face first · {describeLayers(layers, units)} · used by {String(users)} {users === 1 ? 'wall' : 'walls'}</p>
        {layers.map((l, i) => (
          <div key={i} className="fs-layer-edit">
            <Select
              aria-label={`Layer ${String(i + 1)} function`}
              appearance="filled"
              size="sm"
              options={['core', 'substrate', 'insulation', 'membrane', 'airGap', 'finish'].map((f) => ({ value: f, label: f }))}
              value={l.function}
              disabled={readOnly}
              onValueChange={(v) => { setLayers(layers.map((x, j) => (j === i ? { ...x, function: v } : x))); }}
            />
            <LengthField label={`Layer ${String(i + 1)}`} value={l.thickness} units={units} positive disabled={readOnly} onCommit={(v) => {
                if (v !== null) setLayers(layers.map((x, j) => (j === i ? { ...x, thickness: v } : x)));
              }} />
          </div>
        ))}
      </Section>
    </>
  );
}

function FillTypeBody({ ctx }: { ctx: Ctx }) {
  const { element, id, units, readOnly, model } = ctx;
  const kind = element['kind'] === 'windowType' ? 'windowType' : 'doorType';
  const clear = element['clearOpening'] as ClearOpening | undefined;
  const field = (key: 'width' | 'height' | 'sill', label: string) => (
    <LengthField
      label={label}
      value={num(element[key])}
      units={units}
      allowEmpty
      positive={key !== 'sill'}
      nonNegative={key === 'sill'}
      disabled={readOnly}
      onCommit={(v) => { ctx.edit(`Set ${key} of ${labelOf(model, id)}`, v === null ? (element[key] === undefined ? [] : unsetProperty(id, `/${key}`)) : setProperty(id, `/${key}`, v)); }}
    />
  );
  return (
    <>
      <NameOnly ctx={ctx} />
      <Section title="Size">
        {field('width', 'Width')}
        {field('height', 'Height')}
        {field('sill', 'Sill')}
      </Section>
      {holdsClearOpenings(model.document) ? (
        <>
          <Section title="Operation">
            <Row label="How it opens">
              <Select
                aria-label="Operation"
                appearance="filled"
                options={operationOptions(kind)}
                value={str(element['operation']) ?? ''}
                disabled={readOnly}
                onValueChange={(v) => {
                  if (v !== (str(element['operation']) ?? '')) ctx.edit(`Set operation of ${labelOf(model, id)}`, setOperation(id, v, element['operation'] !== undefined));
                }}
              />
            </Row>
          </Section>
          <Section title="Clear opening">
            <ClearOpeningFields
              draftKey={id}
              value={clear}
              isWindow={kind === 'windowType'}
              units={units}
              disabled={readOnly}
              onSet={(next, label) => { ctx.edit(`${label} of ${labelOf(model, id)}`, setClearOpening(id, next, clear !== undefined)); }}
            />
            <p className="fs-note">
              The net clear opening of every opening this {kind === 'doorType' ? 'door' : 'window'} fills, as its maker declares it{kind === 'windowType' ? ' — the area too, when declared' : ''}. An opening can override it. Floorspec never computes one.
            </p>
          </Section>
        </>
      ) : (
        <Section title="Operation and clear opening">
          <CoreUpgradeNotice store={ctx.store} model={model} what="A door's or window's operation and its declared net clear opening" />
        </Section>
      )}
    </>
  );
}

function MaterialBody({ ctx }: { ctx: Ctx }) {
  const { element, id, readOnly, model } = ctx;
  const color = str(element['color']);
  return (
    <>
      <NameOnly ctx={ctx} />
      <Section title="Colour">
        <Row label="Base colour">
          <input
            type="color"
            className="fs-color"
            key={color ?? 'none'}
            {...(color === undefined ? {} : { defaultValue: color })}
            disabled={readOnly}
            aria-label="Base colour"
            onBlur={(e) => {
              const v = e.target.value.toLowerCase();
              if (v !== color) ctx.edit(`Set colour of ${labelOf(model, id)}`, setProperty(id, '/color', v));
            }}
          />
        </Row>
      </Section>
    </>
  );
}

// ─── Nothing selected: the project ───────────────────────────────────────────────────────────

function ProjectPanel({ store, model, units, readOnly }: { store: EditorStore; model: EditorModel; units: UnitSystem; readOnly: boolean }) {
  const project = model.document.project;
  const edit = (label: string, batch: Batch) => void store.apply(label, batch);
  return (
    <div className="fs-inspector__body">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <House />
        </span>
        <div className="fs-inspector__title">
          <h2>{project.name}</h2>
          <p>Project · nothing selected</p>
        </div>
      </div>
      <Section title="Project">
        <TextField label="Name" value={project.name} disabled={readOnly} onCommit={(v) => {
          if (v !== '') edit('Rename the project', setProperty('$project', '/name', v));
        }} />
        <Row label="Units">
          <SegmentedControl
            aria-label="Display units"
            size="sm"
            value={units}
            items={[{ value: 'imperial', label: 'ft-in' }, { value: 'metric', label: 'Metric' }]}
            onValueChange={(v) => { if (!readOnly) switchUnits(store, v as UnitSystem); }}
          />
        </Row>
        <p className="fs-note">Display only: every length is stored exactly, in 1/1280 mm. Typed values accept either system.</p>
        <ReadOnlyField label="Floorspec" value={`Core ${model.document.floorspec}`} />
        {model.document.floorspec !== CURRENT_CORE ? <CoreUpgradeNotice store={store} model={model} what="Door and window operation and declared net clear openings" /> : null}
      </Section>
      <SystemsSummary store={store} model={model} units={units} />
      <Section title="Findings">
        <FindingsList store={store} />
      </Section>
    </div>
  );
}

// ─── Drawing: the tool's settings ────────────────────────────────────────────────────────────

function DrawPanel({ store, model }: { store: EditorStore; model: EditorModel }) {
  const tool = useEditor(store, (s) => s.tool);
  const draw = useEditor(store, (s) => s.draw);
  const draft = useEditor(store, (s) => s.draft);
  const units = useEditor(store, () => store.units);
  const set = (patch: Partial<typeof draw>) => { store.set({ draw: { ...draw, ...patch } }); };
  if (tool === 'wall' || tool === 'separator') {
    const choices = typeChoices(model.document, 'wallType');
    const chosen = store.chosenType(choices, draw.wallType);
    const chain = (draft?.tool === 'wall' || draft?.tool === 'separator') ? draft.chain : [];
    const start = chain[0];
    return (
      <div className="fs-inspector__body">
        <div className="fs-inspector__head">
          <span className="fs-inspector__icon">{tool === 'wall' ? <WallIcon /> : <SeparatorIcon />}</span>
          <div className="fs-inspector__title">
            <h2>{tool === 'wall' ? 'Draw wall' : 'Draw separator'}</h2>
            <p>{start === undefined ? 'Click to start; snaps to junctions and walls' : `Started at ${start.junction ?? `${formatLen(start.point[0], units)}, ${formatLen(start.point[1], units)}`} · ${String(chain.length - 1)} drawn`}</p>
          </div>
        </div>
        {tool === 'wall' ? (
          <Section title="New wall">
            <Select
              aria-label="Wall type"
              appearance="filled"
              options={choices.map((c) => ({ value: c.id, label: c.starter ? `${c.name} (from library)` : c.name }))}
              value={chosen?.id ?? ''}
              onValueChange={(v) => { set({ wallType: v }); }}
            />
            <p className="fs-note">{describeLayers(chosen?.element['layers'] as Layer[] | undefined, units)}</p>
            <SegmentedControl
              aria-label="Justification"
              size="sm"
              value={draw.justification}
              items={[{ value: 'center', label: 'Center' }, { value: 'interiorFace', label: 'Interior face' }, { value: 'exteriorFace', label: 'Exterior face' }]}
              onValueChange={(v) => { set({ justification: v as typeof draw.justification }); }}
            />
          </Section>
        ) : null}
        <Section title="Drawing">
          <Switch checked={draw.chain} onCheckedChange={(v) => { set({ chain: v }); }}>
            Chain {tool === 'wall' ? 'walls' : 'separators'} (start the next at the end)
          </Switch>
        </Section>
        <div className="fs-callout-card" role="note">
          <strong>Splitting is automatic</strong>
          <p>A {tool === 'wall' ? 'wall' : 'separator'} that crosses or ends on another is split there when the batch is applied (Floorspec Ops 5.2). Closing a loop makes a face — name it with the room tool.</p>
        </div>
        <KeyHints />
      </div>
    );
  }
  if (tool === 'door' || tool === 'window') {
    const kind = tool === 'door' ? 'doorType' : 'windowType';
    const choices = typeChoices(model.document, kind);
    const chosen = store.chosenType(choices, tool === 'door' ? draw.doorType : draw.windowType);
    return (
      <div className="fs-inspector__body">
        <div className="fs-inspector__head">
          <span className="fs-inspector__icon">{tool === 'door' ? <DoorIcon /> : <WindowIcon />}</span>
          <div className="fs-inspector__title">
            <h2>{tool === 'door' ? 'Place a door' : 'Place a window'}</h2>
            <p>Point at a wall; it snaps to the centre</p>
          </div>
        </div>
        <Section title={tool === 'door' ? 'Door type' : 'Window type'}>
          <Select
            aria-label={tool === 'door' ? 'Door type' : 'Window type'}
            appearance="filled"
            options={choices.map((c) => ({ value: c.id, label: c.starter ? `${c.name} (from library)` : c.name }))}
            value={chosen?.id ?? ''}
            onValueChange={(v) => { set(tool === 'door' ? { doorType: v } : { windowType: v }); }}
          />
          <p className="fs-note">
            {chosen === undefined ? '' : `${prettyLen(Number(chosen.element['width'] ?? 0), units)} wide × ${prettyLen(Number(chosen.element['height'] ?? 0), units)} high`}
          </p>
        </Section>
        <div className="fs-callout-card" role="note">
          <strong>Exact positions</strong>
          <p>Type a length while pointing at a wall — {units === 'metric' ? '900mm' : `3'`} — and press Enter to place it that far from the nearer end. A door swings to the side you point from, hinged at the nearer jamb.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="fs-inspector__body">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon"><RoomIcon /></span>
        <div className="fs-inspector__title">
          <h2>Name a room</h2>
          <p>Click inside a closed space</p>
        </div>
      </div>
      <div className="fs-callout-card" role="note">
        <strong>Rooms are found, not drawn</strong>
        <p>Walls and separators make faces; a room’s anchor says which face it is (Floorspec Core 6.3). Faces without a room show lighter on the plan.</p>
      </div>
    </div>
  );
}

function KeyHints() {
  return (
    <ul className="fs-keys" aria-label="Keys">
      <li><kbd>Enter</kbd> place the typed length, or finish</li>
      <li><kbd>Esc</kbd> finish the chain</li>
      <li><kbd>Shift</kbd> lock to 45°</li>
      <li><kbd>Alt</kbd> no snapping</li>
    </ul>
  );
}
