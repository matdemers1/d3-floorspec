/**
 * FS_lowvoltage 0.1.0 (registry/FS_lowvoltage/spec.md): outlets, doorbells, security devices,
 * speakers, and the head-ends they are run to.
 */
import { validate as validateSchema } from '../../generated/validate-FS_lowvoltage.js';
import type * as G from '../../generated/types-FS_lowvoltage.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type LowVoltageData = G.FSLowvoltage010;
export type Outlet = Element<G.Outlet>;
export type Doorbell = Element<G.Doorbell>;
export type SecurityDevice = Element<G.SecurityDevice>;
export type Speaker = Element<G.Speaker>;
export type HeadEnd = Element<G.HeadEnd>;

/** Chapter 5: what FS_lowvoltage derives. */
export interface DerivedLowVoltage {
  headEnds: Record<string, { runs: string[]; ports: Record<string, number> }>;
  rooms: Record<string, string[]>;
}

const RUN = ['outlets', 'doorbells', 'security', 'speakers'] as const;
const BUTTONS = new Set(['button', 'videoButton']);
type Run = Outlet | Doorbell | SecurityDevice | Speaker;

/** 2: the systems an element belongs to. */
export function systems(kind: string, el: Run): string[] {
  if (kind === 'outlets') return [...(el as Outlet).media];
  return [({ doorbells: 'doorbell', security: 'security', speakers: 'audio' } as Record<string, string>)[kind]!];
}

function invariants(ctx: ExtensionContext): void {
  const heads = new Map(ctx.coll<HeadEnd>('headEnds'));
  for (const kind of RUN)
    for (const [id, el] of ctx.coll<Run>(kind)) {
      if (el.headEnd === undefined) continue;
      const h = heads.get(el.headEnd);
      if (!h) ctx.report('FS-LOWV-INV-001', `${id} is run to ${el.headEnd}, which is not a head-end.`, [id]);
      else if (systems(kind, el).some((s) => !(h.serves as string[]).includes(s)))
        ctx.report('FS-LOWV-INV-003', `${id} is run to ${el.headEnd}, which does not serve all of its systems.`, [id, el.headEnd]);
    }
  const bells = new Map(ctx.coll<Doorbell>('doorbells'));
  for (const [id, el] of bells) {
    if (el.chime === undefined) continue;
    const c = bells.get(el.chime);
    if (!BUTTONS.has(el.part) || c?.part !== 'chime') ctx.report('FS-LOWV-INV-002', `The doorbell ${id} names ${el.chime}, which it cannot ring.`, [id]);
  }
}

function lints(ctx: ExtensionContext): void {
  for (const kind of ['outlets', 'speakers', 'security'])
    for (const [id, el] of ctx.coll<Outlet | Speaker | SecurityDevice>(kind))
      if (el.headEnd === undefined && !(el as SecurityDevice).wireless) ctx.report('FS-LOWV-LINT-001', `${id} is run to no head-end.`, [id]);
  for (const [id, el] of ctx.coll<Doorbell>('doorbells'))
    if (BUTTONS.has(el.part) && el.chime === undefined) ctx.report('FS-LOWV-LINT-002', `The doorbell ${id} rings no chime.`, [id]);
  for (const [id, el] of ctx.coll<HeadEnd>('headEnds'))
    if (!ctx.hasPurpose(el, 'access')) ctx.report('FS-LOWV-LINT-003', `The head-end ${id} has no access envelope.`, [id]);
}

function derive(ctx: ExtensionContext): DerivedLowVoltage {
  const heads = ctx.coll<HeadEnd>('headEnds').map(([hid]) => {
    const runs: string[] = [];
    const ports = new Map<string, number>();
    for (const kind of RUN)
      for (const [id, el] of ctx.coll<Run>(kind)) {
        if (el.headEnd !== hid) continue;
        runs.push(id);
        if (kind === 'outlets') for (const m of (el as Outlet).media) ports.set(m, (ports.get(m) ?? 0) + ((el as Outlet).ports ?? 1));
      }
    return [hid, { runs: sorted(runs), ports: record(ports) }] as const;
  });
  return { headEnds: record(heads), rooms: ctx.roomsDerived() };
}

export const FS_LOWVOLTAGE: ExtensionImplementation<DerivedLowVoltage> = {
  name: 'FS_lowvoltage',
  version: '0.1.0',
  code: 'LOWV',
  catalogue: [
    { code: 'FS-LOWV-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-LOWV-INV-001', severity: 'error', condition: 'a `headEnd` is not a head-end' },
    { code: 'FS-LOWV-INV-002', severity: 'error', condition: 'a `chime` is not a chime, or a chime has a `chime`' },
    { code: 'FS-LOWV-INV-003', severity: 'error', condition: 'an element is run to a head-end that does not serve one of its systems' },
    { code: 'FS-LOWV-LINT-001', severity: 'info', condition: 'an outlet, a speaker, or a security device that is not wireless, run to no head-end' },
    { code: 'FS-LOWV-LINT-002', severity: 'warning', condition: 'a doorbell button or video doorbell that rings no chime' },
    { code: 'FS-LOWV-LINT-003', severity: 'warning', condition: 'a head-end with no clearance envelope whose purpose is `access`' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
