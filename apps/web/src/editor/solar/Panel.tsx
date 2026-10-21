import { useState } from 'react';
import { Badge, Button, SegmentedControl } from '@d3cloud/ui';
import { GitPullRequestArrow, Sparkles, Sun } from 'lucide-react';
import { compassOf, type DerivedEnergy } from '@floorspec/engine';
import { MONTH_LETTERS, MONTH_NAMES, PV_ADVISORY, type ArrayEstimate } from '@floorspec/analysis';
import type { EditorStore } from '../store';
import type { EditorModel } from '../model';
import { formatLen, type UnitSystem } from '../units';
import { IntField, Row, Section } from '../fields';
import { modesOf, type LayerState } from '../modes';
import { api, messageOf } from '../../lib/api';
import { openReview, refreshProposals } from '../review';
import { useSolarShown } from './Layer';
import { proposeSolar } from '@floorspec/assistant-solar';
import { kwhRange, optionsOf, proposalOf, solarDrawingOf, solarEstimateOf, solarOf, useSolarState, type Sizing } from './data';
import './solar.css';

/**
 * Solar in Electrical mode (FLR-T-16.1, the P16 board's "16.1 · Solar on the roof" and "16.1 · Solar
 * assistant" frames): beside the solar tool, the roof's faces ranked by what a kW makes on them in a typical
 * year after shade, the assistant's proposal — opened as a pending changeset, never main (FLR-ADR-016) — an
 * array laid on a picked face, and the Solar layer On, Ghost or Off. Every predicted number is a range with
 * its method one line away: an estimate to compare layouts, never a guarantee, and no code is checked.
 */

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;
const kw = (w: number): string => `${(w / 1000).toFixed(1)} kW`;

