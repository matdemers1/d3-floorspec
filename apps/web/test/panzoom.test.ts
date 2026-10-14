/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { addLevel, addRoom, drawChain, typeChoices, type Batch, type BatchBuilder, type ChainVertex } from '../src/editor/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { EditorStore } from '../src/editor/store';
import { codeOf, commandFor, commandForCode, COMMANDS, keyOf } from '../src/editor/commands';
import { fit, scaleForPercent, toWorld, visibleRegion, zoomPercent } from '../src/editor/viewport';
import { BASE_PER_FOOT } from '../src/editor/units';
import {
  between,
  elementBounds,
  frameOn,
  goTo,
  navOf,
  openView,
  removeView,
  revealElement,
  saveView,
  WheelDetector,
  wheelAction,
  zoomToFit,
  zoomToPercent,
  zoomToSelection,
  type WheelSample,
} from '../src/editor/panzoom';
import { parsePercent } from '../src/editor/NavChrome';

/**
 * FLR-T-18.6: pan and zoom — the keys (⇧1, ⇧2, ⇧0, H, ⌥H, ⇧N, ⇧V, ⇧⌘S), telling a trackpad from a
 * mouse wheel and what each does by the setting, the animation's in-between views, zoom to the
 * selection, going to an element (on this level and another), and saved views.
 */

const FT = BASE_PER_FOOT;

