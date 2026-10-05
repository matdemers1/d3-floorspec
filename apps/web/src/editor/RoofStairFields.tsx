import { Button, SegmentedControl, Select, Switch } from '@d3cloud/ui';
import { RotateCw } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import { labelOf, sortedLevels, type EditorModel } from './model';
import { IntField, LengthField, ReadOnlyField, Row, Section } from './fields';
import { formatLen, type UnitSystem } from './units';
import type { Batch } from './ops';
import type { FloorCtx } from './FloorFields';
import { roofOverLevel } from './actions';

/**
 * Roofs and stairs in the inspector (Core 0.3, chapters 16 and 17; FLR-T-7.2, 7.3): a roof's pitch,
 * overhang, eave height and thickness, and which of its edges are gables; a stair's form, the way it
 * turns, width, tread, riser count or greatest riser height, and the level it rises to. Each edit is
 * a setProperty or unsetProperty (Ops 2.3); the engine derives the rest, which is shown beneath.
 */

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const set = (id: string, path: string, value: unknown): Batch => [{ op: 'setProperty', id, path, value }];
const unset = (id: string, path: string): Batch => [{ op: 'unsetProperty', id, path }];

// ─── Roofs ───────────────────────────────────────────────────────────────────────────────────

const ROOF_KINDS: Readonly<Record<string, string>> = { flat: 'Flat', shed: 'Shed', gable: 'Gable', hip: 'Hip' };

/** A roof (Core 16.1): pitch, overhang, eave height and thickness, gables edge by edge, and what is derived. */
export function RoofBody({ ctx }: { ctx: FloorCtx }) {
  const { element, id, units, readOnly, model } = ctx;
  const name = labelOf(model, id);
  const levelId = str(element['level']) ?? '';
  const level = model.document.levels?.[levelId] as Json | undefined;
  const elevation = num(level?.['elevation']) ?? 0;
  const view = model.levels.find((l) => l.id === levelId)?.roofs.find((r) => r.id === id);
  const pitch = element['pitch'] as { rise: number; run: number } | undefined;
  const edges = (element['edges'] ?? {}) as Record<string, Json>;
  const footprint = (element['footprint'] ?? []) as [number, number][];
  /** The whole `edges` member with one edge changed: set whole, or unset when nothing differs. */
  const setEdge = (i: number, patch: Json | null): Batch => {
    const edge = Object.fromEntries(Object.entries({ ...(edges[String(i)] ?? {}), ...(patch ?? {}) }).filter(([, v]) => v !== undefined));
    const next: Record<string, Json> = Object.fromEntries(Object.entries({ ...edges, [String(i)]: edge }).filter(([, e]) => Object.keys(e).length > 0));
    return Object.keys(next).length === 0 ? (element['edges'] === undefined ? [] : unset(id, '/edges')) : set(id, '/edges', next);
  };
  const flat = pitch === undefined && Object.values(edges).every((e) => e['pitch'] === undefined);
  const surface = view?.derived.surface;
  return (
    <>
      <Section title="Roof">
        <Row label="Slope">
          <SegmentedControl
            aria-label="Slope"
            size="sm"
            value={flat ? 'flat' : 'sloped'}
            items={[{ value: 'sloped', label: 'Sloped' }, { value: 'flat', label: 'Flat' }]}
            onValueChange={(v) => {
              if (readOnly) return;
              if (v === 'flat' && !flat) ctx.edit(`Make ${name} flat`, [...unset(id, '/pitch'), ...(element['edges'] === undefined ? [] : unset(id, '/edges'))]);
              if (v === 'sloped' && flat) ctx.edit(`Slope ${name}`, set(id, '/pitch', { rise: 6, run: 12 }));
            }}
          />
        </Row>
        {pitch !== undefined ? (
          <>
            <IntField label="Pitch rise" value={pitch.rise} min={1} max={48} unit={`in ${String(pitch.run)}`} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set pitch of ${name}`, set(id, '/pitch', { ...pitch, rise: v })); }} />
            <IntField label="Pitch run" value={pitch.run} min={1} max={48} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set pitch of ${name}`, set(id, '/pitch', { ...pitch, run: v })); }} />
          </>
        ) : null}
        <LengthField
          label="Overhang"
          value={num(element['overhang']) ?? 0}
          units={units}
          nonNegative
          disabled={readOnly}
          onCommit={(v) => { ctx.edit(`Set overhang of ${name}`, v === null || v === 0 ? (element['overhang'] === undefined ? [] : unset(id, '/overhang')) : set(id, '/overhang', v)); }}
        />
        <LengthField
          label="Eave height"
          value={num(element['height'])}
          units={units}
          allowEmpty
          disabled={readOnly}
          placeholder={`${formatLen(num(level?.['height']) ?? 0, units)} (the level's height)`}
          hint="Above the level, where the roof sits on its walls"
          onCommit={(v) => { ctx.edit(`Set eave height of ${name}`, v === null ? (element['height'] === undefined ? [] : unset(id, '/height')) : set(id, '/height', v)); }}
        />
        <LengthField
          label="Thickness"
          value={num(element['thickness'])}
          units={units}
          allowEmpty
          positive
          disabled={readOnly}
          placeholder="Not declared"
          onCommit={(v) => { ctx.edit(`Set thickness of ${name}`, v === null ? (element['thickness'] === undefined ? [] : unset(id, '/thickness')) : set(id, '/thickness', v)); }}
        />
      </Section>
      {!flat ? (
        <Section title="Edges">
          {footprint.map((a, i) => {
            const b = footprint[(i + 1) % footprint.length] ?? a;
            const gable = edges[String(i)]?.['gable'] === true;
            return (
              <Switch
                key={i}
                checked={gable}
                disabled={readOnly}
                onCheckedChange={(on) => { ctx.edit(`${on ? 'Make' : 'Slope'} edge ${String(i)} of ${name}${on ? ' a gable' : ''}`, setEdge(i, on ? { gable: true, pitch: undefined } : { gable: undefined })); }}
              >
                {`Edge ${String(i)} · ${formatLen(Math.hypot(b[0] - a[0], b[1] - a[1]), units)} · gable`}
              </Switch>
            );
          })}
          <p className="fs-note">A gable is a vertical end: the roof stops above that edge instead of sloping up from it.</p>
        </Section>
      ) : null}
      {view !== undefined ? (
        <Section title="Derived">
          <ReadOnlyField label="Kind" value={ROOF_KINDS[view.derived.kind] ?? view.derived.kind} />
          <ReadOnlyField label="Eave" value={`${formatLen(view.derived.eave - elevation, units)} above the level`} />
          {surface ? (
            <ReadOnlyField label="High point" value={`${formatLen(surface.high - elevation, units)} above the level`} />
          ) : (
            <p className="fs-note">Floorspec 0.3 does not derive this roof's surface — its pitches differ, its outline has an oblique edge, or a gable is not at the end of a wing (FS-LINT-015). Its eave outline is drawn.</p>
          )}
          {surface ? <ReadOnlyField label="Faces · lines" value={`${String(surface.faces.length)} faces · ${String(surface.lines.length)} ridges, hips and valleys`} /> : null}
        </Section>
      ) : null}
    </>
  );
}

