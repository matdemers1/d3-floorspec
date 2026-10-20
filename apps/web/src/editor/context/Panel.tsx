import { Badge, Button, IconButton, SegmentedControl } from '@d3cloud/ui';
import { Building2, X } from 'lucide-react';
import { pitchOf, sideOfEdge, type DerivedContext, type StreetSide, type TreeDensity } from '@floorspec/engine';
import type { EditorStore, ToolId } from '../store';
import type { EditorModel } from '../model';
import { formatLen, type UnitSystem } from '../units';
import { LengthField, Row, Section } from '../fields';
import { modesOf, type LayerState } from '../modes';
import { useContextShown } from './Layer';
import { siteDrawingOf } from '../site/Layer';
import { clearContext, contextDrawingOf, FT, generatedRecord, generateOps, generateOptions, recordOf, removeContext, setContextField } from './ops';
import { contextOf, useContextState, type ContextMember } from './state';
import './context.css';

/**
 * The Context panel (FLR-T-15.3, the P15 board's "15.3 · Context" frame): in Landscape mode beside the
 * context tools. Generate the street, the neighbours and the trees beyond the lot from the street side
 * and the lot's own setbacks — or draw them by hand — show, ghost or hide them, and say what context
 * never is: part of the design. Its quantities, schedules, rules and findings never count it; it does
 * cast shade in the sun study and the daylight analysis.
 */

const SIDES: { value: StreetSide; label: string }[] = [
  { value: 'north', label: 'North' },
  { value: 'east', label: 'East' },
  { value: 'south', label: 'South' },
  { value: 'west', label: 'West' },
];
const DENSITY: { value: TreeDensity; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'few', label: 'Few' },
  { value: 'some', label: 'Some' },
  { value: 'many', label: 'Many' },
];
const TOOL_HINTS: Partial<Record<ToolId, string>> = {
  context: 'Drag a street, a neighbour or a tree to move it. Context has no rooms and no materials: it is only ever moved, resized or deleted.',
  tree: 'Click beyond the lot to plant a tree there. A tree the design keeps is a plant (Landscape), not context.',
  neighbour: 'Click the neighbour’s corners, then the first again or Enter. Four square corners get a gable; any other outline is flat-roofed.',
  street: 'Click along the street’s centreline, then double-click or Enter. It takes the carriageway, strip and sidewalk above.',
};

const ft = (v: number, units: UnitSystem) => formatLen(Math.round(v), units);

