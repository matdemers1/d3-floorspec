/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readModel } from '../src/editor/model';
import type { ChangesetRow, HistoryEntry } from '../src/editor/api';
import { ThreeStore } from '../src/editor/three/mode';
import { ThreeController, type CameraLike } from '../src/editor/three/controller';
import {
  choiceOf,
  choicesOf,
  chipText,
  DEFAULT_COMPARE,
  defaultB,
  dividerAt,
  dividerByKey,
  dividerX,
  MAIN,
  MAX_VERSIONS,
  passes,
  sameSource,
  sideAspect,
  sideAt,
  sourceKey,
  type CompareSource,
} from '../src/editor/three/compare/compare';
import { pairRequest, pairSide } from '../src/editor/three/compare/pair';

/**
 * FLR-T-14.4: Compare in 3D — where each side is drawn (one camera, two scissored passes for a swipe;
 * each half its own viewport side by side), the divider as a slider, the sources a side can show and
 * the B a comparison opens with, the store's Compare, B's own camera when unlinked, and the pair
 * export's request.
 */

const KITCHEN = JSON.parse(readFileSync(new URL('../../../packages/engine/standard/conformance/core/0.3/examples/002-kitchen-options/input.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const model = readModel('a'.repeat(64), Object.fromEntries(Object.entries(KITCHEN).filter(([k]) => k !== 'extensions' && k !== 'extensionsUsed')));

describe('where each side is drawn', () => {
  it('swipes with one camera over the whole view: A left of the divider, B right of it', () => {
    const p = passes({ mode: 'swipe', divider: 0.5, flipped: false }, 800, 600);
    expect(p.map((x) => x.side)).toEqual(['a', 'b']);
    // One camera, one projection: both passes draw through the whole view's viewport.
    expect(p.map((x) => x.viewport)).toEqual([
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, width: 800, height: 600 },
    ]);
    expect(p.map((x) => x.scissor)).toEqual([
      { x: 0, y: 0, width: 400, height: 600 },
      { x: 400, y: 0, width: 400, height: 600 },
    ]);
    // Flipped: B on the left.
    expect(passes({ mode: 'swipe', divider: 0.25, flipped: true }, 800, 600).map((x) => [x.side, x.scissor.x, x.scissor.width])).toEqual([
      ['b', 0, 200],
      ['a', 200, 600],
    ]);
    // At an edge one side has no width, and is not drawn.
    expect(passes({ mode: 'swipe', divider: 0, flipped: false }, 800, 600).map((x) => x.side)).toEqual(['b']);
    expect(passes({ mode: 'swipe', divider: 1, flipped: false }, 800, 600).map((x) => x.side)).toEqual(['a']);
    expect(passes({ mode: 'swipe', divider: 0.5, flipped: false }, 800, 0)).toEqual([]);
  });

  it('sets the sides side by side, each half its own viewport at a half’s shape', () => {
    const p = passes({ mode: 'side', divider: 0.1, flipped: false }, 801, 600);
    expect(p.map((x) => [x.side, x.viewport])).toEqual([
      ['a', { x: 0, y: 0, width: 400, height: 600 }],
      ['b', { x: 400, y: 0, width: 401, height: 600 }],
    ]);
    expect(p.every((x) => x.scissor === x.viewport)).toBe(true);
    expect(sideAspect('side', 800, 600)).toBeCloseTo(400 / 600);
    expect(sideAspect('swipe', 800, 600)).toBeCloseTo(800 / 600);
    expect(passes({ mode: 'side', divider: 0.5, flipped: true }, 800, 600).map((x) => x.side)).toEqual(['b', 'a']);
  });

  it('says which side a point is on', () => {
    const swipe = { mode: 'swipe' as const, divider: 0.3, flipped: false };
    expect(sideAt(swipe, 100, 1000)).toBe('a');
    expect(sideAt(swipe, 300, 1000)).toBe('b');
    expect(sideAt({ ...swipe, flipped: true }, 100, 1000)).toBe('b');
    expect(sideAt({ ...swipe, mode: 'side' }, 499, 1000)).toBe('a');
    expect(sideAt({ ...swipe, mode: 'side' }, 500, 1000)).toBe('b');
    expect(dividerX(0.3, 1000)).toBe(300);
  });
});

describe('the divider', () => {
  it('moves as a slider does: arrows by 2 %, Shift and Page Up/Down by 20 %, Home and End to the edges', () => {
    expect(dividerByKey(0.5, 'ArrowRight')).toBe(0.52);
    expect(dividerByKey(0.5, 'ArrowLeft')).toBe(0.48);
    expect(dividerByKey(0.5, 'ArrowUp')).toBe(0.52);
    expect(dividerByKey(0.5, 'ArrowDown')).toBe(0.48);
    expect(dividerByKey(0.5, 'ArrowRight', true)).toBe(0.7);
    expect(dividerByKey(0.5, 'PageDown')).toBe(0.3);
    expect(dividerByKey(0.5, 'PageUp')).toBe(0.7);
    expect(dividerByKey(0.5, 'Home')).toBe(0);
    expect(dividerByKey(0.5, 'End')).toBe(1);
    expect(dividerByKey(0.99, 'ArrowRight')).toBe(1);
    expect(dividerByKey(0.01, 'ArrowLeft', true)).toBe(0);
    expect(dividerByKey(0.5, 'Enter')).toBeNull();
  });

  it('follows the pointer, kept within the view', () => {
    expect(dividerAt(250, 1000)).toBe(0.25);
    expect(dividerAt(-40, 1000)).toBe(0);
    expect(dividerAt(1200, 1000)).toBe(1);
    expect(dividerAt(10, 0)).toBe(0.5);
  });
});

describe('what a side can show', () => {
  const ago = () => 'just now';
  const proposals: ChangesetRow[] = [
    { id: 'c2', name: 'Move the laundry', status: 'pending', base: 'x', head: 'h2', ops: 5, createdBy: 'Claude', createdAt: '2026-10-19T10:00:00Z', fastForward: true },
    { id: 'c1', name: 'Bigger island', status: 'pending', base: 'x', head: 'h1', ops: 1, createdBy: 'Claude', createdAt: '2026-10-19T09:00:00Z', fastForward: true },
    { id: 'c0', name: 'Done', status: 'accepted', base: 'x', head: null, ops: 2, createdBy: null, createdAt: '2026-10-18T09:00:00Z', fastForward: null },
  ];
  const entry = (seq: number, after: string): HistoryEntry => ({ seq, kind: 'apply', author: { kind: 'account', account: null, name: null, token: null }, ops: [], resolved: null, created: [], removed: [], before: null, after, undoOf: null, changeset: null, at: '2026-10-19T08:00:00Z' });
  const log = [entry(42, model.hash), entry(41, 'v41'), entry(40, 'v40'), entry(39, 'v40')];
  const choices = choicesOf({ model, proposals, log, seq: 42, proposer: (c) => c ?? 'An agent', ago, author: () => 'You' });

  it('lists main, the pending changesets oldest first, the other options and the versions before now', () => {
    expect(choices.map((c) => [c.group, c.label])).toEqual([
      ['main', 'Main · v42'],
      ['changesets', '#1 · Bigger island'],
      ['changesets', '#2 · Move the laundry'],
      ['options', 'Deck · No deck'],
      ['options', 'Kitchen · B: open'],
      ['versions', 'v41'],
      ['versions', 'v40'],
    ]);
    expect(choices.find((c) => c.label === '#1 · Bigger island')?.detail).toBe('Claude · 1 op · just now');
    expect(choices.find((c) => c.label === 'Kitchen · B: open')?.detail).toBe('Instead of A: closed');
    expect(choices.find((c) => c.label === 'v41')?.detail).toBe('You · just now');
    expect(chipText('b', choices[1]!)).toBe('B · Changeset #1 · Bigger island');
  });

  it('offers at most a dozen versions', () => {
    const long = Array.from({ length: 30 }, (_, i) => entry(100 - i, `v${String(i)}`));
    expect(choicesOf({ model: null, proposals: [], log: long, seq: null, proposer: () => '', ago }).filter((c) => c.group === 'versions')).toHaveLength(MAX_VERSIONS);
  });

  it('names a source the picker no longer lists, and keys each source', () => {
    const gone: CompareSource = { kind: 'changeset', id: 'zz' };
    expect(choiceOf(choices, gone).label).toBe('A changeset');
    expect(sourceKey({ kind: 'option', set: 'KS', option: 'KB' })).toBe('option:KS:KB');
    expect(sameSource(MAIN, { kind: 'main' })).toBe(true);
    expect(sameSource(MAIN, null)).toBe(false);
  });

  it('opens with the newest pending changeset as B, else another option, else the version before now', () => {
    expect(defaultB(choices, MAIN)).toEqual({ kind: 'changeset', id: 'c2' });
    const noChangesets = choices.filter((c) => c.group !== 'changesets');
    expect(defaultB(noChangesets, MAIN)).toEqual({ kind: 'option', set: 'DS', option: 'DB' });
    expect(defaultB(noChangesets.filter((c) => c.group !== 'options'), MAIN)).toEqual({ kind: 'version', hash: 'v41', seq: 41 });
    expect(defaultB(choices.filter((c) => c.group === 'main'), MAIN)).toBeNull();
    // With A something else, B is main when nothing else is left.
    expect(defaultB(choices.filter((c) => c.group === 'main'), { kind: 'version', hash: 'v41', seq: 41 })).toEqual(MAIN);
  });
});

describe('Compare in the 3D view’s store', () => {
  it('opens putting away the exploded view, Edit in 3D, the tape and the panels; closes keeping its sides', () => {
    const three = new ThreeStore();
    expect(three.get().compare).toEqual(DEFAULT_COMPARE);
    three.toggleExplode(true);
    three.set({ edit: 'tape', sectionOpen: true, cameraOpen: true });
    three.toggleCompare(true);
    const s = three.get();
    expect(s.compare.open).toBe(true);
    expect(s.explode.open).toBe(false);
    expect([s.edit, s.sectionOpen, s.cameraOpen]).toEqual([null, false, false]);
    three.setCompare({ b: { kind: 'option', set: 'KS', option: 'KB' }, mode: 'side', focus: 'R1' });
    three.toggleCompare(false);
    expect(three.get().compare).toMatchObject({ open: false, b: { kind: 'option', set: 'KS', option: 'KB' }, mode: 'side', focus: null });
    // The exploded view closes Compare.
    three.toggleCompare(true);
    three.toggleExplode(true);
    expect(three.get().compare.open).toBe(false);
  });

  it('drives both sides from one camera, framed for a half’s shape side by side; unlinked, B has its own', () => {
    // The controller writes its orbit back once a gesture settles, on the window's timers.
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined, location: { search: '' } });
    const camera = (): CameraLike & { at: number[] } => {
      const c = { at: [0, 0, 0], position: { set: (x: number, y: number, z: number) => { c.at = [x, y, z]; } }, up: { set: () => undefined }, lookAt: () => undefined, updateMatrixWorld: () => undefined };
      return c;
    };
    const ctl = new ThreeController(new ThreeStore());
    ctl.size = { width: 900, height: 600 };
    const box = { min: [-5, -4, 0] as [number, number, number], max: [5, 4, 6] as [number, number, number] };
    ctl.fit(box);
    const whole = ctl.orbit!.distance;
    ctl.reframe(box, sideAspect('side', 900, 600));
    // A half is narrower: the house is framed from further back to fit it.
    expect(ctl.orbit!.distance).toBeGreaterThan(whole);
    // One camera: both passes are drawn from where the controller put it.
    const shared = camera();
    ctl.frame(shared, 0);
    // Unlinked, B's controller starts at A's orbit and turns on its own.
    const ctlB = new ThreeController(new ThreeStore());
    ctlB.orbit = ctl.orbit;
    const b = camera();
    ctlB.frame(b, 0);
    expect(b.at).toEqual(shared.at);
    ctlB.rotate(120, 0);
    ctlB.frame(b, 0);
    expect(b.at).not.toEqual(shared.at);
    ctl.frame(shared, 0);
    expect(ctl.orbit).not.toEqual(ctlB.orbit);
    vi.unstubAllGlobals();
  });
});

