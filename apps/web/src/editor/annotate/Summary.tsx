import { useMemo, useState } from 'react';
import { Switch } from '@d3cloud/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { z765, type Z765Result } from '@floorspec/engine';
import type { EditorStore } from '../store';
import type { EditorModel, LevelView } from '../model';
import { openingWidth } from '../model';
import { operationLabel } from '../openings';
import { formatArea, formatLen, type UnitSystem } from '../units';
import { marks } from './source';
import { annotateOf, SHOW_LABELS, useAnnotate, type ShowSettings } from './state';

/**
 * Construction's annotation (FLR-T-18.11, the board's "Construction mode area summary and tag
 * toggles"): the level's and the whole house's area — gross to the exterior faces, net of the rooms,
 * finished after the engine's Z765 measure — what the plan shows of the annotation, and the door and
 * window schedule by type, each type's tags, size, operation and count.
 */

type Json = Record<string, unknown>;

const z765s = new WeakMap<EditorModel, Z765Result | null>();

/** The engine's Z765 area measure of the design shown, once per model; null when it cannot be measured. */
function measured(model: EditorModel): Z765Result | null {
  if (z765s.has(model)) return z765s.get(model) ?? null;
  let r: Z765Result | null;
  try {
    r = model.valid ? z765(model.view) : null;
  } catch {
    r = null;
  }
  z765s.set(model, r);
  return r;
}

const SQ_FT_TWICE = 2n * 390_144n * 390_144n;
/** Whole square feet as twice the area in square base units, for formatArea. */
const fromSqFt = (sqft: number): bigint => BigInt(Math.round(sqft)) * SQ_FT_TWICE;

export interface AreaRows {
  readonly level: [string, string][];
  readonly house: [string, string][];
}

/** The level's area and the whole house's: gross, net and finished. */
export function areaRows(model: EditorModel, level: LevelView, units: UnitSystem): AreaRows {
  const net = level.rooms.reduce((s, r) => s + r.area2, 0n);
  const z = measured(model);
  const lv = z?.buildings.flatMap((b) => b.levels).find((l) => l.level === level.id);
  const rows: [string, string][] = [];
  if (lv !== undefined) rows.push(['Gross (to exterior faces)', formatArea(fromSqFt(lv.grossSqFt), units)]);
  if (level.rooms.length > 0) rows.push(['Net (rooms)', formatArea(net, units)]);
  if (lv !== undefined) rows.push(['Finished (Z765)', formatArea(fromSqFt(lv.finishedSqFt), units)]);
  const house: [string, string][] = [];
  if (z !== null && model.levels.length > 1) {
    const levels = z.buildings.flatMap((b) => b.levels);
    const allNet = model.levels.reduce((s, l) => s + l.rooms.reduce((t, r) => t + r.area2, 0n), 0n);
    house.push(['Gross', formatArea(fromSqFt(levels.reduce((s, l) => s + l.grossSqFt, 0)), units)]);
    house.push(['Net (rooms)', formatArea(allNet, units)]);
    const above = z.buildings.reduce((s, b) => s + b.aboveGradeSqFt, 0);
    const below = z.buildings.reduce((s, b) => s + b.belowGradeSqFt, 0);
    house.push(['Finished above grade', formatArea(fromSqFt(above), units)]);
    if (below > 0) house.push(['Finished below grade', formatArea(fromSqFt(below), units)]);
  }
  return { level: rows, house };
}

export interface ScheduleGroup {
  readonly kind: 'door' | 'window';
  readonly type: string;
  readonly size: string;
  readonly operation: string;
  readonly marks: readonly string[];
  readonly count: number;
}

/** "D1–D3, D7": marks in order, runs joined. */
export function markRuns(list: readonly string[]): string {
  const sorted = [...list].sort((a, b) => a.charAt(0).localeCompare(b.charAt(0)) || Number(a.slice(1)) - Number(b.slice(1)));
  const runs: string[][] = [];
  for (const m of sorted) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run !== undefined && last !== undefined && last.charAt(0) === m.charAt(0) && Number(m.slice(1)) === Number(last.slice(1)) + 1) run.push(m);
    else runs.push([m]);
  }
  return runs.map((r) => (r.length >= 3 ? `${r[0] ?? ''}–${r[r.length - 1] ?? ''}` : r.join(', '))).join(', ');
}