export function ContextPanel({ store, model, units, readOnly, tool, tools }: { store: EditorStore; model: EditorModel; units: UnitSystem; readOnly: boolean; tool?: ToolId; tools?: { setTool: (t: ToolId) => void } }) {
  const state = useContextState(store, (s) => s);
  const ctx = contextDrawingOf(model);
  const derived = (model.derived?.extensions as { FS_context?: DerivedContext } | undefined)?.FS_context;
  const show = useContextShown(store);
  const site = siteDrawingOf(model);
  const edit = (label: string, batch: Parameters<EditorStore['apply']>[1]) => void store.apply(label, batch);
  const generated = ctx.streets.some((s) => s.generated) || ctx.neighbours.some((n) => n.generated) || ctx.trees.some((t) => t.generated);
  // FS_site's street edge says which side the street is on when the panel has not been told
  const front = site.edges.find((e) => e.kind === 'front');
  const side: StreetSide | null = state.side ?? (front !== undefined && site.lot !== null ? sideOfEdge(site.lot, front.index) : null);
  const set = (patch: Parameters<ReturnType<typeof contextOf>['set']>[0]) => { contextOf(store).set(patch); };

  const generate = (seed: number) => {
    const s = { ...contextOf(store).get(), seed };
    const r = generateOps(model, generateOptions(s));
    if (r.reason !== undefined) {
      store.set({ notice: { tone: 'info', text: r.reason } });
      return;
    }
    set({ seed, selected: null });
    edit(generated ? 'Regenerate the context' : 'Generate the context', r.batch);
  };
  const choose = (t: ToolId) => { if (tools !== undefined) tools.setTool(t); else store.setTool(t); };

  return (
    <section className="fs-context-panel" aria-label="Context">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <Building2 />
        </span>
        <div className="fs-inspector__title">
          <h2>Context</h2>
          <p>Around the lot · never part of the design</p>
        </div>
      </div>
      <div className="fs-context__chips" aria-label="The context at a glance">
        {generated ? <Badge tone="neutral" size="sm">Generated</Badge> : null}
        <Badge tone="neutral" size="sm">{ctx.streets.length === 1 ? '1 street' : `${String(ctx.streets.length)} streets`}</Badge>
        <Badge tone="neutral" size="sm">{ctx.neighbours.length === 1 ? '1 neighbour' : `${String(ctx.neighbours.length)} neighbours`}</Badge>
        <Badge tone="neutral" size="sm">{ctx.trees.length === 1 ? '1 tree' : `${String(ctx.trees.length)} trees`}</Badge>
      </div>
      {tool !== undefined && TOOL_HINTS[tool] !== undefined ? <p className="fs-note fs-context__hint" role="status">{TOOL_HINTS[tool]}</p> : null}

      <Section title="Generate from the street side">
        <SegmentedControl
          aria-label="Street side"
          size="sm"
          value={side ?? ''}
          items={SIDES}
          onValueChange={(v) => { set({ side: v as StreetSide }); }}
        />
        <LengthField label="Street, curb to curb" value={Math.round(state.width * FT)} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) set({ width: v / FT }); }} />
        <LengthField label="Sidewalk" value={Math.round(state.sidewalk * FT)} units={units} nonNegative disabled={readOnly} onCommit={(v) => { if (v !== null) set({ sidewalk: v / FT }); }} />
        <LengthField label="Planting strip" value={Math.round(state.strip * FT)} units={units} nonNegative disabled={readOnly} onCommit={(v) => { if (v !== null) set({ strip: v / FT }); }} />
        <Row label="Neighbours">
          <SegmentedControl aria-label="Neighbours" size="sm" value={state.neighbours ? 'both' : 'none'} items={[{ value: 'both', label: 'Both sides' }, { value: 'none', label: 'None' }]} onValueChange={(v) => { set({ neighbours: v === 'both' }); }} />
        </Row>
        <p className="fs-note">At your setbacks{site.setbacks === null ? ' (30′ front, 10′ sides until the lot has its own)' : ''} · 1–2 storeys · simple gable and hip roofs.</p>
        <Row label="Trees beyond the lot">
          <SegmentedControl aria-label="Trees beyond the lot" size="sm" value={state.trees} items={DENSITY} onValueChange={(v) => { set({ trees: v as TreeDensity }); }} />
        </Row>
        {!readOnly ? (
          <div className="fs-context__actions">
            <Button variant="secondary" size="sm" onClick={() => { generate(generated ? state.seed + 1 : state.seed); }}>
              {generated ? 'Regenerate' : 'Generate'}
            </Button>
            {ctx.empty ? null : (
              <Button variant="ghost" size="sm" onClick={() => { set({ selected: null }); edit('Remove the context', clearContext(model)); }}>
                Remove all
              </Button>
            )}
          </div>
        ) : null}
        {site.lot === null ? <p className="fs-note">Draw the lot first (⇧B): context is generated from its street edge and setbacks.</p> : null}
      </Section>

      {!readOnly ? (
        <Section title="Draw by hand">
          <SegmentedControl
            aria-label="Draw by hand"
            size="sm"
            value={tool === 'tree' || tool === 'neighbour' || tool === 'street' || tool === 'context' ? tool : ''}
            items={[{ value: 'context', label: 'Move' }, { value: 'tree', label: 'Tree' }, { value: 'neighbour', label: 'Neighbour' }, { value: 'street', label: 'Street' }]}
            onValueChange={(v) => { choose(v as ToolId); }}
          />
          {tool === 'tree' ? (
            <Row label="Tree">
              <SegmentedControl aria-label="Tree form" size="sm" value={state.treeForm} items={[{ value: 'deciduous', label: 'Deciduous' }, { value: 'evergreen', label: 'Evergreen' }]} onValueChange={(v) => { set({ treeForm: v === 'evergreen' ? 'evergreen' : 'deciduous' }); }} />
            </Row>
          ) : null}
        </Section>
      ) : null}

      <Section title="Show">
        <SegmentedControl
          aria-label="Show context"
          size="sm"
          value={show}
          items={[{ value: 'on', label: 'On' }, { value: 'ghost', label: 'Ghost' }, { value: 'off', label: 'Off' }]}
          onValueChange={(v) => { modesOf(store).setLayer('context', v as LayerState); }}
        />
      </Section>

      {state.selected !== null ? <Selected store={store} model={model} units={units} readOnly={readOnly} member={state.selected.member} id={state.selected.id} derived={derived} /> : null}

      <Section title="In the model">
        <dl className="fs-context__facts" data-testid="context-never">
          <div className="fs-context__fact"><dt>Quantities and schedules</dt><dd>excluded</dd></div>
          <div className="fs-context__fact"><dt>Rules and findings</dt><dd>excluded</dd></div>
          <div className="fs-context__fact"><dt>Sun, shadow, daylight</dt><dd>casts shade</dd></div>
          <div className="fs-context__fact"><dt>Exports</dt><dd>own layer, marked context</dd></div>
        </dl>
        <p className="fs-note">Drawn in one neutral style — grey massing, dashed outlines, no materials — so it never reads as the design.</p>
      </Section>

      <Section title="Records">
        <RecordList store={store} readOnly={readOnly} member="streets" title="Streets" rows={ctx.streets.map((s) => [s.id, `${s.name === undefined ? '' : `${s.name} · `}${ft(s.overall, units)} wide`])} />
        <RecordList store={store} readOnly={readOnly} member="neighbours" title="Neighbours" rows={ctx.neighbours.map((n) => [n.id, `${n.name === undefined ? '' : `${n.name} · `}${n.roof}`])} />
        <RecordList store={store} readOnly={readOnly} member="trees" title="Trees" rows={ctx.trees.map((t) => [t.id, `${t.form} · ${ft(t.height, units)} tall`])} />
        {ctx.empty ? <p className="fs-note">No context yet: generate it from the street side, or draw it by hand.</p> : null}
      </Section>
    </section>
  );
}

