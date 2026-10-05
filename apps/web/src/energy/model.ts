import {
  CLIMATE_PRESETS,
  cToF,
  ENERGY_PATH,
  estimateEnergy,
  EstimateError,
  F_IP_TO_SI,
  fToC,
  U_IP_TO_SI,
  type AssemblyRow,
  type EnergyEstimate,
  type EnergyInputs,
  type UnitSystem,
} from '@floorspec/analysis';
import { setProperty, unsetProperty, type Batch } from '../editor/ops';

/**
 * The energy screen's model (FLR-T-12.6): the estimate of a document, worked out in the browser by
 * the same isomorphic package the server's MCP resource uses (@floorspec/analysis), and the inputs
 * as the dialog edits them — in the project's display units — and as the document stores them, SI,
 * at `/extras/d3floorspec/energy`.
 */

export type Estimated = { status: 'ok'; estimate: EnergyEstimate } | { status: 'none'; message: string };

export function estimateOf(document: object | null): Estimated {
  if (document === null) return { status: 'none', message: 'This project has no model yet.' };
  try {
    return { status: 'ok', estimate: estimateEnergy(document) };
  } catch (error) {
    if (error instanceof EstimateError) return { status: 'none', message: `Nothing to estimate: ${error.message}.` };
    throw error;
  }
}

/** Save the inputs: a setProperty on the document's extras — or unset them all, back to typical. */
export function setInputs(inputs: EnergyInputs, present: boolean): Batch {
  return Object.keys(inputs).length === 0 ? (present ? unsetProperty('$document', ENERGY_PATH) : []) : setProperty('$document', ENERGY_PATH, inputs);
}

/** Whether a document holds energy inputs at all. */
export function hasInputs(document: unknown): boolean {
  const extras = (document as { extras?: { d3floorspec?: { energy?: unknown } } } | null)?.extras;
  return extras?.d3floorspec?.energy !== undefined;
}

export const presetOptions = CLIMATE_PRESETS.map((p) => ({ value: p.zone, label: `${p.zone} · ${p.kind}`, description: `Like ${p.city}: ${String(p.heatingF)} °F / ${String(p.coolingF)} °F design, ${p.hddF.toLocaleString('en-US')} heating degree days` }));

// ─── Units the dialog speaks ─────────────────────────────────────────────────────────────────

/** A temperature in the display unit. */
export const tempIn = (c: number, system: UnitSystem): number => (system === 'imperial' ? round1(cToF(c)) : round1(c));
export const tempOut = (v: number, system: UnitSystem): number => (system === 'imperial' ? fToC(v) : v);
/** Degree days: °F·days or °C·days. */
export const ddIn = (c: number, system: UnitSystem): number => Math.round(system === 'imperial' ? (c * 9) / 5 : c);
export const ddOut = (v: number, system: UnitSystem): number => (system === 'imperial' ? (v * 5) / 9 : v);

/** An assembly's value as the dialog edits it: R (imperial), U (metric); a slab edge's F either way. */
export function assemblyIn(a: Pick<AssemblyRow, 'kind' | 'value'>, system: UnitSystem): number {
  if (a.kind === 'slab') return round2(system === 'imperial' ? a.value / F_IP_TO_SI : a.value);
  return system === 'imperial' ? round1(U_IP_TO_SI / a.value) : round2(a.value);
}
export function assemblyOut(kind: AssemblyRow['kind'], v: number, system: UnitSystem): number {
  if (kind === 'slab') return system === 'imperial' ? v * F_IP_TO_SI : v;
  return system === 'imperial' ? U_IP_TO_SI / v : v;
}
/** What the dialog calls an assembly's value. */
export function assemblyUnit(kind: AssemblyRow['kind'], system: UnitSystem): string {
  if (kind === 'slab') return system === 'imperial' ? 'F-factor, Btu/h·ft·°F' : 'F, W/m·K';
  return system === 'imperial' ? 'R-value, h·ft²·°F/Btu' : 'U, W/m²·K';
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
