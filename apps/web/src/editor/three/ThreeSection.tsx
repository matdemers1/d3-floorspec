import { Button, Select } from '@d3cloud/ui';
import { Footprints } from 'lucide-react';
import { useEditor, type EditorStore } from '../store';
import { elementOf, levelOfElement, type Kind } from '../model';
import { formatLen } from '../units';
import { EYE_HEIGHTS, threeOf, useThreeState } from './mode';
import { Row, Section } from '../fields';
import { ShadowsRow } from './sun/SunPanel';

/**
 * The inspector's "3D" section (the board's 08 frames), shown while a 3D view is open: what the 3D
 * view is showing, the walkthrough's eye height, and "Walk through from here" for an element a
 * person can stand at — a room (at its anchor) or a door (just inside it).
 */

const UNITS = 1_280_000;

export function ThreeSection({ store, id, kind }: { store: EditorStore; id: string; kind: Kind }) {
  const mode = useThreeState(store, (s) => s.mode);
  const cutaway = useThreeState(store, (s) => s.cutaway);
  const eye = useThreeState(store, (s) => s.eyeHeight);
  const model = useEditor(store, (s) => s.model);
  const levelName = useEditor(store, (s) => s.model?.levels.find((l) => l.id === s.level)?.name ?? null);
  const units = useEditor(store, () => store.units);
  if (mode === 'plan' || model === null) return null;
  const from = walkPoint(store, id, kind);
  const label = (m: number) => `${formatLen(Math.round(m * UNITS), units)}${m === 1.6 ? ' (default)' : ''}`;
  return (
    <Section title="3D">
      <Row label="Showing">
        <span className="fs-three-section__value">{cutaway ? `${levelName ?? 'This level'} and below, cut away` : 'The whole house'}</span>
      </Row>
      <ShadowsRow store={store} />
      <Row label="Eye height" htmlFor="fs-eye-height">
        <Select
          id="fs-eye-height"
          aria-label="Eye height"
          options={EYE_HEIGHTS.map((m) => ({ value: String(m), label: label(m) }))}
          value={String(eye)}
          onValueChange={(v) => { threeOf(store).setEyeHeight(Number(v)); }}
        />
      </Row>
      {from !== null ? (
        <Button className="fs-three-section__walk" variant="secondary" size="sm" icon={<Footprints />} onClick={() => { threeOf(store).walk(from); }}>
          Walk through from here
        </Button>
      ) : null}
      <p className="fs-note">3D is derived from the same model — select here, edit in the plan or the inspector. Meshes are property-tested, not normative.</p>
    </Section>
  );
}

function walkPoint(store: EditorStore, id: string, kind: Kind) {
  const model = store.get().model;
  if (model === null) return null;
  const level = levelOfElement(model, id) ?? null;
  if (kind === 'room') {
    const anchor = elementOf(model, id)?.['anchor'] as [number, number] | undefined;
    return anchor === undefined ? null : { x: anchor[0], y: anchor[1], yaw: null, level };
  }
  if (kind === 'opening') {
    const view = model.levels.flatMap((l) => l.openings).find((o) => o.id === id);
    if (view === undefined || view.kind !== 'door') return null;
    return { x: (view.start[0] + view.end[0]) / 2, y: (view.start[1] + view.end[1]) / 2, yaw: null, level };
  }
  return null;
}
