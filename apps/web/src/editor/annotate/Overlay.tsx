import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@d3cloud/ui';
import { approxMeasure, customString, layoutAnnotations, SCREEN_METRICS } from '@floorspec/render2d';
import { useEditor, type EditorStore, type Viewport } from '../store';
import type { EditorModel, LevelView, Point } from '../model';
import { toScreen } from '../viewport';
import { formatLen, type UnitSystem } from '../units';
import { memberOf, recordOf, removeAnnotation, setNoteText } from './ops';
import { resolvedOf } from './resolved';
import { annotateOf, useAnnotate, type DraftAnchor } from './state';
import { commitNote, draftString } from './tools';

/**
 * What the dimension and note tools draw while they work (FLR-T-18.11), and the cards over the plan:
 * a note's text being typed where it goes, and the card of the annotation selected — its lengths or
 * its text, and Delete.
 */

const f1 = (n: number): string => n.toFixed(1);

/** The anchor under the pointer, as the tool will take it, in words. */
export function anchorWords(a: DraftAnchor): string {
  switch (a.kind) {
    case 'junction':
      return `Junction ${a.id}`;
    case 'wall':
      return a.face === 'location' ? `Location line of ${a.id}` : `${a.face === 'left' ? 'Left' : 'Right'} face of ${a.id}`;
    case 'opening':
      return `Centre of ${a.id}`;
    case 'point':
      return 'Point';
  }
}

/** The SVG part: the string being made, its anchors, the anchor under the pointer, a note's leader. */
export function AnnotationDraftLayer({ store, view, units }: { store: EditorStore; view: Viewport; units: UnitSystem }) {
  const tool = useEditor(store, (s) => s.tool);
  const dim = useAnnotate(store, (a) => a.dimension);
  const note = useAnnotate(store, (a) => a.note);
  const S = (p: Point) => toScreen(view, p);
  const preview = useMemo(() => {
    if (tool !== 'dimension' || dim.cursor === null) return [];
    const anchors = dim.anchors.length >= 2 || dim.hover === null || dim.anchors.length === 0 ? dim.anchors : [...dim.anchors, dim.hover];
    const through = dim.anchors.length >= 2 ? dim.cursor : dim.anchors.length === 1 ? (dim.anchors[0]?.point ?? dim.cursor) : dim.cursor;
    const d = draftString(anchors, through);
    const s = d === null ? null : customString(d);
    if (s === null) return [];
    return layoutAnnotations({ strings: [s] }, { P: (p) => toScreen(view, p), k: view.s }, SCREEN_METRICS, approxMeasure, (v) => formatLen(Math.round(v), units)).prims;
  }, [tool, dim, view, units]);
  if (tool === 'dimension') {
    const out: ReactNode[] = [];
    preview.forEach((p, i) => {
      if (p.t === 'line') out.push(<line key={`l${String(i)}`} className={p.role === 'ext' ? 'fs-anno-draft__ext' : 'fs-anno-draft__line'} x1={f1(p.a[0])} y1={f1(p.a[1])} x2={f1(p.b[0])} y2={f1(p.b[1])} />);
      else if (p.t === 'text')
        out.push(
          <text key={`t${String(i)}`} className="fs-anno-draft__text" x={f1(p.x)} y={f1(p.y)} textAnchor="middle" transform={p.rotate === 0 ? undefined : `rotate(${f1(p.rotate)} ${f1(p.x)} ${f1(p.y)})`}>
            {p.text}
          </text>,
        );
    });
    for (const [i, a] of dim.anchors.entries()) {
      const [x, y] = S(a.point);
      out.push(<circle key={`a${String(i)}`} className="fs-anno-draft__anchor" cx={f1(x)} cy={f1(y)} r={4} />);
    }
    if (dim.hover !== null && !(dim.anchors.length >= 2 && dim.hover.kind === 'point')) {
      const [x, y] = S(dim.hover.point);
      out.push(<circle key="hover" className="fs-anno-draft__anchor" cx={f1(x)} cy={f1(y)} r={6} fillOpacity={0.4} />);
    }
    return <g className="fs-anno-draft" aria-hidden="true">{out}</g>;
  }
  if (tool === 'note' && note !== null && note.tip !== null) {
    const end = note.at ?? note.cursor;
    if (end === null) return null;
    const [x0, y0] = S(note.tip);
    const [x1, y1] = S(end);
    return (
      <g className="fs-anno-draft" aria-hidden="true">
        <line className="fs-anno-draft__line" x1={f1(x0)} y1={f1(y0)} x2={f1(x1)} y2={f1(y1)} />
        <circle className="fs-anno-draft__anchor" cx={f1(x0)} cy={f1(y0)} r={3} />
      </g>
    );
  }
  return null;
}

