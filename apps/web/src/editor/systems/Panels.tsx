import { type ReactNode } from 'react';
import { Badge, Button, IconButton, SegmentedControl, Select, Switch } from '@d3cloud/ui';
import { Plus, Pointer, X } from 'lucide-react';
import type { EditorStore } from '../store';
import { useEditor } from '../store';
import type { ToolController } from '../tools';
import { labelOf, type EditorModel, type LevelView } from '../model';
import { leftNormal, roomsBeside } from '../geometry';
import { facePoint } from './placement';
import { IntField, LengthField, ReadOnlyField, Row, Section, TextField } from '../fields';
import { formatLen, prettyLen, type UnitSystem } from '../units';
import type { Batch, BatchBuilder } from '../ops';
import { setOrUnset } from '../ops';
import { DataIcon, DropIcon, AirIcon, PlugIcon } from '../icons';
import { defaultHeight, RECEPTACLE, extensionOfSystem, extensionVersion, kindById, kindsOf, SYSTEMS, words, type DeviceKind, type SystemId } from './catalog';
import { addCircuit, addGasSource, addStack, assignCircuit, moveDevice, nextRecordId, rotateDevice, setMember, setRecordMember, type HostRef } from './ops';
import { memberSpecs, type MemberSpec } from './schema';
import { AssistantCard } from './Assistant';
import { circuitsOf, compareIds, elementsOfExtension, recordsOf, switchesOf, type DeviceView } from './view';

/**
 * The inspector for the building systems (FLR-T-5.7, the board's "23 · Building systems"): the
 * device tool's panel — which device, its options and mounting height — the Electrical overview
 * of panels and circuits, and the inspector bodies of a device and of a record (a circuit, a stack,
 * a gas source). Every field is an Op: a member is setProperty on the element (or on `$document`
 * for a record), a position is moveElement, a circuit's loads are setProperty of its `loads`.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export interface SystemsCtx {
  store: EditorStore;
  model: EditorModel;
  id: string;
  element: Json;
  units: UnitSystem;
  level: LevelView | undefined;
  readOnly: boolean;
  edit: (label: string, batch: Batch | BatchBuilder) => void;
}

export function SystemIcon({ system }: { system: SystemId | null }) {
  return system === 'electrical' ? <PlugIcon /> : system === 'plumbing' ? <DropIcon /> : system === 'mechanical' ? <AirIcon /> : <DataIcon />;
}

const optionLabel = (v: string) => words(v).replace(/\bgfci\b/i, 'GFCI').replace(/\bafci\b/i, 'AFCI').replace(/\busb\b/i, 'USB').replace(/\bev\b/i, 'EV').replace(/\bco\b/i, 'CO');

// ─── The device tool's panel ─────────────────────────────────────────────────────────────────

const MOUNT_NOTE: Record<DeviceKind['mount'], string> = {
  wall: 'Hosted on a wall face at a height: it follows the wall when the wall moves (Floorspec Core 13.3).',
  floorWall: 'Stands on the room’s floor, backed onto the nearest wall face when put near one.',
  floor: 'Stands on the room’s floor where it is put; outside a room it stands free on the level.',
  ceiling: 'On the room’s ceiling where it is put.',
};

export function DevicePanel({ store, tools, model }: { store: EditorStore; tools: ToolController; model: EditorModel }) {
  const draw = useEditor(store, (s) => s.draw);
  const units = useEditor(store, () => store.units);
  const kind = kindById(draw.device) ?? RECEPTACLE;
  const system = kind.system;
  const set = (patch: Partial<typeof draw>) => { store.set({ draw: { ...draw, ...patch } }); };
  const extension = extensionOfSystem(system);
  const declared = Object.hasOwn((model.document as { extensionsUsed?: object }).extensionsUsed ?? {}, extension);
  return (
    <div className="fs-inspector__body">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon"><SystemIcon system={system} /></span>
        <div className="fs-inspector__title">
          <h2>{SYSTEMS.find((s) => s.id === system)?.label}</h2>
          <p>{extension} {extensionVersion(extension)} · Release Candidate</p>
        </div>
      </div>
      <Section title="Place">
        <Row label="System">
          <Select
            aria-label="System"
            appearance="filled"
            options={SYSTEMS.map((s) => ({ value: s.id, label: s.label }))}
            value={system}
            onValueChange={(v) => { tools.useDevice(kindsOf(v as SystemId)[0]?.id ?? 'receptacle'); }}
          />
        </Row>
        <div className="fs-kinds" role="group" aria-label="Device">
          {kindsOf(system).map((k) => (
            <button key={k.id} type="button" className={k.id === kind.id ? 'fs-kind is-on' : 'fs-kind'} aria-pressed={k.id === kind.id} onClick={() => { tools.useDevice(k.id); }}>
              {k.label}
            </button>
          ))}
        </div>
        {kind.collection === 'receptacles' ? (
          <div className="fs-switches">
            {(['gfci', 'afci', 'usb', 'v240'] as const).map((o) => (
              <Switch key={o} checked={draw.receptacle[o]} onCheckedChange={(on) => { set({ receptacle: { ...draw.receptacle, [o]: on } }); }}>
                {o === 'v240' ? '240 V (30 A range or dryer)' : `${o.toUpperCase()}${o === 'usb' ? ' ports' : ' at the device'}`}
              </Switch>
            ))}
          </div>
        ) : null}
        <DeviceTarget store={store} model={model} />
        {kind.mount === 'wall' ? (
          <LengthField
            label="Height"
            value={draw.height ?? defaultHeight(kind, units)}
            units={units}
            nonNegative
            hint="To its centre, above the wall’s base"
            onCommit={(v) => { set({ height: v }); }}
          />
        ) : null}
      </Section>
      <div className="fs-callout-card" role="note">
        <strong>{kind.label}</strong>
        <p>
          {MOUNT_NOTE[kind.mount]}
          {declared ? '' : ` Placing the first one declares ${extension} ${extensionVersion(extension)} in the same change.`}
        </p>
      </div>
      {system === 'electrical' ? <ElectricalOverview store={store} model={model} units={units} /> : null}
      <ul className="fs-keys" aria-label="Keys">
        <li><kbd>Enter</kbd> place it where it shows — centred on a selected wall</li>
        <li>Type a length, then <kbd>Enter</kbd>: that far from the nearer end</li>
        <li><kbd>Esc</kbd> back to select</li>
      </ul>
    </div>
  );
}

/**
 * Where the tool would place the device now, and — on a wall — which face: the keyboard's way to
 * choose the other side of an interior wall the tool was aimed at.
 */
