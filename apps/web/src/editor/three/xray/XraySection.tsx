import { useEditor, type EditorStore } from '../../store';
import { prettyLen, type UnitSystem } from '../../units';
import { Section } from '../../fields';
import type { EditorModel, Kind } from '../../model';
import { useThreeState } from '../mode';
import { planOf } from './xray';
import type { XrayWall } from '@floorspec/mesh';
import './xray.css';

/**
 * The inspector's X-ray section (FLR-T-14.5, the right column of the board's "14.5 · X-ray" frame):
 * with X-ray on and a wall selected, its layers to scale from its exterior (left) face in, each in its
 * material's colour, and what X-ray finds in it — its studs, the pipes and circuits that run in it, its
 * thickness.
 */

const FUNCTION_LABELS: Readonly<Record<string, string>> = {
  core: 'Core',
  substrate: 'Substrate',
  insulation: 'Insulation',
  membrane: 'Membrane',
  airGap: 'Air gap',
  finish: 'Finish',
};

/** A layer's colour: its material's, as the document records it (the house's own colour, not the editor's). */
function layerColour(model: EditorModel, material: string | undefined): string | undefined {
  return material === undefined ? undefined : model.document.materials?.[material]?.color;
}

function layerName(model: EditorModel, l: XrayWall['layers'][number]): string {
  const m = l.material === undefined ? undefined : model.document.materials?.[l.material]?.name;
  return m ?? FUNCTION_LABELS[l.function] ?? l.function;
}

function coreNote(w: XrayWall, units: UnitSystem): string | null {
  const f = w.framing;
  if (f.system === 'solid') return 'solid';
  if (f.system !== 'studs' || f.member === undefined || f.spacing === undefined) return null;
  const member = f.member.designation ?? `${prettyLen(f.member.width, units)} studs`;
  return `${member} @ ${prettyLen(f.spacing, units)}${w.insulated ? ' + batts' : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

export function XraySection({ store, id, kind }: { store: EditorStore; id: string; kind: Kind }) {
  const on = useThreeState(store, (s) => s.xray.on && s.mode !== 'plan');
  const model = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  if (!on || kind !== 'wall' || model === null || model.derived === null) return null;
  const w = planOf(model.view, model.derived).walls[id];
  if (w === undefined) return null;
  const studs = w.studs + w.kings + w.jacks + w.cripples;
  const framed = w.openings.length === 0 ? '' : ` · king, jack and cripple studs at ${plural(w.openings.length, 'opening')}`;
  const devices = w.devices.length === 0 ? null : plural(w.devices.length, 'device');
  const circuits = w.circuits;
  return (
    <Section title="X-ray · layers, outside → inside">
      <div className="fs-xray-layers__bar" role="img" aria-label={`Layers to scale: ${w.layers.map((l) => `${layerName(model, l)} ${prettyLen(l.thickness, units)}`).join(', ')}`}>
        {w.layers.map((l, i) => (
          <span key={i} style={{ flexGrow: l.thickness, background: layerColour(model, l.material) ?? 'var(--color-fill-quiet)' }} />
        ))}
      </div>
      <ul className="fs-xray-layers__list">
        {w.layers.map((l, i) => {
          const note = l.function === 'core' ? coreNote(w, units) : null;
          return (
            <li key={i}>
              <span className="fs-xray-layers__chip" style={{ background: layerColour(model, l.material) ?? 'var(--color-fill-quiet)' }} aria-hidden="true" />
              <span>{layerName(model, l)}{note === null ? '' : ` · ${note}`}</span>
              <span className="fs-spacer" />
              <span className="fs-mono-small">{prettyLen(l.thickness, units)}</span>
            </li>
          );
        })}
      </ul>
      <dl className="fs-xray-layers__in" aria-label="In this wall">
        <dt>Studs</dt>
        <dd>{w.framing.system === 'studs' ? `${String(studs)}${framed}` : w.framing.system === 'solid' ? 'a solid core' : 'not framed (an arc wall)'}</dd>
        <dt>Insulation</dt>
        <dd>{w.insulated ? plural(w.batts, 'batt') : 'none in the core'}</dd>
        <dt>Plumbing</dt>
        <dd>{w.supply.length + w.drain.length + w.vent.length === 0 ? 'none' : `${String(w.supply.length)} supply · ${String(w.drain.length)} drain · ${String(w.vent.length)} vent`}</dd>
        <dt>Electrical</dt>
        <dd>{circuits.length === 0 ? 'none' : `${devices === null ? '' : `${devices} · `}${plural(circuits.length, 'circuit')} (${circuits.join(', ')})`}</dd>
        {w.ducts.length > 0 ? (
          <>
            <dt>Ducts</dt>
            <dd>{plural(w.ducts.length, 'run')}</dd>
          </>
        ) : null}
        <dt>Total</dt>
        <dd className="fs-mono-small">{prettyLen(w.thickness, units)}</dd>
      </dl>
    </Section>
  );
}
