/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readModel, type Point } from '../src/editor/model';
import { EditorStore } from '../src/editor/store';
import { toScreen } from '../src/editor/viewport';
import { snapAt } from '../src/editor/precision/state';
import { calibrate, centreOf, imageToPlan, initialPlacement, moveBy, normalizeDegrees, planToImage, planWidth, replacePlacement, rotateTo, screenMatrix, type Placement } from '../src/editor/underlay/transform';
import { isUnderlay, neighbourLevel, readSaved, referenceLevel, referencePoints, underlayKey, underlayOf, type Underlay } from '../src/editor/underlay/state';
import { applyMove, applyRotation, applyScale, imageKind } from '../src/editor/underlay/actions';
import { looksLikePdf } from '../src/editor/underlay/pdf';

/**
 * FLR-T-18.12: trace and reference — an underlay's placement (pixels to the plan and back, the
 * screen matrix the canvas draws it with, the scale from two points and a length, a move by a
 * point, a turn about its centre), the view data it is kept as, the reference level's snap points
 * on the Courtyard House, and what a picked file is.
 */

const IN = 32_512;
const FT = 12 * IN;
const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const close = (a: Point, b: Point, eps = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps * Math.max(1, Math.hypot(b[0], b[1]));

const SHA = 'a'.repeat(64);

// The editor's view data lives in this browser's storage: a Map stands in for it.
const kept = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); }, clear: () => { kept.clear(); } });
});
const underlay = (p: Partial<Underlay> = {}): Underlay => ({ sha256: SHA, name: 'plan.png', mediaType: 'image/png', width: 1000, height: 800, origin: [0, 0], scale: FT / 20, rotation: 0, opacity: 0.6, locked: false, state: 'on', ...p });

describe('an underlay’s placement', () => {
  const p: Placement = { origin: [10 * FT, 30 * FT], scale: FT / 20, rotation: 0 };

  it('puts pixel (0, 0) at the origin, x east and y south, a pixel `scale` long', () => {
    expect(imageToPlan(p, 0, 0)).toEqual([10 * FT, 30 * FT]);
    expect(imageToPlan(p, 20, 0)).toEqual([11 * FT, 30 * FT]);
    expect(imageToPlan(p, 0, 20)).toEqual([10 * FT, 29 * FT]);
    expect(planWidth(p, 1000)).toBe(50 * FT);
  });

  it('turns counter-clockwise, the plan’s y up', () => {
    const q = { ...p, rotation: 90 };
    expect(close(imageToPlan(q, 20, 0), [10 * FT, 31 * FT])).toBe(true);
    expect(close(imageToPlan(q, 0, 20), [11 * FT, 30 * FT])).toBe(true);
  });

  it('maps a plan point back to its pixel, at any turn', () => {
    for (const rotation of [0, 30, -45, 90, 180, 137.5]) {
      const q = { ...p, rotation };
      const px: Point = [123.5, 456.25];
      expect(close(planToImage(q, imageToPlan(q, ...px)), px, 1e-9)).toBe(true);
    }
  });

  it('draws on the canvas where its pixels are: the screen matrix agrees with toScreen', () => {
    const view = { cx: 20 * FT, cy: 25 * FT, s: 16 / FT, w: 1200, h: 800 };
    for (const rotation of [0, 15, 90, -120]) {
      const q = { ...p, rotation };
      const [a, b, c, d, e, f] = screenMatrix(q, view);
      for (const [ix, iy] of [[0, 0], [1000, 0], [0, 800], [333, 777]] as Point[]) {
        const viaMatrix: Point = [a * ix + c * iy + e, b * ix + d * iy + f];
        const viaPlan = toScreen(view, imageToPlan(q, ix, iy));
        expect(close(viaMatrix, viaPlan, 1e-9)).toBe(true);
      }
    }
  });

  it('sets its scale from two points and a typed length, the first point staying put', () => {
    const a = imageToPlan(p, 100, 100);
    const b = imageToPlan(p, 300, 100); // 200 px: 10 ft as first placed
    const next = calibrate(p, a, b, 25 * FT)!;
    expect(next.scale).toBeCloseTo((25 * FT) / 200, 9);
    expect(close(imageToPlan(next, 100, 100), a)).toBe(true);
    const b2 = imageToPlan(next, 300, 100);
    expect(Math.hypot(b2[0] - a[0], b2[1] - a[1])).toBeCloseTo(25 * FT, 3);
    expect(calibrate(p, a, a, 10 * FT)).toBeNull();
    expect(calibrate(p, a, b, 0)).toBeNull();
    expect(calibrate(p, a, b, Number.NaN)).toBeNull();
  });

  it('moves by a point, and turns about its centre', () => {
    const from = imageToPlan(p, 0, 0);
    const moved = moveBy(p, from, [0, 0]);
    expect(moved.origin).toEqual([0, 0]);
    const c = centreOf(p, 1000, 800);
    const turned = rotateTo(p, 90, c);
    expect(turned.rotation).toBe(90);
    expect(close(centreOf(turned, 1000, 800), c)).toBe(true);
    expect(rotateTo(p, 450, c).rotation).toBe(90);
    expect(normalizeDegrees(-190)).toBe(170);
    expect(normalizeDegrees(180)).toBe(180);
    expect(normalizeDegrees(-0)).toBe(0);
  });

  it('is laid over the level when imported, and a replacement keeps its width on the plan', () => {
    const frame = { minX: 0, minY: 0, maxX: 60 * FT, maxY: 40 * FT };
    const first = initialPlacement(1200, 800, frame);
    // As wide as 90% of the frame (the image is the wider of the two), centred.
    expect(planWidth(first, 1200)).toBeCloseTo(54 * FT, 3);
    expect(close(centreOf(first, 1200, 800), [30 * FT, 20 * FT], 1e-9)).toBe(true);
    const replaced = replacePlacement(first, 1200, 2400);
    expect(planWidth(replaced, 2400)).toBeCloseTo(54 * FT, 3);
    expect(replaced.origin).toEqual(first.origin);
  });
});

