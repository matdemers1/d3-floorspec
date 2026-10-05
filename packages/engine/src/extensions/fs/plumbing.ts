/**
 * FS_plumbing 0.1.0 (registry/FS_plumbing/spec.md): fixtures, water heaters, drains, cleanouts and
 * logical stacks; what drains where, and where hot water comes from.
 */
import { validate as validateSchema } from '../../generated/validate-FS_plumbing.js';
import type * as G from '../../generated/types-FS_plumbing.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type PlumbingData = G.FSPlumbing010;
export type Fixture = Element<G.Fixture>;
export type WaterHeater = Element<G.WaterHeater>;
export type Drain = Element<G.Drain>;
export type Cleanout = Element<G.Cleanout>;
export type Stack = G.Stack;

/** Chapter 5: what FS_plumbing derives. */
export interface DerivedPlumbing {
  stacks: Record<string, { connected: string[]; cleanouts: string[] }>;
  waterHeaters: Record<string, { fixtures: string[] }>;
  rooms: Record<string, string[]>;
}

const FUELS = new Set(['naturalGas', 'propane', 'oil']);
const NO_DRAIN = new Set(['hoseBibb', 'iceMaker']);
type Drainer = Fixture | WaterHeater | Drain;

/** Every fixture, water heater and drain that has a `drain`: [kind, ID, element]. */
function drainers(ctx: ExtensionContext): [string, string, Drainer & { drain: string }][] {
  const out: [string, string, Drainer & { drain: string }][] = [];
  for (const kind of ['fixtures', 'waterHeaters', 'drains'])
    for (const [id, el] of ctx.coll<Drainer>(kind)) if (el.drain !== undefined) out.push([kind, id, el as Drainer & { drain: string }]);
  return out;
}

function invariants(ctx: ExtensionContext): void {
  const space = ctx.space();
  const stacks = new Map(ctx.records<Stack>('stacks'));
  const drains = new Map(ctx.coll<Drain>('drains'));
  for (const [sid] of stacks) if (space.has(sid)) ctx.report('FS-PLMB-INV-001', `The stack ID ${sid} is also the ID of an element.`, [sid]);
  const toStack = (id: string, el: Drainer | Cleanout, sid: string): void => {
    const s = stacks.get(sid)!;
    if ((s.stack ?? 'drainWasteVent') === 'vent') ctx.report('FS-PLMB-INV-003', `${id} drains to the vent stack ${sid}.`, [id, sid]);
    else if (!s.levels.includes(el.fallback.level)) ctx.report('FS-PLMB-INV-004', `${id} is on ${el.fallback.level}, which the stack ${sid} does not pass through.`, [id, sid]);
  };
  for (const [kind, id, el] of drainers(ctx)) {
    if (stacks.has(el.drain)) toStack(id, el, el.drain);
    else if (!(kind !== 'drains' && drains.has(el.drain)))
      ctx.report('FS-PLMB-INV-002', `${id} drains to ${el.drain}, which is not ${kind === 'drains' ? 'a stack' : 'a stack or a drain'}.`, [id]);
  }
  for (const [id, el] of ctx.coll<Cleanout>('cleanouts')) {
    const s = stacks.get(el.stack);
    if (!s) ctx.report('FS-PLMB-INV-007', `The cleanout ${id} opens ${el.stack}, which is not a stack.`, [id]);
    else if (!s.levels.includes(el.fallback.level)) ctx.report('FS-PLMB-INV-004', `The cleanout ${id} is on ${el.fallback.level}, which the stack ${el.stack} does not pass through.`, [id, el.stack]);
  }
  for (const [sid, s] of stacks)
    if (s.levels.some((l) => !Object.hasOwn(ctx.doc.levels ?? {}, l))) ctx.report('FS-PLMB-INV-006', `The stack ${sid} names a level that does not exist.`, [sid]);
  const heaters = new Map(ctx.coll<WaterHeater>('waterHeaters'));
  for (const [id, el] of ctx.coll<Fixture>('fixtures')) {
    if (el.hotFrom === undefined) continue;
    if (!heaters.has(el.hotFrom)) ctx.report('FS-PLMB-INV-005', `${id}'s hot water comes from ${el.hotFrom}, which is not a water heater.`, [id]);
    else if (el.supply !== undefined && !el.supply.includes('hot')) ctx.report('FS-PLMB-INV-008', `${id} has a hot-water source but no hot supply.`, [id]);
  }
  for (const [id, el] of heaters)
    if (!FUELS.has(el.energy) && el.combustionAir !== undefined) ctx.report('FS-PLMB-INV-009', `The ${el.energy} water heater ${id} burns no fuel, yet has combustion air.`, [id]);
}

