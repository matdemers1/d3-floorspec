import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button, IconButton, Select, Tooltip } from '@d3cloud/ui';
import { Flame, Thermometer, X } from 'lucide-react';
import {
  estimateEnergy,
  HEAT_CAPACITY_IP,
  hourText,
  loadRange,
  range,
  ROOM_METHOD,
  temperature,
  THERMAL_LIBRARY,
  thermalData,
  thermalMatch,
  thermalView,
  wallTypeThermal,
  type AssemblyThermal,
  type EnergyEstimate,
  type LoadPart,
  type RoomLoad,
  type ThermalLibraryItem,
  type UnitSystem,
} from '@floorspec/analysis';
import type { FloorspecDocument } from '@floorspec/engine';
import { setProperty, unsetProperty, type Batch } from '../ops';
import { Row, Section, TextField } from '../fields';
import { formatLen } from '../units';
import { labelOf, type EditorModel } from '../model';
import type { EditorStore } from '../store';
import { threeOf, useThreeState } from '../three/mode';
import { BANDS, envelopeEstimate, envelopeOf, perAreaText, rIn, uIn, useEnvelope, useEnvelopeEstimate, wattsRange } from './state';
import './envelope.css';

/**
 * The thermal envelope in the editor (FLR-T-16.4) — the board's frames "16.4 · Wall type — layer by
 * layer", "16.4 · Heat loss room by room" and "16.4 · Heat-loss map in 3D" and its P16/Assembly layer
 * component: a wall type's layers, outside in, each with its R; its two paths in parallel and its
 * effective R and U; its thermal mass; trying another material in a layer and seeing what it does to
 * the house; a room's heating and cooling loads part by part; the heat-loss map's panel and legend.
 *
 * Every predicted number is a ±20% range with its method named, and every panel says it is advisory:
 * nothing here says an envelope passes, fails or is "compliant" (FLR-ADR-011). R and U are computed
 * from the layers, so they are shown as values with the method that computes them.
 */

type Edit = (label: string, batch: Batch) => void;

const FS_THERMAL = 'FS_thermal';
const uses = (doc: FloorspecDocument): boolean => Object.hasOwn((doc.extensionsUsed ?? {}), FS_THERMAL);
const declare = (doc: FloorspecDocument): Batch => (uses(doc) ? [] : setProperty('$document', `/extensionsUsed/${FS_THERMAL}`, '0.1.0'));
const materialsOf = (doc: FloorspecDocument): Record<string, { name?: string; color?: string; extensions?: Record<string, unknown> }> => (doc.materials ?? {}) as Record<string, { name?: string; color?: string; extensions?: Record<string, unknown> }>;

/** The ops that give every material the library knows its thermal values, and declare FS_thermal. */
export function addLibraryValues(doc: FloorspecDocument): Batch {
  const ops: Batch = [];
  for (const [id, m] of Object.entries(materialsOf(doc)).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const own = m.extensions?.[FS_THERMAL] as Record<string, unknown> | undefined;
    if (own !== undefined && ('conductivity' in own || 'resistance' in own)) continue;
    const item = thermalMatch(id, m);
    if (item !== undefined) ops.push(...setProperty(id, `/extensions/${FS_THERMAL}`, { ...thermalData(item), ...(own ?? {}) }));
  }
  return ops.length === 0 ? [] : [...declare(doc), ...ops];
}

// ─── Pieces ──────────────────────────────────────────────────────────────────────────────────

function Chips({ items }: { items: readonly string[] }) {
  return (
    <ul className="fs-envelope__chips" aria-label="At a glance">
      {items.map((c) => (
        <li key={c} className="fs-envelope__chip">
          {c}
        </li>
      ))}
    </ul>
  );
}

function Line({ label, value, strong = false, testId }: { label: ReactNode; value: ReactNode; strong?: boolean; testId?: string }) {
  return (
    <div className={strong ? 'fs-envelope__line fs-envelope__line--strong' : 'fs-envelope__line'} {...(testId === undefined ? {} : { 'data-testid': testId })}>
      <span className="fs-envelope__line-label">{label}</span>
      <span className="fs-envelope__line-value">{value}</span>
    </div>
  );
}

