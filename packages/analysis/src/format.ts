/**
 * An estimate in words and plain units — what the screen, the dashboard card and MCP show. Loads and
 * yearly figures are ranges (±20%, two significant figures); areas are rounded to what a drawing
 * would print; nothing is shown more precisely than the method is.
 *
 * `imperial`: ft², °F, kBtu/h, R-values (h·ft²·°F/Btu). `metric`: m², °C, kW, U-values (W/(m²·K)).
 * Yearly figures are MWh in both: heat delivered or removed, not fuel.
 */
import { cToF } from './climate.js';
import { BTUH_TO_W, F_IP_TO_SI, SPREAD, U_IP_TO_SI, type AssemblyRow, type EnergyEstimate } from './estimate.js';

export type UnitSystem = 'imperial' | 'metric';

const FT2_PER_M2 = 10.763910;
const FT_PER_M = 3.280840;
const FT3_PER_M3 = 35.314667;

/** Two significant figures. */
export function sig2(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const p = Math.floor(Math.log10(Math.abs(x))) - 1;
  const f = 10 ** p;
  return Math.round(x / f) * f;
}

/** An integer with thousands separators: 12,400. */
export function grouped(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  return (n < 0 && Math.round(n) !== 0 ? '−' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A number of two significant figures, written without float noise: 9.4, 14, 1,200, 0.85. */
export function plain(x: number): string {
  const v = sig2(x);
  const a = Math.abs(v);
  if (a >= 100) return grouped(v);
  const decimals = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  return v.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** `value` ±20% as a range: "25–38". */
export function range(value: number): { low: number; high: number; text: string } {
  const low = sig2(value * (1 - SPREAD));
  const high = sig2(value * (1 + SPREAD));
  return { low, high, text: low === high ? plain(low) : `${plain(low)}–${plain(high)}` };
}

/** A design load (W) as a range in the system's unit. */
export function loadRange(watts: number, system: UnitSystem): { text: string; unit: string } {
  return system === 'imperial' ? { text: range(watts / BTUH_TO_W / 1000).text, unit: 'kBtu/h' } : { text: range(watts / 1000).text, unit: 'kW' };
}

/** A yearly figure (kWh) as a range of MWh. */
export function annualRange(kwh: number): { text: string; unit: string } {
  return { text: range(kwh / 1000).text, unit: 'MWh' };
}

export function area(m2: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const ft2 = m2 * FT2_PER_M2;
    return `${grouped(ft2 >= 100 ? Math.round(ft2 / 10) * 10 : Math.round(ft2))} ft²`;
  }
  return `${m2 >= 10 ? grouped(m2) : (Math.round(m2 * 10) / 10).toFixed(1)} m²`;
}

export function length(m: number, system: UnitSystem): string {
  return system === 'imperial' ? `${grouped(m * FT_PER_M)} ft` : `${grouped(m)} m`;
}

export function volume(m3: number, system: UnitSystem): string {
  return system === 'imperial' ? `${grouped(Math.round((m3 * FT3_PER_M3) / 100) * 100)} ft³` : `${grouped(m3)} m³`;
}

export function temperature(c: number, system: UnitSystem): string {
  return system === 'imperial' ? `${String(Math.round(cToF(c)))} °F` : `${(Math.round(c * 10) / 10).toFixed(1).replace(/\.0$/, '')} °C`;
}

/** Degree days in the system's unit (°F·days or °C·days). */
export function degreeDays(cDays: number, system: UnitSystem): string {
  return system === 'imperial' ? `${grouped(Math.round((cDays * 9) / 5 / 10) * 10)} °F·days` : `${grouped(Math.round(cDays / 10) * 10)} °C·days`;
}

/** kWh of sun on the glass on a clear day. */
export function sunDay(kwh: number): string {
  return `${kwh >= 10 ? grouped(kwh) : (Math.round(kwh * 10) / 10).toFixed(1).replace(/\.0$/, '')} kWh/day`;
}

export function percent(share: number | null): string {
  return share === null ? '—' : `${String(Math.round(share * 100))}%`;
}

/** An assembly's value in words: "R-22" or "U 0.26"; a slab edge's "F-0.54"; air "0.35 ACH". */
export function assemblyValue(a: AssemblyRow, system: UnitSystem): string {
  if (a.kind === 'air') return `${String(Math.round(a.value * 100) / 100)} ACH`;
  if (a.kind === 'slab') return system === 'imperial' ? `F-${(a.value / F_IP_TO_SI).toFixed(2)}` : `F ${a.value.toFixed(2)} W/m·K`;
  if (system === 'imperial') {
    const r = U_IP_TO_SI / a.value;
    return `R-${r >= 10 ? String(Math.round(r)) : (Math.round(r * 10) / 10).toFixed(1)}`;
  }
  return `U ${a.value.toFixed(2)}`;
}

export function assemblyQuantity(a: AssemblyRow, system: UnitSystem): string {
  return a.quantityUnit === 'm2' ? area(a.quantity, system) : a.quantityUnit === 'm' ? length(a.quantity, system) : volume(a.quantity, system);
}

/** A loss coefficient: Btu/h·°F or W/K. */
export function loss(wPerK: number, system: UnitSystem): string {
  return system === 'imperial' ? `${grouped(wPerK / BTUH_TO_W / 1.8)} Btu/h·°F` : `${grouped(wPerK)} W/K`;
}

/** The solar hour as a clock time: 16 → "4 pm". */
export function hourText(h: number): string {
  const hh = ((h + 11) % 12) + 1;
  return `${String(hh)} ${h < 12 ? 'am' : 'pm'}`;
}

/** The estimate as text: what MCP's describe and a resource hand an agent. */
export function describeEstimate(e: EnergyEstimate, system: UnitSystem): string {
  const lines: string[] = [];
  const h = loadRange(e.loads.heating, system);
  const c = loadRange(e.loads.cooling, system);
  lines.push(`Energy & comfort (advisory): ${e.advisory}`);
  lines.push(`Climate: ${e.climate.label}; design ${temperature(e.climate.heatingDesign, system)} / ${temperature(e.climate.coolingDesign, system)} outside, ${temperature(e.climate.indoorWinter, system)} / ${temperature(e.climate.indoorSummer, system)} inside; ${degreeDays(e.climate.hdd, system)} heating, ${degreeDays(e.climate.cdd, system)} cooling.`);
  lines.push(`Design loads: heating ${h.text} ${h.unit}; cooling ${c.text} ${c.unit} (at ${hourText(e.loads.coolingHour)} sun, July 21).`);
  lines.push(`A typical year: heating ${annualRange(e.loads.annualHeating).text} MWh, cooling ${annualRange(e.loads.annualCooling).text} MWh (heat delivered, sun and internal gains left out).`);
  lines.push(`Conditioned: ${area(e.summary.conditionedArea, system)}, ${volume(e.summary.volume, system)}.`);
  lines.push('Façades: ' + e.facades.map((f) => `${f.orientation} ${area(f.wallArea, system)} wall, ${area(f.windowArea, system)} window (${percent(f.wwr)}), ${sunDay(f.solarJuly)} July`).join('; ') + '.');
  lines.push('Assemblies: ' + e.assemblies.map((a) => `${a.label} ${assemblyQuantity(a, system)} ${assemblyValue(a, system)} (${a.sourceText})`).join('; ') + '.');
  if (e.notes.length) lines.push('Comfort notes: ' + e.notes.map((n) => `${n.title} — ${n.detail}`).join('; ') + '.');
  if (e.options) lines.push('Design options: ' + e.options.map((o) => `${o.label}: heating ${loadRange(o.heating, system).text}, cooling ${loadRange(o.cooling, system).text} ${loadRange(o.cooling, system).unit}`).join('; ') + '.');
  lines.push('Assumed: ' + e.assumptions.map((a) => a.text).join(' '));
  return lines.join('\n');
}
