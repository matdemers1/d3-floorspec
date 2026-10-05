/**
 * FS_electrical 0.1.0 (registry/FS_electrical/spec.md): panels, receptacles, switches, lights,
 * alarms and EV chargers; circuits, their loads, panel spaces and feeders; switch control.
 */
import { validate as validateSchema } from '../../generated/validate-FS_electrical.js';
import type * as G from '../../generated/types-FS_electrical.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type ElectricalData = G.FSElectrical010;
export type Panel = Element<G.Panel>;
export type Receptacle = Element<G.Receptacle>;
export type Switch = Element<G.Switch>;
export type Light = Element<G.Light>;
export type Alarm = Element<G.Alarm>;
export type EvCharger = Element<G.EVCharger>;
export type Circuit = G.Circuit;

/** Chapter 6: what FS_electrical derives. */
export interface DerivedElectrical {
  circuits: Record<string, { panel: string; loads: string[]; connectedLoad: number; capacity: number }>;
  panels: Record<string, { circuits: string[]; spacesUsed: number; connectedLoad: number }>;
  controls: Record<string, string[]>;
  rooms: Record<string, string[]>;
}

/** 2.2–2.6: the default voltage of each kind that may be a load. */
const VOLTS: Record<string, number> = { receptacles: 120, lights: 120, alarms: 120, evChargers: 240 };
const LOADS = Object.keys(VOLTS);
const battery = (a: Alarm): boolean => (a.power ?? 'mainsWithBattery') === 'battery';
type Load = Receptacle | Light | Alarm | EvCharger;

const P = (...path: (string | number)[]): string => '/extensions/FS_electrical/' + path.join('/');

function invariants(ctx: ExtensionContext): void {
  const space = ctx.space();
  const panels = new Map(ctx.coll<Panel>('panels'));
  const circuits = ctx.records<Circuit>('circuits');
  const byId = new Map(circuits);
  for (const [cid] of circuits)
    if (space.has(cid)) ctx.report('FS-ELEC-INV-001', `The circuit ID ${cid} is also the ID of an element.`, [cid], P('circuits', cid));
  const onPanel = new Map<string, [string, number, number][]>();
  for (const [cid, c] of circuits) {
    const p = panels.get(c.panel);
    if (!p) {
      ctx.report('FS-ELEC-INV-002', `Circuit ${cid} is on ${c.panel}, which is not a panel.`, [cid], P('circuits', cid, 'panel'));
      continue;
    }
    if (!p.volts.includes(c.volts)) ctx.report('FS-ELEC-INV-007', `Circuit ${cid} is ${c.volts} V; panel ${c.panel} supplies ${p.volts.join('/')} V.`, [cid, c.panel], P('circuits', cid, 'volts'));
    if (c.space !== undefined) {
      const last = c.space + (c.poles ?? 1) - 1;
      if (last > p.spaces) ctx.report('FS-ELEC-INV-008', `Circuit ${cid} takes space ${last}; panel ${c.panel} has ${p.spaces}.`, [cid, c.panel], P('circuits', cid, 'space'));
      onPanel.set(c.panel, [...(onPanel.get(c.panel) ?? []), [cid, c.space, last]]);
    }
  }
  for (const [, cs] of onPanel)
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const [a, a0, a1] = cs[i]!;
        const [b, b0, b1] = cs[j]!;
        if (Math.max(a0, b0) <= Math.min(a1, b1)) ctx.report('FS-ELEC-INV-009', `Circuits ${a} and ${b} take the same panel space.`, [a, b]);
      }
  const feeding = new Map<string, string[]>();
  for (const [cid, c] of circuits)
    (c.loads ?? []).forEach((load, i) => {
      if (!ctx.ext.has(load)) {
        ctx.report('FS-ELEC-INV-003', `Circuit ${cid} feeds ${load}, which is not an extension element.`, [cid], P('circuits', cid, 'loads', i));
        return;
      }
      const own = ctx.own<Load>(load);
      if (own && (own.collection === 'panels' || own.collection === 'switches')) {
        ctx.report('FS-ELEC-INV-004', `Circuit ${cid} lists ${load}, a ${own.collection === 'panels' ? 'panel' : 'switch'}, as a load.`, [cid, load], P('circuits', cid, 'loads', i));
        return;
      }
      feeding.set(load, [...(feeding.get(load) ?? []), cid]);
      if (!own) return;
      if (own.collection === 'alarms' && battery(own.element as Alarm))
        ctx.report('FS-ELEC-INV-013', `The battery-powered alarm ${load} is a load of circuit ${cid}.`, [cid, load], P('circuits', cid, 'loads', i));
      else if ((own.element.volts ?? VOLTS[own.collection]!) !== c.volts)
        ctx.report('FS-ELEC-INV-006', `${load} is ${own.element.volts ?? VOLTS[own.collection]} V, on the ${c.volts} V circuit ${cid}.`, [cid, load], P('circuits', cid, 'loads', i));
    });
  for (const [load, cids] of feeding)
    if (new Set(cids.map((c) => byId.get(c)!.panel)).size > 1) ctx.report('FS-ELEC-INV-005', `${load} is a load of circuits on different panels (${cids.join(', ')}).`, [load]);
  for (const [sid, s] of ctx.coll<Switch>('switches'))
    for (const t of s.controls ?? []) {
      const own = ctx.own(t);
      if (!ctx.ext.has(t) || (own && own.collection !== 'lights' && own.collection !== 'receptacles'))
        ctx.report('FS-ELEC-INV-010', `Switch ${sid} controls ${t}, which is neither a light or receptacle nor an element of another extension.`, [sid]);
    }
  for (const [pid, p] of panels)
    if (p.fedBy !== undefined && !byId.has(p.fedBy)) ctx.report('FS-ELEC-INV-011', `Panel ${pid} is fed by ${p.fedBy}, which is not a circuit.`, [pid]);
  for (const [pid] of panels) {
    let cur = pid;
    const seen = new Set<string>();
    for (;;) {
      const f = panels.get(cur)!.fedBy;
      const c = f === undefined ? undefined : byId.get(f);
      if (!c || !panels.has(c.panel)) break;
      cur = c.panel;
      if (cur === pid) {
        ctx.report('FS-ELEC-INV-012', `Panel ${pid} is fed, through its feeders, by a circuit of itself.`, [pid]);
        break;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
    }
  }
}