/** The legend: the four bands, high first, each with its range. */
export function LossLegend({ title, ranges, note }: { title: string; ranges: readonly string[]; note?: string }) {
  const id = useId();
  return (
    <div className="fs-envelope__legend">
      <span className="fs-overline" id={id}>
        {title}
      </span>
      <ul className="fs-envelope__bands" aria-labelledby={id}>
        {BANDS.map((b, i) => (
          <li key={b.id} className="fs-envelope__band">
            <span className={`fs-envelope__swatch fs-envelope__swatch--${b.id}`} aria-hidden="true" />
            <span className="fs-envelope__band-label">{b.label}</span>
            <span className="fs-envelope__band-range">{ranges[i]}</span>
          </li>
        ))}
      </ul>
      {note === undefined ? null : <p className="fs-note">{note}</p>}
    </div>
  );
}

const roomRanges = (units: UnitSystem): string[] => (units === 'imperial' ? ['> 18 Btu/h per ft²', '12–18', '6–12', '< 6'] : ['> 57 W/m²', '38–57', '19–38', '< 19']);
const surfaceRanges = (units: UnitSystem): string[] => (units === 'imperial' ? ['> 8 Btu/h per ft²', '3–8', '1.5–3', '< 1.5'] : ['> 25 W/m²', '9.5–25', '4.7–9.5', '< 4.7']);

/**
 * The wall type in section, outside on the left: each layer as wide as it is thick, in its colour, and
 * the temperature through the clear path on the heating design day, falling most across the insulation.
 */
function SectionDrawing({ a, model, outside, inside, units }: { a: AssemblyThermal; model: EditorModel; outside: number; inside: number; units: UnitSystem }) {
  const total = a.layers.reduce((s, l) => s + l.thickness, 0);
  const W = 240;
  const H = 120;
  const mats = materialsOf(model.document);
  let x = 0;
  const rects = a.layers.map((l) => {
    const w = Math.max(2, (l.thickness / total) * W);
    const r = { x, w, colour: (l.material === undefined ? undefined : mats[l.material]?.color) ?? 'var(--color-fill-quiet)', l };
    x += w;
    return r;
  });
  const known = a.rClear !== null;
  const rTotal = (a.rClear ?? 0) + a.films.inside + a.films.outside;
  let cum = a.films.outside;
  const pts: string[] = [`0,${String(H * 0.15)}`];
  if (known) {
    const y = (r: number) => H * 0.15 + (H * 0.7 * r) / rTotal;
    pts.length = 0;
    pts.push(`0,${String(y(cum))}`);
    for (const r of rects) {
      cum += r.l.r ?? 0;
      pts.push(`${String(r.x + r.w)},${String(y(cum))}`);
    }
  }
  return (
    <figure className="fs-envelope__section">
      <svg className="fs-envelope__drawing" viewBox={`0 0 ${String(W)} ${String(H)}`} preserveAspectRatio="none" role="img" aria-label={`Section through ${a.label}, outside on the left: ${a.layers.length} layers`}>
        {rects.map((r) => (
          <rect key={r.l.index} x={r.x} y={0} width={r.w} height={H} fill={r.colour} stroke="var(--color-border)" strokeWidth={0.5} />
        ))}
        {known ? <polyline points={pts.join(' ')} fill="none" stroke="var(--color-warning)" strokeWidth={2} /> : null}
      </svg>
      <figcaption className="fs-envelope__caption">
        <span>Out · {temperature(outside, units)}</span>
        <span>In · {temperature(inside, units)}</span>
      </figcaption>
    </figure>
  );
}

// ─── The wall type, layer by layer ───────────────────────────────────────────────────────────

/** A library item a layer could be tried as, by what the layer does. */
const CHOICES: Readonly<Record<string, readonly ThermalLibraryItem['category'][]>> = {
  finish: ['cladding', 'masonry', 'finish', 'roofing'],
  substrate: ['sheathing', 'insulation'],
  insulation: ['insulation'],
  core: ['insulation', 'cavity'],
  airGap: ['air'],
  membrane: ['membrane'],
};

