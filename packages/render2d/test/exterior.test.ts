import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER } from '@floorspec/engine';
import { BEAM_STYLE, beamOf, beamWords, bulbCount, EXTERIOR_DEFS, EXTERIOR_KINDS, exteriorMembers, exteriorOf, MODES, renderPlan, stringBox } from '../src/index.js';

/**
 * Exterior lights and their beams (FLR-T-15.5): the application's catalogue of exterior kinds kept on
 * FS_electrical's `exterior` lights (FLR-ADR-063), and where each one's light lands on the plan — a
 * pool, a cone, a fan, a half-disc, a run of bulbs — drawn in the Beams layer, in one warm tint.
 */

const IN = 32_512;
const FT = 12 * IN;
type Json = Record<string, unknown>;
const COURTYARD = readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

const light = (kind: (typeof EXTERIOR_KINDS)[number], patch: Json = {}): Json => ({ fallback: { box: structuredClone(EXTERIOR_DEFS[kind].box) }, ...exteriorMembers(kind), ...patch });
const at = (x: number, y: number, facing = 0) => ({ point: [x, y, 0], facing });
const span = (ring: readonly (readonly [number, number])[]) => {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { x: [Math.min(...xs), Math.max(...xs)] as const, y: [Math.min(...ys), Math.max(...ys)] as const };
};

describe('the exterior kinds', () => {
  it('records each kind on an exterior light, 12 V, and reads it back with its defaults', () => {
    for (const kind of EXTERIOR_KINDS) {
      const m = exteriorMembers(kind);
      expect(m).toMatchObject({ fixture: 'exterior', volts: 12 });
      expect(exteriorOf(m)).toEqual({ kind, beam: EXTERIOR_DEFS[kind].beam, reach: EXTERIOR_DEFS[kind].reach });
    }
    // A lantern — an exterior light with no kind — and an interior light are not exterior kinds.
    expect(exteriorOf({ fixture: 'exterior' })).toBeNull();
    expect(exteriorOf({ fixture: 'ceiling', extras: { d3floorspec: { exterior: { kind: 'path' } } } })).toBeNull();
    expect(exteriorOf(exteriorMembers('uplight', { beam: 15, reach: 6 * FT }))).toEqual({ kind: 'uplight', beam: 15, reach: 6 * FT });
    expect(beamWords(15)).toBe('15° spot');
    expect(beamWords(40)).toBe('40° flood');
    expect(beamWords(360)).toBe('all round');
  });

  it('hangs a string’s bulbs every 2′ and sizes its box to its run', () => {
    expect(bulbCount(12 * FT)).toBe(6);
    expect(bulbCount(FT)).toBe(2);
    expect(stringBox(20 * FT).max[0]).toBe(20 * FT);
  });
});