function connected(ctx: ExtensionContext, c: Circuit): number {
  let total = 0;
  for (const load of c.loads ?? []) total += ctx.own<Load>(load)?.element.watts ?? 0;
  return total;
}

function lints(ctx: ExtensionContext): void {
  const circuits = ctx.records<Circuit>('circuits');
  const loads = new Set(circuits.flatMap(([, c]) => c.loads ?? []));
  for (const kind of LOADS)
    for (const [id, el] of ctx.coll<Load>(kind)) {
      if (kind === 'alarms' && battery(el as Alarm)) continue;
      if (!loads.has(id)) ctx.report('FS-ELEC-LINT-001', `${id} is a load of no circuit.`, [id]);
    }
  const controlled = new Set(ctx.coll<Switch>('switches').flatMap(([, s]) => s.controls ?? []));
  for (const [id] of ctx.coll<Light>('lights')) if (!controlled.has(id)) ctx.report('FS-ELEC-LINT-002', `No switch controls the light ${id}.`, [id]);
  for (const [cid, c] of circuits) {
    if (c.rating !== undefined && c.breaker > c.rating) ctx.report('FS-ELEC-LINT-003', `Circuit ${cid}'s ${c.breaker} A breaker exceeds its ${c.rating} A conductors.`, [cid]);
    if (connected(ctx, c) > c.breaker * c.volts) ctx.report('FS-ELEC-LINT-004', `Circuit ${cid}'s connected load exceeds its capacity.`, [cid]);
    if (!c.loads?.length) ctx.report('FS-ELEC-LINT-005', `Circuit ${cid} feeds nothing.`, [cid]);
    for (const load of c.loads ?? []) {
      const own = ctx.own<EvCharger>(load);
      if (own?.collection === 'evChargers' && own.element.amps > c.breaker)
        ctx.report('FS-ELEC-LINT-007', `The ${own.element.amps} A charger ${load} is on circuit ${cid}'s ${c.breaker} A breaker.`, [cid, load]);
    }
  }
  for (const [pid, p] of ctx.coll<Panel>('panels'))
    if (!ctx.hasPurpose(p, 'workingSpace')) ctx.report('FS-ELEC-LINT-006', `Panel ${pid} has no working space envelope.`, [pid]);
}