function lints(ctx: ExtensionContext): void {
  for (const [id, el] of ctx.coll<Fixture>('fixtures')) {
    if (el.drain === undefined && !NO_DRAIN.has(el.fixture)) ctx.report('FS-PLMB-LINT-001', `${id} drains to nothing.`, [id]);
    if ((el.supply ?? []).includes('hot') && el.hotFrom === undefined) ctx.report('FS-PLMB-LINT-005', `${id} is supplied hot water from no water heater.`, [id]);
    if (el.fixture === 'waterCloset' && !ctx.hasPurpose(el, 'fixtureClearance')) ctx.report('FS-PLMB-LINT-004', `The water closet ${id} has no fixture clearance envelope.`, [id]);
  }
  for (const [id, el] of ctx.coll<WaterHeater>('waterHeaters')) {
    if (FUELS.has(el.energy) && el.combustionAir === undefined) ctx.report('FS-PLMB-LINT-002', `The water heater ${id} burns fuel and does not say where its combustion air comes from.`, [id]);
    if (!ctx.hasPurpose(el, 'access')) ctx.report('FS-PLMB-LINT-004', `The water heater ${id} has no access envelope.`, [id]);
  }
  for (const [id, el] of ctx.coll<Cleanout>('cleanouts'))
    if (!ctx.hasPurpose(el, 'access')) ctx.report('FS-PLMB-LINT-004', `The cleanout ${id} has no access envelope.`, [id]);
  const used = new Set(drainers(ctx).map(([, , el]) => el.drain));
  for (const [sid] of ctx.records<Stack>('stacks')) if (!used.has(sid)) ctx.report('FS-PLMB-LINT-003', `Nothing drains to the stack ${sid}.`, [sid]);
}

function derive(ctx: ExtensionContext): DerivedPlumbing {
  const drains = new Map(ctx.coll<Drain>('drains'));
  const all = drainers(ctx);
  const stacks = ctx.records<Stack>('stacks').map(([sid]) => {
    const connected = all.filter(([, , el]) => el.drain === sid || drains.get(el.drain)?.drain === sid).map(([, id]) => id);
    const cleanouts = ctx.coll<Cleanout>('cleanouts').filter(([, el]) => el.stack === sid).map(([id]) => id);
    return [sid, { connected: sorted(new Set(connected)), cleanouts: sorted(cleanouts) }] as const;
  });
  const heaters = ctx.coll<WaterHeater>('waterHeaters').map(([hid]) => [hid, { fixtures: sorted(ctx.coll<Fixture>('fixtures').filter(([, f]) => f.hotFrom === hid).map(([id]) => id)) }] as const);
  return { stacks: record(stacks), waterHeaters: record(heaters), rooms: ctx.roomsDerived() };
}

export const FS_PLUMBING: ExtensionImplementation<DerivedPlumbing> = {
  name: 'FS_plumbing',
  version: '0.1.0',
  code: 'PLMB',
  catalogue: [
    { code: 'FS-PLMB-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-PLMB-INV-001', severity: 'error', condition: "a stack's ID is the ID of an element, a program item or an extension element" },
    { code: 'FS-PLMB-INV-002', severity: 'error', condition: 'a `drain` names neither a stack nor, where allowed, a drain' },
    { code: 'FS-PLMB-INV-003', severity: 'error', condition: 'an element drains to a vent stack' },
    { code: 'FS-PLMB-INV-004', severity: 'error', condition: 'an element that drains to a stack, or a cleanout, is on a level the stack does not pass through' },
    { code: 'FS-PLMB-INV-005', severity: 'error', condition: "a fixture's `hotFrom` is not a water heater" },
    { code: 'FS-PLMB-INV-006', severity: 'error', condition: "a stack's `levels` names something that is not a level" },
    { code: 'FS-PLMB-INV-007', severity: 'error', condition: "a cleanout's `stack` is not a stack" },
    { code: 'FS-PLMB-INV-008', severity: 'error', condition: 'a fixture has a `hotFrom` but no `"hot"` in its `supply`' },
    { code: 'FS-PLMB-INV-009', severity: 'error', condition: 'a water heater that burns no fuel has `combustionAir`' },
    { code: 'FS-PLMB-LINT-001', severity: 'warning', condition: 'a fixture other than a hose bibb or an ice maker that drains to nothing' },
    { code: 'FS-PLMB-LINT-002', severity: 'warning', condition: 'a water heater that burns fuel and has no `combustionAir`' },
    { code: 'FS-PLMB-LINT-003', severity: 'info', condition: 'a stack nothing drains to directly' },
    { code: 'FS-PLMB-LINT-004', severity: 'warning', condition: 'a water closet with no `fixtureClearance` envelope, or a water heater or cleanout with no `access` envelope' },
    { code: 'FS-PLMB-LINT-005', severity: 'info', condition: 'a fixture with `"hot"` in its `supply` and no `hotFrom`' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
