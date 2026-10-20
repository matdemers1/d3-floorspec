import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, IconButton, Input, SegmentedControl, StatusDot } from '@d3cloud/ui';
import { LandPlot, X } from 'lucide-react';
import { gradeAt, type DerivedSite } from '@floorspec/engine';
import type { EditorStore, ToolId } from '../store';
import type { EditorModel, LevelView } from '../model';
import { formatLen, type UnitSystem } from '../units';
import { LengthField, Row, Section } from '../fields';
import { siteDrawingOf } from './Layer';
import './site.css';
import { useSite, siteOf } from './state';
import { benchmarkOf, fitHousePad, FT, heightText, housePadOf, parseHeight, removeLot, removeRecord, setBenchmark, setElevation, setSetback, type SetbackKind, type SiteMember } from './ops';

/**
 * The Site panel (FLR-T-15.1, the P15 board's "15.1 · Site" and "15.1 · Terrain" frames): in Landscape
 * mode with nothing selected, and beside the site's tools. The lot as Core's site boundary draws it, its
 * setbacks — values a person types, drawn and advised on, never checked against a code (FLR-ADR-011) —
 * the terrain the survey makes, the grade at the house, and the cut and fill of each graded outline:
 * estimates from the triangulated surface, never an engineered grading plan.
 */

const YD3 = 1_170_432 ** 3;
const yd3 = (v: string | null): string => (v === null ? '—' : `${(Number(BigInt(v) / 1_000_000n) / (YD3 / 1e6)).toFixed(1)} yd³`);
const ft2 = (area: string): number => Number(area.replace(/\.5$/, '')) / (FT * FT);
const signed = (v: number, units: UnitSystem) => `${v >= 0 ? '+' : '−'}${formatLen(Math.abs(Math.round(v)), units)}`;

