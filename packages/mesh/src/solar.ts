/**
 * FS_energy's solar arrays in 3D (FLR-T-16.1): each module a thin slab of dark glass lying on its roof
 * face — 100 mm above it, flush — or on its rack on a flat roof, a rack's legs under its back edge in
 * aluminium. Drawn from the engine's `arrayModules`, the same modules the plan draws, instead of the
 * array's fallback box; coordinates rounded to base units. No texture: a module's cells are its colour,
 * so the editor's 3D view spends nothing of its texture units on them.
 */
import { arrayModules, deriveRoofs, energyCollection, type FloorspecDocument, type SolarArray } from '@floorspec/engine';
import { MeshBuilder, type P3 } from './builder.js';
import type { Kernel } from './kernel.js';
import type { ModelRole } from './roles.js';

/** A module's thickness, glass to backsheet with its frame: 40 mm. */
export const MODULE_THICKNESS = 51_200;

const R = (v: number): number => Math.round(v) + 0;

export interface SolarPiece {
  readonly piece: string;
  readonly role: ModelRole;
  readonly b: MeshBuilder;
}

/** A slab on four corners (counter-clockwise from above), `t` thick along `n`. */
function slab(b: MeshBuilder, c: readonly (readonly [number, number, number])[], n: readonly [number, number, number], t: number): void {
  const bot = c.map((p): P3 => [R(p[0]), R(p[1]), R(p[2])]);
  const top = c.map((p): P3 => [R(p[0] + n[0] * t), R(p[1] + n[1] * t), R(p[2] + n[2] * t)]);
  b.quad(top[0]!, top[1]!, top[2]!, top[3]!);
  b.quad(bot[3]!, bot[2]!, bot[1]!, bot[0]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.quad(bot[i]!, bot[j]!, top[j]!, top[i]!);
  }
}

/** The pieces of every array of a document, by its ID: its modules, and a rack's legs. */
export function solarPieces(kernel: Kernel, doc: FloorspecDocument): Map<string, SolarPiece[]> {
  const out = new Map<string, SolarPiece[]>();
  const arrays = energyCollection<SolarArray>(doc, 'pvArrays');
  if (arrays.length === 0) return out;
  const roofs = deriveRoofs(doc, doc.floorspec === '0.4');
  for (const [id, a] of arrays) {
    const mods = arrayModules(doc, a, roofs[a.roof]);
    if (mods.length === 0) continue;
    const glass = new MeshBuilder(kernel);
    for (const m of mods) slab(glass, m.corners, m.normal, MODULE_THICKNESS);
    const pieces: SolarPiece[] = [{ piece: 'modules', role: 'pvModule', b: glass }];
    if (a.tilt) {
      // A leg under each back corner of each module, from the roof up to the module.
      const legs = new MeshBuilder(kernel);
      const w = 25_600;
      for (const m of mods) {
        const back = [...m.corners].sort((p, q) => q[2] - p[2]).slice(0, 2);
        const low = Math.min(...m.corners.map((p) => p[2]));
        for (const p of back) legs.prism([[[R(p[0] - w), R(p[1] - w)], [R(p[0] + w), R(p[1] - w)], [R(p[0] + w), R(p[1] + w)], [R(p[0] - w), R(p[1] + w)]]], R(low - 192_000), R(p[2]));
      }
      pieces.push({ piece: 'rack', role: 'pvFrame', b: legs });
    }
    out.set(id, pieces);
  }
  return out;
}
