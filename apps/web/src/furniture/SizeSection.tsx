import './resize.css';
import { useState } from 'react';
import { Box as BoxIcon, TriangleAlert } from 'lucide-react';
import type { ResizeAnchor } from '@floorspec/ops';
import { labelOf } from '../editor/model';
import { LengthField, Row, Section } from '../editor/fields';
import { prettyLen } from '../editor/units';
import type { SystemsCtx } from '../editor/systems/Panels';
import type { DeviceView } from '../editor/systems/view';
import { baysAt, boxOf, isResizable, modelKind, resizeBatch, ruleFor, shelterPostsAt, sizeOf, type Axis, type CommonSize, type Size } from './resize';

/**
 * The Size section of an item's inspector (FLR-T-18.4, the board's frame "inspector W × D × H"): its
 * width, depth and height as length fields, each typed size one `resizeElement` (Ops 0.4, 4.11) held at
 * the point "Resize from" chooses; the sizes its kind commonly comes in as chips; and what a new size
 * does to its 3D model — a procedural one is drawn again at it (a longer island gets more bays), a
 * project's own glTF model is fixed-size and drawn as it is (Core 12.6), which the section says.
 */

/** The nine anchors as the grid shows them: the item from above, its front at the bottom (Core 12.6's symbol). */
const GRID: readonly (readonly [ResizeAnchor, string])[] = [
  ['back-right', 'Back, its right corner'],
  ['back', 'Back edge'],
  ['back-left', 'Back, its left corner'],
  ['right', 'Its right side'],
  ['center', 'Middle'],
  ['left', 'Its left side'],
  ['front-right', 'Front, its right corner'],
  ['front', 'Front edge'],
  ['front-left', 'Front, its left corner'],
];

export function SizeSection({ ctx, device }: { ctx: SystemsCtx; device: DeviceView | undefined }) {
  const { model, id, element, units, readOnly } = ctx;
  const at = model.ext.get(id);
  const d = at === undefined ? undefined : { extension: at.extension, collection: at.collection, element };
  const box = boxOf(element);
  const onWall = (element['host'] as { mode?: unknown } | undefined)?.mode === 'wallFace';
  // A wall-hung or wall-backed item keeps its back on the wall; anything else grows from its middle.
  const [anchor, setAnchor] = useState<ResizeAnchor>(onWall ? 'back' : 'center');
  if (d === undefined || box === null || !isResizable(d)) return null;
  const rule = ruleFor(d);
  const size = sizeOf(box);
  const label = labelOf(model, id);
  const category = typeof element['category'] === 'string' ? element['category'] : '';
  const resize = (next: Partial<Size>, what: string) => {
    const changed: Partial<Size> = {};
    for (const a of Object.keys(next) as Axis[]) if (next[a] !== undefined && next[a] !== size[a]) changed[a] = next[a];
    if (Object.keys(changed).length > 0) ctx.edit(`${what} ${label}`, resizeBatch(id, anchor, changed, rule));
  };
  const field = (axis: Axis, title: string) => (
    <>
      <LengthField label={title} value={size[axis]} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) resize({ [axis]: v }, 'Resize'); }} {...(rule.notes[axis] === undefined ? {} : { hint: rule.notes[axis] })} />
      {axis !== 'height' ? <Chips sizes={rule.common.filter((c) => c[axis] !== undefined && (axis === 'width' || c.width === undefined))} size={size} units={units} disabled={readOnly} onPick={(c) => { resize({ ...(c.width === undefined ? {} : { width: c.width }), ...(c.depth === undefined ? {} : { depth: c.depth }) }, 'Resize'); }} /> : null}
    </>
  );
  const kind = modelKind(model.document, d);
  const bays = baysAt(category, size);
  const shelter = d.extension === 'FS_outdoor' && d.collection === 'shelters' ? shelterPostsAt(element, size) : null;
  return (
    <Section title="Size">
      {field('width', 'Width')}
      {field('depth', 'Depth')}
      {field('height', 'Height')}
      <Row label="Resize from">
        <div className="fs-size__anchor" role="radiogroup" aria-label="Resize from">
          {GRID.map(([a, name]) => (
            <button
              key={a}
              type="button"
              role="radio"
              className="fs-size__dot"
              aria-checked={anchor === a}
              aria-label={name}
              title={name}
              disabled={readOnly}
              onClick={() => { setAnchor(a); }}
            />
          ))}
        </div>
      </Row>
      <div className={kind === 'fixed' ? 'fs-size__model fs-size__model--fixed' : 'fs-size__model'} data-testid="model-kind" data-kind={kind}>
        {kind === 'fixed' ? <TriangleAlert aria-hidden="true" size={16} /> : <BoxIcon aria-hidden="true" size={16} />}
        <div>
          {kind === 'fixed' ? (
            <>
              <strong>Fixed-size model</strong>
              <span className="fs-note">Its glTF model is drawn as it is, never stretched (Floorspec Core 12.6): a new size changes its box and clearances, not the model. Pick a size it comes in.</span>
            </>
          ) : (
            <>
              <strong>Procedural — regenerates at any size</strong>
              <span className="fs-note">{shelter !== null ? `${String(shelter.posts)} posts, ${prettyLen(shelter.spacing[0], units)} × ${prettyLen(shelter.spacing[1], units)} o.c.: stretched, it gets more posts, re-spaced — never wider ones.` : bays === null ? 'Drawn again from its box at the new size.' : `${String(bays)} ${bays === 1 ? 'bay' : 'bays'} at ${prettyLen(size.width, units)}: a longer island gets more bays, not stretched ones.`}</span>
            </>
          )}
        </div>
      </div>
      {device === undefined ? null : <span className="fs-note">Drag a handle on the plan: an edge moves one side, a corner two; ⌥ from the middle, ⇧ free (on a corner, keeps proportions). Snaps to the {rule.stepLabel}.</span>}
    </Section>
  );
}

function Chips({ sizes, size, units, disabled, onPick }: { sizes: readonly CommonSize[]; size: Size; units: SystemsCtx['units']; disabled: boolean; onPick: (c: CommonSize) => void }) {
  if (sizes.length === 0) return null;
  return (
    <div className="fs-size__chips" role="group" aria-label="Common sizes">
      {sizes.map((c) => {
        const on = (c.width === undefined || c.width === size.width) && (c.depth === undefined || c.depth === size.depth);
        return (
          <button key={c.label} type="button" className="fs-size__chip" aria-pressed={on} disabled={disabled} onClick={() => { onPick(c); }} title={[c.width === undefined ? null : `${prettyLen(c.width, units)} wide`, c.depth === undefined ? null : `${prettyLen(c.depth, units)} deep`].filter(Boolean).join(', ')}>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