function RecordList({ store, readOnly, member, title, rows }: { store: EditorStore; readOnly: boolean; member: ContextMember; title: string; rows: [string, string][] }) {
  const selected = useContextState(store, (s) => s.selected);
  if (rows.length === 0) return null;
  return (
    <div className="fs-context__records">
      <h4 className="fs-mode-summary__title">{title}</h4>
      <ul>
        {rows.map(([id, text]) => (
          <li key={id} className="fs-context__record" data-selected={selected?.id === id ? '' : undefined}>
            <button type="button" className="fs-context__pick" aria-pressed={selected?.id === id} onClick={() => { contextOf(store).set({ selected: selected?.id === id ? null : { member, id } }); }}>
              <span className="fs-context__record-id">{id}</span>
              <span className="fs-context__record-text">{text}</span>
            </button>
            {!readOnly ? <IconButton label={`Remove ${id}`} icon={<X />} size="sm" onClick={() => { contextOf(store).set({ selected: null }); void store.apply(`Remove ${id}`, removeContext(member, id)); }} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The picked record: what it is, and the few things context lets you change. */
function Selected({ store, model, units, readOnly, member, id, derived }: { store: EditorStore; model: EditorModel; units: UnitSystem; readOnly: boolean; member: ContextMember; id: string; derived: DerivedContext | undefined }) {
  const r = recordOf(model, member, id);
  if (r === undefined) return null;
  const set = (field: string, value: unknown) => { void store.apply(`Change ${id}`, setContextField(member, id, field, value)); };
  const num = (k: string): number | undefined => (typeof r[k] === 'number' ? r[k] : undefined);
  const kind = member === 'streets' ? 'Street' : member === 'neighbours' ? 'Neighbour' : 'Tree';
  const ctx = contextDrawingOf(model);
  const n = member === 'neighbours' ? ctx.neighbours.find((x) => x.id === id) : undefined;
  const d = member === 'neighbours' ? derived?.neighbours[id] : undefined;
  return (
    <Section title={`${kind} · ${typeof r['name'] === 'string' ? r['name'] : id}`} aside={<span className="fs-note">{generatedRecord(model, member, id) ? 'generated' : 'drawn by hand'}</span>}>
      {member === 'streets' ? (
        <>
          <LengthField label="Curb to curb" value={num('width')} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) set('width', v); }} />
          <LengthField label="Sidewalk" value={num('sidewalk') ?? 0} units={units} nonNegative disabled={readOnly} onCommit={(v) => { set('sidewalk', v === 0 ? null : v); }} />
          <LengthField label="Planting strip" value={num('strip') ?? 0} units={units} nonNegative disabled={readOnly} onCommit={(v) => { set('strip', v === 0 ? null : v); }} />
        </>
      ) : null}
      {member === 'neighbours' && n !== undefined ? (
        <>
          <dl className="fs-context__facts">
            <div className="fs-context__fact"><dt>Footprint</dt><dd>{d === undefined ? '—' : `${Math.round(Number(d.area.replace(/\.5$/, '')) / (FT * FT)).toLocaleString('en-US')} ft²`}</dd></div>
            <div className="fs-context__fact"><dt>Roof</dt><dd>{n.roof}{pitchOf(n.footprint, n.ridge - n.eaves) === null ? '' : ` ${String(pitchOf(n.footprint, n.ridge - n.eaves))}`}</dd></div>
            <div className="fs-context__fact"><dt>Style</dt><dd>neutral · no materials</dd></div>
          </dl>
          <LengthField label="Eaves" value={num('height')} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) set('height', v); }} hint={Math.round((num('height') ?? 0) / (9.5 * FT)) <= 1 ? '1 storey' : `${String(Math.round((num('height') ?? 0) / (9.5 * FT)))} storeys`} />
          <LengthField label="Ridge above eaves" value={num('rise') ?? 0} units={units} nonNegative disabled={readOnly} onCommit={(v) => { set('rise', v === 0 ? null : v); }} />
        </>
      ) : null}
      {member === 'trees' ? (
        <>
          <LengthField label="Height" value={num('height')} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) set('height', v); }} />
          <LengthField label="Spread" value={num('spread')} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null) set('spread', v); }} />
          <Row label="Form">
            <SegmentedControl aria-label="Tree form" size="sm" value={r['form'] === 'evergreen' ? 'evergreen' : 'deciduous'} items={[{ value: 'deciduous', label: 'Deciduous' }, { value: 'evergreen', label: 'Evergreen' }]} onValueChange={(v) => { set('form', v === 'evergreen' ? 'evergreen' : null); }} />
          </Row>
        </>
      ) : null}
      {!readOnly ? (
        <Button variant="ghost" size="sm" onClick={() => { contextOf(store).set({ selected: null }); void store.apply(`Remove ${id}`, removeContext(member, id)); }}>
          Remove {id}
        </Button>
      ) : null}
    </Section>
  );
}