function DeviceTarget({ store, model }: { store: EditorStore; model: EditorModel }) {
  const draft = useEditor(store, (s) => (s.draft?.tool === 'device' ? s.draft : null));
  const units = useEditor(store, () => store.units);
  const hover = draft?.hover ?? null;
  if (hover === null) return <p className="fs-note">Point at the plan, or select a wall first and press Enter.</p>;
  if (hover.host.mode !== 'wallFace') return <ReadOnlyField label="At" value={hover.host.mode === 'surface' ? `${labelOf(model, hover.host.room)} · ${hover.host.surface}` : 'Free on the level'} />;
  const host = hover.host;
  const level = store.levelView;
  const wall = level?.walls.find((w) => w.id === host.wall);
  const roomOn = (side: 'left' | 'right') => {
    if (level === undefined || wall === undefined) return null;
    const room = roomsBeside(level, wall.id)[side];
    return room === null ? 'outside' : labelOf(model, room);
  };
  const side = host.side ?? 'right';
  return (
    <>
      <ReadOnlyField label="On" value={`${labelOf(model, host.wall)} · ${typeof host.at === 'number' ? `${formatLen(host.at, units)} from start` : host.at}`} />
      <Row label="Face">
        <SegmentedControl
          aria-label="Face to place on"
          size="sm"
          value={side}
          items={[{ value: 'left', label: `Left (${roomOn('left') ?? '—'})` }, { value: 'right', label: `Right (${roomOn('right') ?? '—'})` }]}
          onValueChange={(v) => {
            if (wall === undefined || v === side || draft === null) return;
            const next = v as 'left' | 'right';
            const n = leftNormal(wall.a, wall.b);
            store.set({ draft: { ...draft, hover: { ...hover, host: { ...host, side: next }, point: facePoint(wall, next, typeof host.at === 'number' ? host.at : 0), facing: next === 'left' ? n : [-n[0], -n[1]] } } });
          }}
        />
      </Row>
    </>
  );
}

// ─── Electrical overview: panels and circuits ────────────────────────────────────────────────

/** A circuit's protection, said as the badge the board draws: at the breaker, or at its receptacles. */
export function circuitBadges(model: EditorModel, circuit: Json): string[] {
  const out = new Set<string>();
  for (const p of Array.isArray(circuit['protection']) ? (circuit['protection'] as string[]) : []) out.add(p.toUpperCase());
  for (const load of Array.isArray(circuit['loads']) ? (circuit['loads'] as string[]) : []) {
    const d = model.levels.flatMap((l) => l.devices).find((x) => x.id === load);
    for (const f of Array.isArray(d?.element['features']) ? (d.element['features'] as string[]) : []) if (f === 'gfci' || f === 'afci') out.add(f.toUpperCase());
  }
  return [...out].sort();
}

