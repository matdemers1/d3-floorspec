import { describeLens, fNumber, savedViewsOf, toUnits, UNITS_PER_METRE, viewRecord, type SavedView } from '@floorspec/mesh';
import type { Batch } from '../../ops';
import type { EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { eyeOf, type Orbit } from '../camera';
import type { ThreeState } from '../mode';
import { offsetOf, type Clock } from '../sun/clock';
import type { SunState } from '../sun/study';

/**
 * Saved views in the editor (FLR-T-13.10, FS_views 0.1.0, FLR-ADR-046): the view the person is looking
 * at — the orbit, the lens and frame, the levels shown, the sky and the clock, the lights — as a view
 * of the document, and the Ops that save, update, rename and delete one on `$document`. A view's own
 * camera is the one every renderer looks through (@floorspec/mesh `viewCamera`).
 */

/** The version of FS_views the editor writes. */
export const FS_VIEWS_VERSION = '0.1.0';
/** The Core drafts FS_views is evaluated for (its 1.1). */
const CORE_DRAFTS = ['0.2', '0.3', '0.4'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The document's saved views, in ID order. */
export const viewsOf = (model: EditorModel): SavedView[] => savedViewsOf(model.document);

/** Why views cannot be saved to this document, or null when they can. */
export function cannotSaveViews(model: EditorModel): string | null {
  const v = model.document.floorspec;
  if (typeof v !== 'string' || !CORE_DRAFTS.includes(v)) return `Views are saved with FS_views, which reads Floorspec ${CORE_DRAFTS.join(', ')} documents; this one is ${typeof v === 'string' ? v : 'not one'}.`;
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The sun panel's clock as a view's `at`: the date and time, with the offset it was read in. */
export function atOfClock(clock: Clock): string {
  const off = offsetOf(clock);
  const m = Math.round(clock.minutes) % 1440;
  const sign = off < 0 ? '-' : '+';
  return `${clock.date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** A view's `at` as the sun panel's clock; null when it is not one. */
export function clockOfAt(at: string): Clock | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$/.exec(at);
  if (m === null) return null;
  const zone = m[4];
  const offset = zone === undefined ? 'auto' : zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return { date: m[1] ?? '', minutes: Number(m[2]) * 60 + Number(m[3]), offset };
}

/**
 * What the view the person is looking at would be saved as: `origin` is the mesh's (base units), the
 * orbit in metres about it. Its lighting is the scene last chosen when that is one of the document's
 * and unchanged, every light when the lights are on otherwise, and off when they are off.
 */
export function viewFromState(o: {
  name: string;
  orbit: Orbit;
  origin: readonly [number, number, number];
  three: Pick<ThreeState, 'shot' | 'levels' | 'lights' | 'scene'>;
  level: string | null;
  sun: Pick<SunState, 'sky' | 'clock'>;
  /** The view's lighting is the chosen scene's, unchanged. */
  sceneUnchanged: boolean;
}): Omit<SavedView, 'id'> {
  const origin: [number, number, number] = [o.origin[0] / UNITS_PER_METRE, o.origin[1] / UNITS_PER_METRE, o.origin[2] / UNITS_PER_METRE];
  const shot = o.three.shot;
  const dof = shot !== null && shot.dof;
  const scene = o.three.lights && o.three.scene.id !== null && o.sceneUnchanged ? o.three.scene.id : undefined;
  return {
    name: o.name,
    eye: toUnits(eyeOf(o.orbit), origin),
    target: toUnits(o.orbit.target, origin),
    focalLength: shot?.focalLength ?? 28,
    twoPoint: shot?.twoPoint ?? false,
    aspect: shot?.aspect ?? '3:2',
    ...(dof && shot.aperture !== null ? { aperture: shot.aperture, ...(shot.focus === null ? {} : { focus: Math.max(1, Math.round(shot.focus * UNITS_PER_METRE)) }) } : {}),
    exposure: shot?.exposure ?? 0,
    ...(o.three.levels === 'house' || o.level === null ? {} : { level: o.level }),
    levels: o.three.levels === 'only' ? 'only' : 'cutaway',
    sky: o.sun.sky,
    ...(o.sun.sky === 'studio' ? {} : { at: atOfClock(o.sun.clock) }),
    lights: o.three.lights ? 'on' : 'off',
    ...(scene === undefined ? {} : { scene }),
  };
}

/** The op that declares FS_views when the document does not yet. */
function declaration(model: EditorModel): Batch {
  const used = isObject(model.document.extensionsUsed) ? (model.document.extensionsUsed as Json) : {};
  return Object.hasOwn(used, 'FS_views') ? [] : ([{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_views', value: FS_VIEWS_VERSION }] as Batch);
}

/** Every ID the document uses — elements, items, extension elements, records, scenes, views — for minting a view's. */
function usedIds(model: EditorModel): Set<string> {
  const ids = new Set<string>([...model.index.keys(), ...model.ext.keys(), ...model.records.keys()]);
  const ext = isObject(model.document.extensions) ? (model.document.extensions as Json) : {};
  for (const [name, member] of [['FS_lighting', 'scenes'], ['FS_views', 'views']] as const) {
    const data = ext[name];
    const rec = isObject(data) ? data[member] : undefined;
    if (isObject(rec)) for (const id of Object.keys(rec)) ids.add(id);
  }
  return ids;
}

/** The next free view ID, `SV<n>` (FS_views: Ops mints none), `skip` past it on a retry. */
export function nextSavedViewId(model: EditorModel, skip = 0): string {
  const used = usedIds(model);
  let n = 0;
  for (const id of used) {
    const m = /^SV(\d+)$/.exec(id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  let id = `SV${String(n + 1 + skip)}`;
  while (used.has(id)) id = `SV${String(Number(id.slice(2)) + 1)}`;
  return id;
}

/** Save a view as a new one. */
export function saveNewView(model: EditorModel, view: Omit<SavedView, 'id'>, attempt = 0): { id: string; batch: Batch } {
  const id = nextSavedViewId(model, attempt);
  return { id, batch: [...declaration(model), { op: 'setProperty', id: '$document', path: `/extensions/FS_views/views/${id}`, value: viewRecord(view) }] as Batch };
}

/** Update a saved view to the view now, keeping its name. */
export function updateView(id: string, view: Omit<SavedView, 'id'>): Batch {
  return [{ op: 'setProperty', id: '$document', path: `/extensions/FS_views/views/${id}`, value: viewRecord(view) }] as Batch;
}

export function renameView(id: string, name: string): Batch {
  return [{ op: 'setProperty', id: '$document', path: `/extensions/FS_views/views/${id}/name`, value: name }] as Batch;
}

export function deleteView(id: string): Batch {
  return [{ op: 'unsetProperty', id: '$document', path: `/extensions/FS_views/views/${id}` }] as Batch;
}

/** Is a name free for a view (FS-VIEW-INV-006: no two views share one)? */
export function viewNameProblem(model: EditorModel, name: string, except: string | null = null): string | null {
  const n = name.trim();
  if (n === '') return 'Give the view a name.';
  if (n.length > 200) return 'A name is at most 200 characters.';
  return viewsOf(model).some((v) => v.id !== except && v.name === n) ? `There is already a view called “${n}”.` : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A view's line under its name: "24 mm · 3:2 · two-point · 19:30 Jun 21" — or its scene's name for the time. */
export function viewMeta(model: EditorModel, view: SavedView): string {
  const scenes = (model.document.extensions as { FS_lighting?: { scenes?: Record<string, { name?: string }> } } | undefined)?.FS_lighting?.scenes;
  const lit = view.scene !== undefined ? (scenes?.[view.scene]?.name ?? view.scene) : view.lights === 'on' ? 'All on' : null;
  const m = view.at === undefined ? null : /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(view.at);
  const when = m === null ? (view.sky === 'clear' ? null : view.sky) : `${m[3] ?? ''} ${MONTHS[Number(m[1]) - 1] ?? ''} ${String(Number(m[2]))}`;
  return [describeLens(view), lit, when].filter((x) => x !== null).join(' · ');
}

/** What a saved view's depth of field is, in words, for a caption: "f/2.8 at 6.4 m". */
export function focusWords(view: SavedView): string | null {
  if (view.aperture === undefined) return null;
  return `f/${String(fNumber(view.aperture))}${view.focus === undefined ? ' at the target' : ` at ${(view.focus / UNITS_PER_METRE).toFixed(1)} m`}`;
}

/** The editor store a saved view's Ops go through. */
export type ViewStore = Pick<EditorStore, 'apply'>;
