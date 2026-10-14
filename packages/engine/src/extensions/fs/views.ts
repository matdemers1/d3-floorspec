/**
 * FS_views 0.1.0 (registry/FS_views/spec.md, FLR-ADR-046): saved views — the photographs a house is
 * meant to be seen in, each a named camera (where it stands and what it looks at, its lens, its frame,
 * depth of field, exposure compensation), how the house is cut away, the sky and the time, and which
 * lights are on. It adds no kind of element and requires no other extension; a view's `scene` is read
 * from FS_lighting's data as it is.
 */
import { validate as validateSchema } from '../../generated/validate-FS_views.js';
import type * as G from '../../generated/types-FS_views.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type ViewsData = G.FSViews010;
export type View = G.View;

/** Chapter 6: what FS_views derives. */
export interface DerivedViews {
  views: Record<string, { name: string; level: string | null; lights: 'off' | 'on'; scene: string | null }>;
}

const P = (...path: (string | number)[]): string => '/extensions/FS_views/' + path.join('/');

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** FS_lighting's scenes, read as data (FS-VIEW-1.3): a `scenes` that is not an object holds none. */
function lightingScenes(ctx: ExtensionContext): Set<string> {
  const lighting = (ctx.doc.extensions as Json | undefined)?.['FS_lighting'];
  const scenes = isObject(lighting) ? lighting['scenes'] : undefined;
  return new Set(isObject(scenes) ? Object.keys(scenes) : []);
}

/** The days a month has, by the Gregorian rule. */
function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function invariants(ctx: ExtensionContext): void {
  const space = ctx.space();
  const scenes = lightingScenes(ctx);
  const views = ctx.records<View>('views');
  const levels = new Set(Object.keys(ctx.doc.levels ?? {}));
  for (const [vid, v] of views) {
    if (space.has(vid) || scenes.has(vid)) ctx.report('FS-VIEW-INV-001', `The view ID ${vid} is also the ID of an element or a lighting scene.`, [vid], P('views', vid));
    const [e, t] = [v.eye, v.target];
    if (e[0] === t[0] && e[1] === t[1] && e[2] === t[2]) ctx.report('FS-VIEW-INV-002', `View ${vid} (${v.name}) looks at the point it stands at: its eye and target are the same.`, [vid], P('views', vid, 'target'));
    if (v.level !== undefined && !levels.has(v.level)) ctx.report('FS-VIEW-INV-003', `View ${vid} (${v.name}) cuts away at the level ${v.level}, which the document does not have.`, [vid], P('views', vid, 'level'));
    if (v.scene !== undefined && !scenes.has(v.scene)) ctx.report('FS-VIEW-INV-004', `View ${vid} (${v.name}) is lit by the scene ${v.scene}, which FS_lighting does not record.`, [vid], P('views', vid, 'scene'));
    if (v.scene !== undefined && v.lights === 'off') ctx.report('FS-VIEW-INV-005', `View ${vid} (${v.name}) names a lighting scene with its lights off.`, [vid], P('views', vid, 'lights'));
    if (v.at !== undefined) {
      const [y, m, d] = v.at.slice(0, 10).split('-').map(Number) as [number, number, number];
      if (d > daysIn(y, m)) ctx.report('FS-VIEW-INV-007', `View ${vid} (${v.name}) is at ${v.at.slice(0, 10)}, a day its month does not have.`, [vid], P('views', vid, 'at'));
    }
  }
  for (let i = 0; i < views.length; i++)
    for (let j = i + 1; j < views.length; j++)
      if (views[i]![1].name === views[j]![1].name)
        ctx.report('FS-VIEW-INV-006', `Views ${views[i]![0]} and ${views[j]![0]} are both named "${views[i]![1].name}".`, [views[i]![0], views[j]![0]], P('views', views[j]![0], 'name'));
}

function lints(ctx: ExtensionContext): void {
  for (const [vid, v] of ctx.records<View>('views')) {
    if (v.twoPoint !== true) continue;
    // More than 30° up or down: 3·dz² > dx² + dy², exactly (the lengths are integers).
    const dx = BigInt(v.target[0] - v.eye[0]);
    const dy = BigInt(v.target[1] - v.eye[1]);
    const dz = BigInt(v.target[2] - v.eye[2]);
    if (3n * dz * dz > dx * dx + dy * dy) ctx.report('FS-VIEW-LINT-001', `View ${vid} (${v.name}) holds its verticals upright while looking more than 30° up or down: the lens shift takes the picture far off its subject.`, [vid], P('views', vid, 'twoPoint'));
  }
}

function derive(ctx: ExtensionContext): DerivedViews {
  return {
    views: record(ctx.records<View>('views').map(([vid, v]) => [vid, { name: v.name, level: v.level ?? null, lights: v.lights === 'on' || v.scene !== undefined ? 'on' : 'off', scene: v.scene ?? null }] as const)),
  };
}

export const FS_VIEWS: ExtensionImplementation<DerivedViews> = {
  name: 'FS_views',
  version: '0.1.0',
  code: 'VIEW',
  catalogue: [
    { code: 'FS-VIEW-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-VIEW-INV-001', severity: 'error', condition: "a view's ID is the ID of an element, a program item, an extension element or a scene of FS_lighting" },
    { code: 'FS-VIEW-INV-002', severity: 'error', condition: "a view's `eye` and `target` are the same point" },
    { code: 'FS-VIEW-INV-003', severity: 'error', condition: "a view's `level` names no level of the document" },
    { code: 'FS-VIEW-INV-004', severity: 'error', condition: "a view's `scene` names no scene of FS_lighting" },
    { code: 'FS-VIEW-INV-005', severity: 'error', condition: 'a view has a `scene` and `lights` "off"' },
    { code: 'FS-VIEW-INV-006', severity: 'error', condition: 'two views with the same `name`; once for each pair' },
    { code: 'FS-VIEW-INV-007', severity: 'error', condition: "a view's `at` names a day its month does not have" },
    { code: 'FS-VIEW-LINT-001', severity: 'warning', condition: 'two-point perspective on a view whose line of sight is more than 30° above or below level' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
