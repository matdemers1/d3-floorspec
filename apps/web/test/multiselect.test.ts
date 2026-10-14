import { describe, expect, it } from 'vitest';
import { EditorStore } from '../src/editor/store';

describe('FLR-T-18.8 the selection: a primary and everything selected, kept in step', () => {
  it('a single select is the whole selection; a cleared one empties it', () => {
    const store = new EditorStore('p');
    store.select('W1');
    expect(store.get().selection).toBe('W1');
    expect(store.get().selected).toEqual(['W1']);
    store.select(null);
    expect(store.get().selection).toBeNull();
    expect(store.get().selected).toEqual([]);
  });

  it('selectMany makes the last one the primary, and adds with `add`', () => {
    const store = new EditorStore('p');
    store.selectMany(['A', 'B', 'C']);
    expect(store.get().selection).toBe('C');
    expect(store.get().selected).toEqual(['A', 'B', 'C']);
    store.selectMany(['D'], { add: true });
    expect(store.get().selected).toEqual(['A', 'B', 'C', 'D']);
    expect(store.get().selection).toBe('D');
    store.selectMany(['A', 'B'], { primary: 'A' });
    expect(store.get().selected).toEqual(['B', 'A']);
    expect(store.get().selection).toBe('A');
  });

  it('a toggle takes an element out, and the primary falls to the one picked before it', () => {
    const store = new EditorStore('p');
    store.selectMany(['A', 'B', 'C']);
    store.toggleSelected('C');
    expect(store.get().selected).toEqual(['A', 'B']);
    expect(store.get().selection).toBe('B');
    store.toggleSelected('C');
    expect(store.get().selected).toEqual(['A', 'B', 'C']);
  });

  it('setting only the primary to the primary keeps the group (an edit that reselects it)', () => {
    const store = new EditorStore('p');
    store.selectMany(['A', 'B']);
    store.set({ selection: 'B' });
    expect(store.get().selected).toEqual(['A', 'B']);
    store.set({ selection: 'Z' });
    expect(store.get().selected).toEqual(['Z']);
  });

  it('clearing the primary clears both', () => {
    const store = new EditorStore('p');
    store.selectMany(['A', 'B']);
    store.set({ level: 'L2', selection: null });
    expect(store.get().selected).toEqual([]);
    expect(store.get().selection).toBeNull();
  });
});
