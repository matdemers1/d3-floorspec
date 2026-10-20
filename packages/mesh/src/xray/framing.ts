/**
 * Inside a wall (FLR-T-14.5): its layers as a framer builds them.
 *
 * - **The core** (5.4's `core` layer) is framed as FS_structural says on the wall (its §2.3 `framing`):
 *   studs of its member at its spacing, or a solid slab for `solid` and `panels` and for concrete,
 *   concrete masonry and masonry. A wall that records no framing is framed with Floorspec's default —
 *   2x studs, 1½″ wide and as deep as the core, **16″ on centre** — since Core's wall types carry no
 *   spacing (8.3) and FS_structural's framing is optional.
 * - **Studs** stand between a single bottom plate and a double top plate: one at each end of the core,
 *   and one centred every spacing from its start; at each opening, a king and a jack stud each side,
 *   a header over it (FS_structural §2.4's `header` when it has one, else two plies 9¼″ deep), a
 *   rough sill under a window, and cripples where the layout falls over or under it. A door's bottom
 *   plate is cut out.
 * - **Batts** fill the core's cavities when its material says it is insulated (its ID or name holds
 *   "insulat", as the libraries' `wood-stud-framing-insulated` does): every free rectangle of the
 *   elevation between the members.
 * - **Sheathing** (`substrate` layers) and **continuous insulation** (`insulation` layers) are slabs with
 *   the openings cut through. Membranes, air gaps and finishes are what X-ray fades.
 *
 * An arc wall (Core 0.4) is not framed here: its layers would follow its curve.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from '../own.js';
import { alongAt, cells, INCH, layerOffsets, openingsOf, type FrameOpening, type Rect, type WallFrame } from './frames.js';
import type { FrameBox, XrayFraming, XrayPiece } from './types.js';

/** 16″ on centre: Floorspec's default stud spacing for a wall that records none. */
export const DEFAULT_STUD_SPACING = 16 * INCH;
/** A 2x member's actual width, 1½″. */
export const DEFAULT_STUD_WIDTH = (3 * INCH) / 2;
/** A default header: two plies of 2x10, 9¼″ deep. */
export const DEFAULT_HEADER_DEPTH = (37 * INCH) / 4;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const MASONRY = new Set(['concrete', 'concreteMasonry', 'masonry']);

/** How a wall's core is framed: FS_structural's framing on the wall, else the default. */
export function framingOf(doc: FloorspecDocument, wallId: string, depth: number): XrayFraming {
  const w = get(doc.walls, wallId);
  const f = obj(obj(obj(w?.extensions)?.['FS_structural'])?.['framing']);
  if (f !== undefined) {
    const system = f['system'];
    if (system === 'solid' || system === 'panels' || (typeof f['material'] === 'string' && MASONRY.has(f['material']))) return { system: 'solid', source: 'FS_structural' };
    const m = obj(f['member']);
    const width = num(m?.['width']) ?? DEFAULT_STUD_WIDTH;
    const designation = typeof m?.['designation'] === 'string' ? m['designation'] : undefined;
    return {
      system: 'studs',
      spacing: num(f['spacing']) ?? DEFAULT_STUD_SPACING,
      member: { width, depth, ...(designation === undefined ? {} : { designation }) },
      source: 'FS_structural',
    };
  }
  return { system: 'studs', spacing: DEFAULT_STUD_SPACING, member: { width: DEFAULT_STUD_WIDTH, depth }, source: 'default' };
}

/** An opening's header: FS_structural's (plies × width, its member's depth), else the default. */
function headerOf(doc: FloorspecDocument, openingId: string): number {
  const h = obj(obj(obj(get(doc.openings, openingId)?.extensions)?.['FS_structural'])?.['header']);
  return num(obj(h?.['member'])?.['depth']) ?? DEFAULT_HEADER_DEPTH;
}

/** Whether a core layer's material says its cavities are insulated. */
function insulatedCore(doc: FloorspecDocument, material: string | undefined): boolean {
  if (material === undefined) return false;
  const m = get(doc.materials, material);
  return /insulat/i.test(material) || /insulat/i.test(m?.name ?? '');
}

/** What one wall's framing drew, and the pieces. */
export interface WallFraming {
  framing: XrayFraming;
  insulated: boolean;
  studs: number;
  kings: number;
  jacks: number;
  cripples: number;
  headers: number;
  batts: number;
  openings: string[];
  pieces: XrayPiece[];
}

/** A member's rectangle on the elevation and what it is. */
interface Member extends Rect {
  part: 'stud' | 'king' | 'jack' | 'cripple' | 'plate' | 'header' | 'sill';
}

