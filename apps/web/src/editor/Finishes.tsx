import { useState } from 'react';
import { Button, IconButton, Select } from '@d3cloud/ui';
import { Plus, Trash2 } from 'lucide-react';
import type { EditorStore } from './store';
import { labelOf, type EditorModel } from './model';
import { LengthField, Row } from './fields';
import { formatLen, type UnitSystem } from './units';
import type { Batch } from './ops';

/**
 * A wall's faces and their finishes (Core 0.3, 18.5–18.6; FLR-T-8.1): what each face resolves to —
 * its own material, the room it faces, or its outermost layer — a face's own material, and the
 * regions on it (a backsplash between the counter and the cabinets). Every change sets the wall's
 * whole `finishes`, or unsets it when nothing is left, so the document never holds an empty face.
 */

import { setFinishes, withFace, type Face, type Finishes, type Region, type Side } from './finishOps';

type Json = Record<string, unknown>;

/** 36" and 54": a counter's top and the bottom of wall cabinets — where a backsplash starts and ends. */
const COUNTER = 1_170_432;
const CABINETS = 1_755_648;

const SOURCE: Record<string, string> = { face: 'its own', room: 'from the room', layer: 'from its layers' };

export function WallFinishes({
  store,
  model,
  id,
  element,
  units,
  readOnly,
  length,
  sides,
  edit,
}: {
  store: EditorStore;
  model: EditorModel;
  id: string;
  element: Json;
  units: UnitSystem;
  readOnly: boolean;
  length: number;
  sides: { left: string | null; right: string | null };
  edit: (label: string, batch: Batch) => void;
}) {
  const finishes = element['finishes'] as Finishes | undefined;
  return (
    <>
      {(['left', 'right'] as const).map((side) => (
        <FaceSection
          key={side}
          store={store}
          model={model}
          id={id}
          side={side}
          finishes={finishes}
          room={(model.derived?.finishes?.walls[id]?.[side]?.room ?? sides[side]) ?? null}
          units={units}
          readOnly={readOnly}
          length={length}
          edit={edit}
        />
      ))}
    </>
  );
}

function FaceSection({
  store,
  model,
  id,
  side,
  finishes,
  room,
  units,
  readOnly,
  length,
  edit,
}: {
  store: EditorStore;
  model: EditorModel;
  id: string;
  side: Side;
  finishes: Finishes | undefined;
  room: string | null;
  units: UnitSystem;
  readOnly: boolean;
  length: number;
  edit: (label: string, batch: Batch) => void;
}) {
  const face: Face = finishes?.[side] ?? {};
  const regions = face.regions ?? [];
  const resolved = model.derived?.finishes?.walls[id]?.[side];
  const materials = Object.keys(model.document.materials ?? {}).map((m) => ({ value: m, label: labelOf(model, m) }));
  const sideName = side === 'left' ? 'Left face' : 'Right face';
  const [draft, setDraft] = useState<Region | null>(null);
  const change = (label: string, next: Face) => { edit(label, setFinishes(id, withFace(finishes, side, next))); };
  const wall = labelOf(model, id);
  return (
    <section className="fs-section fs-face-finish" aria-label={`${sideName} of ${wall}`} data-side={side}>
      <div className="fs-section__head">
        <h3 className="fs-overline">{sideName}</h3>
        {room === null ? <span className="fs-face__room">Outside</span> : (
          <button type="button" className="fs-face__room fs-linkish" onClick={() => { store.select(room); }}>
            {labelOf(model, room)}
          </button>
        )}
      </div>
      <p className="fs-face-finish__resolved" data-testid={`finish-${side}`}>
        {resolved?.material === undefined ? (regions.length > 0 ? 'No finish beside its regions' : 'No finish') : `${labelOf(model, resolved.material)} · ${SOURCE[resolved.source ?? ''] ?? ''}`}
      </p>
      <Row label="Material">
        <Select
          aria-label={`${sideName} material`}
          appearance="filled"
          options={[{ value: '', label: room === null ? 'From its layers' : 'From the room' }, ...materials]}
          value={face.material ?? ''}
          disabled={readOnly || materials.length === 0}
          onValueChange={(v) => {
            const next: Face = { ...face };
            if (v === '') delete next.material;
            else next.material = v;
            change(v === '' ? `Clear the ${side} face of ${wall}` : `Finish the ${side} face of ${wall}`, next);
          }}
        />
      </Row>
      {regions.length > 0 ? (
        <ul className="fs-regions" aria-label={`Regions of the ${side} face`}>
          {regions.map((r, i) => (
            <li key={i}>
              <span className="fs-regions__swatch" style={{ background: model.document.materials?.[r.material]?.color ?? 'transparent' }} aria-hidden="true" />
              <span>
                {labelOf(model, r.material)}
                <span className="fs-mono-small">
                  {' '}
                  {formatLen(r.from, units)}–{formatLen(r.to, units)} along, {formatLen(r.bottom, units)}–{formatLen(r.top, units)} up
                </span>
              </span>
              <span className="fs-spacer" />
              {!readOnly ? (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={`Remove the region ${String(i + 1)} of the ${side} face`}
                  icon={<Trash2 />}
                  onClick={() => { change(`Remove a region of ${wall}`, { ...face, regions: regions.filter((_, k) => k !== i) }); }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {readOnly ? null : draft === null ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus />}
          disabled={materials.length === 0}
          onClick={() => { setDraft({ from: 0, to: Math.max(1, Math.floor(length)), bottom: COUNTER, top: CABINETS, material: materials[0]?.value ?? '' }); }}
        >
          Add a region
        </Button>
      ) : (
        <div className="fs-region-form" role="group" aria-label={`New region on the ${side} face`}>
          <LengthField label="From" value={draft.from} units={units} nonNegative hint="Along the wall from its start" onCommit={(v) => { if (v !== null) setDraft({ ...draft, from: v }); }} />
          <LengthField label="To" value={draft.to} units={units} positive onCommit={(v) => { if (v !== null) setDraft({ ...draft, to: v }); }} />
          <LengthField label="Bottom" value={draft.bottom} units={units} nonNegative hint="Above the wall's base" onCommit={(v) => { if (v !== null) setDraft({ ...draft, bottom: v }); }} />
          <LengthField label="Top" value={draft.top} units={units} positive onCommit={(v) => { if (v !== null) setDraft({ ...draft, top: v }); }} />
          <Row label="Material">
            <Select aria-label="Region material" appearance="filled" options={materials} value={draft.material} onValueChange={(v) => { setDraft({ ...draft, material: v }); }} />
          </Row>
          <div className="fs-region-form__actions">
            <Button size="sm" variant="ghost" onClick={() => { setDraft(null); }}>Cancel</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={draft.material === '' || draft.to <= draft.from || draft.top <= draft.bottom}
              onClick={() => {
                change(`Add a region to ${wall}`, { ...face, regions: [...regions, draft] });
                setDraft(null);
              }}
            >
              Add region
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