describe('beams on the plan', () => {
  it('pools a path light’s light about it: about 1.6 times its height in radius', () => {
    const b = beamOf('P1', light('path'), at(0, 0))!;
    expect(b.shape).toBe('pool');
    const s = span(b.ring);
    const r = Math.round((EXTERIOR_DEFS.path.box.max[2] - EXTERIOR_DEFS.path.box.min[2]) * 1.6);
    expect(s.x[1]).toBe(r);
    expect(s.x[0]).toBe(-r);
    expect(b.ring.every((p) => Number.isInteger(p[0]) && Number.isInteger(p[1]))).toBe(true);
  });

  it('throws an uplight’s cone along its facing, as far as its reach, as wide as its beam', () => {
    const narrow = beamOf('U1', light('uplight', { extras: { d3floorspec: { exterior: { kind: 'uplight', beam: 15, reach: 6 * FT } } } }), at(0, 0, 90_000_000))!;
    const wide = beamOf('U2', light('uplight', { extras: { d3floorspec: { exterior: { kind: 'uplight', beam: 60, reach: 6 * FT } } } }), at(0, 0, 90_000_000))!;
    expect(narrow.shape).toBe('cone');
    // Facing north: the cone runs up the plan to its reach.
    expect(span(narrow.ring).y[1]).toBeGreaterThanOrEqual(6 * FT);
    expect(span(narrow.ring).y[0]).toBeGreaterThanOrEqual(0);
    expect(span(wide.ring).x[1] - span(wide.ring).x[0]).toBeGreaterThan(3 * (span(narrow.ring).x[1] - span(narrow.ring).x[0]));
  });

  it('fans a wall-washer’s light out from its face, a step light’s in a half-disc before its riser', () => {
    const fan = beamOf('W1', light('wallWash'), at(0, 0))!;
    expect(fan.shape).toBe('fan');
    expect(span(fan.ring).x[0]).toBe(EXTERIOR_DEFS.wallWash.box.max[0]);
    expect(span(fan.ring).x[1]).toBe(EXTERIOR_DEFS.wallWash.box.max[0] + EXTERIOR_DEFS.wallWash.reach);
    const step = beamOf('S1', light('step'), at(0, 0))!;
    expect(step.shape).toBe('halfDisc');
    expect(span(step.ring).x[0]).toBeGreaterThanOrEqual(EXTERIOR_DEFS.step.box.max[0] - 1);
  });

  it('runs a string’s band along its box, a bulb every 2′', () => {
    const s = beamOf('T1', light('string', { fallback: { box: stringBox(16 * FT) } }), at(0, 0))!;
    expect(s.shape).toBe('string');
    expect(s.bulbs).toHaveLength(8);
    expect(span(s.ring).x).toEqual([0, 16 * FT]);
  });

  it('is null for a light that is not an exterior kind', () => {
    expect(beamOf('L1', { fixture: 'ceiling' }, at(0, 0))).toBeNull();
  });
});

describe('the Beams layer', () => {
  // Two path lights and an uplight on the Courtyard House's front lawn.
  const parsed = JSON.parse(COURTYARD) as { extensions: { FS_electrical: { collections: { lights: Record<string, Json> } } } };
  const put = (id: string, kind: (typeof EXTERIOR_KINDS)[number], position: [number, number], rotation?: number) => {
    const el = light(kind);
    parsed.extensions.FS_electrical.collections.lights[id] = { ...el, fallback: { ...(el['fallback'] as Json), level: 'L1' }, host: { mode: 'free', level: 'L1', position, ...(rotation === undefined ? {} : { rotation }) } };
  };
  put('XP1', 'path', [-8_000_000, 12_000_000]);
  put('XP2', 'path', [-5_000_000, 9_800_000]);
  put('XU1', 'uplight', [-7_000_000, 2_944_000], 180_000_000);
  const doc = JSON.stringify(parsed);

  it('is a valid plan', () => {
    expect(check(doc, OFFICIAL_READER).valid).toBe(true);
  });

  it('draws every exterior light’s beam in the electrical and landscape plans, in the warm tint with a dashed edge', () => {
    for (const mode of ['electrical', 'landscape'] as const) {
      const svg = renderPlan(doc, { mode, level: 'L1' });
      expect(svg).toContain('<g id="beams">');
      expect(svg).toContain('data-beam="XP1" data-shape="pool"');
      expect(svg).toContain('data-beam="XU1" data-shape="cone"');
      expect(svg).toContain(`fill="${BEAM_STYLE.light.fill}"`);
      expect(svg).toContain('stroke-dasharray="3 2"');
    }
    expect(renderPlan(doc, { mode: 'electrical', level: 'L1', theme: 'dark' })).toContain(`fill="${BEAM_STYLE.dark.fill}"`);
  });

  it('leaves the beams out of the other trades’ plans, and when the layer is off', () => {
    expect(MODES.construction.layers.beams).toBe('off');
    expect(renderPlan(doc, { mode: 'plumbing', level: 'L1' })).not.toContain('data-beam=');
    expect(renderPlan(doc, { mode: 'electrical', level: 'L1', layers: { beams: 'off' } })).not.toContain('data-beam=');
  });

  it('draws a plan without exterior kinds exactly as before', () => {
    expect(renderPlan(COURTYARD, { level: 'L1' })).not.toContain('id="beams"');
  });
});
