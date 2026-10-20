/**
 * Extension elements (12.6). Each one this reader has a model for — an outlet, a light, a toilet, a
 * cabinet, a sofa (models/) — is drawn as that model's pieces, each a part with its `model`: what
 * the element is and what the piece is made of. Every other one, and every one when models are
 * turned off, is its fallback box — its footprint in plan from its bottom to its top — as a block.
 *
 * An element paired with an FS_furniture appliance (paired.ts, FLR-T-12.34) — a washer's plumbing
 * fixture, a cooktop's gas appliance, in the appliance's box — draws nothing, models or not: the
 * appliance's parts stand for it, and say so in `standsFor`.
 */
import { extElements, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { MeshBuilder } from './builder.js';
import type { Kernel } from './kernel.js';
import { drawModels, type ElementModel } from './models/index.js';
import { pairedElements } from './paired.js';
import type { RawPart } from './part.js';
import { solarPieces } from './solar.js';

export function extensionParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean, models = true): RawPart[] {
  if (!want('extension')) return [];
  const out: RawPart[] = [];
  const elements = new Map(extElements(doc).map((e) => [e.id, e]));
  const paired = pairedElements(doc, derived);
  const standsFor = new Map<string, string[]>();
  for (const [id, appliance] of paired) standsFor.set(appliance, [...(standsFor.get(appliance) ?? []), id]);
  for (const id of paired.keys()) elements.delete(id);
  const drawn = models ? drawModels(kernel, doc, derived, elements) : new Map<string, ElementModel>();
  // FS_energy's arrays (FLR-T-16.1): their modules on the roof, never their fallback box.
  const solar = solarPieces(kernel, doc);
  for (const id of Object.keys(derived.fallbacks ?? {}).sort()) {
    const f = derived.fallbacks![id]!;
    if (f.top <= f.bottom || paired.has(id)) continue;
    const extension = { name: f.extension, collection: f.collection };
    const stands = standsFor.get(id);
    const also = stands === undefined ? {} : { standsFor: stands };
    const pv = solar.get(id);
    if (pv !== undefined && f.extension === 'FS_energy') {
      for (const p of pv) out.push({ kind: 'extension', id, level: f.level, piece: p.piece, closed: true, extension, model: { kind: 'pvArray', role: p.role }, exact: p.b });
      continue;
    }
    const m = drawn.get(id);
    if (m !== undefined) {
      for (const p of m.pieces) out.push({ kind: 'extension', id, level: f.level, piece: p.name, closed: true, extension, ...also, model: { kind: m.kind, role: p.role, ...(p.smooth && { smooth: true as const }) }, exact: p.b });
      continue;
    }
    const b = new MeshBuilder(kernel);
    b.prism([f.footprint], f.bottom, f.top);
    out.push({ kind: 'extension', id, level: f.level, closed: true, extension, ...also, exact: b });
  }
  return out;
}
