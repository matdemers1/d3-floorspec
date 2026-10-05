/**
 * FS_mechanical 0.1.0 (registry/FS_mechanical/spec.md): equipment, terminals, exhaust, gas
 * appliances and gas sources; fuel and combustion air.
 */
import { validate as validateSchema } from '../../generated/validate-FS_mechanical.js';
import type * as G from '../../generated/types-FS_mechanical.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type MechanicalData = G.FSMechanical010;
export type Equipment = Element<G.Equipment>;
export type Terminal = Element<G.Terminal>;
export type Exhaust = Element<G.Exhaust>;
export type GasAppliance = Element<G.GasAppliance>;
export type GasSource = G.GasSource;

/** Chapter 5: what FS_mechanical derives. */
export interface DerivedMechanical {
  gasSources: Record<string, { fuel: string; appliances: string[]; input: number }>;
  equipment: Record<string, { terminals: string[]; airflow: number }>;
  rooms: Record<string, string[]>;
}

const GASES = new Set(['naturalGas', 'propane']);
const SERVICED = new Set(['furnace', 'airHandler', 'boiler']);

/** Every element that may burn fuel, with its fuel: equipment (default electric) and gas appliances. */
function burners(ctx: ExtensionContext): [string, Equipment | GasAppliance, string][] {
  return [
    ...ctx.coll<Equipment>('equipment').map(([id, el]) => [id, el, el.fuel ?? 'electric'] as [string, Equipment, string]),
    ...ctx.coll<GasAppliance>('gasAppliances').map(([id, el]) => [id, el, el.fuel] as [string, GasAppliance, string]),
  ];
}

function invariants(ctx: ExtensionContext): void {
  const space = ctx.space();
  const sources = new Map(ctx.records<GasSource>('gasSources'));
  for (const [gid] of sources) if (space.has(gid)) ctx.report('FS-MECH-INV-001', `The gas source ID ${gid} is also the ID of an element.`, [gid]);
  for (const [id, el, fuel] of burners(ctx)) {
    if (el.gasFrom === undefined) continue;
    const g = sources.get(el.gasFrom);
    if (!g) ctx.report('FS-MECH-INV-002', `${id} draws from ${el.gasFrom}, which is not a gas source.`, [id]);
    else if (g.fuel !== fuel) ctx.report('FS-MECH-INV-003', `${id} burns ${fuel}; its gas source ${el.gasFrom} supplies ${g.fuel}.`, [id, el.gasFrom]);
  }
  for (const [id, el] of ctx.coll<Equipment>('equipment'))
    if ((el.fuel ?? 'electric') === 'electric' && (el.combustionAir !== undefined || el.vent !== undefined))
      ctx.report('FS-MECH-INV-005', `The electric equipment ${id} has combustion air or a vent.`, [id]);
  const equipment = new Map(ctx.coll<Equipment>('equipment'));
  for (const [id, el] of ctx.coll<Terminal>('terminals'))
    if (el.equipment !== undefined && !equipment.has(el.equipment)) ctx.report('FS-MECH-INV-004', `The terminal ${id} is served by ${el.equipment}, which is not equipment.`, [id]);
}

function lints(ctx: ExtensionContext): void {
  for (const [id, el, fuel] of burners(ctx)) {
    if (fuel !== 'electric' && el.combustionAir === undefined) ctx.report('FS-MECH-LINT-001', `${id} burns fuel and does not say where its combustion air comes from.`, [id]);
    if (GASES.has(fuel) && el.gasFrom === undefined) ctx.report('FS-MECH-LINT-002', `${id} burns ${fuel} and draws from no gas source.`, [id]);
  }
  for (const [id, el] of ctx.coll<Terminal>('terminals'))
    if (el.terminal !== 'transfer' && el.equipment === undefined) ctx.report('FS-MECH-LINT-003', `The ${el.terminal} terminal ${id} names no equipment.`, [id]);
  for (const [id, el] of ctx.coll<Equipment>('equipment'))
    if (SERVICED.has(el.equipment) && !ctx.hasPurpose(el, 'workingSpace')) ctx.report('FS-MECH-LINT-004', `The ${el.equipment} ${id} has no working space envelope.`, [id]);
  const drawn = new Set(burners(ctx).flatMap(([, el]) => (el.gasFrom === undefined ? [] : [el.gasFrom])));
  for (const [gid] of ctx.records<GasSource>('gasSources')) if (!drawn.has(gid)) ctx.report('FS-MECH-LINT-005', `Nothing draws from the gas source ${gid}.`, [gid]);
}

function derive(ctx: ExtensionContext): DerivedMechanical {
  const all = burners(ctx);
  const gas = ctx.records<GasSource>('gasSources').map(([gid, g]) => {
    const mine = all.filter(([, el]) => el.gasFrom === gid);
    return [gid, { fuel: g.fuel, appliances: sorted(mine.map(([id]) => id)), input: mine.reduce((s, [, el]) => s + (el.input ?? 0), 0) }] as const;
  });
  const terminals = ctx.coll<Terminal>('terminals');
  const equipment = ctx.coll<Equipment>('equipment').map(([eid]) => {
    const ts = terminals.filter(([, t]) => t.equipment === eid);
    return [eid, { terminals: sorted(ts.map(([id]) => id)), airflow: ts.reduce((s, [, t]) => s + (t.airflow ?? 0), 0) }] as const;
  });
  return { gasSources: record(gas), equipment: record(equipment), rooms: ctx.roomsDerived() };
}

export const FS_MECHANICAL: ExtensionImplementation<DerivedMechanical> = {
  name: 'FS_mechanical',
  version: '0.1.0',
  code: 'MECH',
  catalogue: [
    { code: 'FS-MECH-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-MECH-INV-001', severity: 'error', condition: "a gas source's ID is the ID of an element, a program item or an extension element" },
    { code: 'FS-MECH-INV-002', severity: 'error', condition: 'a `gasFrom` is not a gas source' },
    { code: 'FS-MECH-INV-003', severity: 'error', condition: "an element's `fuel` is not its gas source's" },
    { code: 'FS-MECH-INV-004', severity: 'error', condition: "a terminal's `equipment` is not equipment" },
    { code: 'FS-MECH-INV-005', severity: 'error', condition: 'electric equipment has `combustionAir` or `vent`' },
    { code: 'FS-MECH-LINT-001', severity: 'warning', condition: 'equipment or a gas appliance that burns fuel and has no `combustionAir`' },
    { code: 'FS-MECH-LINT-002', severity: 'warning', condition: 'a gas appliance, or equipment burning natural gas or propane, with no `gasFrom`' },
    { code: 'FS-MECH-LINT-003', severity: 'warning', condition: 'a supply or return terminal that names no equipment' },
    { code: 'FS-MECH-LINT-004', severity: 'warning', condition: 'a furnace, an air handler or a boiler with no clearance envelope whose purpose is `workingSpace`' },
    { code: 'FS-MECH-LINT-005', severity: 'info', condition: 'a gas source that nothing draws from' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