export function WallTypeThermalSection({ store, model, id, units, readOnly, edit }: { store: EditorStore; model: EditorModel; id: string; units: UnitSystem; readOnly: boolean; edit: Edit }) {
  const doc = model.document;
  const view = useMemo(() => thermalView(doc), [doc]);
  const a = useMemo(() => wallTypeThermal(view, id), [view, id]);
  const env = useEnvelopeEstimate(store);
  const [trial, setTrial] = useState<{ layer: number; item: string } | null>(null);
  const compare = useMemo(() => (trial === null ? null : tryLayer(model, id, trial.layer, trial.item)), [model, id, trial]);
  if (a === undefined) return null;
  const users = Object.values(doc.walls ?? {}).filter((w) => w?.type === id).length;
  const est = env?.status === 'ok' ? env.estimate : null;
  const outside = est?.climate.heatingDesign ?? -4;
  const inside = est?.climate.indoorWinter ?? 21;
  const thermal = uses(doc);
  const library = addLibraryValues(doc);
  const f = a.framing?.fraction ?? 0;
  const mats = materialsOf(doc);
  const ownFraming = (doc.types?.[id] as { extensions?: Record<string, { framing?: { material: string; fraction: number } }> } | undefined)?.extensions?.[FS_THERMAL]?.framing;
  return (
    <Section title="Thermal · layer by layer">
      <div className="fs-envelope" data-region="wall-type-thermal">
        <Chips items={[a.rEffective === null ? 'R not known' : `${rIn(a.rEffective, units)} effective`, ...(a.u === null ? [] : [uIn(a.u, units)]), ...(a.framing ? [`framing ${String(Math.round(f * 100))}%`] : []), `${String(users)} ${users === 1 ? 'wall' : 'walls'}`]} />
        <SectionDrawing a={a} model={model} outside={outside} inside={inside} units={units} />
        <span className="fs-overline">Layers · outside in</span>
        <ol className="fs-envelope__layers" aria-label={`Layers of ${labelOf(model, id)}, outside in`}>
          {a.layers.map((l) => (
            <li key={l.index} className="fs-envelope__layer">
              <span className="fs-envelope__layer-swatch" style={{ background: (l.material === undefined ? undefined : mats[l.material]?.color) ?? 'var(--color-fill-quiet)' }} aria-hidden="true" />
              <span className="fs-envelope__layer-name">
                {l.materialName ?? `${l.function}, no material`}
                {l.source === 'library' ? <span className="fs-envelope__tag"> · library</span> : null}
              </span>
              <span className="fs-envelope__layer-t">{formatLen(l.thickness, units)}</span>
              <span className="fs-envelope__layer-r">{l.r === null ? 'R ?' : rIn(l.r, units)}</span>
            </li>
          ))}
        </ol>
        <span className="fs-overline">Assembly · parallel paths</span>
        {a.rClear === null ? (
          <p className="fs-note">A layer has no thermal value: give its material a conductivity or a resistance.</p>
        ) : (
          <>
            <Line label={`Through the cavity · ${String(Math.round((1 - f) * 100))}%`} value={rIn(a.rClear + a.films.inside + a.films.outside, units)} />
            {a.framing && a.rFramed !== null ? <Line label={`Through the framing · ${String(Math.round(f * 100))}%`} value={rIn(a.rFramed + a.films.inside + a.films.outside, units)} /> : null}
            {a.rEffective !== null && a.u !== null ? <Line label="Effective, with air films" value={`${rIn(a.rEffective, units)} · ${uIn(a.u, units)}`} strong testId="wall-type-effective" /> : null}
            {a.heatCapacity === null ? null : <Line label="Thermal mass" value={units === 'imperial' ? `≈ ${String(Math.round((a.heatCapacity / HEAT_CAPACITY_IP) * 10) / 10)} Btu/ft²·°F` : `≈ ${String(Math.round(a.heatCapacity / 1000))} kJ/m²·K`} />}
          </>
        )}
        <p className="fs-note">
          {a.method}.{a.framing ? ` Framing: ${a.framing.text}.` : ''} Conductivity, density and heat capacity come from each material{a.fromDocument ? '' : ', or the CC0 thermal library where a material states none'}, cited on the material. For comparing assemblies — never a code check.
        </p>
        {!readOnly ? (
          <Row label="Framing">
            <TextField
              label="Framing, % of the wall"
              value={ownFraming === undefined ? '' : String(ownFraming.fraction / 10)}
              placeholder={a.framing ? `${String(Math.round(f * 100))} (${a.framing.source})` : 'none'}
              onCommit={(v) => {
                const n = Number.parseFloat(v);
                if (v.trim() === '') {
                  if (ownFraming !== undefined) edit(`Unset the framing of ${labelOf(model, id)}`, unsetProperty(id, `/extensions/${FS_THERMAL}/framing`));
                  return;
                }
                if (!Number.isFinite(n) || n <= 0 || n > 100) return;
                const material = ownFraming?.material ?? Object.keys(mats).find((m) => thermalMatch(m, mats[m])?.category === 'framing' || m === 'wood-stud-framing') ;
                if (material === undefined) return;
                edit(`Set the framing of ${labelOf(model, id)}`, [...declare(doc), ...setProperty(id, `/extensions/${FS_THERMAL}/framing`, { material, fraction: Math.round(n * 10) })]);
              }}
            />
          </Row>
        ) : null}
        <TryLayer a={a} units={units} trial={trial} setTrial={setTrial} compare={compare} readOnly={readOnly} onApply={(batch) => { edit(`Try another material in ${labelOf(model, id)}`, batch); setTrial(null); }} />
        {!thermal && !readOnly && library.length > 0 ? (
          <div className="fs-envelope__offer">
            <p className="fs-note">This plan does not use FS_thermal yet: the energy estimate takes its climate zone's typical values. Add the library's typical values to its materials to use its own assemblies.</p>
            <Button size="sm" variant="secondary" onClick={() => { edit('Add thermal values from the library', library); }}>
              Add thermal values
            </Button>
          </div>
        ) : null}
        <Button size="sm" variant="secondary" onClick={() => { openEnergy(store); }}>
          Heat loss by room…
        </Button>
      </div>
    </Section>
  );
}

