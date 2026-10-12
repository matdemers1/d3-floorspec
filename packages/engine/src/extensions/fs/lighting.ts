/**
 * FS_lighting 0.1.0 (registry/FS_lighting/spec.md, FLR-ADR-043): lighting design over FS_electrical's
 * lights — what each luminaire gives (lumens, a colour temperature or a tunable range, whether it
 * dims) and named lighting scenes, each the luminaires it turns on at an output and a colour
 * temperature, every other off. It adds no kind of element, and requires FS_electrical ^0.1.0.
 */
import { validate as validateSchema } from '../../generated/validate-FS_lighting.js';
import type * as G from '../../generated/types-FS_lighting.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type LightingData = G.FSLighting010;
export type Luminaire = G.Luminaire;
export type Scene = G.Scene;
export type SceneSetting = G.Setting;

/** Chapter 6: what FS_lighting derives. */
export interface DerivedLighting {
  scenes: Record<string, { name: string; on: string[]; dimmed: string[] }>;
  luminaires: Record<string, { scenes: string[] }>;
}

const P = (...path: (string | number)[]): string => '/extensions/FS_lighting/' + path.join('/');
/** FS_electrical 2.3: the switches that can dim what they control. */
const DIMMING = new Set(['dimmer', 'smart']);

/** 2.1.1, 3.1.1: a light of FS_electrical, or an extension element of an extension other than FS_electrical. */
function givesLight(ctx: ExtensionContext, id: string): boolean {
  const x = ctx.ext.get(id);
  if (x === undefined) return false;
  return x.extension === 'FS_electrical' ? x.collection === 'lights' : true;
}

function invariants(ctx: ExtensionContext): void {
  const space = ctx.space();
  const scenes = ctx.records<Scene>('scenes');
  for (const [sid] of scenes)
    if (space.has(sid)) ctx.report('FS-LGHT-INV-001', `The scene ID ${sid} is also the ID of an element.`, [sid], P('scenes', sid));
  for (const [id, l] of ctx.records<Luminaire>('luminaires')) {
    if (!givesLight(ctx, id)) ctx.report('FS-LGHT-INV-002', `${id} has a luminaire record but is not a light.`, [id], P('luminaires', id));
    const range = l.cctRange;
    if (range !== undefined && !(range[0] < range[1])) {
      ctx.report('FS-LGHT-INV-003', `The luminaire ${id}'s colour temperature range runs from ${range[0]} K to ${range[1]} K: its warm end must be below its cool end.`, [id], P('luminaires', id, 'cctRange'));
      continue;
    }
    if (range !== undefined && l.cct !== undefined && (l.cct < range[0] || l.cct > range[1]))
      ctx.report('FS-LGHT-INV-004', `The luminaire ${id} is ${l.cct} K, outside its range of ${range[0]}–${range[1]} K.`, [id], P('luminaires', id, 'cct'));
  }
  for (const [sid, s] of scenes)
    for (const id of Object.keys(s.on ?? {}).sort())
      if (!givesLight(ctx, id)) ctx.report('FS-LGHT-INV-005', `Scene ${sid} (${s.name}) turns on ${id}, which is not a light.`, [sid], P('scenes', sid, 'on', id));
  for (let i = 0; i < scenes.length; i++)
    for (let j = i + 1; j < scenes.length; j++)
      if (scenes[i]![1].name === scenes[j]![1].name)
        ctx.report('FS-LGHT-INV-006', `Scenes ${scenes[i]![0]} and ${scenes[j]![0]} are both named "${scenes[i]![1].name}".`, [scenes[i]![0], scenes[j]![0]], P('scenes', scenes[j]![0], 'name'));
}