/** The members of a stud-framed core from `c0` to `c1` along the wall. */
export function studLayout(c0: number, c1: number, base: number, top: number, width: number, spacing: number, openings: readonly (FrameOpening & { header: number })[]): Member[] {
  const w = width;
  const out: Member[] = [];
  const zb = base + w;
  const zt = top - 2 * w;
  // Plates: one at the bottom, cut out under a door; two at the top.
  const doors = openings.filter((o) => o.sill <= base).map((o) => ({ t0: o.t0, t1: o.t1, z0: base, z1: base + w }));
  for (const r of cells({ t0: c0, t1: c1, z0: base, z1: base + w }, doors)) out.push({ ...r, part: 'plate' });
  out.push({ t0: c0, t1: c1, z0: zt, z1: top, part: 'plate' });
  if (zt <= zb || c1 - c0 < w) return out;
  // Each opening's zone, king stud to king stud.
  const zones = openings.map((o) => ({ lo: o.t0 - 2 * w, hi: o.t1 + 2 * w }));
  const clear = (a: number, b: number) => zones.every((z) => b <= z.lo || a >= z.hi);
  const clamp = (a: number, b: number): [number, number] | null => {
    const lo = Math.max(c0, a);
    const hi = Math.min(c1, b);
    return hi - lo > 0 ? [lo, hi] : null;
  };
  // The layout: a stud at each end, one centred every spacing from the start.
  const layout: number[] = [];
  for (let k = 1; ; k++) {
    const p = c0 + k * spacing;
    if (p + w / 2 > c1 - w) break;
    layout.push(p);
  }
  const ends = [
    [c0, c0 + w],
    [c1 - w, c1],
  ] as const;
  for (const [a, b] of ends) if (clear(a, b)) out.push({ t0: a, t1: b, z0: zb, z1: zt, part: 'stud' });
  for (const p of layout) if (clear(p - w / 2, p + w / 2)) out.push({ t0: p - w / 2, t1: p + w / 2, z0: zb, z1: zt, part: 'stud' });
  for (const o of openings) {
    const head = Math.min(o.head, zt);
    const header = Math.min(head + o.header, zt);
    for (const [a, b, part, z1] of [
      [o.t0 - 2 * w, o.t0 - w, 'king', zt],
      [o.t0 - w, o.t0, 'jack', head],
      [o.t1, o.t1 + w, 'jack', head],
      [o.t1 + w, o.t1 + 2 * w, 'king', zt],
    ] as const) {
      const r = clamp(a, b);
      if (r !== null && z1 > zb) out.push({ t0: r[0], t1: r[1], z0: zb, z1, part });
    }
    if (head < zt) {
      const r = clamp(o.t0 - w, o.t1 + w);
      if (r !== null) out.push({ t0: r[0], t1: r[1], z0: head, z1: header, part: 'header' });
    }
    // Over the header and under a window's rough sill: cripples where the layout falls.
    const inside = layout.filter((p) => p - w / 2 >= o.t0 && p + w / 2 <= o.t1);
    if (header < zt) for (const p of inside) out.push({ t0: p - w / 2, t1: p + w / 2, z0: header, z1: zt, part: 'cripple' });
    if (o.sill > base) {
      const sill = Math.max(zb, o.sill - w);
      out.push({ t0: o.t0, t1: o.t1, z0: sill, z1: o.sill, part: 'sill' });
      if (sill > zb) for (const p of inside) out.push({ t0: p - w / 2, t1: p + w / 2, z0: zb, z1: sill, part: 'cripple' });
    }
  }
  return out;
}

const box = (f: WallFrame, r: Rect, b0: number, b1: number): FrameBox => ({ o: f.S, u: f.u, a: [r.t0, r.t1], b: [b0, b1], z: [r.z0, r.z1] });

/** A wall's framing, insulation and sheathing. */
export function frameWall(doc: FloorspecDocument, derived: Derived, f: WallFrame): WallFraming {
  const offsets = layerOffsets(f.left, f.layers);
  const coreAt = f.layers.findIndex((l) => l.function === 'core');
  const coreLayer = coreAt < 0 ? undefined : f.layers[coreAt];
  const framing: XrayFraming = coreLayer === undefined || f.arc ? { system: 'none', source: 'default' } : framingOf(doc, f.id, coreLayer.thickness);
  const insulated = coreLayer !== undefined && insulatedCore(doc, coreLayer.material);
  const result: WallFraming = { framing, insulated, studs: 0, kings: 0, jacks: 0, cripples: 0, headers: 0, batts: 0, openings: [], pieces: [] };
  if (f.arc) return result;
  const openings = openingsOf(doc, derived, f).map((o) => ({ ...o, header: headerOf(doc, o.id) }));
  result.openings = openings.map((o) => o.id);
  const holes: Rect[] = openings.map((o) => ({ t0: o.t0, t1: o.t1, z0: o.sill, z1: o.head }));
  const push = (system: XrayPiece['system'], part: string, b: FrameBox, sheet: boolean) => {
    result.pieces.push(sheet ? { system, level: f.level, part, owner: f.id, wall: f.id, shape: 'box', box: b, sheet: true } : { system, level: f.level, part, owner: f.id, wall: f.id, shape: 'box', box: b });
  };
  f.layers.forEach((layer, i) => {
    const { lo, hi } = offsets[i]!;
    const [a0, a1] = alongAt(f, (lo + hi) / 2);
    if (!(a1 > a0)) return;
    const area: Rect = { t0: a0, t1: a1, z0: f.base, z1: f.top };
    if (layer.function === 'substrate') {
      for (const r of cells(area, holes)) push('framing', 'sheathing', box(f, r, lo, hi), true);
    } else if (layer.function === 'insulation') {
      for (const r of cells(area, holes)) push('insulation', 'board', box(f, r, lo, hi), true);
    } else if (i === coreAt) {
      if (framing.system === 'solid') {
        for (const r of cells(area, holes)) push('framing', 'core', box(f, r, lo, hi), false);
        return;
      }
      const members = studLayout(a0, a1, f.base, f.top, framing.member!.width, framing.spacing!, openings);
      for (const m of members) {
        push('framing', m.part, box(f, m, lo, hi), false);
        if (m.part === 'stud') result.studs++;
        else if (m.part === 'king') result.kings++;
        else if (m.part === 'jack') result.jacks++;
        else if (m.part === 'cripple') result.cripples++;
        else if (m.part === 'header') result.headers++;
      }
      if (insulated) {
        for (const r of cells(area, [...members, ...holes])) {
          if (r.t1 - r.t0 < INCH || r.z1 - r.z0 < INCH) continue;
          push('insulation', 'batt', box(f, r, lo, hi), true);
          result.batts++;
        }
      }
    }
  });
  return result;
}