/** What another library material in a layer would do: the assembly's R and U, and the house's heating load. */
interface Trial {
  readonly before: { r: number | null; u: number | null; heating: number | null };
  readonly after: { r: number | null; u: number | null; heating: number | null };
  readonly batch: Batch;
}

function tryLayer(model: EditorModel, typeId: string, layer: number, itemId: string): Trial | null {
  const item = THERMAL_LIBRARY.find((i) => i.id === itemId);
  const doc = model.document;
  const t = doc.types?.[typeId] as { layers?: { material?: string }[] } | undefined;
  if (item === undefined || t?.layers?.[layer] === undefined) return null;
  const mats = materialsOf(doc);
  const existing = Object.keys(mats).find((m) => thermalMatch(m, mats[m])?.id === item.id);
  const material = existing ?? `thermal-${item.id}`;
  const add: Batch = existing !== undefined ? [] : [{ op: 'addElement', collection: 'materials', id: material, element: { name: item.name, extensions: { [FS_THERMAL]: thermalData(item) } } }];
  const batch: Batch = [...declare(doc), ...add, ...setProperty(typeId, `/layers/${String(layer)}/material`, material)];
  const after = structuredClone(doc) as FloorspecDocument & { types: Record<string, { layers: { material?: string }[] }>; materials?: Record<string, unknown> };
  after.materials = { ...(after.materials ?? {}), ...(existing === undefined ? { [material]: { name: item.name, extensions: { [FS_THERMAL]: thermalData(item) } } } : {}) };
  const target = after.types[typeId]?.layers[layer];
  if (target === undefined) return null;
  target.material = material;
  after.extensionsUsed = { ...(after.extensionsUsed ?? {}), [FS_THERMAL]: '0.1.0' };
  const one = (d: FloorspecDocument) => {
    const a = wallTypeThermal(thermalView(d), typeId);
    let heating: number | null;
    try {
      heating = estimateEnergy(d, { design: model.design, compare: false }).loads.heating;
    } catch {
      heating = null;
    }
    return { r: a?.rEffective ?? null, u: a?.u ?? null, heating };
  };
  const before = uses(doc) ? one(doc) : one({ ...doc, extensionsUsed: { ...(doc.extensionsUsed ?? {}), [FS_THERMAL]: '0.1.0' } });
  return { before, after: one(after), batch };
}

