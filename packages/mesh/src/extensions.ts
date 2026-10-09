/**
 * Extension elements (12.6). Each one this reader has a model for — an outlet, a light, a toilet, a
 * cabinet, a sofa (models/) — is drawn as that model's pieces, each a part with its `model`: what
 * the element is and what the piece is made of. Every other one, and every one when models are
 * turned off, is its fallback box — its footprint in plan from its bottom to its top — as a block.
 */
import { extElements, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { MeshBuilder } from './builder.js';
import type { Kernel } from './kernel.js';
import { drawModels, type ElementModel } from './models/index.js';
import type { RawPart } from './part.js';

export function extensionParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean, models = true): RawPart[] {
  if (!want('extension')) return [];
  const out: RawPart[] = [];
  const elements = new Map(extElements(doc).map((e) => [e.id, e]));
  const drawn = models ? drawModels(kernel, doc, derived, elements) : new Map<string, ElementModel>();
  for (const id of Object.keys(derived.fallbacks ?? {}).sort()) {
    const f = derived.fallbacks![id]!;
    if (f.top <= f.bottom) continue;
    const extension = { name: f.extension, collection: f.collection };
    const m = drawn.get(id);
    if (m !== undefined) {
      for (const p of m.pieces) out.push({ kind: 'extension', id, level: f.level, piece: p.name, closed: true, extension, model: { kind: m.kind, role: p.role, ...(p.smooth && { smooth: true as const }) }, exact: p.b });
      continue;
    }
    const b = new MeshBuilder(kernel);
    b.prism([f.footprint], f.bottom, f.top);
    out.push({ kind: 'extension', id, level: f.level, closed: true, extension, exact: b });
  }
  return out;
}