export function SolarPanel({ store, model, units, readOnly }: { store: EditorStore; model: EditorModel; units: UnitSystem; readOnly: boolean }) {
  const state = useSolarState(store, (s) => s);
  const show = useSolarShown(store);
  const drawing = solarDrawingOf(model);
  const est = solarEstimateOf(model);
  const proposal = proposalOf(model, optionsOf(state));
  const picked = state.face === null ? undefined : drawing.faces.find((f) => f.key === state.face);
  const onFace = picked === undefined ? null : proposalOf(model, { faces: [picked.key] });
  const [busy, setBusy] = useState(false);
  const set = (patch: Parameters<ReturnType<typeof solarOf>['set']>[0]) => { solarOf(store).set(patch); };

  const review = async () => {
    setBusy(true);
    try {
      const body = state.sizing === 'kwh' ? { kwh: state.kwh, cutoff: state.cutoff } : state.sizing === 'fill' ? { fill: true, cutoff: state.cutoff } : { cutoff: state.cutoff };
      const answer = await api.post<{ changeset: { id: string } | null }>(`/api/projects/${store.projectId}/assistants/solar`, body);
      if (answer.changeset === null) store.set({ notice: { tone: 'info', text: 'Nothing to lay out: every face worth it already has an array, or none fits a row inside its setbacks.' } });
      else {
        await refreshProposals(store);
        await openReview(store, answer.changeset.id);
      }
    } catch (error) {
      store.set({ notice: { tone: 'danger', text: messageOf(error) } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="fs-solar-panel" aria-label="Solar">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon">
          <Sun />
        </span>
        <div className="fs-inspector__title">
          <h2>Electrical · solar</h2>
          <p>Arrays on the roof faces · FS_energy</p>
        </div>
      </div>
      <div className="fs-solar__chips" aria-label="Solar at a glance">
        <Badge tone="neutral" size="sm">{drawing.arrays.length === 1 ? '1 array' : `${String(drawing.arrays.length)} arrays`}</Badge>
        <Badge tone="neutral" size="sm">{est.total.modules} modules</Badge>
        <Badge tone="neutral" size="sm">{est.total.kw.toFixed(1)} kW</Badge>
        {drawing.arrays.length > 0 ? <Badge tone="neutral" size="sm">Estimate</Badge> : null}
      </div>
      <p className="fs-note fs-solar__hint" role="status">
        Click an array to see its year; click a roof face to lay an array on it. Arrays keep {formatLen(drawing.setbacks.eave, units)} from eaves and {formatLen(drawing.setbacks.ridge, units)} from ridges and rakes — Floorspec’s defaults, not a code’s.
      </p>

      {drawing.arrays.length > 0 ? (
        <Section title="A year · estimate ±20%">
          <dl className="fs-solar__facts" data-testid="solar-total">
            <div className="fs-solar__fact"><dt>Production</dt><dd>{kwhRange(est.total.low, est.total.high)}</dd></div>
          </dl>
          <MonthBars monthly={est.total.monthly} label="Every array, by month" />
          <p className="fs-note" data-testid="solar-advisory">{est.methodText}</p>
        </Section>
      ) : null}

      {picked !== undefined ? (
        <Section title={`${picked.roofName ?? picked.roof} · ${picked.bearing === null ? 'flat roof' : `faces ${compassOf(picked.bearing)} · ${String(picked.pitch?.rise ?? 0)}:${String(picked.pitch?.run ?? 12)}`}`}>
          {typeof onFace === 'string' ? (
            <p className="fs-note">{onFace.charAt(0).toUpperCase() + onFace.slice(1)}.</p>
          ) : onFace?.arrays[0] === undefined ? (
            <p className="fs-note">{onFace?.faces[0]?.reason === undefined ? 'Nothing fits a row of modules inside this face’s setbacks.' : `Not here: ${onFace.faces[0].reason}.`}</p>
          ) : (
            <FaceFit store={store} model={model} face={picked.key} label={picked.roofName ?? picked.roof} fit={onFace.arrays[0]} readOnly={readOnly} />
          )}
        </Section>
      ) : null}

      <Section title="Solar assistant · whole roof">
        {typeof proposal === 'string' ? (
          <p className="fs-note">{proposal.charAt(0).toUpperCase() + proposal.slice(1)}.</p>
        ) : (
          <>
            <Row label="Size to">
              <SegmentedControl
                aria-label="Size to"
                size="sm"
                value={state.sizing}
                items={[{ value: 'use', label: 'House’s use' }, { value: 'kwh', label: 'kWh a year' }, { value: 'fill', label: 'Fill' }]}
                onValueChange={(v) => { set({ sizing: v as Sizing }); }}
              />
            </Row>
            {state.sizing === 'kwh' ? <IntField label="kWh a year" value={state.kwh} min={100} max={1_000_000} unit="kWh" onCommit={(v) => { if (v !== null) set({ kwh: v }); }} /> : null}
            <IntField label="Use a face making at least" value={Math.round(state.cutoff * 100)} min={0} max={100} unit="% of the best" onCommit={(v) => { if (v !== null) set({ cutoff: v / 100 }); }} />
            <h4 className="fs-mode-summary__title">Faces, ranked · kWh per kW a year</h4>
            <ol className="fs-solar__faces" data-testid="solar-faces">
              {proposal.faces.map((f) => (
                <li key={f.key} className="fs-solar__face" data-status={f.status}>
                  <span className="fs-solar__face-name">{f.roofName ?? f.roof} · {f.facing}</span>
                  <span className="fs-solar__face-value">{f.perKw > 0 ? `≈ ${Math.round(f.perKw).toLocaleString('en-US')}` : '—'}{f.status === 'skipped' ? ' · skipped' : ''}</span>
                </li>
              ))}
            </ol>
            {proposal.arrays.length > 0 ? (
              <>
                <h4 className="fs-mode-summary__title">What it would add</h4>
                <ul className="fs-solar__adds" data-testid="solar-adds">
                  {proposal.arrays.map((a) => (
                    <li key={a.id}>
                      <span>+ {a.modules} panels · {a.name}</span>
                      <span className="fs-solar__muted">{a.facing} · {kwhRange(a.low, a.high)} a year</span>
                    </li>
                  ))}
                  {proposal.inverter !== null && proposal.circuit !== null ? (
                    <li>
                      <span>+ 1 inverter · {kw(proposal.inverter.watts)} hybrid</span>
                      <span className="fs-solar__muted">beside the panel · {proposal.shutdown ?? ''} rapid shutdown · {proposal.circuit}</span>
                    </li>
                  ) : null}
                </ul>
                <p className="fs-note">
                  {proposal.total.modules} panels · {proposal.total.kw.toFixed(1)} kW · {kwhRange(proposal.total.low, proposal.total.high)} a year
                  {proposal.target === null ? '' : ` · sized to ${proposal.target.source}`}.
                </p>
              </>
            ) : (
              <p className="fs-note">Nothing more to lay out: every face worth it has an array, or none fits a row inside its setbacks.</p>
            )}
            <p className="fs-note">An estimate from latitude, azimuth, tilt and shade (packages/analysis), ±20%. No code is checked or cited. It opens as a pending changeset: main is unchanged until it is accepted.</p>
            {!readOnly ? (
              <Button variant="primary" size="sm" icon={<GitPullRequestArrow />} loading={busy} disabled={proposal.arrays.length === 0} onClick={() => void review()}>
                Review as changeset
              </Button>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Show">
        <SegmentedControl
          aria-label="Show solar"
          size="sm"
          value={show}
          items={[{ value: 'on', label: 'On' }, { value: 'ghost', label: 'Ghost' }, { value: 'off', label: 'Off' }]}
          onValueChange={(v) => { modesOf(store).setLayer('solar', v as LayerState); }}
        />
      </Section>
    </section>
  );
}

/**
 * An array laid on one face, as ops on the plan shown. Its IDs are the assistant's next free ones; an ID a
 * changeset retired is refused (FS-OPS-005), and the batch is built again with it set aside.
 */
function FaceFit({ store, model, face, label, fit, readOnly }: { store: EditorStore; model: EditorModel; face: string; label: string; fit: { id: string; modules: number; rows: number; columns: number; layout: string; mount: string; kw: number; low: number; high: number; perKw: number }; readOnly: boolean }) {
  const place = () => {
    const tried = new Set<string>();
    const build = (): never => {
      const p = proposeSolar(model.document, { faces: [face], retired: [...tried] });
      for (const op of p.batch as { id?: string; path?: string }[]) {
        if (typeof op.id === 'string' && op.id !== '$document') tried.add(op.id);
        const c = /\/circuits\/([^/]+)$/.exec(op.path ?? '');
        if (c?.[1] !== undefined) tried.add(c[1]);
      }
      return p.batch as never;
    };
    solarOf(store).set({ face: null });
    void store.apply(`Place an array on ${label}`, build, { select: (created) => created.find((id) => id.startsWith('PV')) ?? null });
  };
  return (
    <>
      <p className="fs-note" data-testid="solar-face-fit">
        {fit.modules} modules ({fit.rows} × {fit.columns}, {fit.layout}, {fit.mount}) · {fit.kw.toFixed(1)} kW · {kwhRange(fit.low, fit.high)} a year · ≈ {Math.round(fit.perKw).toLocaleString('en-US')} kWh a kW
      </p>
      {!readOnly ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={place}
        >
          Place an array here
        </Button>
      ) : null}
    </>
  );
}

/** Twelve bars, one a month, in the info colour: the board's P16 production chart. */
export function MonthBars({ monthly, label }: { monthly: readonly number[]; label: string }) {
  const top = Math.max(1, ...monthly);
  return (
    <figure className="fs-solar__months" aria-label={label}>
      <div className="fs-solar__bars">
        {monthly.map((v, i) => (
          <span key={i} className="fs-solar__bar" title={`${MONTH_NAMES[i] ?? ''}: about ${Math.round(v).toLocaleString('en-US')} kWh`} style={{ height: `${String(Math.max(4, Math.round((v / top) * 100)))}%` }} />
        ))}
      </div>
      <div className="fs-solar__letters" aria-hidden="true">
        {MONTH_LETTERS.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </figure>
  );
}

/** The inspector of a selected array (the board's "Array · PV1"): its panels, its face and shade, its year, its circuits. */
export function ArrayBody({ store, model, id, units, readOnly, heading = false }: { store: EditorStore; model: EditorModel; id: string; units: UnitSystem; readOnly: boolean; heading?: boolean }) {
  const drawing = solarDrawingOf(model);
  const a = drawing.arrays.find((x) => x.id === id);
  const est: ArrayEstimate | undefined = solarEstimateOf(model).arrays.find((x) => x.id === id);
  const derived = (model.derived?.extensions as { FS_energy?: DerivedEnergy } | undefined)?.FS_energy?.arrays[id];
  const el = (model.document.extensions as Record<string, { collections?: { pvArrays?: Record<string, { module?: { watts?: number } }> } }> | undefined)?.['FS_energy']?.collections?.pvArrays?.[id];
  if (a === undefined || est === undefined) return <p className="fs-note">This array is not placed on a roof face this reader can draw.</p>;
  const set = (path: string, value: unknown) => { void store.apply(`Change ${id}`, [{ op: 'setProperty', id, path, value }] as never, { select: () => id }); };
  const facing = a.bearing === null ? 'flat' : `${String(Math.round(a.bearing))}° ${compassOf(a.bearing)}`;
  const pitch = derived?.pitch === null || derived?.pitch === undefined ? 'flat' : `${String(derived.pitch.rise)}:${String(derived.pitch.run)}`;
  const inverter = a.inverter === null ? null : drawing.inverters.find(([iid]) => iid === a.inverter);
  return (
    <div className="fs-solar-array" data-testid="solar-array">
      {heading ? (
        <div className="fs-inspector__head">
          <span className="fs-inspector__icon">
            <Sun />
          </span>
          <div className="fs-inspector__title">
            <h2>Array · {id}</h2>
            <p>{a.name ?? a.roof} · FS_energy array</p>
          </div>
        </div>
      ) : null}
      <div className="fs-solar__chips" aria-label={`${id} at a glance`}>
        <Badge tone="neutral" size="sm">{a.modules.length} panels</Badge>
        <Badge tone="neutral" size="sm">{(a.watts / 1000).toFixed(1)} kW</Badge>
        <Badge tone="neutral" size="sm">{a.bearing === null ? 'flat' : `${String(Math.round(a.bearing))}°`} · {pitch}</Badge>
        <Badge tone="neutral" size="sm">Estimate</Badge>
        {a.clear === false ? <Badge tone="warning" size="sm">Inside a setback</Badge> : null}
      </div>
      <Section title="Panels">
        <IntField label="Panel" value={el?.module?.watts} min={1} max={100_000} unit="W per panel" disabled={readOnly} onCommit={(v) => { if (v !== null) set('/module/watts', v); }} />
        <IntField label="Rows" value={a.rows} min={1} max={1000} disabled={readOnly} onCommit={(v) => { if (v !== null) set('/rows', v); }} />
        <IntField label="Columns" value={a.columns} min={1} max={1000} disabled={readOnly} onCommit={(v) => { if (v !== null) set('/columns', v); }} />
        <dl className="fs-solar__facts">
          <div className="fs-solar__fact"><dt>Layout</dt><dd>{a.rows} rows × {a.columns} · {a.layout}{a.mount === 'racked' ? ' · racked' : ''}</dd></div>
          <div className="fs-solar__fact"><dt>Setbacks</dt><dd>{formatLen(drawing.setbacks.ridge, units)} ridge · {formatLen(drawing.setbacks.eave, units)} eave · {formatLen(drawing.setbacks.rake, units)} rakes</dd></div>
        </dl>
      </Section>
      <Section title="Orientation and shade">
        <dl className="fs-solar__facts">
          <div className="fs-solar__fact"><dt>Face</dt><dd>{a.bearing === null ? 'flat' : `faces ${facing}`} · tilt {String(Math.round(a.tilt))}°</dd></div>
          <div className="fs-solar__fact"><dt>Shade</dt><dd>{pct(est.shade)} a year{est.shadedBy.length > 0 ? ` · ${est.shadedBy.join(', ')}` : ''}</dd></div>
        </dl>
      </Section>
      <Section title="A year · estimate ±20%">
        <dl className="fs-solar__facts">
          <div className="fs-solar__fact fs-solar__fact--lead"><dt>Production</dt><dd data-testid="solar-production">{kwhRange(est.low, est.high)}</dd></div>
        </dl>
        <MonthBars monthly={est.monthly} label={`${id} by month`} />
        <dl className="fs-solar__facts">
          <div className="fs-solar__fact"><dt>Per kW</dt><dd>≈ {Math.round(est.perKw).toLocaleString('en-US')} kWh/kW · {Math.abs(solarEstimateOf(model).site.latitude).toFixed(1)}° {solarEstimateOf(model).site.latitude >= 0 ? 'N' : 'S'}</dd></div>
          <div className="fs-solar__fact"><dt>Worst month</dt><dd>{MONTH_NAMES[est.worst.month]} · {pct(est.worst.share)} shaded</dd></div>
        </dl>
      </Section>
      <Section title="On circuits">
        <dl className="fs-solar__facts">
          <div className="fs-solar__fact"><dt>Inverter</dt><dd>{inverter === null || inverter === undefined ? 'none yet' : `${inverter[0]} · ${(inverter[1].watts / 1000).toFixed(1)} kW ${inverter[1].kind ?? 'string'}`}</dd></div>
          <div className="fs-solar__fact"><dt>Rapid shutdown</dt><dd>{a.rapidShutdown === 'module' ? 'at each module' : 'at the array'}</dd></div>
        </dl>
        <p className="fs-note" data-testid="solar-method">{solarEstimateOf(model).methodText}</p>
        <p className="fs-note">{PV_ADVISORY}</p>
      </Section>
      {!readOnly ? (
        <Button variant="secondary" size="sm" icon={<Sparkles />} onClick={() => { store.select(null); store.setTool('solar'); }}>
          Ask the assistant to lay out the roof
        </Button>
      ) : null}
    </div>
  );
}