export function ElectricalOverview({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const derived = model.derived?.extensions?.FS_electrical;
  const panels = elementsOfExtension(model.document, 'FS_electrical', 'panels');
  const circuits = recordsOf(model.document, 'FS_electrical', 'circuits');
  const roomOf = (id: string) => Object.entries(derived?.rooms ?? {}).find(([, ids]) => ids.includes(id))?.[0];
  return (
    <>
      {panels.length === 0 ? (
        <p className="fs-note">No panel yet. Circuits start at a panel: place one, then add circuits to it from its inspector.</p>
      ) : (
        panels.map(([pid, p]) => {
          const room = roomOf(pid);
          const d = derived?.panels[pid];
          return (
            <button key={pid} type="button" className="fs-panel-card" onClick={() => { store.select(pid); }}>
              <PlugIcon />
              <span>
                <strong>{labelOf(model, pid)} · {String(num(p['mainBreaker']) ?? num(p['rating']) ?? '')} A {p['mainBreaker'] === undefined ? 'main lugs' : 'main'}</strong>
                <span className="fs-panel-card__meta">{[room === undefined ? null : labelOf(model, room), `${String(num(p['spaces']) ?? 0)} spaces`, d === undefined ? null : `${String(d.spacesUsed)} used`].filter((x) => x !== null).join(' · ')}</span>
              </span>
            </button>
          );
        })
      )}
      {circuits.length > 0 ? (
        <Section title={`Circuits · ${String(circuits.length)}`}>
          <ul className="fs-circuits">
            {circuits.map(([cid, c], i) => {
              const loads = Array.isArray(c['loads']) ? c['loads'].length : 0;
              return (
                <li key={cid}>
                  <button type="button" className="fs-circuit" onClick={() => { store.select(cid); }}>
                    <span className={`fs-circuit__bar fs-run-bg--${String((i % 6) + 1)}`} aria-hidden="true" />
                    <span className="fs-circuit__text">
                      <span className="fs-circuit__name">{cid}{str(c['name']) === undefined ? '' : ` · ${str(c['name']) ?? ''}`}</span>
                      <span className="fs-circuit__meta">
                        {String(num(c['breaker']) ?? '')} A · {num(c['volts']) === 240 ? '240 V · ' : ''}{loads === 1 ? '1 device' : `${String(loads)} devices`}
                      </span>
                    </span>
                    {circuitBadges(model, c).map((b) => <Badge key={b} size="sm" tone="neutral">{b}</Badge>)}
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      <AssistantCard store={store} model={model} units={units} />
      <Legend units={units} />
    </>
  );
}

function Legend({ units: _units }: { units: UnitSystem }) {
  return (
    <ul className="fs-sym-legend" aria-label="Symbols">
      <li><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M6 5.5v5M10 5.5v5" /></svg>Receptacle</li>
      <li><span className="fs-sym-legend__s" aria-hidden="true">S</span>Switch</li>
      <li><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="m4 4 8 8M4 12l8-8" /></svg>Light</li>
      <li><svg viewBox="0 0 24 16" aria-hidden="true"><path d="M1 8h22" strokeDasharray="4 3" /></svg>Home run</li>
    </ul>
  );
}

// ─── A device's inspector ────────────────────────────────────────────────────────────────────

/** Every element of every extension except `self`, as options: what a switch may control, a circuit feed. */
function deviceOptions(model: EditorModel, filter: (d: DeviceView) => boolean): { value: string; label: string }[] {
  return model.levels
    .flatMap((l) => l.devices)
    .filter(filter)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((d) => ({ value: d.id, label: `${labelOf(model, d.id)}${labelOf(model, d.id).includes(d.id) ? '' : ` · ${d.id}`}` }));
}

/** What a reference member may name (each spec's 3.x, 4.x). */
function referenceOptions(model: EditorModel, extension: string, member: string, self: string, element: Json): { value: string; label: string }[] {
  const doc = model.document;
  const records = (ext: string, coll: string) => recordsOf(doc, ext, coll).map(([id]) => ({ value: id, label: labelOf(model, id) }));
  const elements = (ext: string, coll: string, keep: (e: Json) => boolean = () => true) => elementsOfExtension(doc, ext, coll).filter(([id, e]) => id !== self && keep(e)).map(([id]) => ({ value: id, label: `${labelOf(model, id)}${labelOf(model, id).includes(id) ? '' : ` · ${id}`}` }));
  switch (`${extension}/${member}`) {
    case 'FS_electrical/fedBy':
      return recordsOf(doc, 'FS_electrical', 'circuits').filter(([, c]) => c['panel'] !== self).map(([id]) => ({ value: id, label: labelOf(model, id) }));
    case 'FS_electrical/panel':
      return elements('FS_electrical', 'panels');
    case 'FS_plumbing/hotFrom':
      return elements('FS_plumbing', 'waterHeaters');
    case 'FS_plumbing/drain':
      return element['receptor'] !== undefined ? records('FS_plumbing', 'stacks') : [...records('FS_plumbing', 'stacks'), ...elements('FS_plumbing', 'drains')];
    case 'FS_plumbing/stack':
      return records('FS_plumbing', 'stacks');
    case 'FS_mechanical/gasFrom':
      return records('FS_mechanical', 'gasSources');
    case 'FS_mechanical/equipment':
      return elements('FS_mechanical', 'equipment');
    case 'FS_lowvoltage/headEnd':
      return elements('FS_lowvoltage', 'headEnds');
    case 'FS_lowvoltage/chime':
      return elements('FS_lowvoltage', 'doorbells', (e) => e['part'] === 'chime');
    default:
      return [];
  }
}

/** The fields of a kind's members, from its schema: each change a setProperty or unsetProperty. */
export function MemberFields({ ctx, extension, specs, element, set, skip = [] }: { ctx: SystemsCtx; extension: string; specs: MemberSpec[]; element: Json; set: (member: string, value: unknown, label: string) => void; skip?: readonly string[] }) {
  const { readOnly, model, id } = ctx;
  const out: ReactNode[] = [];
  for (const spec of specs) {
    if (skip.includes(spec.name)) continue;
    const value = element[spec.name];
    switch (spec.type) {
      case 'int':
        out.push(
          <IntField
            key={spec.name}
            label={spec.label}
            value={num(value)}
            unit={spec.unit}
            min={spec.min}
            max={spec.max}
            disabled={readOnly}
            allowEmpty={!spec.required}
            placeholder={spec.default === undefined ? (spec.required ? 'Required' : 'Not stated') : `${String(spec.default)} (default)`}
            onCommit={(v) => { set(spec.name, v ?? undefined, spec.label); }}
          />,
        );
        break;
      case 'length':
        out.push(<LengthField key={spec.name} label={spec.label} value={num(value)} units={ctx.units} allowEmpty={!spec.required} positive disabled={readOnly} placeholder="Not stated" onCommit={(v) => { set(spec.name, v ?? undefined, spec.label); }} />);
        break;
      case 'enum':
        out.push(
          <Row key={spec.name} label={spec.label}>
            <Select
              aria-label={spec.label}
              appearance="filled"
              options={[...(spec.required ? [] : [{ value: '', label: spec.default === undefined ? 'Not stated' : `${optionLabel(spec.default)} (default)` }]), ...spec.options.map((o) => ({ value: o, label: optionLabel(o) }))]}
              value={str(value) ?? ''}
              disabled={readOnly}
              onValueChange={(v) => { set(spec.name, v === '' ? undefined : v, spec.label); }}
            />
          </Row>,
        );
        break;
      case 'enumSet': {
        const list = Array.isArray(value) ? (value as string[]) : [];
        out.push(
          <div key={spec.name} className="fs-enumset" role="group" aria-label={spec.label}>
            <span className="fs-row__label">{spec.label}</span>
            <div className="fs-switches">
              {spec.options.map((o) => (
                <Switch
                  key={o}
                  checked={list.includes(o)}
                  disabled={readOnly}
                  onCheckedChange={(on) => {
                    const next = on ? spec.options.filter((x) => x === o || list.includes(x)) : list.filter((x) => x !== o);
                    set(spec.name, next.length === 0 && !spec.required ? undefined : next, spec.label);
                  }}
                >
                  {optionLabel(o)}
                </Switch>
              ))}
            </div>
          </div>,
        );
        break;
      }
      case 'intList':
        out.push(
          <TextField
            key={spec.name}
            label={spec.label}
            value={Array.isArray(value) ? value.join(', ') : ''}
            disabled={readOnly}
            placeholder="120, 240"
            onCommit={(v) => {
              const list = v.split(/[\s,]+/).filter((x) => x !== '').map(Number);
              if (list.length > 0 && list.every((n) => Number.isSafeInteger(n) && n > 0)) set(spec.name, [...new Set(list)], spec.label);
            }}
          />,
        );
        break;
      case 'text':
        out.push(<TextField key={spec.name} label={spec.label} value={str(value) ?? ''} disabled={readOnly} placeholder="None" maxLength={spec.maxLength ?? 200} onCommit={(v) => { set(spec.name, v === '' ? undefined : v, spec.label); }} />);
        break;
      case 'bool':
        out.push(
          <Switch key={spec.name} checked={value === true || (value === undefined && spec.default === true)} disabled={readOnly} onCheckedChange={(on) => { set(spec.name, on === (spec.default ?? false) ? undefined : on, spec.label); }}>
            {spec.label}
          </Switch>,
        );
        break;
      case 'ref': {
        const options = referenceOptions(model, extension, spec.name, id, element);
        out.push(
          <Row key={spec.name} label={spec.label}>
            <Select
              aria-label={spec.label}
              appearance="filled"
              options={[...(spec.required ? [] : [{ value: '', label: 'None' }]), ...options, ...(str(value) !== undefined && !options.some((o) => o.value === value) ? [{ value: String(value), label: `${String(value)} (missing)` }] : [])]}
              value={str(value) ?? ''}
              disabled={readOnly}
              {...(options.length === 0 ? { placeholder: 'Nothing to choose yet' } : {})}
              onValueChange={(v) => { set(spec.name, v === '' ? undefined : v, spec.label); }}
            />
          </Row>,
        );
        break;
      }
      case 'refList':
        // Lists of references (a switch's controls, a circuit's loads, a stack's levels) have panels of their own.
        break;
    }
  }
  return <>{out}</>;
}

/** The elements that may be a circuit's load (FS_electrical 3.2): anything but a panel or a switch. */
const canBeLoad = (d: DeviceView) => !(d.extension === 'FS_electrical' && (d.collection === 'panels' || d.collection === 'switches'));

export function DeviceBody({ ctx, device }: { ctx: SystemsCtx; device: DeviceView | undefined }) {
  const { model, id, element, readOnly } = ctx;
  const at = model.ext.get(id);
  if (at === undefined) return null;
  const specs = memberSpecs(at.extension, at.collection);
  const known = specs.length > 0;
  const set = (member: string, value: unknown, label: string) => {
    ctx.edit(`Set ${label.toLowerCase()} of ${labelOf(model, id)}`, setMember(id, member, value, element[member] !== undefined));
  };
  const asLoad = device === undefined ? canBeLoadAt(at) : canBeLoad(device);
  return (
    <>
      <PlacementSection ctx={ctx} device={device} />
      {asLoad && elementsOfExtension(model.document, 'FS_electrical', 'panels').length > 0 ? <CircuitSection ctx={ctx} /> : null}
      {at.extension === 'FS_electrical' && at.collection === 'switches' ? <ControlsSection ctx={ctx} /> : null}
      {at.extension === 'FS_electrical' && at.collection === 'panels' ? <PanelCircuits ctx={ctx} /> : null}
      <SwitchedBy ctx={ctx} />
      <Section title="Properties">
        <TextField label="Name" value={str(element['name']) ?? ''} disabled={readOnly} placeholder="No name" onCommit={(v) => { ctx.edit(`Rename ${id}`, setOrUnset(id, '/name', v, element['name'] !== undefined)); }} />
        {known ? (
          <MemberFields ctx={ctx} extension={at.extension} specs={specs} element={element} set={set} />
        ) : (
          <p className="fs-note">{at.extension} is not an extension this editor implements: its own members are kept as they are.</p>
        )}
        <SourceRecordButtons ctx={ctx} extension={at.extension} />
      </Section>
      <FallbackSection ctx={ctx} device={device} />
    </>
  );
}

const canBeLoadAt = (at: { extension: string; collection: string }) => !(at.extension === 'FS_electrical' && (at.collection === 'panels' || at.collection === 'switches'));

/** "New stack" and "New gas source": a record the reference fields can then name, made and named in one change. */
function SourceRecordButtons({ ctx, extension }: { ctx: SystemsCtx; extension: string }) {
  const { model, id, element, readOnly, level } = ctx;
  if (readOnly) return null;
  const collection = model.ext.get(id)?.collection ?? '';
  const drains = ['fixtures', 'waterHeaters', 'drains'].includes(collection) && !(collection === 'fixtures' && ['hoseBibb', 'iceMaker'].includes(String(element['fixture'])));
  if (extension === 'FS_plumbing' && drains && element['drain'] === undefined && recordsOf(model.document, 'FS_plumbing', 'stacks').length === 0) {
    return (
      <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => {
        ctx.edit(`Drain ${labelOf(model, id)} to a new stack`, () => {
          const fallbackLevel = (element['fallback'] as Json | undefined)?.['level'];
          const stack = addStack(model.document, [level?.id ?? (typeof fallbackLevel === 'string' ? fallbackLevel : '')], 'Main stack');
          return [...stack.ops, ...setMember(id, 'drain', stack.id, false)];
        });
      }}>
        Drain to a new stack
      </Button>
    );
  }
  if (extension === 'FS_mechanical' && element['gasFrom'] === undefined && (element['fuel'] === 'naturalGas' || element['fuel'] === 'propane') && !recordsOf(model.document, 'FS_mechanical', 'gasSources').some(([, g]) => g['fuel'] === element['fuel'])) {
    return (
      <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => {
        ctx.edit(`Feed ${labelOf(model, id)} from a new gas source`, () => {
          const source = addGasSource(model.document, element['fuel'] as 'naturalGas', element['fuel'] === 'propane' ? 'Propane tank' : 'Gas meter');
          return [...source.ops, ...setMember(id, 'gasFrom', source.id, false)];
        });
      }}>
        Feed from a new gas source
      </Button>
    );
  }
  return null;
}

function PlacementSection({ ctx, device }: { ctx: SystemsCtx; device: DeviceView | undefined }) {
  const { model, id, element, units, readOnly } = ctx;
  const host = isObject(element['host']) ? element['host'] : null;
  const label = labelOf(model, id);
  const move = (h: HostRef, what: string) => { ctx.edit(`${what} ${label}`, moveDevice(id, h)); };
  const room = Object.entries(model.derived?.extensions?.[(model.ext.get(id)?.extension ?? '') as 'FS_electrical']?.rooms ?? {}).find(([, ids]) => ids.includes(id))?.[0];
  if (host === null) {
    return (
      <Section title="Placement">
        <p className="fs-note">Not hosted: placed by its fallback box alone, in the level’s coordinates (Floorspec Core 12.6).</p>
      </Section>
    );
  }
  if (host['mode'] === 'wallFace') {
    const wall = String(host['wall']);
    const side = host['side'] === 'left' ? 'left' : 'right';
    const offset = Number(host['offset']);
    const height = Number(host['height']);
    const wallHost = (patch: Partial<{ side: 'left' | 'right'; at: number; height: number }>): HostRef => ({ mode: 'wallFace', wall, side: patch.side ?? side, at: patch.at ?? offset, height: patch.height ?? height });
    return (
      <Section title="Placement">
        <Row label="Wall">
          <button type="button" className="fs-linkish fs-row__link" onClick={() => { ctx.store.select(wall); }}>{labelOf(model, wall)}</button>
        </Row>
        <Row label="Face">
          <SegmentedControl
            aria-label="Face"
            size="sm"
            activationMode="manual"
            value={side}
            items={[{ value: 'left', label: 'Left (exterior)' }, { value: 'right', label: 'Right' }]}
            onValueChange={(v) => { if (!readOnly && v !== side) move(wallHost({ side: v as 'left' | 'right' }), 'Turn'); }}
          />
        </Row>
        <LengthField label="From start" value={offset} units={units} nonNegative disabled={readOnly} hint="Along the wall’s location line; it follows the wall" onCommit={(v) => { if (v !== null) move(wallHost({ at: v }), 'Move'); }} />
        <LengthField label="Height" value={height} units={units} nonNegative disabled={readOnly} hint="Above the wall’s base, to the device’s frame" onCommit={(v) => { if (v !== null) move(wallHost({ height: v }), 'Raise'); }} />
        {room === undefined ? null : <ReadOnlyField label="Room" value={labelOf(model, room)} />}
        {device?.placement === null || device === undefined ? null : <ReadOnlyField label="At (derived)" value={`${formatLen(device.placement.point[0], units)}, ${formatLen(device.placement.point[1], units)}`} />}
      </Section>
    );
  }
  const position = host['position'] as [number, number];
  const rotation = num(host['rotation']) ?? 0;
  const surface = host['mode'] === 'surface' ? (host['surface'] === 'ceiling' ? 'ceiling' : 'floor') : null;
  const same = (at: [number, number]): HostRef =>
    host['mode'] === 'surface'
      ? { mode: 'surface', room: String(host['room']), surface: surface ?? 'floor', at, rotation }
      : { mode: 'free', level: String(host['level']), at, rotation };
  return (
    <Section title="Placement">
      {host['mode'] === 'surface' ? (
        <Row label={surface === 'ceiling' ? 'Ceiling of' : 'Floor of'}>
          <button type="button" className="fs-linkish fs-row__link" onClick={() => { ctx.store.select(String(host['room'])); }}>{labelOf(model, String(host['room']))}</button>
        </Row>
      ) : (
        <ReadOnlyField label="Stands free on" value={labelOf(model, String(host['level']))} />
      )}
      <LengthField label="East (x)" value={position[0]} units={units} disabled={readOnly} onCommit={(v) => { if (v !== null) move(same([v, position[1]]), 'Move'); }} />
      <LengthField label="North (y)" value={position[1]} units={units} disabled={readOnly} onCommit={(v) => { if (v !== null) move(same([position[0], v]), 'Move'); }} />
      <IntField label="Facing" unit="°" value={Math.round(rotation / 1_000_000)} min={-359} max={360} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Turn ${label}`, rotateDevice(id, v * 1_000_000)); }} />
    </Section>
  );
}

function CircuitSection({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, element, readOnly } = ctx;
  const circuits = recordsOf(model.document, 'FS_electrical', 'circuits');
  const on = circuitsOf(model.document, id);
  const volts = num(element['volts']);
  const panels = elementsOfExtension(model.document, 'FS_electrical', 'panels');
  const label = labelOf(model, id);
  return (
    <Section
      title="Circuit"
      aside={
        readOnly ? undefined : (
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => {
            const panel = panels[0];
            if (panel === undefined) return;
            ctx.edit(`Put ${label} on a new circuit`, () => {
              const circuitVolts = volts ?? (model.ext.get(id)?.collection === 'evChargers' ? 240 : 120);
              const added = addCircuit(model.document, { panel: panel[0], breaker: circuitVolts === 240 ? 30 : 20, volts: circuitVolts, poles: circuitVolts === 240 ? 2 : 1, name: `${label} circuit`, loads: [] });
              return [...assignCircuit(model.document, id, null), ...added.ops, ...setRecordMember('FS_electrical', 'circuits', added.id, 'loads', [id])];
            });
          }}>
            New circuit
          </Button>
        )
      }
    >
      <Row label="On circuit">
        <Select
          aria-label="Circuit"
          appearance="filled"
          options={[{ value: '', label: 'None' }, ...circuits.map(([cid, c]) => ({ value: cid, label: `${labelOf(model, cid)} · ${String(c['breaker'])} A ${String(c['volts'])} V` }))]}
          value={on[0] ?? ''}
          disabled={readOnly}
          onValueChange={(v) => { ctx.edit(v === '' ? `Take ${label} off its circuit` : `Put ${label} on ${v}`, assignCircuit(model.document, id, v === '' ? null : v)); }}
        />
      </Row>
      {on.length > 1 ? <p className="fs-note">Fed by {on.join(' and ')} (split-wired).</p> : null}
    </Section>
  );
}

function ControlsSection({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, element, readOnly, store } = ctx;
  const picking = useEditor(store, (s) => s.picking !== null && 'switch' in s.picking && s.picking.switch === id);
  const controls = Array.isArray(element['controls']) ? (element['controls'] as string[]) : [];
  const options = deviceOptions(model, (d) => d.id !== id && !controls.includes(d.id) && !(d.extension === 'FS_electrical' && d.collection !== 'lights' && d.collection !== 'receptacles'));
  const label = labelOf(model, id);
  return (
    <Section
      title="Controls"
      aside={readOnly ? undefined : (
        <Button size="sm" variant={picking ? 'secondary' : 'ghost'} icon={<Pointer />} aria-pressed={picking} onClick={() => { store.set({ picking: picking ? null : { switch: id } }); }}>
          {picking ? 'Done picking' : 'Pick on the plan'}
        </Button>
      )}
    >
      {picking ? <p className="fs-note" role="status">Click lights, receptacles or a fan on the plan to link or unlink them. Esc when done.</p> : null}
      {controls.length === 0 ? <p className="fs-note">Controls nothing yet.</p> : (
        <ul className="fs-reflist">
          {controls.map((c) => (
            <li key={c}>
              <button type="button" className="fs-linkish" onClick={() => { store.select(c); }}>{labelOf(model, c)}</button>
              <span className="fs-spacer" />
              {readOnly ? null : <IconButton size="sm" variant="ghost" label={`Unlink ${labelOf(model, c)}`} icon={<X />} onClick={() => { ctx.edit(`Unlink ${labelOf(model, c)} from ${label}`, setMember(id, 'controls', controls.filter((x) => x !== c), true)); }} />}
            </li>
          ))}
        </ul>
      )}
      {readOnly || options.length === 0 ? null : (
        <Select
          aria-label="Add to what it controls"
          appearance="filled"
          options={options}
          value=""
          placeholder="Add a light or receptacle…"
          onValueChange={(v) => { if (v !== '') ctx.edit(`Link ${labelOf(model, v)} to ${label}`, setMember(id, 'controls', [...controls, v], controls.length > 0)); }}
        />
      )}
    </Section>
  );
}

function SwitchedBy({ ctx }: { ctx: SystemsCtx }) {
  const switches = switchesOf(ctx.model.document, ctx.id);
  if (switches.length === 0) return null;
  return (
    <Section title="Switched by">
      <ul className="fs-reflist">
        {switches.map((s) => (
          <li key={s}>
            <button type="button" className="fs-linkish" onClick={() => { ctx.store.select(s); }}>{labelOf(ctx.model, s)}</button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PanelCircuits({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, readOnly, store } = ctx;
  const derived = model.derived?.extensions?.FS_electrical?.panels[id];
  const circuits = recordsOf(model.document, 'FS_electrical', 'circuits').filter(([, c]) => c['panel'] === id);
  return (
    <Section
      title={`Circuits · ${String(circuits.length)}`}
      aside={readOnly ? undefined : (
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => {
          ctx.edit(`Add a circuit to ${labelOf(model, id)}`, () => {
            const cid = nextRecordId(model.document, 'C');
            return addCircuit(model.document, { panel: id, breaker: 20, volts: 120, name: `Circuit ${cid.slice(1)}` }, cid).ops;
          });
          store.set({ focus: 'circuit' });
        }}>
          Add circuit
        </Button>
      )}
    >
      {derived === undefined ? null : <p className="fs-note">{`${String(derived.spacesUsed)} spaces used · ${String(derived.connectedLoad)} W connected (the sum of the stated watts; not a load calculation)`}</p>}
      <ul className="fs-reflist">
        {circuits.map(([cid, c]) => (
          <li key={cid}>
            <button type="button" className="fs-linkish" onClick={() => { store.select(cid); }}>{labelOf(model, cid)}</button>
            <span className="fs-spacer" />
            <span className="fs-mono-small">{String(c['breaker'])} A · {Array.isArray(c['loads']) ? String(c['loads'].length) : '0'}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function FallbackSection({ ctx, device }: { ctx: SystemsCtx; device: DeviceView | undefined }) {
  const box = (ctx.element['fallback'] as Json | undefined)?.['box'] as { min: number[]; max: number[] } | undefined;
  if (box === undefined) return null;
  const size = (i: number) => prettyLen((box.max[i] ?? 0) - (box.min[i] ?? 0), ctx.units);
  return (
    <Section title="Fallback">
      <ReadOnlyField label="Box (D × W × H)" value={`${size(0)} × ${size(1)} × ${size(2)}`} />
      <p className="fs-note">What a reader without its extension draws (Floorspec Core 12.6).</p>
      {device !== undefined && device.clearances.length > 0 ? (
        <ul className="fs-reflist">
          {device.clearances.map((c) => <li key={c.name}><span>{c.name}</span><span className="fs-spacer" /><span className="fs-mono-small">{words(c.purpose)}</span></li>)}
        </ul>
      ) : null}
    </Section>
  );
}

// ─── A record's inspector: a circuit, a stack, a gas source ──────────────────────────────────

export function RecordBody({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, element, readOnly, store } = ctx;
  const at = model.records.get(id);
  if (at === undefined) return null;
  const set = (member: string, value: unknown, label: string) => {
    ctx.edit(`Set ${label.toLowerCase()} of ${id}`, setRecordMember(at.extension, at.collection, id, member, value));
  };
  const specs = memberSpecs(at.extension, at.collection, true);
  const listMember = at.collection === 'circuits' ? 'loads' : at.collection === 'stacks' ? 'levels' : null;
  const list = listMember === null || !Array.isArray(element[listMember]) ? [] : (element[listMember] as string[]);
  const derived = at.collection === 'circuits' ? model.derived?.extensions?.FS_electrical?.circuits[id] : undefined;
  const stack = at.collection === 'stacks' ? model.derived?.extensions?.FS_plumbing?.stacks[id] : undefined;
  const gas = at.collection === 'gasSources' ? model.derived?.extensions?.FS_mechanical?.gasSources[id] : undefined;
  const loadOptions = at.collection === 'circuits' ? deviceOptions(model, (d) => canBeLoad(d) && !list.includes(d.id)) : [];
  return (
    <>
      <Section title={at.collection === 'circuits' ? 'Circuit' : at.collection === 'stacks' ? 'Stack' : 'Gas source'}>
        <TextField label="Name" value={str(element['name']) ?? ''} disabled={readOnly} autoFocus={store.get().focus === 'circuit'} placeholder="No name" onCommit={(v) => { store.set({ focus: null }); set('name', v === '' ? undefined : v, 'Name'); }} />
        <MemberFields ctx={ctx} extension={at.extension} specs={specs} element={element} set={set} />
        {derived === undefined ? null : <ReadOnlyField label="Connected" value={`${String(derived.connectedLoad)} W of ${String(derived.capacity)} W (breaker × volts)`} />}
        {gas === undefined ? null : <ReadOnlyField label="Connected input" value={`${String(gas.input)} W`} />}
      </Section>
      {at.collection === 'circuits' ? (
        <Section title={`Loads · ${String(list.length)}`}>
          <ul className="fs-reflist">
            {list.map((l) => (
              <li key={l}>
                <button type="button" className="fs-linkish" onClick={() => { store.select(l); }}>{labelOf(model, l)}</button>
                <span className="fs-spacer" />
                {readOnly ? null : <IconButton size="sm" variant="ghost" label={`Take ${labelOf(model, l)} off ${id}`} icon={<X />} onClick={() => { set('loads', list.length === 1 ? undefined : list.filter((x) => x !== l), 'Loads'); }} />}
              </li>
            ))}
          </ul>
          {readOnly || loadOptions.length === 0 ? null : (
            <Select aria-label="Add a load" appearance="filled" options={loadOptions} value="" placeholder="Add a device…" onValueChange={(v) => { if (v !== '') ctx.edit(`Put ${labelOf(model, v)} on ${id}`, assignCircuit(model.document, v, id)); }} />
          )}
          <p className="fs-note">Connected load is the sum of the loads’ stated watts (FS_electrical 3.2) — a design figure, not a code calculation.</p>
        </Section>
      ) : null}
      {at.collection === 'stacks' ? (
        <Section title="Levels">
          <div className="fs-switches">
            {model.levels.map((l) => (
              <Switch key={l.id} checked={list.includes(l.id)} disabled={readOnly || (list.length === 1 && list.includes(l.id))} onCheckedChange={(on) => { set('levels', on ? [...list, l.id] : list.filter((x) => x !== l.id), 'Levels'); }}>
                {l.name}
              </Switch>
            ))}
          </div>
          {stack === undefined ? null : <p className="fs-note">{stack.connected.length === 0 ? 'Nothing drains to it yet.' : `Connected: ${stack.connected.map((c) => labelOf(model, c)).join(', ')}`}</p>}
        </Section>
      ) : null}
      {gas !== undefined && gas.appliances.length > 0 ? (
        <Section title="Appliances">
          <ul className="fs-reflist">
            {gas.appliances.map((a) => <li key={a}><button type="button" className="fs-linkish" onClick={() => { store.select(a); }}>{labelOf(model, a)}</button></li>)}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

/** The project panel's building-systems section: what each extension holds, and the electrical overview. */
export function SystemsSummary({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const devices = model.levels.flatMap((l) => l.devices);
  const used = Object.keys((model.document as { extensionsUsed?: object }).extensionsUsed ?? {});
  if (devices.length === 0 && used.length === 0) return null;
  return (
    <Section title="Building systems">
      <ul className="fs-reflist">
        {SYSTEMS.map((s) => {
          const n = devices.filter((d) => d.system === s.id).length;
          const declared = used.includes(s.extension);
          if (n === 0 && !declared) return null;
          return (
            <li key={s.id} title={`${s.extension} ${extensionVersion(s.extension)}`}>
              <SystemIcon system={s.id} />
              <span>{s.label}</span>
              <span className="fs-spacer" />
              <span className="fs-mono-small">{n === 1 ? '1 element' : `${String(n)} elements`}</span>
            </li>
          );
        })}
      </ul>
      <p className="fs-note">{SYSTEMS.filter((s) => used.includes(s.extension)).map((s) => `${s.extension} ${extensionVersion(s.extension)}`).join(' · ')} · Release Candidates</p>
      {used.includes('FS_electrical') ? <ElectricalOverview store={store} model={model} units={units} /> : null}
    </Section>
  );
}