/** The whole house's doors and windows, by type and size: each group's tags, operation and count. */
export function scheduleGroups(model: EditorModel, units: UnitSystem): ScheduleGroup[] {
  const doc = model.view;
  const m = marks(model);
  const groups = new Map<string, { kind: 'door' | 'window'; type: string; size: string; operation: string; marks: string[] }>();
  for (const [id, o] of Object.entries((doc.openings ?? {}) as Record<string, Json | undefined>)) {
    if (o === undefined) continue;
    const fill = typeof o['fill'] === 'string' ? o['fill'] : undefined;
    const type = (fill === undefined ? undefined : (doc.types?.[fill] as Json | undefined)) ?? {};
    const kind = type['kind'] === 'doorType' ? 'door' : type['kind'] === 'windowType' ? 'window' : null;
    if (kind === null) continue;
    const width = openingWidth(doc, o) ?? 0;
    const height = typeof o['height'] === 'number' ? o['height'] : typeof type['height'] === 'number' ? type['height'] : 0;
    const size = `${formatLen(width, units)} × ${formatLen(height, units)}`;
    const name = typeof type['name'] === 'string' ? type['name'] : (fill ?? '—');
    const operation = operationLabel(typeof type['operation'] === 'string' ? type['operation'] : undefined) ?? '—';
    const key = `${kind}|${name}|${size}|${operation}`;
    const g = groups.get(key) ?? { kind, type: name, size, operation, marks: [] };
    g.marks.push(m.get(id) ?? id);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, count: g.marks.length }))
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === 'door' ? -1 : 1) : a.type.localeCompare(b.type) || a.size.localeCompare(b.size)));
}

export function AnnotationSummary({ store, model, level, units }: { store: EditorStore; model: EditorModel; level: LevelView; units: UnitSystem }) {
  const show = useAnnotate(store, (a) => a.show);
  const areas = useMemo(() => areaRows(model, level, units), [model, level, units]);
  const groups = useMemo(() => scheduleGroups(model, units), [model, units]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="fs-mode-summary__group" data-testid="area-summary">
        <h4 className="fs-mode-summary__title">Area</h4>
        {areas.level.length === 0 ? (
          <p className="fs-note">No rooms yet.</p>
        ) : (
          <dl className="fs-mode-summary__rows">
            {areas.level.map(([name, value]) => (
              <div key={name} className="fs-mode-summary__row">
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {areas.house.length > 0 ? (
          <>
            <h4 className="fs-mode-summary__title fs-mode-summary__title--sub">Whole house</h4>
            <dl className="fs-mode-summary__rows">
              {areas.house.map(([name, value]) => (
                <div key={name} className="fs-mode-summary__row">
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </div>
      <div className="fs-mode-summary__group fs-anno-show" role="group" aria-label="Show on the plan">
        <h4 className="fs-mode-summary__title">Show</h4>
        {(Object.keys(SHOW_LABELS) as (keyof ShowSettings)[]).map((k) => (
          <Switch key={k} checked={show[k]} onCheckedChange={(on) => { annotateOf(store).setShow({ [k]: on }); }}>
            {SHOW_LABELS[k]}
          </Switch>
        ))}
      </div>
      <div className="fs-mode-summary__group fs-schedule-panel">
        <button type="button" className="fs-schedule-panel__toggle" aria-expanded={open} onClick={() => { setOpen(!open); }}>
          {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <span className="fs-mode-summary__title">Door and window schedule · whole house</span>
          <span className="fs-schedule-panel__count">{groups.reduce((s, g) => s + g.count, 0)}</span>
        </button>
        {open ? (
          groups.length === 0 ? (
            <p className="fs-note">No doors or windows yet.</p>
          ) : (
            <ul className="fs-schedule-panel__list" aria-label="Door and window schedule">
              {groups.map((g) => (
                <li key={`${g.kind}|${g.type}|${g.size}|${g.operation}`} className="fs-schedule-panel__row">
                  <div className="fs-schedule-panel__line">
                    <span className="fs-schedule-panel__tags">{markRuns(g.marks)}</span>
                    <span className="fs-schedule-panel__count" aria-label={`${String(g.count)} of this type`}>
                      ×{g.count}
                    </span>
                  </div>
                  <div className="fs-schedule-panel__type">{g.type}</div>
                  <div className="fs-schedule-panel__meta">
                    <span className="fs-mono">{g.size}</span>
                    {g.operation === '—' ? null : <span>{g.operation}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </>
  );
}
