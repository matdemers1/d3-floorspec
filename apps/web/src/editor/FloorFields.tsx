import { Button, SegmentedControl, Select } from '@d3cloud/ui';
import { Pointer } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import { labelOf, type EditorModel, type RoomView } from './model';
import { IntField, LengthField, ReadOnlyField, Row, Section } from './fields';
import { formatLen, type UnitSystem } from './units';
import type { Batch, BatchBuilder } from './ops';
import { CoreUpgradeNotice } from './OpeningFields';
import { holdsClearOpenings } from './openings';
import { startingCeiling, type CeilingKind } from './floors';

/**
 * Floors, ceilings and slabs in the inspector (Core 0.3, chapter 15; FLR-T-7.1): a level's floor
 * thickness and ceiling height, a room's floor (offset, thickness) and ceiling (flat, tray or
 * vaulted, with a vault's ridge picked on the plan), and a slab's purpose, thickness and top. Each
 * edit is a setProperty or unsetProperty of the member (Ops 2.3); the engine derives the rest.
 */

type Json = Record<string, unknown>;

export interface FloorCtx {
  store: EditorStore;
  model: EditorModel;
  id: string;
  element: Json;
  units: UnitSystem;
  readOnly: boolean;
  edit: (label: string, batch: Batch | BatchBuilder) => void;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A copy of an object without one member. */
const without = (o: Json, key: string): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const set = (id: string, path: string, value: unknown): Batch => [{ op: 'setProperty', id, path, value }];
const unset = (id: string, path: string): Batch => [{ op: 'unsetProperty', id, path }];

/** The member's own value set, or unset when the field is emptied. */
const setOrClear = (id: string, path: string, value: number | null, present: boolean): Batch => (value === null ? (present ? unset(id, path) : []) : set(id, path, value));

// ─── Levels ──────────────────────────────────────────────────────────────────────────────────

/** A level's floor thickness and ceiling height (Core 1.8): what its rooms' floors and ceilings default to. */
export function LevelFloorCeiling({ ctx }: { ctx: FloorCtx }) {
  const { element, id, units, readOnly, model } = ctx;
  if (!holdsClearOpenings(model.document))
    return (
      <Section title="Floors and ceilings">
        <CoreUpgradeNotice store={ctx.store} model={model} what="Floors and ceilings" />
      </Section>
    );
  const height = num(element['height']) ?? 0;
  return (
    <Section title="Floors and ceilings">
      <LengthField
        label="Floor thickness"
        value={num(element['floorThickness'])}
        units={units}
        allowEmpty
        positive
        disabled={readOnly}
        placeholder="Not declared"
        hint="Its rooms' floors, unless a room says otherwise"
        onCommit={(v) => { ctx.edit(`Set floor thickness of ${labelOf(model, id)}`, setOrClear(id, '/floorThickness', v, element['floorThickness'] !== undefined)); }}
      />
      <LengthField
        label="Ceiling height"
        value={num(element['ceilingHeight'])}
        units={units}
        allowEmpty
        positive
        disabled={readOnly}
        placeholder={`${formatLen(height, units)} (the level's height)`}
        hint="Above the level's elevation, for its rooms' ceilings"
        onCommit={(v) => { ctx.edit(`Set ceiling height of ${labelOf(model, id)}`, setOrClear(id, '/ceilingHeight', v, element['ceilingHeight'] !== undefined)); }}
      />
    </Section>
  );
}

// ─── Rooms ───────────────────────────────────────────────────────────────────────────────────

/** A room's floor and ceiling (Core 15.1, 15.2). */
export function RoomFloorCeiling({ ctx, room }: { ctx: FloorCtx; room: RoomView | undefined }) {
  const { element, id, units, readOnly, model, store } = ctx;
  const ridgePicking = useEditor(store, (s) => s.picking !== null && 'ridge' in s.picking && s.picking.ridge === id);
  if (!holdsClearOpenings(model.document))
    return (
      <Section title="Floor and ceiling">
        <CoreUpgradeNotice store={store} model={model} what="A room's own floor and ceiling — sunken, raised, tray or vaulted" />
      </Section>
    );
  const name = labelOf(model, id);
  const floor = (element['floor'] as Json | undefined) ?? {};
  const ceiling = element['ceiling'] as Json | undefined;
  const kind = (str(ceiling?.['kind']) ?? 'flat') as CeilingKind;
  const level = model.document.levels?.[str(element['level']) ?? ''] as Json | undefined;
  const levelHeight = num(level?.['ceilingHeight']) ?? num(level?.['height']) ?? 0;
  const levelThickness = num(level?.['floorThickness']);
  const floorMember = (key: 'offset' | 'thickness', v: number | null): Batch => {
    const next: Json = without(floor, key);
    if (v !== null && !(key === 'offset' && v === 0)) next[key] = v;
    return Object.keys(next).length === 0 ? (element['floor'] === undefined ? [] : unset(id, '/floor')) : set(id, '/floor', next);
  };
  const ceilingMember = (key: string, v: unknown): Batch => {
    const next: Json = without(ceiling ?? { kind: 'flat' }, key);
    if (v !== null && v !== undefined) next[key] = v;
    // A flat ceiling with nothing of its own is the default: the member goes.
    if (next['kind'] === 'flat' && Object.keys(next).length === 1) return ceiling === undefined ? [] : unset(id, '/ceiling');
    return set(id, '/ceiling', next);
  };
  const pitch = (ceiling?.['pitch'] as { rise?: number; run?: number } | undefined) ?? {};
  const ridge = ceiling?.['ridge'] as [[number, number], [number, number]] | undefined;
  const above = (z: number): string => formatLen(z - (num(level?.['elevation']) ?? 0), units);
  const least = room?.ceiling !== null && room?.ceiling !== undefined && room.floorTop !== null ? room.ceiling.low - room.floorTop : undefined;
  return (
    <>
      <Section title="Floor">
        <LengthField
          label="Floor offset"
          value={num(floor['offset'])}
          units={units}
          allowEmpty
          disabled={readOnly}
          placeholder={`${formatLen(0, units)} (at the level)`}
          hint="Negative for a sunken floor, positive for a raised one"
          onCommit={(v) => { ctx.edit(`Set floor offset of ${name}`, floorMember('offset', v)); }}
        />
        <LengthField
          label="Floor thickness"
          value={num(floor['thickness'])}
          units={units}
          allowEmpty
          positive
          disabled={readOnly}
          placeholder={levelThickness === undefined ? 'Not declared' : `${formatLen(levelThickness, units)} (the level's)`}
          onCommit={(v) => { ctx.edit(`Set floor thickness of ${name}`, floorMember('thickness', v)); }}
        />
      </Section>
      <Section title="Ceiling">
        <Row label="Kind">
          <SegmentedControl
            aria-label="Ceiling kind"
            size="sm"
            value={kind}
            items={[{ value: 'flat', label: 'Flat' }, { value: 'tray', label: 'Tray' }, { value: 'vaulted', label: 'Vaulted' }]}
            onValueChange={(v) => {
              if (readOnly || v === kind) return;
              const next = startingCeiling(v as CeilingKind, ceiling, room, levelHeight);
              const flatDefault = v === 'flat' && Object.keys(next).length === 1;
              ctx.edit(`Make ${name}'s ceiling ${v}`, flatDefault ? (ceiling === undefined ? [] : unset(id, '/ceiling')) : set(id, '/ceiling', next));
            }}
          />
        </Row>
        <LengthField
          label={kind === 'vaulted' ? 'Ridge height' : 'Ceiling height'}
          value={num(ceiling?.['height'])}
          units={units}
          allowEmpty={kind !== 'vaulted'}
          positive
          disabled={readOnly}
          placeholder={`${formatLen(levelHeight, units)} (the level's)`}
          hint="Above the level's elevation, not the floor"
          onCommit={(v) => { ctx.edit(`Set ceiling height of ${name}`, ceilingMember('height', v)); }}
        />
        {kind === 'tray' ? (
          <>
            <LengthField label="Border" value={num(ceiling?.['border'])} units={units} positive disabled={readOnly} hint="In from the walls, in plan" onCommit={(v) => { if (v !== null) ctx.edit(`Set tray border of ${name}`, ceilingMember('border', v)); }} />
            <LengthField label="Depth" value={num(ceiling?.['depth'])} units={units} positive disabled={readOnly} hint="How far the centre is raised" onCommit={(v) => { if (v !== null) ctx.edit(`Set tray depth of ${name}`, ceilingMember('depth', v)); }} />
          </>
        ) : null}
        {kind === 'vaulted' ? (
          <>
            <IntField label="Pitch rise" value={pitch.rise} min={1} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set pitch of ${name}`, ceilingMember('pitch', { rise: v, run: pitch.run ?? 12 })); }} />
            <IntField label="Pitch run" value={pitch.run} min={1} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set pitch of ${name}`, ceilingMember('pitch', { rise: pitch.rise ?? 4, run: v })); }} />
            <Row label="Slopes">
              <SegmentedControl
                aria-label="Slopes"
                size="sm"
                value={str(ceiling?.['slopes']) ?? 'both'}
                items={[{ value: 'both', label: 'Both sides' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
                onValueChange={(v) => { if (!readOnly) ctx.edit(`Set slopes of ${name}`, ceilingMember('slopes', v === 'both' ? null : v)); }}
              />
            </Row>
            <ReadOnlyField label="Ridge" value={ridge === undefined ? '—' : ridge.map((p) => `${formatLen(p[0], units)}, ${formatLen(p[1], units)}`).join(' → ')} />
            {!readOnly ? (
              <Row label="">
                <Button
                  size="sm"
                  variant={ridgePicking ? 'secondary' : 'ghost'}
                  icon={<Pointer />}
                  aria-pressed={ridgePicking}
                  onClick={() => { store.set({ picking: ridgePicking ? null : { ridge: id, first: null } }); }}
                >
                  {ridgePicking ? 'Cancel picking' : 'Pick the ridge on the plan'}
                </Button>
              </Row>
            ) : null}
            {ridgePicking ? <p className="fs-note" role="status">Click two points the ridge runs through. Esc to stop.</p> : null}
          </>
        ) : null}
        {room?.ceiling ? (
          <ReadOnlyField
            label="Ceiling"
            value={room.ceiling.low === room.ceiling.high ? `${above(room.ceiling.low)} above the level` : `${above(room.ceiling.low)} to ${above(room.ceiling.high)} above the level`}
          />
        ) : null}
        {least !== undefined ? <ReadOnlyField label="Least height" value={`${formatLen(least, units)} above the floor`} /> : null}
      </Section>
    </>
  );
}

// ─── Slabs ───────────────────────────────────────────────────────────────────────────────────

/** Core 6.7: what a slab is for (Core 0.3). */
export const SLAB_PURPOSES: readonly [string, string][] = [
  ['patio', 'Patio'],
  ['deck', 'Deck'],
  ['porch', 'Porch'],
  ['stoop', 'Stoop'],
  ['landing', 'Landing'],
  ['balcony', 'Balcony'],
  ['garage', 'Garage'],
  ['walkway', 'Walkway'],
  ['driveway', 'Driveway'],
  ['equipmentPad', 'Equipment pad'],
  ['other', 'Other'],
];

export const slabPurposeLabel = (p: string | undefined): string | undefined => SLAB_PURPOSES.find(([v]) => v === p)?.[1] ?? p;

/** A slab (Core 6.7, 15.7): purpose, thickness, top above its level, and what is derived. */
export function SlabBody({ ctx }: { ctx: FloorCtx }) {
  const { element, id, units, readOnly, model } = ctx;
  const name = labelOf(model, id);
  const v03 = holdsClearOpenings(model.document);
  const levelId = str(element['level']) ?? '';
  const slab = model.levels.find((l) => l.id === levelId)?.slabs.find((s) => s.id === id);
  const level = model.document.levels?.[levelId] as Json | undefined;
  const elevation = num(level?.['elevation']) ?? 0;
  return (
    <Section title="Slab">
      {v03 ? (
        <Row label="Purpose">
          <Select
            aria-label="Purpose"
            appearance="filled"
            options={[{ value: '', label: 'Not stated' }, ...SLAB_PURPOSES.map(([value, label]) => ({ value, label }))]}
            value={str(element['purpose']) ?? ''}
            disabled={readOnly}
            onValueChange={(v) => {
              if (v !== (str(element['purpose']) ?? '')) ctx.edit(`Set purpose of ${name}`, v === '' ? unset(id, '/purpose') : set(id, '/purpose', v));
            }}
          />
        </Row>
      ) : null}
      <LengthField label="Thickness" value={num(element['thickness'])} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set thickness of ${name}`, set(id, '/thickness', v)); }} />
      <LengthField
        label="Top above level"
        value={num(element['offset'])}
        units={units}
        allowEmpty
        disabled={readOnly}
        placeholder={`${formatLen(0, units)} (at the level)`}
        onCommit={(v) => { ctx.edit(`Set the top of ${name}`, v === null || v === 0 ? (element['offset'] === undefined ? [] : unset(id, '/offset')) : set(id, '/offset', v)); }}
      />
      <ReadOnlyField label="Level" value={labelOf(model, levelId)} />
      {slab !== undefined ? <ReadOnlyField label="Top · bottom" value={`${formatLen(slab.top - elevation, units)} · ${formatLen(slab.bottom - elevation, units)} from the level`} /> : null}
      {!v03 ? <CoreUpgradeNotice store={ctx.store} model={model} what="A slab's purpose" /> : null}
    </Section>
  );
}

/** The slab tool's settings: a new slab's thickness, top and purpose. */
export function SlabDrawSettings({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const draw = useEditor(store, (s) => s.draw);
  const v03 = holdsClearOpenings(model.document);
  const setSlab = (patch: Partial<typeof draw.slab>) => { store.set({ draw: { ...draw, slab: { ...draw.slab, ...patch } } }); };
  return (
    <Section title="New slab">
      <LengthField label="Thickness" value={draw.slab.thickness} units={units} positive onCommit={(v) => { if (v !== null) setSlab({ thickness: v }); }} />
      <LengthField label="Top above level" value={draw.slab.offset} units={units} onCommit={(v) => { setSlab({ offset: v ?? 0 }); }} />
      {v03 ? (
        <Row label="Purpose">
          <Select
            aria-label="Purpose"
            appearance="filled"
            options={[{ value: '', label: 'Not stated' }, ...SLAB_PURPOSES.map(([value, label]) => ({ value, label }))]}
            value={draw.slab.purpose ?? ''}
            onValueChange={(v) => { setSlab({ purpose: v === '' ? null : v }); }}
          />
        </Row>
      ) : null}
    </Section>
  );
}
