import { useSyncExternalStore } from 'react';
import { solarDrawing, usesEnergy, type SolarDrawing } from '@floorspec/engine';
import { estimateSolar, type SolarEstimate } from '@floorspec/analysis';
import { proposeSolar, type SolarOptions, type SolarProposal } from '@floorspec/assistant-solar';
import type { EditorModel } from '../model';
import type { EditorStore } from '../store';

/**
 * Solar in the editor (FLR-T-16.1, FS_energy): what the plan, the panel and the inspector read from a
 * model — its arrays and roof faces drawn (the engine's `solarDrawing`), each array's production estimate
 * (@floorspec/analysis), and what the solar assistant would propose (@floorspec/assistant-solar, the same
 * package the server runs) — each worked out once per model. Beside it, the viewer's own state: the face
 * picked on the plan and how the assistant is asked to size. What a person keeps is FS_energy in the
 * document, written as Ops.
 */

const drawings = new WeakMap<EditorModel, SolarDrawing>();
const estimates = new WeakMap<EditorModel, SolarEstimate>();
const proposals = new WeakMap<EditorModel, Map<string, SolarProposal | string>>();

export function solarDrawingOf(model: EditorModel): SolarDrawing {
  let d = drawings.get(model);
  if (d === undefined) {
    d = solarDrawing(model.view);
    drawings.set(model, d);
  }
  return d;
}

/** The production estimate of the model's arrays; empty when it has none. */
export function solarEstimateOf(model: EditorModel): SolarEstimate {
  let e = estimates.get(model);
  if (e === undefined) {
    e = estimateSolar(model.view, { drawing: solarDrawingOf(model) });
    estimates.set(model, e);
  }
  return e;
}

/** What the assistant would propose for these options, or why it cannot. */
export function proposalOf(model: EditorModel, options: SolarOptions = {}): SolarProposal | string {
  const key = JSON.stringify(options);
  let m = proposals.get(model);
  if (m === undefined) {
    m = new Map();
    proposals.set(model, m);
  }
  let p = m.get(key);
  if (p === undefined) {
    try {
      p = proposeSolar(model.document, options);
    } catch (error) {
      p = error instanceof Error ? error.message : 'the assistant could not read this plan';
    }
    m.set(key, p);
  }
  return p;
}

export const hasSolar = (model: EditorModel): boolean => usesEnergy(model.view) && solarDrawingOf(model).arrays.length > 0;

/** How the assistant sizes: to the house's use, to kWh a year, or every face worth it. */
export type Sizing = 'use' | 'kwh' | 'fill';

export interface SolarState {
  /** The roof face picked on the plan, by key (`RF1:0`, `RF3`). */
  face: string | null;
  sizing: Sizing;
  /** kWh a year, when sizing to kWh. */
  kwh: number;
  /** The share of the best face a face must make. */
  cutoff: number;
}

const DEFAULTS: SolarState = { face: null, sizing: 'use', kwh: 12_000, cutoff: 0.75 };

export class SolarStore {
  private state: SolarState = DEFAULTS;
  private readonly listeners = new Set<() => void>();
  get = (): SolarState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  set(patch: Partial<SolarState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}

const stores = new WeakMap<EditorStore, SolarStore>();

export function solarOf(store: EditorStore): SolarStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new SolarStore();
    stores.set(store, s);
  }
  return s;
}

export function useSolarState<T>(store: EditorStore, selector: (s: SolarState) => T): T {
  const s = solarOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}

/** The assistant's options for the panel's sizing. */
export function optionsOf(s: SolarState): SolarOptions {
  return { cutoff: s.cutoff, ...(s.sizing === 'kwh' ? { target: { kind: 'kwh', kwh: s.kwh } } : s.sizing === 'fill' ? { target: { kind: 'fill' } } : {}) };
}

/** kWh a year as the board writes it: "12,000–18,000 kWh". */
export const kwhRange = (low: number, high: number): string => `${low.toLocaleString('en-US')}–${high.toLocaleString('en-US')} kWh`;
