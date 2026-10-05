import { useState } from 'react';
import type { Diagnostic } from '@floorspec/engine';
import { Button, IconButton, StatusDot } from '@d3cloud/ui';
import { CircleAlert, Info, Wrench, X } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import { labelOf, type EditorModel } from './model';
import { describeFix } from './ops';

/**
 * Diagnostics in the editor (FLR-T-3.8). A rejected batch changes nothing; the banner says so,
 * shows each coded diagnostic, outlines its elements on the canvas (Canvas › Findings), and offers
 * a diagnostic's fix as one click — sent together with the batch it repairs. The head's own
 * findings (lints) are listed with their fixes too.
 */

/** Why, in a sentence, with the rule it comes from — for the codes a person meets while drawing. */
const WHY: Record<string, string> = {
  'FS-INV-101': 'Two junctions on a level cannot share a position (Floorspec Core 5.1).',
  'FS-INV-102': 'A wall cannot start and end at the same junction (Core 5.2).',
  'FS-INV-103': 'Two walls cannot join the same two junctions — one would be drawn on top of the other (Core 5.2).',
  'FS-INV-104': 'Walls on a level may meet only at junctions (Core 5.3).',
  'FS-INV-105': 'A junction cannot sit inside a wall; the wall must be split there (Core 5.3).',
  'FS-INV-106': 'Two walls cannot overlap along their length (Core 5.3).',
  'FS-INV-109': 'The wall is too short for the walls joining it: its corners cross (Core 5.7).',
  'FS-INV-110': 'The corner where these walls meet cannot be filled (Core 5.7).',
  'FS-INV-201': 'A room’s anchor must be inside a closed space (Core 6.3).',
  'FS-INV-202': 'Two rooms cannot claim one space. Removing the wall between them merged their spaces (Core 6.3).',
  'FS-INV-203': 'The space is too thin to be a room — usually two walls too close together (Core 6.3).',
  'FS-INV-204': 'A room’s anchor must be inside the room, not in a wall’s thickness (Core 6.3).',
  'FS-INV-301': 'An opening needs a width and a height, from itself or its type (Core 7.2).',
  'FS-INV-302': 'Hosted openings must stay within their wall (Core 7.3). The fix is an op you can undo.',
  'FS-INV-303': 'An opening must fit under its wall’s top (Core 7.3).',
  'FS-INV-304': 'Two openings on one wall cannot overlap (Core 7.3).',
  'FS-OPS-003': 'The edit named something that is not there (Floorspec Ops 2–3).',
  'FS-OPS-004': 'The edit could mean more than one element; nothing is guessed (Ops 3.3).',
  'FS-OPS-006': 'Other elements depend on this one (Ops 2.2).',
  'FS-OPS-007': 'The level’s walls do not form closed spaces here, so the edit has no faces to read (Ops 3.4).',
  'FS-OPS-008': 'The edit does not apply to this wall or room as it stands (Ops 4).',
  'FS-OPS-009': 'An opening would straddle a junction the edit inserts (Ops 5.2).',
  'FS-OPS-012': 'That length or point is not in the reference grammar (Ops 3.1).',
};

export function explain(code: string): string | undefined {
  return WHY[code];
}

export function RejectionBanner({ store }: { store: EditorStore }) {
  const rejection = useEditor(store, (s) => s.rejection);
  const model = useEditor(store, (s) => s.model);
  const pending = useEditor(store, (s) => s.pending);
  const [expanded, setExpanded] = useState(false);
  if (rejection === null || model === null) return null;
  const [first, ...rest] = rejection.diagnostics;
  if (first === undefined) return null;
  const why = explain(first.code);
  const fixable = rejection.diagnostics.filter((d) => d.fix !== undefined && d.fix.length > 0).length;
  return (
    <div className="fs-reject" role="alert">
      <div className="fs-reject__card">
        <CircleAlert className="fs-reject__icon" aria-hidden="true" />
        <div className="fs-reject__text">
          <p className="fs-reject__title">{rejection.label} rejected — nothing changed</p>
          <p className="fs-reject__code">
            {first.code} · {first.message}
          </p>
        </div>
        <span className="fs-spacer" />
        {first.fix !== undefined && first.fix.length > 0 ? (
          <Button size="sm" variant="secondary" icon={<Wrench />} disabled={pending !== null} onClick={() => void store.applyFix(first)}>
            Fix: {describeFix(first.fix, (id) => labelOf(model, id))}
          </Button>
        ) : null}
        {fixable > 1 ? (
          <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void store.applyAllFixes()}>
            Apply all {String(fixable)}
          </Button>
        ) : null}
        <IconButton size="sm" label="Dismiss" icon={<X />} onClick={() => { store.dismissRejection(); }} />
      </div>
      {why !== undefined || rest.length > 0 ? (
        <div className="fs-reject__why">
          <Info aria-hidden="true" />
          <div>
            {why !== undefined ? <p>{why}</p> : null}
            {rest.length > 0 ? (
              <>
                <button type="button" className="fs-linkish" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); }}>
                  {expanded ? 'Hide' : 'Show'} {String(rest.length)} more {rest.length === 1 ? 'diagnostic' : 'diagnostics'}
                </button>
                {expanded ? <DiagnosticRows store={store} model={model} diagnostics={rest} /> : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DiagnosticRows({ store, model, diagnostics }: { store: EditorStore; model: EditorModel; diagnostics: Diagnostic[] }) {
  const pending = useEditor(store, (s) => s.pending);
  return (
    <ul className="fs-diags">
      {diagnostics.map((d, i) => (
        <li key={`${d.code}-${String(i)}`} className="fs-diag">
          <div className="fs-diag__line">
            <StatusDot tone={d.severity === 'error' ? 'danger' : d.severity === 'warning' ? 'warning' : 'neutral'} size="sm">
              <span className="fs-mono-small">{d.code}</span>
            </StatusDot>
            <span className="fs-spacer" />
            {d.fix !== undefined && d.fix.length > 0 ? (
              <Button size="sm" variant="ghost" icon={<Wrench />} disabled={pending !== null} onClick={() => void store.applyFix(d)}>
                {describeFix(d.fix, (id) => labelOf(model, id))}
              </Button>
            ) : null}
          </div>
          <p className="fs-diag__message">{d.message}</p>
          {d.elements.length > 0 ? (
            <p className="fs-diag__elements">
              {d.elements.map((id) =>
                model.index.has(id) ? (
                  <button key={id} type="button" className="fs-linkish" onClick={() => { store.select(id); }}>
                    {labelOf(model, id)}
                  </button>
                ) : (
                  <span key={id}>{id}</span>
                ),
              )}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The head's own findings: lints for a valid model, every diagnostic for one that is not. */
export function FindingsList({ store }: { store: EditorStore }) {
  const model = useEditor(store, (s) => s.model);
  if (model === null) return null;
  if (model.diagnostics.length === 0) return <p className="fs-note">No findings. The model is valid and nothing in it needs attention.</p>;
  return <DiagnosticRows store={store} model={model} diagnostics={model.diagnostics} />;
}
