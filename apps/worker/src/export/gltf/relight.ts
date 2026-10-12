/**
 * A lighting scene's lenses (FLR-T-13.12, FS_lighting 3.2): a luminaire a scene turns off has a dark
 * lens, one it dims a dimmer lens, and one it sets warmer or cooler a lens of that colour — in every
 * renderer that reads the scene (the path tracer, the glTF export the GPU still and Blender read, and
 * the headless render), because each reads its lens from the scene's materials.
 *
 * The lamps themselves are @floorspec/mesh's `lightsOf` with the lighting, and which lenses change
 * and how its `lensGlows`; this module only gives each changed fixture's own glowing pieces
 * (`emissive` materials — a lens, a shade) a material of their own.
 */
import type { LensGlow } from '@floorspec/mesh';
import type { SceneLevel, SceneMaterial } from './scene.js';

/** How a fixture's glowing pieces are drawn: off (`null`), or scaled per channel (@floorspec/mesh `lensGlows`). */
export type Glow = LensGlow;

/**
 * The levels with each changed fixture's glowing primitives on a material of their own: a copy of
 * the shared one with its emissive scaled — or none, for a fixture that is off. New materials are
 * appended to `materials` (one per distinct glow and source material).
 */
export function relight(levels: readonly SceneLevel[], materials: SceneMaterial[], glows: ReadonlyMap<string, Glow>): SceneLevel[] {
  if (glows.size === 0) return [...levels];
  const made = new Map<string, number>();
  const materialFor = (index: number, glow: Glow): number => {
    const m = materials[index]!;
    if (m.emissive === undefined) return index;
    const key = `${String(index)}:${glow === null ? 'off' : glow.map((c) => c.toFixed(4)).join(',')}`;
    const at = made.get(key);
    if (at !== undefined) return at;
    const { emissive, ...rest } = m;
    const copy: SceneMaterial = glow === null
      ? { ...rest, key: `${m.key}:off`, name: `${m.name} (off)` }
      : { ...rest, key: `${m.key}:${key}`, name: `${m.name} (dimmed)`, emissive: [emissive[0] * glow[0], emissive[1] * glow[1], emissive[2] * glow[2]] };
    materials.push(copy);
    made.set(key, materials.length - 1);
    return materials.length - 1;
  };
  return levels.map((level) => ({
    ...level,
    nodes: level.nodes.map((node) => {
      if (!glows.has(node.id)) return node;
      const glow = glows.get(node.id)!;
      return { ...node, primitives: node.primitives.map((p) => ({ ...p, material: materialFor(p.material, glow) })) };
    }),
  }));
}