// No animation frames under Node: every move of the view is immediate. The store's preview cancels one.
(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame ??= () => undefined;

function commit(model: EditorModel, batch: Batch | BatchBuilder): EditorModel {
  const sent = typeof batch === 'function' ? batch(0) : batch;
  const result = apply(model.document, { batch: sent });
  if (result.status !== 'committed') throw new Error(`rejected: ${result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return readModel(result.hash, result.document);
}
const v = (x: number, y: number): ChainVertex => ({ point: [x * FT, y * FT] });

/** Two levels: a 30 × 20 ft box with a room on the first, a 10 × 10 ft box far off on the second. */
function twoLevels(): { model: EditorModel; L1: string; L2: string; room: string; far: string } {
  let m = readModel('blank', { floorspec: '0.1', project: { name: 'Pan and zoom' } });
  m = commit(m, addLevel(m.document, { name: 'Level 1', elevation: 0, height: 3_511_296 }));
  const L1 = m.levels[0]?.id as string;
  const ext = typeChoices(m.document, 'wallType').find((c) => c.id === 'EXT26');
  m = commit(m, drawChain(m.document, L1, [v(0, 0), v(30, 0), v(30, 20), v(0, 20), v(0, 0)], { kind: 'wall', type: ext }));
  m = commit(m, addRoom({ level: L1, at: [10 * FT, 10 * FT], name: 'Hall' }));
  m = commit(m, addLevel(m.document, { name: 'Level 2', elevation: 3_511_296, height: 3_511_296 }));
  const L2 = m.levels.find((l) => l.id !== L1)?.id as string;
  m = commit(m, drawChain(m.document, L2, [v(200, 200), v(210, 200), v(210, 210), v(200, 210), v(200, 200)], { kind: 'wall', type: ext }));
  const room = m.levels.find((l) => l.id === L1)?.rooms[0]?.id as string;
  const far = m.levels.find((l) => l.id === L2)?.walls[0]?.id as string;
  return { model: m, L1, L2, room, far };
}

function storeOn(model: EditorModel, level: string): EditorStore {
  const store = new EditorStore('panzoom-test');
  const bounds = model.levels.find((l) => l.id === level)?.bounds ?? null;
  store.set({ status: 'ready', model, level, view: fit(bounds, 800, 600) });
  return store;
}

const sample = (o: Partial<WheelSample>): WheelSample => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe('the keys', () => {
  const press = (code: string, o: { shift?: boolean; alt?: boolean; meta?: boolean } = {}) =>
    codeOf({ code, shiftKey: o.shift ?? false, altKey: o.alt ?? false, metaKey: o.meta ?? false, ctrlKey: false }, true);

  it('⇧1 fits, ⇧2 zooms to the selection, ⇧0 is 100% — by the key’s place, whatever ⇧ types there', () => {
    expect(commandForCode(press('Digit1', { shift: true }))?.id).toBe('view.fit');
    expect(commandForCode(press('Digit2', { shift: true }))?.id).toBe('view.zoomSelection');
    expect(commandForCode(press('Digit0', { shift: true }))?.id).toBe('view.zoom100');
    // The plain digits are still the views (1 plan, 2 3D) and 0 still fits.
    expect(commandForCode(press('Digit1'))).toBeUndefined();
    expect(commandFor('1')?.id).toBe('view.plan');
    expect(commandFor('0')?.id).toBe('view.fit');
  });

  it('H is the hand; the history moved to ⌥H', () => {
    expect(commandFor(keyOf({ key: 'h', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, true))?.id).toBe('tool.hand');
    // ⌥H types "˙" on a Mac: only its place names it.
    expect(commandFor(keyOf({ key: '˙', metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }, true))).toBeUndefined();
    expect(commandForCode(press('KeyH', { alt: true }))?.id).toBe('history.toggle');
    expect(COMMANDS.find((c) => c.id === 'history.toggle')?.hint).toBe('⌥H');
    expect(COMMANDS.find((c) => c.id === 'history.toggle')?.keys ?? []).not.toContain('h');
  });

  it('⇧N the minimap, ⇧V the saved views, ⇧⌘S saves the view — not N, V or S', () => {
    expect(commandForCode(press('KeyN', { shift: true }))?.id).toBe('view.minimap');
    expect(commandForCode(press('KeyV', { shift: true }))?.id).toBe('view.savedViews');
    expect(commandForCode(press('KeyS', { shift: true, meta: true }))?.id).toBe('view.saveView');
    expect(commandFor('n')?.id).toBe('tool.window');
    expect(commandFor('v')?.id).toBe('tool.select');
  });

  it('binds no key by its place twice', () => {
    const codes = COMMANDS.flatMap((c) => c.codes ?? []);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('the wheel', () => {
  it('tells a mouse wheel from a trackpad', () => {
    const d = new WheelDetector();
    // Firefox reports a wheel in lines.
    expect(d.classify(sample({ deltaY: 3, deltaMode: 1 }), 0)).toBe('mouse');
    // A notch: a whole step, a whole number of 120s in the legacy delta.
    expect(new WheelDetector().classify(sample({ deltaY: 100, wheelDeltaY: -120 }), 1000)).toBe('mouse');
    expect(new WheelDetector().classify(sample({ deltaY: 4.000244140625, wheelDeltaY: -120 }), 1000)).toBe('mouse');
    // Chromium and WebKit give a trackpad's legacy delta as −3 × deltaY, even a large one.
    expect(new WheelDetector().classify(sample({ deltaY: 40, wheelDeltaY: -120 }), 1000)).toBe('trackpad');
    // Any sideways movement, small or fractional steps.
    expect(new WheelDetector().classify(sample({ deltaX: 2, deltaY: 50 }), 1000)).toBe('trackpad');
    expect(new WheelDetector().classify(sample({ deltaY: 3.5 }), 1000)).toBe('trackpad');
    expect(new WheelDetector().classify(sample({ deltaY: 100 }), 1000)).toBe('mouse');
  });

  it('keeps a trackpad’s stream a trackpad’s, momentum included', () => {
    const d = new WheelDetector();
    expect(d.classify(sample({ deltaY: 2.5 }), 0)).toBe('trackpad');
    expect(d.classify(sample({ deltaY: 120 }), 100)).toBe('trackpad');
    // After a pause, a notch is a mouse again.
    expect(d.classify(sample({ deltaY: 100 }), 1000)).toBe('mouse');
  });

  it('zooms or pans by the setting', () => {
    const wheel = sample({ deltaY: 100 });
    const pinch = sample({ deltaY: 3, ctrlKey: true });
    const scroll = sample({ deltaY: 3 });
    expect(wheelAction('auto', wheel, 'mouse')).toBe('zoom');
    expect(wheelAction('auto', scroll, 'trackpad')).toBe('pan');
    expect(wheelAction('auto', pinch, 'trackpad')).toBe('zoom');
    expect(wheelAction('auto', { ...wheel, shiftKey: true }, 'mouse')).toBe('pan');
    expect(wheelAction('zoom', scroll, 'trackpad')).toBe('zoom');
    expect(wheelAction('zoom', { ...wheel, shiftKey: true }, 'mouse')).toBe('pan');
    expect(wheelAction('pan', wheel, 'mouse')).toBe('pan');
    expect(wheelAction('pan', { ...wheel, metaKey: true }, 'mouse')).toBe('zoom');
    expect(wheelAction('pan', pinch, 'trackpad')).toBe('zoom');
  });
});

describe('moving the view', () => {
  it('animates evenly: the scale in proportion, and a zoom about a point holds that point still', () => {
    const a = { cx: 0, cy: 0, s: 0.001, w: 800, h: 600 };
    const b = { cx: 1000, cy: 500, s: 0.004, w: 800, h: 600 };
    const start = between(a, b, 0);
    expect(start.s).toBeCloseTo(a.s, 12);
    expect([start.cx, start.cy]).toEqual([a.cx, a.cy]);
    expect(between(a, b, 1).s).toBeCloseTo(b.s, 12);
    expect(between(a, b, 0.5).s).toBeCloseTo(0.002, 12);
    const at: [number, number] = [200, 150];
    const before = toWorld(a, at);
    for (const t of [0.25, 0.5, 1]) {
      const mid = toWorld(between(a, b, t, at), at);
      expect(mid[0]).toBeCloseTo(before[0], 6);
      expect(mid[1]).toBeCloseTo(before[1], 6);
    }
  });

  it('fits, zooms to 100% and to a typed percentage — at once where there is no animation frame', () => {
    const { model, L1 } = twoLevels();
    const store = storeOn(model, L1);
    zoomToPercent(store, 100);
    expect(zoomPercent(store.get().view!)).toBe(100);
    zoomToPercent(store, 250);
    expect(zoomPercent(store.get().view!)).toBe(250);
    zoomToFit(store);
    expect(store.get().view).toEqual(fit(model.levels.find((l) => l.id === L1)!.bounds, 800, 600));
    expect(parsePercent(' 180 % ')).toBe(180);
    expect(parsePercent('180%')).toBe(180);
    expect(parsePercent('99999')).toBe(4000);
    expect(parsePercent('two')).toBeNull();
    expect(parsePercent('0')).toBeNull();
  });

  it('zooms to the selection, framed, no closer than 400%', () => {
    const { model, L1, room } = twoLevels();
    const store = storeOn(model, L1);
    expect(zoomToSelection(store)).toBe(false);
    store.select(room);
    expect(zoomToSelection(store)).toBe(true);
    const view = store.get().view!;
    const b = elementBounds(model.levels.find((l) => l.id === L1)!, room)!;
    const shown = visibleRegion(view);
    expect(shown.minX).toBeLessThanOrEqual(b.minX);
    expect(shown.maxX).toBeGreaterThanOrEqual(b.maxX);
    expect(view.s).toBeLessThanOrEqual(scaleForPercent(400));
    // A wall end — a point — is not a screenful.
    const junction = model.levels.find((l) => l.id === L1)!.junctions[0]!.id;
    store.select(junction);
    zoomToSelection(store);
    expect(zoomPercent(store.get().view!)).toBe(400);
  });

  it('goes to an element: the view stays when it is in view, comes to it when it is not, and onto its level', () => {
    const { model, L1, L2, room, far } = twoLevels();
    const store = storeOn(model, L1);
    const fitted = store.get().view!;
    goTo(store, room);
    expect(store.get().selection).toBe(room);
    expect(store.get().view).toEqual(fitted);
    // Panned well away: the room comes back into view.
    store.set({ view: { ...fitted, cx: fitted.cx + 200 * FT } });
    revealElement(store, room);
    const back = visibleRegion(store.get().view!);
    const b = elementBounds(model.levels.find((l) => l.id === L1)!, room)!;
    expect(back.minX).toBeLessThanOrEqual(b.minX);
    expect(back.maxX).toBeGreaterThanOrEqual(b.maxX);
    // On another level: the editor goes there, and the canvas arriving keeps the element's view.
    goTo(store, far);
    expect(store.get().level).toBe(L2);
    expect(navOf(store).claim(L2)).toBe(true);
    const wall = elementBounds(model.levels.find((l) => l.id === L2)!, far)!;
    const shown = visibleRegion(store.get().view!);
    expect(shown.minX).toBeLessThanOrEqual(wall.minX);
    expect(shown.maxX).toBeGreaterThanOrEqual(wall.maxX);
  });

  it('frames a finding’s shapes, onto their level when it is another', () => {
    const { model, L1, L2 } = twoLevels();
    const store = storeOn(model, L1);
    const shapes = { minX: 200 * FT, minY: 200 * FT, maxX: 205 * FT, maxY: 204 * FT };
    frameOn(store, L2, shapes, 140);
    expect(store.get().level).toBe(L2);
    expect(navOf(store).claim(L2)).toBe(true);
    expect(store.get().view).toEqual(fit(shapes, 800, 600, 140));
  });

  it('saves a view by name and goes back to it — its level, zoom and region', () => {
    const { model, L1, L2 } = twoLevels();
    const store = storeOn(model, L1);
    zoomToPercent(store, 200);
    const there = store.get().view!;
    const saved = saveView(store, '  Hall close up ')!;
    expect(saved).toMatchObject({ name: 'Hall close up', level: L1, mode: null, zoom: 200, fit: false });
    const fittedSave = (zoomToFit(store), saveView(store, ''))!;
    expect(fittedSave.fit).toBe(true);
    expect(fittedSave.name).toBe('Level 1 — whole level');
    store.setLevel(L2);
    store.set({ view: fit(model.levels.find((l) => l.id === L2)!.bounds, 800, 600) });
    expect(openView(store, saved)).toBe(true);
    expect(store.get().level).toBe(L1);
    const back = store.get().view!;
    expect(back.s).toBeCloseTo(there.s, 9);
    expect(back.cx).toBeCloseTo(there.cx, 3);
    expect(back.cy).toBeCloseTo(there.cy, 3);
    expect(navOf(store).get().saved.map((s) => s.name)).toEqual(['Hall close up', 'Level 1 — whole level']);
    removeView(store, saved.id);
    expect(navOf(store).get().saved).toHaveLength(1);
  });
});
