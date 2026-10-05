import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModel } from '../src/editor/model';
import { tokens } from '../src/share/Markdown';
import { anchorIn, placeOf, targetOf } from '../src/share/pins';
import { rememberReturn, takeReturn } from '../src/share/returnTo';

/** FLR-T-9.6: comment text, pins and the way back after signing in. */

const HOUSE = readFileSync(new URL('../e2e/fixtures/p6-demo-house.json', import.meta.url), 'utf8');

describe('markdown-lite', () => {
  it('reads bold, italic and code, and leaves everything else as the text it is', () => {
    expect(tokens('a **b** *c* `d` e')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' e' },
    ]);
    // Markup is not markup here: it is text, drawn as a text node.
    expect(tokens('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
    expect(tokens('[a link](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[a link](javascript:alert(1))' }]);
    // A marker without its pair stays as typed.
    expect(tokens('2 * 3 = 6 and **open')).toEqual([{ kind: 'text', text: '2 * 3 = 6 and **open' }]);
  });
});

describe('pins', () => {
  const model = readModel('h1', HOUSE);
  const level = model.levels.find((l) => l.id === 'L1');
  const l1 = () => {
    if (level === undefined) throw new Error('no L1');
    return level;
  };

  it('stand on an element: a wall at its middle, a room at its anchor', () => {
    if (level === undefined) throw new Error('no L1');
    const wall = level.walls.find((w) => w.id === 'W2');
    expect(anchorIn(level, 'W2')).toEqual(wall === undefined ? null : [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]);
    expect(anchorIn(level, level.rooms[0]?.id ?? '')).toEqual(level.rooms[0]?.anchor);
    expect(anchorIn(level, 'NOPE')).toBeNull();
  });

  it('are where they were clicked on the same version, follow the element on a later one, and detach when it is gone', () => {
    const pin = { element: 'W2', level: 'L1', version: 'h1', point: [10, 20] as [number, number] };
    expect(placeOf(model, { pin })).toEqual({ level: 'L1', point: [10, 20], detached: false });
    const later = readModel('h2', HOUSE);
    expect(placeOf(later, { pin })).toEqual({ level: 'L1', point: anchorIn(l1(), 'W2'), detached: false });
    const gone = { ...pin, element: 'W99' };
    expect(placeOf(model, { pin: gone })).toEqual({ level: 'L1', point: [10, 20], detached: true });
    expect(placeOf(null, { pin })).toEqual({ level: 'L1', point: [10, 20], detached: true });
    expect(placeOf(model, { pin: null })).toBeNull();
  });

  it('pin a new comment to the selection: at the click on the plan, at the anchor from 3D', () => {
    expect(targetOf(model, 'W2', [1000.4, -7.6], true)).toEqual({ element: 'W2', level: 'L1', point: [1000, -8] });
    const anchor = anchorIn(l1(), 'W2') ?? [0, 0];
    expect(targetOf(model, 'W2', [1000, 0], false)).toEqual({ element: 'W2', level: 'L1', point: [Math.round(anchor[0]), Math.round(anchor[1])] });
    expect(targetOf(model, null, null, true)).toBeNull();
    // A level is not a place on the plan.
    expect(targetOf(model, 'L1', null, true)).toBeNull();
  });
});

describe('the way back after signing in', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });
  const LINK = `/s/${'a'.repeat(43)}`;

  it('goes back to a share link once, and only to a share link', () => {
    rememberReturn(LINK);
    expect(takeReturn()).toBe(LINK);
    expect(takeReturn()).toBeNull();
    for (const elsewhere of ['https://evil.example/s/x', '//evil.example', '/projects', `/s/${'a'.repeat(42)}`, `/s/${'a'.repeat(43)}/../x`]) {
      rememberReturn(elsewhere);
      expect(takeReturn(), elsewhere).toBeNull();
    }
    // Planted by something else in this origin's storage: still only a share link.
    store.set('floorspec.returnTo', JSON.stringify({ path: 'https://evil.example', at: Date.now() }));
    expect(takeReturn()).toBeNull();
  });

  it('forgets a way back that is half an hour old', () => {
    rememberReturn(LINK);
    expect(takeReturn(Date.now() + 31 * 60_000)).toBeNull();
  });
});