function TryLayer({ a, units, trial, setTrial, compare, readOnly, onApply }: { a: AssemblyThermal; units: UnitSystem; trial: { layer: number; item: string } | null; setTrial: (t: { layer: number; item: string } | null) => void; compare: Trial | null; readOnly: boolean; onApply: (batch: Batch) => void }) {
  const layer = trial?.layer ?? a.layers.findIndex((l) => l.function === 'finish');
  const fn = a.layers[layer]?.function ?? 'finish';
  const items = THERMAL_LIBRARY.filter((i) => (CHOICES[fn] ?? []).includes(i.category));
  const h = (w: number | null) => (w === null ? '—' : `${loadRange(w, units).text} ${loadRange(w, units).unit}`);
  return (
    <div className="fs-envelope__try" data-region="try-layer">
      <span className="fs-overline">Compare · another material in a layer</span>
      <Row label="Layer">
        <Select
          aria-label="Layer to try"
          appearance="filled"
          size="sm"
          options={a.layers.map((l) => ({ value: String(l.index), label: `${String(l.index + 1)} · ${l.materialName ?? l.function}` }))}
          value={String(Math.max(0, layer))}
          onValueChange={(v) => { setTrial({ layer: Number(v), item: trial?.item ?? '' }); }}
        />
      </Row>
      <Row label="Instead">
        <Select
          aria-label="Material to try"
          appearance="filled"
          size="sm"
          options={[{ value: '', label: 'Choose a material' }, ...items.map((i) => ({ value: i.id, label: i.name }))]}
          value={trial?.item ?? ''}
          onValueChange={(v) => { setTrial(v === '' ? null : { layer: Math.max(0, layer), item: v }); }}
        />
      </Row>
      {compare === null ? null : (
        <div className="fs-envelope__compare" role="status" aria-live="polite">
          <Line label="This wall" value={`${compare.before.r === null ? '?' : rIn(compare.before.r, units)} → ${compare.after.r === null ? '?' : rIn(compare.after.r, units)}`} strong />
          <Line label="The house, heating" value={`${h(compare.before.heating)} → ${h(compare.after.heating)}`} />
          <p className="fs-note">Advisory, ±20%: a comparison of two choices, the rest of the house unchanged.</p>
          {!readOnly ? (
            <Button size="sm" variant="secondary" onClick={() => { onApply(compare.batch); }}>
              Use it
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Go to the energy screen's room table. */
function openEnergy(store: EditorStore): void {
  window.location.assign(`/projects/${store.projectId}/energy#heat-loss-by-room`);
}

// ─── A room's loads ──────────────────────────────────────────────────────────────────────────

const partValue = (p: LoadPart, units: UnitSystem): string => {
  if (p.value === undefined) return '';
  if (p.kind === 'air') return ` · ${String(Math.round(p.value * 100) / 100)} ACH`;
  if (p.kind === 'slab') return '';
  if (p.kind === 'windows' || p.kind === 'doors') return ` · ${uIn(p.value, units)}`;
  return ` · ${rIn(1 / p.value, units)}`;
};
const partArea = (p: LoadPart, units: UnitSystem): string =>
  p.kind === 'windows' || p.kind === 'doors' ? ` · ${units === 'imperial' ? `${String(Math.round(p.quantity * 10.76391))} ft²` : `${String(Math.round(p.quantity * 10) / 10)} m²`}` : '';

function Parts({ parts, units, total, label, testId }: { parts: readonly LoadPart[]; units: UnitSystem; total: number; label: string; testId: string }) {
  return (
    <>
      <div className="fs-envelope__bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${String(Math.round((p.watts / Math.max(1e-9, total)) * 100))}%`).join(', ')}`}>
        {parts.map((p) => (
          <span key={p.kind} className={`fs-envelope__bar-part fs-envelope__bar-part--${p.kind}`} style={{ flexGrow: p.watts }} />
        ))}
      </div>
      {parts.map((p) => (
        <Line key={p.kind} label={`${p.label}${partArea(p, units)}${partValue(p, units)}`} value={wattsRange(p.watts, units)} />
      ))}
      <Line label={label} value={wattsRange(total, units)} strong testId={testId} />
    </>
  );
}

export function RoomHeatLossSection({ store, room, units }: { store: EditorStore; room: string; units: UnitSystem }) {
  const env = useEnvelopeEstimate(store);
  if (env === null || env.status !== 'ok') return null;
  const e = env.estimate;
  const r = e.rooms.find((x) => x.room === room);
  if (r === undefined) return null;
  return (
    <Section title="Heat loss and gain">
      <div className="fs-envelope" data-region="room-heat-loss">
        <p className="fs-envelope__sub">{e.climate.station ? `${e.climate.station.city.replace(/,.*/, '')}, zone ${e.climate.zone}` : e.climate.label}</p>
        <Chips items={roomChips(r, units)} />
        <span className="fs-overline">Heating · design day, {temperature(e.climate.heatingDesign, units)}</span>
        <Parts parts={r.heatingParts} units={units} total={r.heating} label="Heating, this room" testId="room-heating" />
        <span className="fs-overline">Cooling · Jul 21, {hourText(r.coolingHour)}</span>
        <Parts parts={r.coolingParts} units={units} total={r.cooling} label="Cooling, this room" testId="room-cooling" />
        <p className="fs-note">{ROOM_METHOD} {e.thermal ? 'From the plan’s own assemblies (FS_thermal).' : 'From the climate zone’s typical assemblies: the plan states none.'} Advisory: an estimate to compare options, not a sizing report.</p>
        <Button size="sm" variant="secondary" onClick={() => { threeOf(store).setMode('3d'); envelopeOf(store).toggle(true); }}>
          See the heat-loss map in 3D
        </Button>
      </div>
    </Section>
  );
}

function roomChips(r: RoomLoad, units: UnitSystem): string[] {
  const area = units === 'imperial' ? `${String(Math.round(r.area * 10.76391))} ft²` : `${String(Math.round(r.area * 10) / 10)} m²`;
  return [area, `${String(r.exteriorWalls)} exterior wall${r.exteriorWalls === 1 ? '' : 's'}`, ...(r.westGlass > 0.5 ? ['west glass'] : []), 'Estimate'];
}

// ─── A material's and a door's or window's values ───────────────────────────────────────────

const FIELDS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'conductivity', label: 'Conductivity', hint: 'mW/(m·K)' },
  { key: 'resistance', label: 'Resistance (air space, membrane)', hint: 'thousandths of m²·K/W' },
  { key: 'density', label: 'Density', hint: 'kg/m³' },
  { key: 'specificHeat', label: 'Specific heat', hint: 'J/(kg·K)' },
];

const libraryValue = (item: ThermalLibraryItem | undefined, key: string): string => {
  const v = item === undefined ? undefined : thermalData(item)[key];
  return typeof v === 'number' ? String(v) : 'not stated';
};

/** A material's FS_thermal values: each a whole number in FS_thermal's units, and the library's to start from. */
export function MaterialThermalSection({ model, id, readOnly, edit }: { model: EditorModel; id: string; readOnly: boolean; edit: Edit }) {
  const doc = model.document;
  const m = materialsOf(doc)[id];
  const own = (m?.extensions?.[FS_THERMAL] ?? {}) as Record<string, number | string>;
  const item = thermalMatch(id, m);
  const set = (key: string, v: string) => {
    if (v.trim() === '') {
      if (own[key] !== undefined) edit(`Unset ${key} of ${labelOf(model, id)}`, unsetProperty(id, `/extensions/${FS_THERMAL}/${key}`));
      return;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return;
    const clash = key === 'conductivity' ? 'resistance' : key === 'resistance' ? 'conductivity' : null;
    edit(`Set ${key} of ${labelOf(model, id)}`, [...declare(doc), ...(clash !== null && own[clash] !== undefined ? unsetProperty(id, `/extensions/${FS_THERMAL}/${clash}`) : []), ...setProperty(id, `/extensions/${FS_THERMAL}/${key}`, n)]);
  };
  return (
    <Section title="Thermal">
      <div className="fs-envelope" data-region="material-thermal">
        {FIELDS.map((f) => (
          <TextField key={f.key} label={`${f.label}, ${f.hint}`} value={own[f.key] === undefined ? '' : String(own[f.key])} placeholder={libraryValue(item, f.key)} disabled={readOnly} onCommit={(v) => { set(f.key, v); }} />
        ))}
        <p className="fs-note">{typeof own['citation'] === 'string' ? own['citation'] : item === undefined ? 'No thermal values: the estimate cannot use this material in an assembly.' : `The library's typical values for ${item.name} are shown greyed; the estimate uses them where the plan states none.`}</p>
        {!readOnly && item !== undefined && own['conductivity'] === undefined && own['resistance'] === undefined ? (
          <Button size="sm" variant="secondary" onClick={() => { edit(`Add thermal values to ${labelOf(model, id)}`, [...declare(doc), ...setProperty(id, `/extensions/${FS_THERMAL}`, { ...thermalData(item), ...own })]); }}>
            Use the library's values
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

/** A door's or a window's whole-unit rating (FS_thermal 2.5), as its maker states it. */
export function UnitThermalSection({ model, id, readOnly, edit, units }: { model: EditorModel; id: string; readOnly: boolean; edit: Edit; units: UnitSystem }) {
  const doc = model.document;
  const t = doc.types?.[id] as { kind: string; extensions?: Record<string, { uFactor?: number; shgc?: number }> } | undefined;
  const own = t?.extensions?.[FS_THERMAL] ?? {};
  const window = t?.kind === 'windowType';
  const setU = (v: string) => {
    if (v.trim() === '') {
      if (own.uFactor !== undefined) edit(`Unset the U-factor of ${labelOf(model, id)}`, unsetProperty(id, `/extensions/${FS_THERMAL}/uFactor`));
      return;
    }
    const x = Number.parseFloat(v);
    if (!Number.isFinite(x) || x <= 0) return;
    // Imperial: U in Btu/(h·ft²·°F); metric: W/(m²·K). Stored in mW/(m²·K).
    const si = units === 'imperial' ? x * 5.678263 : x;
    edit(`Set the U-factor of ${labelOf(model, id)}`, [...declare(doc), ...setProperty(id, `/extensions/${FS_THERMAL}/uFactor`, Math.round(si * 1000))]);
  };
  const setShgc = (v: string) => {
    if (v.trim() === '') {
      if (own.shgc !== undefined) edit(`Unset the SHGC of ${labelOf(model, id)}`, unsetProperty(id, `/extensions/${FS_THERMAL}/shgc`));
      return;
    }
    const x = Number.parseFloat(v);
    if (!Number.isFinite(x) || x < 0 || x > 1) return;
    edit(`Set the SHGC of ${labelOf(model, id)}`, [...declare(doc), ...setProperty(id, `/extensions/${FS_THERMAL}/shgc`, Math.round(x * 1000))]);
  };
  const uShown = own.uFactor === undefined ? '' : units === 'imperial' ? (own.uFactor / 1000 / 5.678263).toFixed(2) : (own.uFactor / 1000).toFixed(2);
  return (
    <Section title="Thermal rating">
      <TextField label={units === 'imperial' ? 'U-factor, Btu/h·ft²·°F' : 'U-factor, W/m²·K'} value={uShown} placeholder="not rated" disabled={readOnly} onCommit={setU} />
      {window || own.shgc !== undefined ? <TextField label="Solar heat gain coefficient" value={own.shgc === undefined ? '' : (own.shgc / 1000).toFixed(2)} placeholder="not rated" disabled={readOnly} onCommit={setShgc} /> : null}
      <p className="fs-note">The whole unit's rating, as its maker states it (NFRC in North America): frame, glass and edge together. Unrated, the estimate takes the climate zone's typical value.</p>
    </Section>
  );
}

// ─── The heat-loss map: its button and its panel ────────────────────────────────────────────

export function HeatLossButton({ store, disabled }: { store: EditorStore; disabled: boolean }) {
  const on = useEnvelope(store, (s) => s.on);
  return (
    <Tooltip content={on ? 'Hide the heat-loss map' : 'Heat-loss map: every surface coloured by the heat it loses on the design day'}>
      <IconButton label="Heat-loss map" icon={<Flame />} size="sm" pressed={on} disabled={disabled} onClick={() => { envelopeOf(store).toggle(); }} />
    </Tooltip>
  );
}

const SHARE_LABEL: Record<string, string> = { windows: 'Windows', air: 'Air leakage', walls: 'Walls', slab: 'Slab edge', ceiling: 'Ceiling', floor: 'Floors', doors: 'Doors' };

export function HeatLossPanel({ store }: { store: EditorStore }) {
  const open = useEnvelope(store, (s) => s.open);
  const on = useEnvelope(store, (s) => s.on);
  const other = useThreeState(store, (s) => s.cameraOpen || s.lightingOpen || s.sectionOpen || s.xray.on || s.compare.open);
  const env = useEnvelopeEstimate(store);
  const units = store.units;
  const title = useId();
  if (!on) return null;
  const e: EnergyEstimate | null = env?.status === 'ok' ? env.estimate : null;
  const close = () => { envelopeOf(store).toggle(false); };
  if (!open || other) {
    return (
      <div className="fs-envelope__float-legend">
        <LossLegend title={`Heat loss · ${units === 'imperial' ? 'Btu/h per ft²' : 'W/m²'} of surface`} ranges={surfaceRanges(units)} />
      </div>
    );
  }
  return (
    <section className="fs-sun fs-envelope__panel" aria-labelledby={title} data-region="heat-loss-panel" onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } ev.stopPropagation(); }}>
      <header className="fs-sun__head">
        <Thermometer aria-hidden="true" />
        <h2 className="fs-sun__title" id={title}>
          Heat-loss map
        </h2>
        <IconButton label="Close the heat-loss map" icon={<X />} size="sm" onClick={close} />
      </header>
      {e === null ? (
        <p className="fs-note">{env?.status === 'none' ? env.message : 'Working out the estimate…'}</p>
      ) : (
        <div className="fs-envelope">
          <p className="fs-envelope__sub">Whole house · {e.climate.station ? `${e.climate.station.city.replace(/,.*/, '')}, zone ${e.climate.zone}` : e.climate.label}</p>
          <span className="fs-overline">Share of the heating load</span>
          {e.shares.map((s) => (
            <Line key={s.kind} label={SHARE_LABEL[s.kind] ?? s.kind} value={`${String(Math.round(s.share * 100))}%`} />
          ))}
          <span className="fs-overline">Whole house · estimate ±20%</span>
          <Line label="Heating design load" value={`${loadRange(e.loads.heating, units).text} ${loadRange(e.loads.heating, units).unit}`} strong testId="house-heating" />
          <Line label="Cooling design load" value={`${loadRange(e.loads.cooling, units).text} ${loadRange(e.loads.cooling, units).unit}`} />
          <Line label="Heating, a year" value={`${range(e.loads.annualHeating / 1000).text} MWh of heat`} />
          <span className="fs-overline">Climate</span>
          <Line label={e.climate.station?.city ?? `Zone ${e.climate.zone}`} value={`${temperature(e.climate.heatingDesign, units)} / ${temperature(e.climate.coolingDesign, units)} design`} />
          <LossLegend title={`Heat loss · ${units === 'imperial' ? 'Btu/h per ft²' : 'W/m²'} of surface`} ranges={surfaceRanges(units)} note={`Design day, ${temperature(e.climate.heatingDesign, units)} out, ${temperature(e.climate.indoorWinter, units)} in. Advisory.`} />
          <p className="fs-note">Each surface takes its assembly’s U × the temperature difference. Rooms’ loads are in each room’s inspector and on the energy screen.</p>
        </div>
      )}
    </section>
  );
}

/** The room legend, for the energy screen and the plan. */
export function RoomLegend({ units }: { units: UnitSystem }) {
  return <LossLegend title={`Heat loss · ${units === 'imperial' ? 'Btu/h per ft²' : 'W/m²'} of floor`} ranges={roomRanges(units)} note="Advisory — a room-by-room estimate (Manual J-style), not a sizing report." />;
}

export { envelopeEstimate, perAreaText };
