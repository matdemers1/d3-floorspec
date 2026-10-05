/** Extension elements (12.6): each one's fallback box — its footprint in plan from its bottom to its top — as a block. */
import type { Derived } from '@floorspec/engine';
import { MeshBuilder } from './builder.js';
import type { Kernel } from './kernel.js';
import type { RawPart } from './part.js';

export function extensionParts(kernel: Kernel, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  if (!want('extension')) return [];
  const out: RawPart[] = [];
  for (const id of Object.keys(derived.fallbacks ?? {}).sort()) {
    const f = derived.fallbacks![id]!;
    if (f.top <= f.bottom) continue;
    const b = new MeshBuilder(kernel);
    b.prism([f.footprint], f.bottom, f.top);
    out.push({ kind: 'extension', id, level: f.level, closed: true, extension: { name: f.extension, collection: f.collection }, exact: b });
  }
  return out;
}