function derive(ctx: ExtensionContext): DerivedElectrical {
  const circuits = ctx.records<Circuit>('circuits');
  const c = circuits.map(([cid, x]) => [cid, { panel: x.panel, loads: sorted(x.loads ?? []), connectedLoad: connected(ctx, x), capacity: x.breaker * x.volts }] as const);
  const cmap = new Map(c);
  const panels = ctx.coll<Panel>('panels').map(([pid]) => {
    const mine = circuits.filter(([, x]) => x.panel === pid).map(([cid]) => cid);
    return [pid, {
      circuits: mine,
      spacesUsed: mine.reduce((s, cid) => s + (circuits.find(([k]) => k === cid)![1].poles ?? 1), 0),
      connectedLoad: mine.reduce((s, cid) => s + cmap.get(cid)!.connectedLoad, 0),
    }] as const;
  });
  const controls = new Map<string, string[]>();
  for (const [sid, s] of ctx.coll<Switch>('switches')) for (const t of s.controls ?? []) controls.set(t, [...(controls.get(t) ?? []), sid]);
  return {
    circuits: record(c),
    panels: record(panels),
    controls: record([...controls].map(([k, v]) => [k, sorted(v)])),
    rooms: ctx.roomsDerived(),
  };
}

export const FS_ELECTRICAL: ExtensionImplementation<DerivedElectrical> = {
  name: 'FS_electrical',
  version: '0.1.0',
  code: 'ELEC',
  catalogue: [
    { code: 'FS-ELEC-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-ELEC-INV-001', severity: 'error', condition: "a circuit's ID is the ID of an element, a program item or an extension element" },
    { code: 'FS-ELEC-INV-002', severity: 'error', condition: "a circuit's `panel` is not a panel of FS_electrical" },
    { code: 'FS-ELEC-INV-003', severity: 'error', condition: 'a load is not an extension element' },
    { code: 'FS-ELEC-INV-004', severity: 'error', condition: 'a load is a panel or a switch' },
    { code: 'FS-ELEC-INV-005', severity: 'error', condition: 'an element is a load of circuits on two different panels' },
    { code: 'FS-ELEC-INV-006', severity: 'error', condition: 'a receptacle, light, alarm or EV charger is a load of a circuit of another voltage' },
    { code: 'FS-ELEC-INV-007', severity: 'error', condition: "a circuit's `volts` is not one of its panel's" },
    { code: 'FS-ELEC-INV-008', severity: 'error', condition: 'a circuit takes a space its panel does not have' },
    { code: 'FS-ELEC-INV-009', severity: 'error', condition: 'two circuits of one panel take the same space' },
    { code: 'FS-ELEC-INV-010', severity: 'error', condition: 'a switch controls something that is neither a light or receptacle of FS_electrical nor an element of another extension' },
    { code: 'FS-ELEC-INV-011', severity: 'error', condition: "a panel's `fedBy` is not a circuit" },
    { code: 'FS-ELEC-INV-012', severity: 'error', condition: 'a panel is fed by a circuit of itself, directly or not' },
    { code: 'FS-ELEC-INV-013', severity: 'error', condition: 'a battery-powered alarm is a load' },
    { code: 'FS-ELEC-LINT-001', severity: 'warning', condition: 'a receptacle, light, EV charger, or alarm not powered by battery alone, that is a load of no circuit' },
    { code: 'FS-ELEC-LINT-002', severity: 'info', condition: 'a light that no switch controls' },
    { code: 'FS-ELEC-LINT-003', severity: 'warning', condition: "a circuit whose `breaker` exceeds its `rating`" },
    { code: 'FS-ELEC-LINT-004', severity: 'warning', condition: 'a circuit whose connected load exceeds its capacity' },
    { code: 'FS-ELEC-LINT-005', severity: 'info', condition: 'a circuit with no loads' },
    { code: 'FS-ELEC-LINT-006', severity: 'warning', condition: 'a panel with no clearance envelope whose purpose is `workingSpace`' },
    { code: 'FS-ELEC-LINT-007', severity: 'warning', condition: "an EV charger whose `amps` exceeds the `breaker` of a circuit it is a load of" },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