function lints(ctx: ExtensionContext): void {
  const luminaires = new Map(ctx.records<Luminaire>('luminaires'));
  // FS_electrical 4.1: the lights some dimmer or smart switch controls.
  const dimmable = new Set<string>();
  const electrical = (ctx.doc.extensions as Record<string, { collections?: { switches?: Record<string, { control?: string; controls?: string[] }> } }> | undefined)?.['FS_electrical'];
  for (const s of Object.values(electrical?.collections?.switches ?? {})) if (DIMMING.has(s.control ?? 'single')) for (const t of s.controls ?? []) dimmable.add(t);
  for (const [sid, s] of ctx.records<Scene>('scenes'))
    for (const [id, set] of Object.entries(s.on ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const output = set?.output ?? 100;
      const l = luminaires.get(id);
      if (output < 100 && l?.dimmable === false) ctx.report('FS-LGHT-LINT-001', `Scene ${sid} (${s.name}) dims ${id} to ${output}%, which is not dimmable.`, [sid, id], P('scenes', sid, 'on', id, 'output'));
      const cct = set?.cct;
      if (cct !== undefined && l !== undefined) {
        const range = l.cctRange;
        const off = range !== undefined ? cct < range[0] || cct > range[1] : l.cct !== undefined && cct !== l.cct;
        if (off) ctx.report('FS-LGHT-LINT-002', `Scene ${sid} (${s.name}) sets ${id} to ${cct} K, which it cannot give (${range !== undefined ? `${range[0]}–${range[1]} K` : `${l.cct} K`}).`, [sid, id], P('scenes', sid, 'on', id, 'cct'));
      }
      const x = ctx.ext.get(id);
      if (output < 100 && x?.extension === 'FS_electrical' && x.collection === 'lights' && !dimmable.has(id))
        ctx.report('FS-LGHT-LINT-003', `Scene ${sid} (${s.name}) dims ${id} to ${output}%, but no dimmer or smart switch controls it.`, [sid, id], P('scenes', sid, 'on', id, 'output'));
    }
}

function derive(ctx: ExtensionContext): DerivedLighting {
  const scenes = ctx.records<Scene>('scenes');
  const of = new Map<string, string[]>();
  for (const [id] of ctx.records<Luminaire>('luminaires')) of.set(id, []);
  for (const [sid, s] of scenes) for (const id of Object.keys(s.on ?? {})) of.set(id, [...(of.get(id) ?? []), sid]);
  return {
    scenes: record(
      scenes.map(([sid, s]) => {
        const on = Object.entries(s.on ?? {});
        return [sid, { name: s.name, on: sorted(on.map(([id]) => id)), dimmed: sorted(on.filter(([, v]) => (v?.output ?? 100) < 100).map(([id]) => id)) }] as const;
      }),
    ),
    luminaires: record([...of].map(([id, ss]) => [id, { scenes: sorted(ss) }] as const)),
  };
}

export const FS_LIGHTING: ExtensionImplementation<DerivedLighting> = {
  name: 'FS_lighting',
  version: '0.1.0',
  code: 'LGHT',
  catalogue: [
    { code: 'FS-LGHT-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-LGHT-INV-001', severity: 'error', condition: "a scene's ID is the ID of an element, a program item or an extension element" },
    { code: 'FS-LGHT-INV-002', severity: 'error', condition: 'a luminaire record whose ID is neither a light of FS_electrical nor an element of another extension' },
    { code: 'FS-LGHT-INV-003', severity: 'error', condition: "a luminaire's `cctRange` whose first value is not less than its second" },
    { code: 'FS-LGHT-INV-004', severity: 'error', condition: "a luminaire's `cct` outside its `cctRange`" },
    { code: 'FS-LGHT-INV-005', severity: 'error', condition: "a scene's `on` names something that is neither a light of FS_electrical nor an element of another extension; once for each" },
    { code: 'FS-LGHT-INV-006', severity: 'error', condition: 'two scenes with the same `name`; once for each pair' },
    { code: 'FS-LGHT-LINT-001', severity: 'warning', condition: 'a scene dims a luminaire whose `dimmable` is false' },
    { code: 'FS-LGHT-LINT-002', severity: 'warning', condition: 'a scene sets a colour temperature its luminaire cannot give' },
    { code: 'FS-LGHT-LINT-003', severity: 'info', condition: 'a scene dims a light of FS_electrical that no dimmer or smart switch controls' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