/** The roof tool's settings: a new roof's pitch, overhang and gables, and a roof over the whole level. */
export function RoofDrawSettings({ store, units }: { store: EditorStore; units: UnitSystem }) {
  const draw = useEditor(store, (s) => s.draw);
  const pending = useEditor(store, (s) => s.pending);
  const setRoof = (patch: Partial<typeof draw.roof>) => { store.set({ draw: { ...draw, roof: { ...draw.roof, ...patch } } }); };
  return (
    <>
      <Section title="New roof">
        <IntField label="Pitch rise" value={draw.roof.rise} min={1} max={48} unit={`in ${String(draw.roof.run)}`} onCommit={(v) => { if (v !== null) setRoof({ rise: v }); }} />
        <IntField label="Pitch run" value={draw.roof.run} min={1} max={48} onCommit={(v) => { if (v !== null) setRoof({ run: v }); }} />
        <LengthField label="Overhang" value={draw.roof.overhang} units={units} nonNegative onCommit={(v) => { setRoof({ overhang: v ?? 0 }); }} />
        <Switch checked={draw.roof.gables} onCheckedChange={(v) => { setRoof({ gables: v }); }}>
          Gable the two short ends of a four-sided roof
        </Switch>
      </Section>
      <Section title="Over this level">
        <Button size="sm" variant="secondary" loading={pending !== null} onClick={() => { roofOverLevel(store); }}>
          Roof over the walls
        </Button>
        <p className="fs-note">A footprint along the outside faces of this level's exterior walls, with these settings.</p>
      </Section>
    </>
  );
}

// ─── Stairs ──────────────────────────────────────────────────────────────────────────────────

const FORMS: readonly [string, string][] = [
  ['straight', 'Straight'],
  ['lShaped', 'L-shaped'],
  ['uShaped', 'U-shaped'],
  ['winder', 'Winder'],
  ['spiral', 'Spiral'],
];

