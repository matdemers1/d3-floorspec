import type { EditorStore } from './store';
import { kindOf, labelOf, sortedLevels } from './model';
import { roomsBeside } from './geometry';
import { exteriorOutline } from '@floorspec/engine';
import { addLevel, addRoof, DEFAULT_LEVEL_HEIGHT, removeOps, setUnits, type RemoveKind } from './ops';
import type { UnitSystem } from './units';
import { removeDevice, removeRecord } from './systems/ops';

/**
 * Edits that more than one surface starts — the keyboard, the inspector, the tree, the command
 * registry — in one place, so each builds its batch the same way.
 */

/** Remove an element, asking first where the batch needs an answer (Ops 4.7's `keep`). */
export function requestRemove(store: EditorStore, id: string): void {
  const s = store.get();
  const model = s.model;
  if (model === null || s.readOnly !== null) return;
  const kind = kindOf(model, id);
  const name = labelOf(model, id);
  if (kind === 'wall') {
    const level = model.levels.find((l) => l.walls.some((w) => w.id === id));
    const sides = level === undefined ? { left: null, right: null } : roomsBeside(level, id);
    if (sides.left !== null && sides.right !== null && sides.left !== sides.right) {
      store.set({ prompt: { kind: 'keep', wall: id, rooms: [sides.left, sides.right] } });
      return;
    }
    void store.apply(`Remove ${name}`, removeOps(id, 'wall'), { select: () => null });
    return;
  }
  if (kind === 'extensionElement') {
    // Its references go in the same batch: a circuit's loads, a switch's controls (Ops 0.5).
    void store.apply(`Remove ${name}`, removeDevice(model.document, id), { select: () => null });
    return;
  }
  if (kind === 'circuit' || kind === 'stack' || kind === 'gasSource') {
    const at = model.records.get(id);
    if (at !== undefined) void store.apply(`Remove ${name}`, removeRecord(model.document, at.extension, at.collection, id), { select: () => null });
    return;
  }
  if (kind === 'level' || kind === 'building' || kind === 'optionSet' || kind === 'option') {
    store.set({
      prompt: {
        kind: 'remove',
        id,
        title: `Remove ${name}?`,
        detail:
          kind === 'level'
            ? 'Everything drawn on it goes too: its walls, openings, separators and rooms. Undo brings it all back.'
            : kind === 'building'
              ? 'Its levels and everything on them go too. Undo brings it all back.'
              : kind === 'optionSet'
                ? 'Its options and everything drawn in them go too (Ops 2.2). The common design stays. Undo brings them back.'
                : 'Everything drawn in it goes too (Ops 2.2). A primary option leaves its set without one until another is made primary. Undo brings it back.',
      },
    });
    return;
  }
  const removeKind: RemoveKind =
    kind === 'junction' || kind === 'opening' || kind === 'room' || kind === 'separator' || kind === 'material'
      ? kind
      : kind === 'wallType' || kind === 'doorType' || kind === 'windowType'
        ? 'type'
        : 'other';
  void store.apply(`Remove ${name}`, removeOps(id, removeKind), { select: () => null });
}

/** Answer the prompt: remove the wall keeping one room, or remove the level or building. */
export function confirmPrompt(store: EditorStore, keep?: string): void {
  const prompt = store.get().prompt;
  const model = store.get().model;
  store.set({ prompt: null });
  if (prompt === null || model === null) return;
  if (prompt.kind === 'keep') {
    void store.apply(`Remove ${labelOf(model, prompt.wall)}`, removeOps(prompt.wall, 'wall', keep), { select: () => keep ?? null });
    return;
  }
  const kind = kindOf(model, prompt.id) === 'building' ? 'building' : 'level';
  void store.apply(`Remove ${labelOf(model, prompt.id)}`, removeOps(prompt.id, kind), { select: () => null });
}

/** Add a level above the highest (or Level 1 on an empty project), and switch to it. */
export function newLevel(store: EditorStore): void {
  const model = store.get().model;
  if (model === null) return;
  const levels = sortedLevels(model.document);
  const top = levels[levels.length - 1]?.level;
  const elevation = top === undefined ? 0 : Number(top['elevation']) + Number(top['height']);
  const height = top === undefined ? DEFAULT_LEVEL_HEIGHT : Number(top['height']);
  const name = `Level ${String(levels.length + 1)}`;
  void store.apply(`Add ${name}`, addLevel(model.document, { name, elevation, height }), {
    select: (created) => created.find((id) => model.index.get(id) === undefined && /^L\d+$/.test(id)) ?? null,
  });
}

/** Switch the project's display units: a setProperty on the document's extras, undoable. */
export function switchUnits(store: EditorStore, system: UnitSystem): void {
  if (store.units === system) return;
  void store.apply(system === 'metric' ? 'Show metric' : 'Show feet and inches', setUnits(system));
}

/**
 * A roof over the level being drawn (Core 0.3, 16.1): its footprint the outside faces of the
 * level's exterior walls as the engine derives them (the largest group of walls, when there are
 * several), with the roof tool's pitch, overhang and gables. The roof layer is shown.
 */
export function roofOverLevel(store: EditorStore): void {
  const s = store.get();
  if (s.model === null || s.level === null || s.readOnly !== null) return;
  let rings: [number, number][][];
  try {
    rings = exteriorOutline(s.model.document, s.level);
  } catch {
    rings = [];
  }
  const ring = rings[0];
  if (ring === undefined || ring.length < 3) {
    store.set({ notice: { tone: 'info', text: 'This level has no walls that enclose a space to roof over: draw them first, or draw the roof with the roof tool.' } });
    return;
  }
  store.set({ layers: { ...s.layers, roof: true } });
  void store.apply(`Roof over ${labelOf(s.model, s.level)}`, addRoof(s.model.document, s.level, ring, s.draw.roof), { select: (created) => created[0] ?? null });
}
