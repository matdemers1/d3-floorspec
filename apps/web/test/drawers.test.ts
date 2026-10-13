import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWER_TIMING, DrawerMachine, DrawersStore, HOT_ZONE, SWIPE, zoneAt, type DrawerState, type PinStorage } from '../src/editor/drawers';
import { COMMANDS, commandFor } from '../src/editor/commands';

/**
 * FLR-T-18.2: the edge drawers' state machine against the drawer spec — 120 ms in the 20 px hot
 * zone to peek, onto the peek to open, 300 ms off it to hide, never while a field in it has focus,
 * pinning, the shortcut's cycle and edge swipes — on fake timers.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function machine(): { m: DrawerMachine; seen: DrawerState[] } {
  const seen: DrawerState[] = [];
  const m = new DrawerMachine((s) => { seen.push(s); });
  return { m, seen };
}

describe('a drawer', () => {
  it('peeks after the pointer rests 120 ms in its hot zone, not before', () => {
    const { m } = machine();
    m.zoneEnter();
    vi.advanceTimersByTime(DRAWER_TIMING.peek - 1);
    expect(m.state).toBe('hidden');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('peeking');
  });

  it('does not peek when the pointer only passes through the hot zone', () => {
    const { m, seen } = machine();
    m.zoneEnter();
    vi.advanceTimersByTime(60);
    m.zoneLeave();
    vi.advanceTimersByTime(1000);
    expect(m.state).toBe('hidden');
    expect(seen).toEqual([]);
  });

  it('opens when the pointer moves onto the peek past the hot zone, and hides 300 ms after it leaves', () => {
    const { m, seen } = machine();
    m.zoneEnter();
    vi.advanceTimersByTime(DRAWER_TIMING.peek);
    // The peek slides in under the pointer resting at the edge: that alone does not open it.
    m.enter();
    expect(m.state).toBe('peeking');
    m.zoneLeave();
    expect(m.state).toBe('open');
    m.leave();
    vi.advanceTimersByTime(DRAWER_TIMING.leave - 1);
    expect(m.state).toBe('open');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('hidden');
    expect(seen).toEqual(['peeking', 'open', 'hidden']);
  });

  it('stays open when the pointer comes back within 300 ms', () => {
    const { m } = machine();
    m.open();
    m.enter();
    m.leave();
    vi.advanceTimersByTime(200);
    m.enter();
    vi.advanceTimersByTime(1000);
    expect(m.state).toBe('open');
  });

  it('a peek the pointer leaves without opening goes after 300 ms', () => {
    const { m } = machine();
    m.zoneEnter();
    vi.advanceTimersByTime(DRAWER_TIMING.peek);
    m.zoneLeave();
    vi.advanceTimersByTime(DRAWER_TIMING.leave);
    expect(m.state).toBe('hidden');
  });

  it('never closes while a field in it has focus or a menu from it is open, and leaves once it lets go', () => {
    const { m } = machine();
    m.open();
    m.enter();
    m.hold(true);
    m.leave();
    vi.advanceTimersByTime(5000);
    expect(m.state).toBe('open');
    m.dismiss();
    expect(m.state).toBe('open');
    m.hold(false);
    vi.advanceTimersByTime(DRAWER_TIMING.leave);
    expect(m.state).toBe('hidden');
  });

  it('pins and unpins; a pinned drawer ignores the hot zone, leaving and a click on the plan', () => {
    const { m } = machine();
    m.pin(true);
    expect(m.state).toBe('pinned');
    m.zoneEnter();
    m.leave();
    m.dismiss();
    m.close();
    vi.advanceTimersByTime(5000);
    expect(m.state).toBe('pinned');
    // Unpinned under the pointer, it stays until the pointer leaves.
    m.enter();
    m.pin(false);
    expect(m.state).toBe('open');
    m.leave();
    vi.advanceTimersByTime(DRAWER_TIMING.leave);
    expect(m.state).toBe('hidden');
  });

  it('cycles on its shortcut: hidden → open → pinned → hidden', () => {
    const { m } = machine();
    expect(m.cycle()).toBe('open');
    // Opened from the keyboard, with the pointer elsewhere, it does not time out.
    vi.advanceTimersByTime(5000);
    expect(m.state).toBe('open');
    expect(m.cycle()).toBe('pinned');
    expect(m.cycle()).toBe('hidden');
  });

  it('peeks and then opens as a touch swipe comes in from the edge', () => {
    const { m } = machine();
    m.swipe(SWIPE.peek - 1);
    expect(m.state).toBe('hidden');
    m.swipe(SWIPE.peek);
    expect(m.state).toBe('peeking');
    m.swipe(SWIPE.open);
    expect(m.state).toBe('open');
  });

  it('a click on the plan puts a floating drawer away at once', () => {
    const { m } = machine();
    m.open();
    m.dismiss();
    expect(m.state).toBe('hidden');
  });
});

describe('the hot zones', () => {
  const area = { left: 0, top: 52, right: 1440, bottom: 900 };
  const all = () => true;
  it('are 20 px from the canvas area’s edges, 28 px on a coarse pointer', () => {
    expect(zoneAt(19, 400, area, HOT_ZONE.fine, all)).toBe('left');
    expect(zoneAt(20, 400, area, HOT_ZONE.fine, all)).toBeNull();
    expect(zoneAt(27, 400, area, HOT_ZONE.coarse, all)).toBe('left');
    expect(zoneAt(700, 60, area, HOT_ZONE.fine, all)).toBe('top');
    expect(zoneAt(1430, 400, area, HOT_ZONE.fine, all)).toBe('right');
    expect(zoneAt(700, 400, area, HOT_ZONE.fine, all)).toBeNull();
  });
  it('give a corner to the nearer edge, and skip a drawer that is not away', () => {
    expect(zoneAt(4, 62, area, HOT_ZONE.fine, all)).toBe('left');
    expect(zoneAt(14, 54, area, HOT_ZONE.fine, all)).toBe('top');
    expect(zoneAt(4, 400, area, HOT_ZONE.fine, (side) => side !== 'left')).toBeNull();
  });
});

class MemoryStorage implements PinStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe('the editor’s drawers', () => {
  it('start pinned outside full screen and hidden in it', () => {
    const d = new DrawersStore('p1', undefined, new MemoryStorage());
    expect([d.get().left, d.get().top, d.get().right]).toEqual(['pinned', 'pinned', 'pinned']);
    d.setFull(true);
    expect([d.get().left, d.get().top, d.get().right]).toEqual(['hidden', 'hidden', 'hidden']);
    expect(d.get().notice?.kind).toBe('full');
    vi.advanceTimersByTime(DRAWER_TIMING.notice);
    expect(d.get().notice).toBeNull();
    d.setFull(false);
    expect(d.get().left).toBe('pinned');
  });

  it('remember a pin per project and per view, in full screen and out of it', () => {
    const storage = new MemoryStorage();
    const d = new DrawersStore('p1', undefined, storage);
    d.setFull(true);
    d.setPinned('left', true);
    expect(d.get().notice).toMatchObject({ kind: 'pinned', side: 'left' });
    d.setView('3d');
    expect(d.get().left).toBe('hidden');
    d.setView('plan');
    expect(d.get().left).toBe('pinned');
    // Collapsing the inspector outside full screen is unpinning it.
    d.setFull(false);
    d.summon('right');
    expect(d.get().right).toBe('hidden');
    // Another visit to the same project finds them as they were left.
    const again = new DrawersStore('p1', undefined, storage);
    expect(again.get().right).toBe('hidden');
    again.setFull(true);
    expect(again.get().left).toBe('pinned');
    // Another project starts from the defaults.
    expect(new DrawersStore('p2', undefined, storage).get().right).toBe('pinned');
  });

  it('move the hot zone between drawers as the pointer moves', () => {
    const d = new DrawersStore('p1', undefined, new MemoryStorage());
    d.setFull(true);
    d.pointerZone('left');
    expect(d.get().zone).toBe('left');
    vi.advanceTimersByTime(DRAWER_TIMING.peek);
    expect(d.get().left).toBe('peeking');
    d.pointerZone('top');
    vi.advanceTimersByTime(DRAWER_TIMING.peek);
    expect(d.get().top).toBe('peeking');
    vi.advanceTimersByTime(DRAWER_TIMING.leave);
    expect(d.get().left).toBe('hidden');
  });

  it('a click on the plan closes floating drawers and leaves pinned ones', () => {
    const d = new DrawersStore('p1', undefined, new MemoryStorage());
    d.setFull(true);
    d.setPinned('right', true);
    d.reveal('left');
    d.reveal('top');
    d.closeFloating();
    expect([d.get().left, d.get().top, d.get().right]).toEqual(['hidden', 'hidden', 'pinned']);
  });
});

describe('the keys', () => {
  it('F is full screen; the furniture library moved to I', () => {
    expect(commandFor('f')?.id).toBe('view.fullscreen');
    expect(commandFor('i')?.id).toBe('tool.furniture');
    const ids = COMMANDS.map((c) => c.id);
    for (const id of ['view.drawerLeft', 'view.drawerTop', 'view.drawerRight']) expect(ids).toContain(id);
    // The drawers' keys are read by their place on the keyboard, not through the registry.
    expect(commandFor('Mod+\\')).toBeUndefined();
  });
});
