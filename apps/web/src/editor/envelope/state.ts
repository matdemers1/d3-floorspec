import { useMemo, useSyncExternalStore } from 'react';
import { BTUH_TO_W, estimateEnergy, EstimateError, R_SI_TO_IP, range, type EnergyEstimate, type LossBand, type UnitSystem } from '@floorspec/analysis';
import { useEditor, type EditorStore } from '../store';
import type { EditorModel } from '../model';

/**
 * The thermal envelope in the editor (FLR-T-16.4): the heat-loss map's state beside the 3D view's — is
 * it drawn, is its panel open — and the estimate the wall type, room and 3D views all read, worked out
 * in the browser by @floorspec/analysis from the design shown, once per version and design. View
 * state only: nothing here is written to the document.
 */

export interface EnvelopeState {
  /** The map is drawn over the 3D view. */
  on: boolean;
  /** Its panel is open over the view. */
  open: boolean;
}

export class EnvelopeStore {
  private state: EnvelopeState = { on: false, open: false };
  private readonly listeners = new Set<() => void>();
  get = (): EnvelopeState => this.state;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<EnvelopeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  /** On (and the panel open) or off. */
  toggle(on: boolean = !this.state.on): void {
    this.set(on ? { on: true, open: true } : { on: false, open: false });
  }
}

const stores = new WeakMap<EditorStore, EnvelopeStore>();
export function envelopeOf(store: EditorStore): EnvelopeStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new EnvelopeStore();
    stores.set(store, s);
  }
  return s;
}

export function useEnvelope<T>(store: EditorStore, selector: (s: EnvelopeState) => T): T {
  const e = envelopeOf(store);
  return useSyncExternalStore(e.subscribe, () => selector(e.get()), () => selector(e.get()));
}

/** The estimate of a model's design, or why there is none. */
export type Envelope = { status: 'ok'; estimate: EnergyEstimate } | { status: 'none'; message: string };

const estimates = new WeakMap<EditorModel, Envelope>();

/** The estimate of the design a model shows: worked out once per model. */
export function envelopeEstimate(model: EditorModel): Envelope {
  let e = estimates.get(model);
  if (e === undefined) {
    try {
      e = { status: 'ok', estimate: estimateEnergy(model.document, { design: model.design, compare: false }) };
    } catch (error) {
      if (!(error instanceof EstimateError)) throw error;
      e = { status: 'none', message: `Nothing to estimate: ${error.message}.` };
    }
    estimates.set(model, e);
  }
  return e;
}

/** The estimate of the model shown, while there is one. */
export function useEnvelopeEstimate(store: EditorStore): Envelope | null {
  const model = useEditor(store, (s) => s.model);
  return useMemo(() => (model === null ? null : envelopeEstimate(model)), [model]);
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────

const FT2_PER_M2 = 10.76391;

/** A load as a range: "6,200–9,400 Btu/h" or "1,800–2,800 W". */
export function wattsRange(watts: number, units: UnitSystem): string {
  return units === 'imperial' ? `${range(watts / BTUH_TO_W).text} Btu/h` : `${range(watts).text} W`;
}

/** Heat per area of floor or surface, in the legend's unit: Btu/h per ft² or W/m². */
export function perAreaText(btuhPerFt2: number, units: UnitSystem): string {
  return units === 'imperial' ? `${String(Math.round(btuhPerFt2))} Btu/h per ft²` : `${String(Math.round(btuhPerFt2 * BTUH_TO_W * FT2_PER_M2))} W/m²`;
}

/** An R-value in the system's words: "R-24" or "RSI 4.2". */
export function rIn(rSI: number, units: UnitSystem): string {
  if (units === 'metric') return `RSI ${rSI.toFixed(rSI >= 10 ? 0 : rSI >= 1 ? 1 : 2)}`;
  const r = rSI * R_SI_TO_IP;
  return `R-${r >= 10 ? String(Math.round(r)) : r >= 1 ? (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, '') : (Math.round(r * 10) / 10).toFixed(1)}`;
}

/** A U-factor in the system's words: "U-0.042" or "U 0.24 W/m²K". */
export function uIn(uSI: number, units: UnitSystem): string {
  if (units === 'metric') return `U ${uSI.toFixed(2)} W/m²K`;
  const u = uSI / R_SI_TO_IP;
  return `U-${u >= 0.1 ? u.toFixed(2) : u.toFixed(3)}`;
}

/** The four bands, high first, with the legends' words. */
export const BANDS: readonly { id: LossBand; label: string }[] = [
  { id: 'high', label: 'High' },
  { id: 'raised', label: 'Raised' },
  { id: 'typical', label: 'Typical' },
  { id: 'low', label: 'Low' },
];
