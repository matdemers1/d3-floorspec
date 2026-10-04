/**
 * A batch may pass through any state, valid or not (1.2), and the applier must answer every request
 * with a result — never an exception. Seeded random batches of primitives and composites, with
 * members of every JSON type, over plans in good and bad shape.
 */
import { describe, expect, it } from 'vitest';
import { apply } from '../src/index.js';
import { box, IN, pair } from './doc.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['J1', 'J2', 'J3', 'J4', 'T', 'B0', 'W1', 'W2', 'W3', 'W7', 'RA', 'RB', 'R1', 'L1', 'B1', 'O1', 'D36', 'nope', 'Kitchen', 'north wall of Kitchen', 'wall between Kitchen and Dining', 'end of W7', '$project', '$site', '$document'];
const PATHS = ['/position', '/start', '/end', '/level', '/anchor', '/name', '/layers', '/layers/0/thickness', '/join', '/offset', '/wall', '/top/height', '/extras/x', '', 'bad', '/building', '/site'];

function value(r: () => number): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  switch (Math.floor(r() * 9)) {
    case 0:
      return Math.floor(r() * 8000000) - 1000000;
    case 1:
      return [Math.floor(r() * 8000000), Math.floor(r() * 3000000)];
    case 2:
      return pick(IDS);
    case 3:
      return pick([`2' east of J1`, '1 m from J1 toward J3', "1' 6\"", 'centered', "2' from end", 'J9', 'garbage text', '3/0"']);
    case 4:
      return null;
    case 5:
      return { kind: 'butt', through: ['W1'] };
    case 6:
      return [{ thickness: 12800, function: 'core' }];
    case 7:
      return true;
    default:
      return 1.5;
  }
}

function operation(r: () => number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const id = (): string => pick(IDS);
  switch (Math.floor(r() * 16)) {
    case 0:
      return { op: 'addElement', collection: pick(['junctions', 'walls', 'rooms', 'openings', 'levels']), element: { level: 'L1', position: value(r), start: id(), end: id(), anchor: value(r), wall: id(), offset: value(r) } };
    case 1:
      return { op: 'addJunction', level: 'L1', position: value(r) };
    case 2:
      return { op: 'addWall', level: 'L1', start: id(), end: id(), layers: [{ thickness: 12800, function: 'core' }] };
    case 3:
      return { op: 'removeElement', id: id(), ...(r() < 0.5 && { cascade: true }) };
    case 4:
      return { op: 'setProperty', id: id(), path: pick(PATHS), value: value(r) };
    case 5:
      return { op: 'unsetProperty', id: id(), path: pick(PATHS) };
    case 6:
      return { op: 'moveJunction', id: id(), to: value(r) };
    case 7:
      return { op: 'drawWall', level: 'L1', from: value(r), to: value(r), layers: [{ thickness: 12800, function: 'core' }] };
    case 8:
      return { op: 'moveWall', wall: id(), by: value(r), ...(r() < 0.5 && { toward: id() }) };
    case 9:
      return { op: 'moveRoom', room: id(), by: value(r) };
    case 10:
      return { op: 'resizeRoom', room: id(), side: pick(['north', 'south', 'east', 'west']), by: value(r) };
    case 11:
      return { op: 'addOpening', wall: id(), at: value(r), fill: 'D36' };
    case 12:
      return { op: 'moveOpening', opening: id(), at: value(r) };
    case 13:
      return { op: 'addRoom', level: id(), at: value(r) };
    case 14:
      return { op: 'removeWall', wall: id(), ...(r() < 0.5 && { keep: id() }) };
    default:
      return { op: 'drawSeparator', level: 'L1', from: value(r), to: value(r) };
  }
}

describe('robustness', () => {
  it('answers every request with a result, never an exception', () => {
    const door = { D36: { kind: 'doorType', width: 36 * IN, height: 80 * IN } };
    const docs = [box(), pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W7', offset: 0, fill: 'D36' } } })];
    let committed = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const batch = Array.from({ length: 1 + Math.floor(r() * 5) }, () => operation(r));
      const d = docs[seed % 2]!;
      let result: ReturnType<typeof apply> | undefined;
      expect(() => (result = apply(d, { batch })), `seed ${seed}: ${JSON.stringify(batch)}`).not.toThrow();
      if (result?.status === 'committed') committed++;
    }
    expect(committed).toBeGreaterThan(0);
  });
});