describe('the pair export’s request', () => {
  it('names each side as the server takes it, and the camera — this view, or a saved one', () => {
    const designed = { ...model, design: { KS: 'KA', DS: 'DA' } };
    expect(pairSide(MAIN, designed)).toEqual({ design: { KS: 'KA', DS: 'DA' } });
    expect(pairSide({ kind: 'changeset', id: 'c1' }, designed)).toEqual({ changeset: 'c1', design: { KS: 'KA', DS: 'DA' } });
    expect(pairSide({ kind: 'option', set: 'KS', option: 'KB' }, designed)).toEqual({ design: { KS: 'KB', DS: 'DA' } });
    expect(pairSide({ kind: 'version', hash: 'v41', seq: 41 }, designed)).toEqual({ version: 'v41' });
    expect(pairSide(MAIN, { ...model, design: {} })).toEqual({});
    const shot = { name: 'The view in the editor', eye: [1, 2, 3] as const, target: [4, 5, 6] as const, focalLength: 28, twoPoint: false, aspect: '3:2' as const, exposure: 0, levels: 'cutaway' as const, sky: 'clear' as const, lights: 'off' as const };
    expect(pairRequest({ a: MAIN, b: { kind: 'changeset', id: 'c1' }, main: { ...model, design: {} }, camera: { shot }, size: 'small', quality: 'draft' })).toEqual({
      a: {},
      b: { changeset: 'c1' },
      shot: { name: 'The view in the editor', eye: [1, 2, 3], target: [4, 5, 6], focalLength: 28 },
      size: 'small',
      quality: 'draft',
    });
    expect(pairRequest({ a: MAIN, b: { kind: 'version', hash: 'v41', seq: 41 }, main: { ...model, design: {} }, camera: { view: 'SV1' }, size: 'medium', quality: 'standard' })).toMatchObject({ view: 'SV1', b: { version: 'v41' } });
  });
});