/** A height in the survey's datum, typed in feet: "811.25". */
function HeightField({ label, value, placeholder, onCommit, disabled, hint }: { label: string; value: string; placeholder?: string; onCommit: (text: string) => boolean; disabled?: boolean; hint?: string }) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (text.trim() === value.trim()) return;
    if (onCommit(text.trim())) setError(null);
    else setError('Type a height in feet, as 811.25.');
  };
  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        invalid={error !== null}
        inputMode="decimal"
        autoComplete="off"
        aria-describedby={error !== null ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
          if (error !== null) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // committed on blur: the plan's keys work again at once
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            editing.current = false;
            setText(value);
            setError(null);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {error !== null ? (
        <p id={`${id}-error`} className="fs-field-error" role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="fs-note">
          {hint}
        </p>
      ) : null}
    </Row>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="fs-site__facts">
      {rows.map(([k, v]) => (
        <div key={k} className="fs-site__fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const TOOL_HINTS: Partial<Record<ToolId, string>> = {
  lot: 'Click the lot’s corners, then the first again or Enter. The lot is the site’s boundary.',
  setback: 'Click the lot edge on the street: it becomes the front, the edges beside it the sides, the rest the rear.',
  spot: 'Click to place a spot at the height above — or, with it empty, at the ground’s height there.',
  contour: 'Click along the line, then double-click or Enter. A contour line is a line of spots at one height.',
  pad: 'Click the pad’s corners. Inside it the ground is cut or filled to its height.',
};

export function SitePanel({ store, model, level, units, readOnly, tool }: { store: EditorStore; model: EditorModel; level: LevelView; units: UnitSystem; readOnly: boolean; tool?: ToolId }) {
  const site = siteDrawingOf(model);
  const derived = (model.derived?.extensions as { FS_site?: DerivedSite } | undefined)?.FS_site;
  const state = useSite(store, (s) => s);
  const bench = benchmarkOf(model);
  const edit = (label: string, batch: Parameters<EditorStore['apply']>[1]) => void store.apply(label, batch);
  const lot = derived?.lot ?? null;
  const surface = site.surface;
  const area = lot === null ? null : ft2(lot.area);
  const streetEdges = site.edges.filter((e) => e.kind === 'front');
  const sideEdges = site.edges.filter((e) => e.kind === 'side');
  const frontage = streetEdges.reduce((s, e) => s + e.length, 0);
  const depth = sideEdges.length === 0 ? null : sideEdges.reduce((s, e) => s + e.length, 0) / sideEdges.length;
  const mid = (e: (typeof site.edges)[number]): [number, number] => [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2];
  const gradeOfEdges = (es: typeof site.edges) => {
    const gs = es.map((e) => (surface === null ? undefined : gradeAt(surface, ...mid(e)))).filter((g): g is number => g !== undefined);
    return gs.length === 0 ? null : gs.reduce((a, b) => a + b, 0) / gs.length;
  };
  const streetGrade = gradeOfEdges(streetEdges);
  const rearGrade = gradeOfEdges(site.edges.filter((e) => e.kind === 'rear'));
  const fall = streetGrade !== null && rearGrade !== null ? rearGrade - streetGrade : null;
  const intrusions = model.diagnostics.filter((d) => d.code === 'FS-SITE-LINT-003');
  const offSurface = model.diagnostics.filter((d) => d.code === 'FS-SITE-LINT-002' || d.code === 'FS-SITE-LINT-001');
  const floor = model.document.levels?.[level.id]?.elevation ?? 0;
  const housePad = housePadOf(model);
  const padDerived = housePad === null ? undefined : derived?.grading[housePad.id];
  const padHigh = padDerived?.high ?? null;
  const padLow = padDerived?.low ?? null;
  const names = new Map<string, string>(site.graded.map((g) => [g.id, g.name ?? (g.kind === 'pad' ? `Pad ${g.id}` : g.id)]));
  const setbacks = site.setbacks;

  const setback = (kind: SetbackKind, value: number | null) => { edit(`Set the ${kind} setback`, setSetback(model, kind, value)); };

  return (
    <section className="fs-site-panel" aria-label="Lot and terrain">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <LandPlot />
        </span>
        <div className="fs-inspector__title">
          <h2>Site</h2>
          <p>{model.document.project.name}{lot === null ? ' · no lot drawn' : ''}</p>
        </div>
      </div>
      {lot !== null && area !== null ? (
        <div className="fs-site__chips" aria-label="The lot at a glance">
          <Badge tone="neutral" size="sm">{(area / 43_560).toFixed(2)} ac</Badge>
          <Badge tone="neutral" size="sm">{Math.round(area).toLocaleString('en-US')} ft²</Badge>
          <Badge tone="neutral" size="sm">{site.edges.length} sides</Badge>
        </div>
      ) : null}
      {tool !== undefined && TOOL_HINTS[tool] !== undefined ? <p className="fs-note fs-site__hint" role="status">{TOOL_HINTS[tool]}</p> : null}

      <Section title="Lot">
        {lot === null ? (
          <p className="fs-note">No lot yet. Draw its corners with the lot tool (⇧B) — the site’s boundary — or import a survey’s.</p>
        ) : (
          <>
            <Facts
              rows={[
                ['Area', `${Math.round(area ?? 0).toLocaleString('en-US')} ft² · ${((area ?? 0) / 43_560).toFixed(2)} ac`],
                ['Frontage', streetEdges.length === 0 ? 'no street edge yet' : formatLen(Math.round(frontage), units)],
                ['Depth', depth === null ? '—' : `${formatLen(Math.round(depth), units)} average`],
                ['Fall to the street', fall === null ? '—' : `${formatLen(Math.round(Math.abs(fall)), units)} · ${depth === null ? '—' : ((Math.abs(fall) / depth) * 100).toFixed(1)} % average${fall < 0 ? ' (rising)' : ''}`],
              ]}
            />
            {!readOnly ? (
              <Button variant="ghost" size="sm" onClick={() => { edit('Remove the lot', removeLot(model)); }}>
                Remove the lot
              </Button>
            ) : null}
          </>
        )}
      </Section>

      {lot !== null ? (
        <Section title="Setbacks · from the boundary">
          {setbacks === null ? <p className="fs-note">Click the street edge with the setback tool (⇧K): the lot gets its front, sides and rear.</p> : null}
          <LengthField label="Front" value={setbacks?.front} units={units} allowEmpty nonNegative disabled={readOnly} placeholder="none" onCommit={(v) => { setback('front', v); }} />
          <LengthField label="Side" value={setbacks?.side} units={units} allowEmpty nonNegative disabled={readOnly} placeholder="none" onCommit={(v) => { setback('side', v); }} />
          <LengthField label="Rear" value={setbacks?.rear} units={units} allowEmpty nonNegative disabled={readOnly} placeholder="none" onCommit={(v) => { setback('rear', v); }} />
          {setbacks !== null ? (
            <p className="fs-site__status" data-testid="setback-status">
              <StatusDot tone={intrusions.length === 0 ? 'neutral' : 'warning'} size="sm">
                {intrusions.length === 0 ? 'The house, its paving and pads sit inside the setbacks' : `${String(intrusions.length)} ${intrusions.length === 1 ? 'thing is' : 'things are'} in a setback: ${intrusions.flatMap((d) => d.elements).slice(0, 4).join(', ')}`}
              </StatusDot>
            </p>
          ) : null}
          <p className="fs-note">Values you type are drawn, never checked against a code. A rules pack brings a jurisdiction’s numbers and still only advises (FLR-ADR-011). Walks and drives cross the front setback by design.</p>
        </Section>
      ) : null}

      <Section title="Terrain">
        {surface === null ? (
          <p className="fs-note">No surface yet: place three spot elevations (⇧E) or draw contour lines (⇧C). Their points make one triangulated surface.</p>
        ) : (
          <Facts
            rows={[
              ['Source', `${String(site.spots.length)} spots · ${String(site.contours.length)} contour lines`],
              ['Surface', `${String(surface.points.length)} points · ${String(surface.triangles.length)} triangles`],
              ['Range', `${heightText(surface.low, bench)}′ – ${heightText(surface.high, bench)}′`],
            ]}
          />
        )}
        <HeightField
          label="First floor"
          value={heightText(floor, bench)}
          disabled={readOnly}
          hint="The survey’s height of this level’s floor: every height here is in the survey’s datum."
          onCommit={(t) => {
            const z = parseHeight(t, 0);
            if (z === null) return false;
            edit('Set the survey’s benchmark', setBenchmark(model, z - floor));
            return true;
          }}
        />
        <Row label="Contour interval">
          <SegmentedControl
            aria-label="Contour interval"
            size="sm"
            value={String(state.interval)}
            items={[{ value: '0.5', label: '6″' }, { value: '1', label: '1′' }, { value: '2', label: '2′' }, { value: '5', label: '5′' }]}
            onValueChange={(v) => { siteOf(store).set({ interval: Number(v) }); }}
          />
        </Row>
        <p className="fs-note">Every fifth contour is a major one. The interval is your view; the survey is the model.</p>
      </Section>

      <Section title="Next to place">
        <HeightField label="Spot elevation" value={state.spot} placeholder="the ground’s" disabled={readOnly} onCommit={(t) => { siteOf(store).set({ spot: t }); return t === '' || parseHeight(t, bench) !== null; }} />
        <HeightField label="Contour line" value={state.contour} placeholder="813" disabled={readOnly} onCommit={(t) => { siteOf(store).set({ contour: t }); return t === '' || parseHeight(t, bench) !== null; }} />
        <HeightField label="Grade pad" value={state.pad} placeholder={`${heightText(floor - 8 * 32_512, bench)} (8″ under the floor)`} disabled={readOnly} onCommit={(t) => { siteOf(store).set({ pad: t }); return t === '' || parseHeight(t, bench) !== null; }} />
      </Section>

      <Section title="Grade at the house">
        <Facts
          rows={[
            ['Finished floor', `${heightText(floor, bench)}′`],
            ['Grade · high', padHigh === null ? '—' : `${heightText(padHigh, bench)}′ · ${signed(padHigh - floor, units)}`],
            ['Grade · low', padLow === null ? '—' : `${heightText(padLow, bench)}′ · ${signed(padLow - floor, units)}`],
          ]}
        />
        {housePad !== null ? (
          <HeightField
            label="House pad"
            value={heightText(housePad.elevation, bench)}
            disabled={readOnly}
            onCommit={(t) => {
              const z = parseHeight(t, bench);
              if (z === null) return false;
              edit('Set the house pad’s height', setElevation('pads', housePad.id, z));
              return true;
            }}
          />
        ) : null}
        {!readOnly ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const batch = fitHousePad(model, level);
              if (batch === null) store.set({ notice: { tone: 'info', text: 'This level has no walls to fit a pad to.' } });
              else edit(housePad === null ? 'Set the house on a pad' : 'Fit the pad to the house', batch);
            }}
          >
            {housePad === null ? 'Set the house on a pad' : 'Fit the pad to the house'}
          </Button>
        ) : null}
        <p className="fs-note">The ground moves, the house does not: its pad, its terrace and its walks cut and fill the ground to their own heights.</p>
      </Section>

      <Section title="Cut and fill · estimates">
        {derived === undefined || derived.cut === null ? (
          <p className="fs-note">Nothing is measured until there is a surface.</p>
        ) : (
          <>
            <table className="fs-site__table" aria-label="Cut and fill">
              <thead>
                <tr>
                  <th scope="col">Graded</th>
                  <th scope="col">Cut</th>
                  <th scope="col">Fill</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(derived.grading).map(([id, g]) => (
                  <tr key={id}>
                    <th scope="row">{names.get(id) ?? id}</th>
                    <td>{yd3(g.cut)}</td>
                    <td>{yd3(g.fill)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td data-testid="cut-total">{yd3(derived.cut)}</td>
                  <td data-testid="fill-total">{yd3(derived.fill)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="fs-site__legend">
              <span className="fs-site__swatch fs-site__swatch--cut" aria-hidden="true" /> Cut · hatched
              <span className="fs-site__swatch fs-site__swatch--fill" aria-hidden="true" /> Fill · dashed
            </p>
            {offSurface.length > 0 ? <p className="fs-note">Part of the site runs beyond the survey: what is graded there is not measured.</p> : null}
            <p className="fs-note">Estimated from the triangulated surface — advisory, not an engineered grading plan.</p>
          </>
        )}
      </Section>

      <Section title="Survey and pads">
        <RecordList store={store} readOnly={readOnly} member="spots" title="Spots" rows={site.spots.map((s) => [s.id, `${s.name === undefined ? '' : `${s.name} · `}${heightText(s.elevation, bench)}′`])} />
        <RecordList store={store} readOnly={readOnly} member="contours" title="Contour lines" rows={site.contours.map((c) => [c.id, `${heightText(c.elevation, bench)}′ · ${String(c.points.length)} points`])} />
        <RecordList store={store} readOnly={readOnly} member="pads" title="Pads" rows={site.graded.filter((g) => g.kind === 'pad').map((g) => [g.id, `${g.name === undefined ? '' : `${g.name} · `}${heightText(g.elevation, bench)}′`])} />
      </Section>
    </section>
  );
}

function RecordList({ store, readOnly, member, title, rows }: { store: EditorStore; readOnly: boolean; member: SiteMember; title: string; rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="fs-site__records">
      <h4 className="fs-mode-summary__title">{title}</h4>
      <ul>
        {rows.map(([id, text]) => (
          <li key={id} className="fs-site__record">
            <span className="fs-site__record-id">{id}</span>
            <span className="fs-site__record-text">{text}</span>
            {!readOnly ? <IconButton label={`Remove ${id}`} icon={<X />} size="sm" onClick={() => { void store.apply(`Remove ${id}`, removeRecord(member, id)); }} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