/** A stair (Core 17.1): form and turn, width, tread, risers or greatest riser, the level it rises to, and what is derived. */
export function StairBody({ ctx }: { ctx: FloorCtx }) {
  const { element, id, units, readOnly, model } = ctx;
  const name = labelOf(model, id);
  const levelId = str(element['level']) ?? '';
  const form = (element['form'] ?? { kind: 'straight' }) as Json & { kind: string };
  const view = model.levels.find((l) => l.id === levelId)?.stairs.find((s) => s.id === id);
  const d = view?.derived;
  const n = d?.risers ?? num(element['risers']) ?? 16;
  const half = Math.max(2, Math.floor(n / 2));
  const width = num(element['width']) ?? 0;
  const formFor = (kind: string): Json | null => {
    const turn = str(form['turn']) ?? 'left';
    switch (kind) {
      case 'lShaped':
      case 'uShaped':
        return { kind, turn, risersBeforeTurn: num(form['risersBeforeTurn']) ?? half };
      case 'winder':
        return { kind, turn, angle: 'quarter', risersBeforeTurn: Math.max(1, (num(form['risersBeforeTurn']) ?? half) - 1), winders: 3 };
      case 'spiral':
        return { kind, turn, diameter: 2 * width + 2 * 32512 * 6, sweep: 270_000_000 };
      default:
        return null;
    }
  };
  const building = (model.document.levels?.[levelId] as Json | undefined)?.['building'];
  const others = sortedLevels(model.document).filter((l) => l.id !== levelId && l.level['building'] === building);
  const rotation = num(element['rotation']) ?? 0;
  const turned = rotation + 90_000_000 > 180_000_000 ? rotation - 270_000_000 : rotation + 90_000_000;
  const byCount = element['risers'] !== undefined;
  return (
    <>
      <Section title="Stair">
        <Row label="Form">
          <Select
            aria-label="Form"
            appearance="filled"
            options={FORMS.map(([value, label]) => ({ value, label }))}
            value={form.kind}
            disabled={readOnly}
            onValueChange={(v) => {
              if (v === form.kind) return;
              const next = formFor(v);
              ctx.edit(`Make ${name} ${FORMS.find(([k]) => k === v)?.[1] ?? v}`, next === null ? unset(id, '/form') : set(id, '/form', next));
            }}
          />
        </Row>
        {form.kind !== 'straight' ? (
          <Row label="Turns">
            <SegmentedControl
              aria-label="Turns"
              size="sm"
              value={str(form['turn']) ?? 'left'}
              items={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
              onValueChange={(v) => { if (!readOnly && v !== form['turn']) ctx.edit(`Turn ${name} ${v}`, set(id, '/form/turn', v)); }}
            />
          </Row>
        ) : null}
        {form['risersBeforeTurn'] !== undefined ? (
          <IntField label="Risers before the turn" value={num(form['risersBeforeTurn'])} min={1} max={99} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set the turn of ${name}`, set(id, '/form/risersBeforeTurn', v)); }} />
        ) : null}
        {form.kind === 'uShaped' ? (
          <LengthField label="Gap between flights" value={num(form['gap']) ?? 0} units={units} nonNegative disabled={readOnly} onCommit={(v) => { ctx.edit(`Set the gap of ${name}`, v === null || v === 0 ? (form['gap'] === undefined ? [] : unset(id, '/form/gap')) : set(id, '/form/gap', v)); }} />
        ) : null}
        {form.kind === 'winder' ? (
          <IntField label="Winders" value={num(form['winders'])} min={1} max={9} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set the winders of ${name}`, set(id, '/form/winders', v)); }} />
        ) : null}
        <LengthField label="Width" value={width} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set width of ${name}`, set(id, '/width', v)); }} />
        <LengthField label="Tread" value={num(element['tread'])} units={units} positive disabled={readOnly} hint="The going, nosing to nosing" onCommit={(v) => { if (v !== null) ctx.edit(`Set tread of ${name}`, set(id, '/tread', v)); }} />
        <Row label="Risers by">
          <SegmentedControl
            aria-label="Risers by"
            size="sm"
            value={byCount ? 'count' : 'height'}
            items={[{ value: 'height', label: 'Greatest height' }, { value: 'count', label: 'Count' }]}
            onValueChange={(v) => {
              if (readOnly) return;
              if (v === 'count' && !byCount) ctx.edit(`Fix the risers of ${name}`, [...set(id, '/risers', n), ...unset(id, '/maxRiser')]);
              if (v === 'height' && byCount) ctx.edit(`Let ${name}'s risers follow the rise`, [...set(id, '/maxRiser', 251_968), ...unset(id, '/risers')]);
            }}
          />
        </Row>
        {byCount ? (
          <IntField label="Risers" value={num(element['risers'])} min={1} max={99} disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set risers of ${name}`, set(id, '/risers', v)); }} />
        ) : (
          <LengthField label="Greatest riser" value={num(element['maxRiser'])} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) ctx.edit(`Set greatest riser of ${name}`, set(id, '/maxRiser', v)); }} />
        )}
        <Row label="Rises to">
          <Select
            aria-label="Rises to"
            appearance="filled"
            options={others.map((l) => ({ value: l.id, label: labelOf(model, l.id) }))}
            value={str(element['to']) ?? ''}
            disabled={readOnly}
            onValueChange={(v) => { if (v !== element['to']) ctx.edit(`${name} rises to ${labelOf(model, v)}`, set(id, '/to', v)); }}
          />
        </Row>
        <Button size="sm" variant="secondary" icon={<RotateCw />} disabled={readOnly} onClick={() => { ctx.edit(`Turn ${name} a quarter`, turned === 0 ? unset(id, '/rotation') : set(id, '/rotation', turned)); }}>
          Turn a quarter
        </Button>
      </Section>
      {d !== undefined ? (
        <Section title="Derived">
          <ReadOnlyField label="Risers" value={`${String(d.risers)} × ${formatLen(d.riserHeight, units)}`} />
          <ReadOnlyField label="Rise" value={formatLen(d.rise, units)} />
          {d.run !== undefined ? <ReadOnlyField label="Run" value={formatLen(d.run, units)} /> : null}
          {d.walkline !== undefined ? <ReadOnlyField label="Walkline" value={formatLen(d.walkline.length, units)} /> : null}
          <ReadOnlyField label="Headroom" value={d.headroom !== undefined ? formatLen(d.headroom, units) : d.steps === undefined ? 'Not derived for this form' : 'Nothing above it'} />
          <ReadOnlyField label="From · to" value={`${d.footRoom !== undefined ? labelOf(model, d.footRoom) : 'no room'} → ${d.headRoom !== undefined ? labelOf(model, d.headRoom) : 'no room'}`} />
          {d.steps === undefined ? <p className="fs-note">Floorspec 0.3 derives a winder's or a spiral's risers and box, not its steps (FS-LINT-016).</p> : null}
        </Section>
      ) : null}
    </>
  );
}

/** The stair tool's settings: a new stair's form, turn, width, tread and greatest riser. */
export function StairDrawSettings({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const draw = useEditor(store, (s) => s.draw);
  const level = useEditor(store, (s) => s.level);
  const setStair = (patch: Partial<typeof draw.stair>) => { store.set({ draw: { ...draw, stair: { ...draw.stair, ...patch } } }); };
  const above = level === null ? undefined : sortedLevels(model.document).find((l) => l.level['building'] === model.document.levels?.[level]?.building && Number(l.level['elevation']) > Number(model.document.levels?.[level]?.elevation));
  return (
    <Section title="New stair">
      <SegmentedControl
        aria-label="Form"
        size="sm"
        value={draw.stair.form}
        items={[{ value: 'straight', label: 'Straight' }, { value: 'lShaped', label: 'L' }, { value: 'uShaped', label: 'U' }]}
        onValueChange={(v) => { setStair({ form: v as typeof draw.stair.form }); }}
      />
      {draw.stair.form !== 'straight' ? (
        <SegmentedControl
          aria-label="Turns"
          size="sm"
          value={draw.stair.turn}
          items={[{ value: 'left', label: 'Turns left' }, { value: 'right', label: 'Turns right' }]}
          onValueChange={(v) => { setStair({ turn: v as 'left' | 'right' }); }}
        />
      ) : null}
      <LengthField label="Width" value={draw.stair.width} units={units} positive onCommit={(v) => { if (v !== null) setStair({ width: v }); }} />
      <LengthField label="Tread" value={draw.stair.tread} units={units} positive onCommit={(v) => { if (v !== null) setStair({ tread: v }); }} />
      <LengthField label="Greatest riser" value={draw.stair.maxRiser} units={units} positive onCommit={(v) => { if (v !== null) setStair({ maxRiser: v }); }} />
      <p className="fs-note">{above === undefined ? 'This level has no level above it: add one first.' : `Rises to ${labelOf(model, above.id)}; the riser count follows the floors at each end.`}</p>
    </Section>
  );
}