describe('the underlay is view data, checked when read back', () => {
  afterEach(() => { kept.clear(); });

  it('accepts what it wrote and ignores anything else', () => {
    expect(isUnderlay(underlay())).toBe(true);
    expect(isUnderlay(underlay({ page: 2 }))).toBe(true);
    expect(isUnderlay({ ...underlay(), sha256: 'nope' })).toBe(false);
    expect(isUnderlay({ ...underlay(), scale: 0 })).toBe(false);
    expect(isUnderlay({ ...underlay(), opacity: 2 })).toBe(false);
    expect(isUnderlay({ ...underlay(), state: 'maybe' })).toBe(false);
    expect(isUnderlay({ ...underlay(), origin: [1] })).toBe(false);
    localStorage.setItem(underlayKey('p'), JSON.stringify({ levels: { L1: underlay(), L2: { evil: true } }, reference: 'sideways' }));
    const saved = readSaved('p');
    expect(Object.keys(saved.levels)).toEqual(['L1']);
    expect(saved.reference).toBe('off');
    localStorage.setItem(underlayKey('p'), '{not json');
    expect(readSaved('p')).toEqual({ levels: {}, reference: 'off' });
  });
});

describe('trace and reference on the Courtyard House', () => {
  afterEach(() => { kept.clear(); });
  const model = readModel('h', HOUSE);
  const L1 = model.levels.find((l) => l.id === 'L1')!;
  const L2 = model.levels.find((l) => l.id === 'L2')!;

  function editor(level: string): EditorStore {
    const store = new EditorStore(`underlay-${level}-${String(Math.random())}`);
    store.set({ model, level, status: 'ready', view: { cx: 0, cy: 0, s: 16 / FT, w: 1200, h: 800 } });
    return store;
  }

  it('finds the level below and above, and draws nothing past the ends', () => {
    const upper = editor('L2');
    expect(neighbourLevel(upper, 'L2', 'below')?.id).toBe('L1');
    expect(neighbourLevel(upper, 'L2', 'above')).toBeNull();
    expect(neighbourLevel(upper, 'L1', 'above')?.id).toBe('L2');
    expect(referenceLevel(upper)).toBeNull();
    underlayOf(upper).setReference('below');
    expect(referenceLevel(upper)?.id).toBe('L1');
    underlayOf(upper).setReference('above');
    expect(referenceLevel(upper)).toBeNull();
    expect(referencePoints(upper)).toEqual([]);
  });

  it('snaps to the reference level’s junctions and wall corners while it is shown, not before', () => {
    const upper = editor('L2');
    const j = L1.junctions.find((x) => !L2.junctions.some((y) => Math.hypot(y.position[0] - x.position[0], y.position[1] - x.position[1]) < 2 * FT))!;
    expect(j, 'a main-floor junction with nothing upstairs near it').toBeDefined();
    const near: Point = [j.position[0] + IN / 4, j.position[1] - IN / 4];
    const tol = 10 / (16 / FT);
    const off = snapAt(upper, L2, near, { tol });
    expect(off.kind).not.toBe('ghost');
    underlayOf(upper).setReference('below');
    const pts = referencePoints(upper);
    expect(pts.length).toBeGreaterThanOrEqual(L1.junctions.length);
    expect(pts.every((r) => Number.isInteger(r.point[0]) && Number.isInteger(r.point[1]))).toBe(true);
    const on = snapAt(upper, L2, near, { tol });
    expect(on.kind).toBe('ghost');
    expect(on.point).toEqual(j.position);
    expect(on.label).toBe(`Junction on ${L1.name}`);
  });

  it('calibrates, moves and turns through the store, and a lock holds it', () => {
    const store = editor('L1');
    const u = underlayOf(store);
    const start = underlay({ origin: [0, 10 * FT] });
    u.put('L1', start);
    const a = imageToPlan(start, 100, 100);
    const b = imageToPlan(start, 500, 100);
    expect(applyScale(store, 'L1', a, b, 40 * FT)).toBeNull();
    expect(u.of('L1')!.scale).toBeCloseTo((40 * FT) / 400, 9);
    expect(u.get().interaction).toBeNull();
    expect(applyScale(store, 'L1', a, a, 40 * FT)).toMatch(/same point/);
    const corner = imageToPlan(u.of('L1')!, 0, 0);
    applyMove(store, 'L1', corner, [5 * FT, 5 * FT]);
    expect(close(imageToPlan(u.of('L1')!, 0, 0), [5 * FT, 5 * FT])).toBe(true);
    applyRotation(store, 'L1', 30);
    expect(u.of('L1')!.rotation).toBe(30);
    // Kept in this browser, for this project.
    expect(readSaved(store.projectId).levels['L1']?.rotation).toBe(30);
    u.update('L1', { locked: true });
    const held = u.of('L1')!;
    applyRotation(store, 'L1', 60);
    applyMove(store, 'L1', [0, 0], [FT, FT]);
    expect(applyScale(store, 'L1', a, b, 10 * FT)).toBe('The underlay is locked.');
    expect(u.of('L1')).toEqual(held);
    // Opacity and the layer state are not its placement: a locked underlay can still be faded or hidden.
    u.update('L1', { opacity: 0.3, state: 'ghost' });
    expect(u.of('L1')!.opacity).toBe(0.3);
    expect(u.of('L1')!.state).toBe('ghost');
    u.remove('L1');
    expect(u.of('L1')).toBeUndefined();
    expect(readSaved(store.projectId).levels).toEqual({});
  });

  it('ends a calibration when the level changes', () => {
    const store = editor('L1');
    const u = underlayOf(store);
    u.put('L1', underlay());
    u.begin('calibrate');
    expect(u.get().interaction?.kind).toBe('calibrate');
    store.set({ level: 'L2' });
    expect(u.get().interaction).toBeNull();
  });
});

describe('what a picked file is', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('reads PNG, JPEG and WebP from their first bytes, and a PDF from its header', () => {
    expect(imageKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(imageKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(imageKind(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageKind(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('\n\n%PDF-2.0'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('<svg/>'))).toBe(false);
  });
});
