import { Button, IconButton, Select } from '@d3cloud/ui';
import { DoorOpen, Fence, X } from 'lucide-react';
import { outdoor, type DerivedOutdoor } from '@floorspec/engine';
import type { EditorStore } from '../store';
import type { EditorModel } from '../model';
import { prettyLen, type UnitSystem } from '../units';
import { LengthField, ReadOnlyField, Row, Section } from '../fields';
import type { SystemsCtx } from '../systems/Panels';
import { labelOf } from '../model';
import { FENCE_STYLES, fenceStyle, gateAt, gatesOf, setGates } from './ops';
import { outdoorOf, useOutdoor } from './state';

/**
 * FS_outdoor in the inspector (FLR-T-15.2): the fence tool's panel — the style the next fence is drawn
 * in — and, for a selected outdoor room, what is derived from it (a pool's water, a fence's posts, a
 * shelter's posts) with a fence's gates to add and edit. Safety stays advisory: a pool barrier or a
 * fence's height is a rule pack's finding, never this panel's (FLR-ADR-011).
 */

const BARRIER = 'A pool barrier is a rule for a rules pack — nothing here checks one, and nothing here says “compliant”.';

export function FencePanel({ store, readOnly }: { store: EditorStore; readOnly: boolean }) {
  const styleId = useOutdoor(store, (s) => s.fenceStyle);
  const style = fenceStyle(styleId);
  const units = store.units;
  return (
    <div className="fs-inspector__body" data-testid="fence-panel">
      <Section title="Fence · drawing" aside={<Fence aria-hidden="true" size={16} />}>
        <Row label="Style">
          <Select
            aria-label="Fence style"
            appearance="filled"
            options={FENCE_STYLES.map((s) => ({ value: s.id, label: s.name }))}
            value={style.id}
            disabled={readOnly}
            onValueChange={(v) => { outdoorOf(store).set({ fenceStyle: v }); }}
          />
        </Row>
        <ReadOnlyField label="Height" value={prettyLen(style.height, units)} />
        <ReadOnlyField label="Post spacing" value={`${prettyLen(Number(style.members['postSpacing']), units)} o.c. at most`} />
        <p className="fs-note">Click the fence’s points as a wall is drawn; double-click or press Enter to finish. A gate is an opening in its line: add one from the fence’s inspector — it snaps to where a path crosses.</p>
        <p className="fs-note">{BARRIER}</p>
      </Section>
    </div>
  );
}

const gallons = (volume: string): number => Number(BigInt(volume) / 1_280n ** 3n) / 1e6 / 3.785411784;

/** A selected FS_outdoor element: what is derived from it, and a fence's gates. */
export function OutdoorSection({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, element, readOnly, units } = ctx;
  const at = model.ext.get(id);
  if (at === undefined || at.extension !== 'FS_outdoor') return null;
  const derived = (model.derived?.extensions as { FS_outdoor?: DerivedOutdoor } | undefined)?.FS_outdoor;
  const len = (v: number) => prettyLen(v, units);
  if (at.collection === 'pools') {
    const p = derived?.pools[id];
    return (
      <Section title="Water">
        {p === undefined ? null : (
          <>
            <ReadOnlyField label="Basin" value={`${len(p.basin[1])} × ${len(p.basin[0])}`} />
            <ReadOnlyField label="Water depth" value={len(p.depth)} />
            <ReadOnlyField label="Volume" value={`≈ ${Math.round(gallons(p.volume)).toLocaleString('en-US')} gal (an estimate)`} />
          </>
        )}
        <p className="fs-note">The coping and the water line are its members below; the basin is its box less the coping. {BARRIER}</p>
      </Section>
    );
  }
  if (at.collection === 'shelters') {
    const s = derived?.shelters[id];
    return s === undefined ? null : (
      <Section title="Structure">
        <ReadOnlyField label="Posts" value={`${String(s.posts)} · ${String(s.bays[0])} × ${String(s.bays[1])} bays`} />
        <ReadOnlyField label="Post spacing" value={`${len(s.spacing[0])} × ${len(s.spacing[1])} o.c.`} />
        <p className="fs-note">A covered porch is the same element with a solid top; a shade sail is fabric between its posts. Drag a handle to stretch it: posts are re-spaced, never stretched.</p>
      </Section>
    );
  }
  if (at.collection !== 'fences') return null;
  const f = derived?.fences[id];
  const gates = gatesOf(element);
  const name = labelOf(model, id);
  const edit = (label: string, next: readonly outdoor.Gate[]) => { ctx.edit(`${label} ${name}`, setGates(id, element, next)); };
  const add = () => {
    const g = gateAt(model.document, element);
    if (g === null) {
      ctx.store.set({ notice: { tone: 'info', text: 'There is no room left on this fence for a gate.' } });
      return;
    }
    edit('Add a gate to', [...gates, { offset: g.offset, width: g.width, swing: 'left' }]);
  };
  return (
    <Section
      title="Fence"
      aside={readOnly ? null : (
        <Button size="sm" variant="secondary" data-testid="add-gate" onClick={add}>
          <DoorOpen aria-hidden="true" size={14} /> Add gate
        </Button>
      )}
    >
      {f === undefined ? null : (
        <>
          <ReadOnlyField label="Length" value={len(f.length)} />
          <ReadOnlyField label="Posts" value={String(f.posts)} />
        </>
      )}
      {gates.map((g, i) => (
        <div key={i} className="fs-outdoor__gate" data-testid={`gate-${String(i)}`}>
          <Row label={g.name ?? `Gate ${String(i + 1)}`}>
            {readOnly ? null : (
              <IconButton label={`Remove gate ${String(i + 1)}`} icon={<X />} size="sm" onClick={() => { edit('Remove a gate from', gates.filter((_, k) => k !== i)); }} />
            )}
          </Row>
          <LengthField label="Along the line" value={g.offset} units={units} nonNegative disabled={readOnly} onCommit={(v) => { if (v !== null) edit('Move a gate of', gates.map((x, k) => (k === i ? { ...x, offset: v } : x))); }} />
          <LengthField label="Width" value={g.width} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) edit('Resize a gate of', gates.map((x, k) => (k === i ? { ...x, width: v } : x))); }} />
          <Row label="Swing">
            <Select
              aria-label="Gate swing"
              appearance="filled"
              options={[{ value: 'left', label: 'Left of the line' }, { value: 'right', label: 'Right of the line' }, { value: 'slide', label: 'Slides' }]}
              value={g.swing ?? 'left'}
              disabled={readOnly}
              onValueChange={(v) => { edit('Swing a gate of', gates.map((x, k) => (k === i ? { ...x, swing: v as 'left' | 'right' | 'slide' } : x))); }}
            />
          </Row>
        </div>
      ))}
      <p className="fs-note">A gate is an opening in the fence’s line, measured along it from its start. {BARRIER}</p>
    </Section>
  );
}

/** Whether a model holds any FS_outdoor element: the Landscape summary's outdoor rows. */
export const hasOutdoor = (model: EditorModel): boolean => [...model.ext.values()].some((x) => x.extension === 'FS_outdoor');
export type { UnitSystem };
