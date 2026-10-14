import { SegmentedControl } from '@d3cloud/ui';
import { useEditor, type EditorStore } from '../store';
import { labelOf } from '../model';
import { LengthField, Row, Section } from '../fields';
import { DIM_REF_LABELS, DIM_REFS, precisionOf, usePrecision, type DimRef } from './state';
import { useTempDims } from './Overlay';

/**
 * The inspector's half of the temporary dimensions (FLR-T-18.9), after the board's "Position on W12":
 * the same distances the plan shows, as fields — the keyboard's way to them — and what they measure
 * to (Face, Centre, Other face), the Tab of the plan's fields. A value typed here is the same one
 * batch as one typed on the plan.
 */
export function PositionSection({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  const levelId = useEditor(store, (s) => s.level);
  const level = model?.levels.find((l) => l.id === levelId);
  const temp = useTempDims(store, level, model);
  const ref = usePrecision(store, (p) => p.ref);
  const readOnly = useEditor(store, (s) => s.readOnly !== null);
  const units = useEditor(store, () => store.units);
  if (temp === null || model === null) return null;
  const host = model.document.openings?.[temp.id]?.wall;
  const title = typeof host === 'string' ? `Position on ${labelOf(model, host)}` : 'Distances to neighbours';
  return (
    <Section title={title}>
      {temp.dims.map((d) => (
        <LengthField
          key={d.key}
          label={d.label}
          value={Math.round(d.value)}
          units={units}
          nonNegative
          disabled={readOnly || d.apply === undefined}
          hint={`To ${d.to}`}
          onCommit={(v) => {
            if (v === null || d.apply === undefined) return;
            const r = d.apply(v);
            if ('error' in r) store.set({ notice: { tone: 'info', text: r.error } });
            else void store.apply(r.label, r.batch, { select: () => temp.id });
          }}
        />
      ))}
      <Row label="Measured to">
        <SegmentedControl
          aria-label="Measured to"
          size="sm"
          value={ref}
          items={DIM_REFS.map((r) => ({ value: r, label: DIM_REF_LABELS[r] }))}
          onValueChange={(v) => { precisionOf(store).set({ ref: v as DimRef }); }}
        />
      </Row>
    </Section>
  );
}
