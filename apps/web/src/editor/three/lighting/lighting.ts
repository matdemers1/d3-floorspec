/**
 * Lighting design in the editor (FLR-T-13.12, FS_lighting 0.1.0, FLR-ADR-043), without React: the
 * house's lights, what each switch (and each plugged-in lamp) controls, the scenes the Lighting
 * panel offers, and the Ops that save, rename and delete a scene. Which lights are on now is the 3D
 * view's state (mode.ts); a scene is saved to the document only when a person says so.
 */
import { ALL_ON, CCT_SLIDER, lightingData, lightsOf, luminairesOf, normalizeOn, sameLighting, scenesOf, settingOf, type FixtureLight, type Lighting, type LuminaireData, type NamedScene } from '@floorspec/mesh';
import type { Batch } from '../../ops';
import { labelOf, type EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { threeOf } from '../mode';

/** The version of FS_lighting the editor writes, and of FS_electrical it requires (Core 12.3). */
export const FS_LIGHTING_VERSION = '0.1.0';
const FS_ELECTRICAL_VERSION = '0.1.0';
/** The Core drafts FS_lighting is evaluated for (its 1.1): a scene saved in another is not read. */
const CORE_DRAFTS = ['0.2', '0.3', '0.4'];

/** Every light of the house at full, in `lightsOf`'s order: the lights a lighting can turn on. */
export function houseLights(model: EditorModel): FixtureLight[] {
  return model.derived === null ? [] : lightsOf(model.view, model.derived, ALL_ON);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What clicking an element flips (FLR-T-13.12): an FS_electrical switch's lights (its `controls`
 * that are lights), or a plugged-in lamp itself; null for anything else.
 */
export function controlsOf(model: EditorModel, id: string, lights: readonly FixtureLight[]): string[] | null {
  const ext = model.ext.get(id);
  if (ext === undefined) return null;
  if (ext.extension === 'FS_electrical' && ext.collection === 'switches') {
    const el = ((model.view.extensions as Json | undefined)?.['FS_electrical'] as { collections?: { switches?: Record<string, { controls?: unknown }> } } | undefined)?.collections?.switches?.[id];
    const ids = new Set(lights.map((l) => l.id));
    const controls = Array.isArray(el?.controls) ? el.controls.filter((c): c is string => typeof c === 'string' && ids.has(c)) : [];
    return controls.length === 0 ? null : controls;
  }
  const lamp = lights.find((l) => l.id === id);
  return lamp !== undefined && lamp.switches.length === 0 && (lamp.fixture === 'floorLamp' || lamp.fixture === 'tableLamp') ? [id] : null;
}

/** A switch's (or a lamp's) name, as the view says it: "Kitchen switch", "Switch X12", "Table lamp X40". */
export function switchLabel(model: EditorModel, id: string): string {
  return labelOf(model, id);
}

/** What a switch does now, in words: "3 lights · click to turn off". */
export function switchHint(lighting: Lighting, lightsOn: boolean, controls: readonly string[]): string {
  const any = lightsOn && controls.some((c) => settingOf(lighting, c) !== null);
  const n = controls.length;
  return `${String(n)} light${n === 1 ? '' : 's'} · click to turn ${any ? 'off' : 'on'}`;
}

/** The panel's scenes: "All on", the document's own, "Off". */
export function panelScenes(model: EditorModel): NamedScene[] {
  return scenesOf(model.view);
}

/** Does the view's lighting still match the scene it was chosen as? */
export function unchanged(lighting: Lighting, scene: NamedScene | undefined, lights: readonly FixtureLight[]): boolean {
  return scene !== undefined && sameLighting(lighting, scene.lighting, lights.map((l) => l.id));
}

/** How many lights are on, and how many of them dimmed, under a lighting. */
export function census(lighting: Lighting, lights: readonly FixtureLight[]): { on: number; dimmed: number; total: number } {
  let on = 0;
  let dimmed = 0;
  for (const l of lights) {
    const s = settingOf(lighting, l.id);
    if (s === null) continue;
    on++;
    if (s.output < 100) dimmed++;
  }
  return { on, dimmed, total: lights.length };
}

/** A luminaire's own data, and the colour-temperature range its control offers. */
export function luminaireOf(model: EditorModel, light: FixtureLight): { data: LuminaireData; range: readonly [number, number]; tunable: boolean } {
  const data = luminairesOf(model.view).get(light.id) ?? {};
  const range = data.cctRange ?? CCT_SLIDER;
  return { data, range, tunable: data.cctRange !== undefined };
}

// ─── Saving to the document ──────────────────────────────────────────────────────────────────

/** Why scenes cannot be saved to this document, or null when they can. */
export function cannotSave(model: EditorModel): string | null {
  const v = model.document.floorspec;
  if (typeof v !== 'string' || !CORE_DRAFTS.includes(v)) return `Scenes are saved with FS_lighting, which reads Floorspec ${CORE_DRAFTS.join(', ')} documents; this one is ${typeof v === 'string' ? v : 'not one'}.`;
  return null;
}

/** The ops that declare FS_lighting (and FS_electrical, which it requires) when the document does not yet. */
function declarations(model: EditorModel): Batch {
  const used = isObject(model.document.extensionsUsed) ? (model.document.extensionsUsed as Json) : {};
  return [
    ...(Object.hasOwn(used, 'FS_electrical') ? [] : [{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: FS_ELECTRICAL_VERSION }]),
    ...(Object.hasOwn(used, 'FS_lighting') ? [] : [{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_lighting', value: FS_LIGHTING_VERSION }]),
  ] as Batch;
}

/** A lighting as a scene's `on`: explicit, every light it turns on (FS_lighting 3.1). */
function onOf(lighting: Lighting, lights: readonly FixtureLight[]): Record<string, { output?: number; cct?: number }> {
  const on: Record<string, { output?: number; cct?: number }> = {};
  for (const l of lights) {
    const s = settingOf(lighting, l.id);
    if (s === null) continue;
    on[l.id] = { ...(s.output === 100 ? {} : { output: s.output }), ...(s.cct === undefined || s.cct === l.ownKelvin ? {} : { cct: s.cct }) };
  }
  return normalizeOn(on);
}

/** Every ID the document uses, for minting a scene's: elements, program items, extension elements, records. */
function usedIds(model: EditorModel): Set<string> {
  const ids = new Set<string>([...model.index.keys(), ...model.ext.keys(), ...model.records.keys()]);
  for (const id of Object.keys(lightingData(model.document)?.scenes ?? {})) ids.add(id);
  return ids;
}

/** The next free scene ID, `LS<n>` (FS_lighting 1.3: Ops mints no `LS`), `skip` past it on a retry. */
export function nextSceneId(model: EditorModel, skip = 0): string {
  const used = usedIds(model);
  let n = 0;
  for (const id of used) {
    const m = /^LS(\d+)$/.exec(id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  let id = `LS${String(n + 1 + skip)}`;
  while (used.has(id)) id = `LS${String(Number(id.slice(2)) + 1)}`;
  return id;
}

/** Save the view's lighting as a new scene. */
export function saveNewScene(model: EditorModel, name: string, lighting: Lighting, lights: readonly FixtureLight[], attempt = 0): { id: string; batch: Batch } {
  const id = nextSceneId(model, attempt);
  return { id, batch: [...declarations(model), { op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${id}`, value: { name, on: onOf(lighting, lights) } }] as Batch };
}

/** Save the view's lighting over a scene of the document's, keeping its name. */
export function overwriteScene(id: string, lighting: Lighting, lights: readonly FixtureLight[]): Batch {
  return [{ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${id}/on`, value: onOf(lighting, lights) }] as Batch;
}

export function renameScene(id: string, name: string): Batch {
  return [{ op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${id}/name`, value: name }] as Batch;
}

export function deleteScene(id: string): Batch {
  return [{ op: 'unsetProperty', id: '$document', path: `/extensions/FS_lighting/scenes/${id}` }] as Batch;
}

/** Is a name free for a scene (FS-LGHT-3.1.2: no two scenes share one; the built-ins' are taken too)? */
export function nameProblem(model: EditorModel, name: string, except: string | null = null): string | null {
  const n = name.trim();
  if (n === '') return 'Give the scene a name.';
  if (n.length > 200) return 'A name is at most 200 characters.';
  const taken = scenesOf(model.view).some((s) => (except === null || s.id !== except) && s.name.toLowerCase() === n.toLowerCase());
  return taken ? `There is already a scene called “${n}”.` : null;
}

/**
 * A switch (or a lamp) clicked on the plan (FLR-T-13.12): with the 3D view's lights on, it flips its
 * lights as a click in 3D does — the split view shows them change. True when it was one.
 */
export function flipFromPlan(store: EditorStore, id: string): boolean {
  const three = threeOf(store);
  const model = store.get().model;
  if (model === null || !three.get().lights) return false;
  const lights = houseLights(model);
  const controls = controlsOf(model, id, lights);
  if (controls === null) return false;
  three.flipSwitch(controls, lights.map((l) => l.id));
  return true;
}
