import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, furniture, OFFICIAL_READER } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { PlanError, proposeStaging, type StagingProposal } from '../src/index.js';

/**
 * The staging assistant (FLR-T-13.11) on the Courtyard House and the suites' houses: the batch it
 * proposes commits under the reference applier as the server runs it; it adds no interference
 * FS_furniture reports — nothing in a door's swing, a clearance envelope or another piece's way —
 * and leaves every other diagnostic as it was; each rule places what it says where it says; staging
 * a staged house adds nothing; and the same plan always gives the same batch.
 */

const MM = 1280;
const COURTYARD = readFileSync(new URL('fixtures/courtyard.floorspec.json', import.meta.url), 'utf8');
const standard = new URL('../../../engine/standard/', import.meta.url);
const FLAT = readFileSync(new URL('conformance/ext/FS_furniture/0.1.0/examples/001-p8-demo-flat/input.json', standard), 'utf8');
const SHOWCASE = readFileSync(new URL('../../../mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8');

type Json = Record<string, unknown>;
interface Placed {
  host: Json;
  category: string;
  catalogue: string;
  with?: string;
  fallback: { box: { min: number[]; max: number[] }; asset: string; symbol: string };
}

function commit(doc: string, p: StagingProposal): string {
  const r = apply(doc, { batch: p.batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

const codes = (doc: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const d of check(doc, OFFICIAL_READER).diagnostics) out[d.code] = (out[d.code] ?? 0) + 1;
  return out;
};

const pieces = (doc: string): Record<string, Placed> => (JSON.parse(doc) as { extensions: { FS_furniture: { collections: { pieces: Record<string, Placed> } } } }).extensions.FS_furniture.collections.pieces;

describe('staging the Courtyard House', () => {
  const p = proposeStaging(COURTYARD);
  const after = commit(COURTYARD, p);
  const placed = pieces(after);
  const of = (room: string, prefix: string) => p.added.filter((a) => a.room === room && a.item.startsWith(prefix));

  it('commits, valid, with no new diagnostic of any kind — no piece in a swing, an envelope or another piece', () => {
    expect(p.added.length).toBeGreaterThan(60);
    expect(check(after, OFFICIAL_READER).valid).toBe(true);
    expect(codes(after)).toEqual(codes(COURTYARD));
  });

  it('places only starter-library decor, each with its model and symbol as assets and its library box size', () => {
    const doc = JSON.parse(after) as { assets: Record<string, { sha256: string }> };
    for (const a of p.added) {
      const el = placed[a.id]!;
      const item = furniture.STARTER_LIBRARY_ITEMS[a.item]!;
      expect(el.catalogue, a.id).toBe(a.item);
      expect(el.category, a.id).toBe(item.element.category);
      expect(doc.assets[el.fallback.asset]?.sha256, a.id).toBe(item.model.sha256);
      expect(doc.assets[el.fallback.symbol]?.sha256, a.id).toBe(item.symbol.sha256);
      // Curtains and blinds are sized to their windows, a bed's throw to its bed, a mirror to its wall: the rest keep the library's size.
      if (!/^(curtains|blind|throw-bed|mirror)/.test(a.item))
        for (const k of [0, 1, 2]) expect(el.fallback.box.max[k]! - el.fallback.box.min[k]!, `${a.id} ${String(k)}`).toBe(item.element.fallback.box.max[k]! - item.element.fallback.box.min[k]!);
    }
    // Each library file once, however many pieces name it.
    expect(new Set(p.files.map((f) => f.sha256)).size).toBe(p.files.length);
  });

  it('dresses the great room: rugs under the seating group and the dining table, a floor lamp, textiles, curtains, a tree', () => {
    expect(of('R7', 'rug-').map((a) => a.with).sort()).toEqual(['GR-SOFA', 'GR-TABLE']);
    expect(of('R7', 'lamp-floor')).toHaveLength(1);
    expect(of('R7', 'cushion').every((a) => a.with === 'GR-SOFA')).toBe(true);
    expect(of('R7', 'throw-sofa')).toHaveLength(1);
    expect(of('R7', 'curtains')).not.toHaveLength(0);
    expect(of('R7', 'plant-')).not.toHaveLength(0);
    expect(of('R7', 'vase-stems')).toHaveLength(1);
    // The seating rug: the coffee table wholly on it.
    const rug = of('R7', 'rug-').find((a) => a.with === 'GR-SOFA')!;
    expect(rug.item).toBe('rug-3000x2000');
  });

  it('dresses each bedroom: a rug under the bed, a lamp on every nightstand grouped with the bed, cushions and a throw', () => {
    for (const [room, bed] of [['R1', 'GB-BED'], ['R17', 'PB-BED'], ['R14', 'B2-BED'], ['R15', 'B3-BED']] as const) {
      expect(of(room, 'rug-').map((a) => a.with), room).toEqual([bed]);
      const lamps = of(room, 'lamp-table').filter((a) => a.rule === 'on the nightstand');
      expect(lamps.map((a) => a.with), room).toEqual([bed, bed]);
      expect(of(room, 'cushion').length, room).toBeGreaterThan(0);
      expect(of(room, 'throw-bed').map((a) => a.with), room).toEqual([bed]);
      // On top of the nightstand: its box raised to the nightstand's height.
      for (const l of lamps) expect(placed[l.id]!.fallback.box.min[2], l.id).toBe(600 * MM);
    }
    expect(of('R1', 'art-').some((a) => a.rule === 'over the bed')).toBe(true);
  });

  it('hangs art and mirrors on wall faces, clear of the floor; curtains on the walls of windows', () => {
    for (const a of p.added.filter((x) => /^(art|mirror|curtains|blind|towel-bar)/.test(x.item))) {
      const h = placed[a.id]!.host;
      expect(h['mode'], a.id).toBe('wallFace');
      if (!a.item.startsWith('curtains')) expect(h['height'] as number, a.id).toBeGreaterThan(900 * MM);
    }
  });

  it('dresses the kitchen and the baths', () => {
    expect(of('R8', 'bowl-fruit').map((a) => a.with)).toEqual(['KIT-ISLAND']);
    expect(of('R8', 'kettle')).toHaveLength(1);
    expect(of('R8', 'blind-')).not.toHaveLength(0);
    expect(of('R2', 'soap-set').map((a) => a.with)).toEqual(['GBA-VAN']);
    expect(of('R19', 'mirror-').map((a) => a.with).sort()).toEqual(['PBA-VAN0', 'PBA-VAN1']);
    // No curtains where water is.
    for (const room of ['R2', 'R4', 'R8', 'R12', 'R19']) expect(of(room, 'curtains'), room).toEqual([]);
  });

  it('leaves the garage, the pantry, the laundry and the roof deck alone', () => {
    for (const room of ['R9', 'R10', 'R11', 'R18', 'R20']) expect(of(room, ''), room).toEqual([]);
  });

  it('explains what it did room by room, and never claims a design is compliant', () => {
    expect(p.name).toMatch(/^Staging: /);
    expect(p.name.length).toBeLessThanOrEqual(120);
    const said = p.explanation.join('\n');
    expect(said).toContain('Great room: ');
    expect(said).toContain('rug under the seating group');
    expect(said).not.toMatch(/complian/i);
  });

  it('adds nothing to a house it has staged', () => {
    const again = proposeStaging(after);
    expect(again.batch).toEqual([]);
    expect(again.explanation[0]).toMatch(/^Nothing to stage/);
  });

  it('gives the same batch every time', () => {
    expect(JSON.stringify(proposeStaging(COURTYARD).batch)).toBe(JSON.stringify(p.batch));
  });
});

describe('the rooms asked for', () => {
  it('stages only those rooms, and names them in the changeset', () => {
    const p = proposeStaging(COURTYARD, { rooms: ['R7'] });
    expect(new Set(p.added.map((a) => a.room))).toEqual(new Set(['R7']));
    expect(p.name).toBe('Staging: Great room');
    expect(p.rooms).toEqual(['R7']);
  });

  it('stages only a level asked for', () => {
    const p = proposeStaging(COURTYARD, { level: 'L2' });
    const rooms = (JSON.parse(COURTYARD) as { rooms: Record<string, { level: string }> }).rooms;
    expect(p.added.every((a) => rooms[a.room]?.level === 'L2')).toBe(true);
  });

  it('refuses a room or a level the plan does not have', () => {
    expect(() => proposeStaging(COURTYARD, { rooms: ['NOPE'] })).toThrow(PlanError);
    expect(() => proposeStaging(COURTYARD, { level: 'L9' })).toThrow(PlanError);
  });

  it('never mints an ID the plan once used', () => {
    const first = proposeStaging(COURTYARD, { rooms: ['R7'] });
    const retired = first.added.map((a) => a.id);
    const second = proposeStaging(COURTYARD, { rooms: ['R7'], retired });
    for (const a of second.added) expect(retired).not.toContain(a.id);
  });
});

describe('other houses', () => {
  for (const [name, doc] of [
    ['the showcase', SHOWCASE],
    ['the FS_furniture demo flat', FLAT],
  ] as const)
    it(`stages ${name} without a new diagnostic`, () => {
      const p = proposeStaging(doc);
      const after = commit(doc, p);
      expect(check(after, OFFICIAL_READER).valid).toBe(true);
      expect(codes(after)).toEqual(codes(doc));
    });

  it('says so when a plan is not valid', () => {
    expect(() => proposeStaging('{"floorspec":"0.2"}')).toThrow(/fix it before staging it/);
  });
});