/** The HTML part: the tool's hint, a note's text being typed, and the selected annotation's card. */
export function AnnotationHtml({ store, view, level, model, units }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem }) {
  const tool = useEditor(store, (s) => s.tool);
  const dim = useAnnotate(store, (a) => a.dimension);
  const note = useAnnotate(store, (a) => a.note);
  const selected = useAnnotate(store, (a) => a.selected);
  return (
    <>
      {tool === 'dimension' ? (
        <p className="fs-anno-hint" role="status">
          {dim.anchors.length === 0
            ? 'Dimension: click a junction, a wall’s face or a door or window to measure from.'
            : dim.anchors.length === 1
              ? `From ${anchorWords(dim.anchors[0] as DraftAnchor)} — click what to measure to.`
              : 'Click more to measure on, or click where the string goes (Enter: here). Esc cancels.'}
          {dim.hover !== null && dim.hover.kind !== 'point' ? <span className="fs-anno-hint__under"> · {anchorWords(dim.hover)}</span> : null}
        </p>
      ) : null}
      {tool === 'note' && note === null ? (
        <p className="fs-anno-hint" role="status">
          Note: click where its text goes, or drag from what it points at to where its text goes.
        </p>
      ) : null}
      {note !== null && note.at !== null ? <NoteInput store={store} view={view} at={note.at} /> : null}
      {selected !== null ? <AnnotationCard store={store} view={view} level={level} model={model} units={units} id={selected} /> : null}
    </>
  );
}

function NoteInput({ store, view, at }: { store: EditorStore; view: Viewport; at: Point }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const [x, y] = toScreen(view, at);
  return (
    <div className="fs-note-input" style={{ left: Math.min(x, view.w - 250), top: Math.min(y + 8, view.h - 120) }} role="dialog" aria-label="New note">
      <label htmlFor="fs-note-text">
        <p>Note text — Enter adds it, ⇧Enter a new line</p>
      </label>
      <textarea
        id="fs-note-text"
        ref={ref}
        value={text}
        maxLength={500}
        onChange={(e) => { setText(e.target.value); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void commitNote(store, text);
          } else if (e.key === 'Escape') annotateOf(store).set({ note: null });
        }}
      />
      <div className="fs-anno-card__actions">
        <Button size="sm" variant="primary" disabled={text.trim() === ''} onClick={() => { void commitNote(store, text); }}>
          Add note
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { annotateOf(store).set({ note: null }); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AnnotationCard({ store, view, level, model, units, id }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem; id: string }) {
  const member = memberOf(model, id);
  const record = recordOf(model, id);
  const resolved = resolvedOf(model, level.id);
  const dim = resolved.dimensions.find((d) => d.id === id);
  const note = resolved.notes.find((n) => n.id === id);
  const [text, setText] = useState(typeof record?.['text'] === 'string' ? record['text'] : '');
  useEffect(() => {
    setText(typeof record?.['text'] === 'string' ? record['text'] : '');
  }, [record]);
  if (member === null || record === undefined) return null;
  const readOnly = store.get().readOnly !== null;
  const anchorPt: Point | undefined = dim?.anchors[dim.anchors.length - 1]?.onLine ?? note?.at;
  const [x, y] = anchorPt === undefined ? [view.w - 270, 80] : toScreen(view, [anchorPt[0], anchorPt[1]]);
  const left = Math.max(8, Math.min(x + 16, view.w - 264));
  const top = Math.max(8, Math.min(y + 16, view.h - 180));
  const remove = () => {
    void store.apply(member === 'dimensions' ? 'Remove the dimension' : 'Remove the note', removeAnnotation(model, id)).then((ok) => { if (ok) annotateOf(store).select(null); });
  };
  return (
    <section className="fs-anno-card" style={{ left, top }} aria-label={member === 'dimensions' ? `Dimension ${id}` : `Note ${id}`} data-testid="annotation-card">
      <div className="fs-anno-card__head">
        <span>{member === 'dimensions' ? `Dimension ${id}` : `Note ${id}`}</span>
        <Button size="sm" variant="ghost" onClick={() => { annotateOf(store).select(null); }}>
          Done
        </Button>
      </div>
      {member === 'dimensions' ? (
        dim === undefined ? (
          <p className="fs-note">It no longer measures to anything on this level — what it measured to was moved away or removed.</p>
        ) : (
          <p className="fs-anno-card__lengths">{dim.lengths.map((l) => formatLen(l, units)).join(' · ')}</p>
        )
      ) : (
        <textarea
          aria-label="Note text"
          value={text}
          maxLength={500}
          disabled={readOnly}
          onChange={(e) => { setText(e.target.value); }}
          onKeyDown={(e) => { e.stopPropagation(); }}
        />
      )}
      <div className="fs-anno-card__actions">
        {member === 'notes' ? (
          <Button size="sm" variant="secondary" disabled={readOnly || text.trim() === '' || text === record['text']} onClick={() => { void store.apply('Edit the note', setNoteText(id, text.trim())); }}>
            Save text
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={remove}>
          Delete
        </Button>
      </div>
    </section>
  );
}
