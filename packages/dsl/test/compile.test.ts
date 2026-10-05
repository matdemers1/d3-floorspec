/** The grammar, the layout and the compiler's errors (FLR-T-10.5). */
import { describe, expect, test } from 'vitest';
import { build, compile, inferFunction, parse, type DslDiagnostic } from '../src/index.js';
import { built, summarize } from './helpers.js';

const FT = 390144;
const IN = 32512;
const SQ_FT = 152212340736n;

function errorOf(text: string): DslDiagnostic {
  const r = compile(text);
  if (r.ok) expect.fail(`expected an error for:\n${text}`);
  return r.diagnostics[0]!;
}

/** The first error of a text: where it is, and what it says. */
function expectError(text: string, where: Partial<Pick<DslDiagnostic, 'code' | 'line' | 'column'>>, message: RegExp | string): void {
  const d = errorOf(text);
  expect(d).toMatchObject(where);
  if (typeof message === 'string') expect(d.message).toBe(message);
  else expect(d.message).toMatch(message);
}

/** Net area of a rectangle room with walls of thickness t centred on its sides. */
const net = (wFt: number, hFt: number, tIn: number): string => String((BigInt(wFt * FT - tIn * IN) * BigInt(hFt * FT - tIn * IN)));

describe('the example from the plan', () => {
  const text = [
    'dining 12x12 at 0,0',
    'kitchen 14x12 east-of dining',
    'hall 8x12 west-of dining',
    'bath 8x5 north-of hall aligned left',
    'study 12x11 north-of dining as office',
    'door kitchen-dining 36"',
    `window kitchen north 4'x3' sill 3'`,
  ].join('\n');

  test('compiles to an Ops 0.3 batch of the operations it describes', () => {
    const r = compile(text);
    if (!r.ok) expect.fail(JSON.stringify(r.diagnostics));
    const ops = r.batch.map((o) => o.op);
    expect(ops).toContain('addLevel');
    expect(ops.filter((o) => o === 'addRoom')).toHaveLength(5);
    expect(ops.filter((o) => o === 'drawWall').length).toBeGreaterThan(0);
    expect(ops.filter((o) => o === 'addOpening')).toHaveLength(2);
    // The openings use relative references, resolved by the applier.
    const openings = r.batch.filter((o) => o.op === 'addOpening');
    expect(openings.map((o) => o.wall)).toEqual(['wall between Kitchen and Dining', 'north wall of Kitchen']);
    expect(openings.map((o) => o.at)).toEqual(['centered', 'centered']);
    // Every coordinate is an integer of base units.
    for (const o of r.batch) if (o.op === 'drawWall') expect([...(o.from as number[]), ...(o.to as number[])].every((v) => Number.isInteger(v))).toBe(true);
  });

  test('applies, validates, and derives the rooms it says', () => {
    const b = built(text);
    const s = summarize(b.document);
    expect(Object.keys(s.rooms).sort()).toEqual(['Bath', 'Dining', 'Hall', 'Kitchen', 'Study']);
    expect(s.rooms['Kitchen']!.function).toBe('kitchen');
    expect(s.rooms['Study']!.function).toBe('office');
    expect(s.rooms['Hall']!.function).toBe('circulation');
    // 6" exterior and 4 1/2" interior walls, both centred: the kitchen loses 3" on its outside sides and 2 1/4" on the dining side.
    const kitchenW = BigInt(14 * FT) - BigInt(3 * IN) - BigInt(Math.round(2.25 * IN));
    const kitchenH = BigInt(12 * FT) - 2n * BigInt(3 * IN);
    expect(BigInt(s.rooms['Kitchen']!.area)).toBe(kitchenW * kitchenH);
    // The bath sits on the hall's west edge.
    expect(s.rooms['Bath']!.outer.some((p) => p.startsWith(`${-8 * FT + 3 * IN},`))).toBe(true);
    expect(s.openings.map((o) => o.kind).sort()).toEqual(['doorType', 'windowType']);
  });

  test('is deterministic: the same text, the same batch, byte for byte', () => {
    expect(JSON.stringify(compile(text))).toBe(JSON.stringify(compile(text)));
    const a = build(text);
    const b = build(text);
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
  });
});

describe('rooms and relations', () => {
  test('alignment: south (default), north, center; west (default), east', () => {
    const b = built(['wall exterior 6"', 'wall interior 6"', 'a 10x10 at 0,0', 'b 4x6 east-of a aligned north', 'c 4x2 east-of a', 'd 4x2 west-of a aligned center', 'e 6x4 north-of a aligned east', 'f 4x4 north-of a'].join('\n'));
    const s = summarize(b.document);
    const lo = (name: string): string => s.rooms[name]!.outer[0]!;
    const half = 3 * IN;
    expect(lo('B')).toBe(`${10 * FT + half},${4 * FT + half}`);
    expect(lo('C')).toBe(`${10 * FT + half},${half}`);
    expect(lo('D')).toBe(`${-4 * FT + half},${4 * FT + half}`);
    expect(lo('E')).toBe(`${4 * FT + half},${10 * FT + half}`);
    expect(lo('F')).toBe(`${half},${10 * FT + half}`);
  });

  test('a relation may refer to a room declared later', () => {
    const b = built('a 10x10 at 0,0\nb 10x10 east-of c\nc 10x10 north-of a');
    expect(Object.keys(summarize(b.document).rooms).sort()).toEqual(['A', 'B', 'C']);
  });

  test('two relations, one per axis', () => {
    const b = built(['wall exterior 6"', 'wall interior 6"', 'a 10x10 at 0,0', 'b 10x20 east-of a', 'c 10x10 north-of a', 'd 10x10 east-of b north-of a'].join('\n'));
    const s = summarize(b.document);
    expect(s.rooms['D']!.outer[0]).toBe(`${20 * FT + 3 * IN},${10 * FT + 3 * IN}`);
  });

  test('the net area of a room walled on every side by centred walls of one thickness is (w − t)(h − t), exactly', () => {
    const b = built(['wall exterior 6"', 'wall interior 6"', 'a 14x12 at 0,0', 'b 10x12 east-of a', 'c 24x8 north-of a'].join('\n'));
    const s = summarize(b.document);
    expect(s.rooms['A']!.area).toBe(net(14, 12, 6));
    expect(s.rooms['B']!.area).toBe(net(10, 12, 6));
    expect(s.rooms['C']!.area).toBe(net(24, 8, 6));
  });

  test('names, functions and their inference', () => {
    expect(inferFunction('Primary bedroom')).toBe('sleeping');
    expect(inferFunction('dining_room')).toBe('dining');
    expect(inferFunction('kitchen_pantry')).toBe('storage');
    expect(inferFunction('Half baths')).toBe('bath');
    expect(inferFunction('Sunroom')).toBe('unspecified');
    const b = built('living "Great room" 20x16 at 0,0\nbed_2 12x11 east-of living\nsun 10x10 north-of living\nden 10x10 east-of sun as office');
    const s = summarize(b.document);
    expect(s.rooms['Great room']!.function).toBe('living');
    expect(s.rooms['Bed 2']!.function).toBe('sleeping');
    expect(s.rooms['Sun']!.function).toBe('unspecified');
    expect(s.rooms['Den']!.function).toBe('office');
  });

  test('levels: at, above, height; rooms belong to the level above them', () => {
    const b = built(['level ground "Ground floor" at 0 height 9\'', 'living 20x16 at 0,0', 'level upper above ground height 8\'', 'bed 12x12 at 0,0'].join('\n'));
    const doc = JSON.parse(b.document) as { levels: Record<string, { name: string; elevation: number; height: number }> };
    const levels = Object.values(doc.levels).sort((a, c) => a.elevation - c.elevation);
    expect(levels.map((l) => [l.name, l.elevation, l.height])).toEqual([
      ['Ground floor', 0, 9 * FT],
      ['Upper', 9 * FT, 8 * FT],
    ]);
    const s = summarize(b.document);
    expect(s.rooms['Living']!.level).toBe('Ground floor');
    expect(s.rooms['Bed']!.level).toBe('Upper');
  });

  test('metric units: bare numbers are metres; lengths in the Ops grammar work either way', () => {
    const b = built(['units metric', 'wall exterior 200 mm', 'wall interior 200mm', 'kitchen 4.2x3.6 at 0,0', 'dining 3 x 3600 mm west-of kitchen', 'door kitchen-dining 900 mm'].join('\n'));
    const s = summarize(b.document);
    const M = 1_280_000n;
    const t = 256_000n; // 200 mm
    expect(BigInt(s.rooms['Kitchen']!.area)).toBe((42n * M / 10n - t) * (36n * M / 10n - t));
    expect(BigInt(s.rooms['Dining']!.area)).toBe((3n * M - t) * (36n * M / 10n - t));
    expect(s.openings[0]!.head).toBe(2100 * 1280);
  });

  test('imperial lengths in the Ops reference grammar, exactly', () => {
    const b = built(`wall exterior 6"\nwall interior 6"\na 12' 6 1/2"x10'-3" at 0,0`);
    const s = summarize(b.document);
    const w = 12n * BigInt(FT) + BigInt(6.5 * IN);
    const h = 10n * BigInt(FT) + 3n * BigInt(IN);
    expect(s.rooms['A']!.area).toBe(String((w - BigInt(6 * IN)) * (h - BigInt(6 * IN))));
  });
});

describe('openings', () => {
  const plan = ['wall exterior 6"', 'wall interior 6"', 'a 20x10 at 0,0', 'b 10x10 north-of a', 'c 10x10 north-of a aligned east'].join('\n');

  test('a door between two rooms is centred on their shared wall by default; "at … from …" measures from that wall\'s end', () => {
    const s = summarize(built(`${plan}\ndoor a-b 3'\ndoor a-c 3' at 1' from east`).document);
    expect(s.openings.map((o) => o.span)).toEqual([`${3.5 * FT},${10 * FT} ${6.5 * FT},${10 * FT}`, `${16 * FT},${10 * FT} ${19 * FT},${10 * FT}`].sort());
  });

  test('hinge and swing by compass side, or swing into a room', () => {
    const s = summarize(built(`${plan}\ndoor a-b 3' hinge west swing into a`).document);
    expect(s.openings[0]!.hinge).toBe(`${3.5 * FT},${10 * FT}`);
    expect(s.openings[0]!.swing).toBe('south');
  });

  test('exterior doors and windows; empty openings', () => {
    const s = summarize(built(`${plan}\ndoor a south 3' x 7' "Front door"\nwindow b west 3'x4' sill 2'6"\nopening b-c 4' x 7'`).document);
    expect(s.openings.map((o) => o.kind).sort()).toEqual(['doorType', 'empty', 'windowType']);
    const front = s.openings.find((o) => o.name === 'Front door')!;
    expect(front.head).toBe(7 * FT);
    const win = s.openings.find((o) => o.kind === 'windowType')!;
    expect(win.sill).toBe(2 * FT + 6 * IN);
    expect(win.head).toBe(2 * FT + 6 * IN + 4 * FT);
  });

  test('a door type is made once per size and reused', () => {
    const r = compile(`${plan}\ndoor a-b 3'\ndoor a-c 3'`);
    if (!r.ok) expect.fail(JSON.stringify(r.diagnostics));
    expect(r.batch.filter((o) => o.op === 'addElement' && o.collection === 'types' && (o.element as { kind: string }).kind === 'doorType')).toHaveLength(1);
  });
});

describe('the brief', () => {
  test('items, counts, areas and adjacencies compile to the program', () => {
    const text = ['brief: 3 bed, 2 bath 50 sq ft, office min 9 m2, "Great room" as living 300 sq ft', 'adjacent bed-bath', 'near office-"Great room"', 'apart office-bed', 'bed1 12x12 at 0,0 for bed', 'study 10x12 east-of bed1 for office'].join('\n');
    const b = built(text);
    const doc = JSON.parse(b.document) as { program: { items: Record<string, Record<string, unknown>>; adjacency: { a: string; b: string; kind: string }[] } };
    const items = Object.values(doc.program.items);
    expect(items).toContainEqual({ function: 'sleeping', name: 'Bedroom', count: 3 });
    expect(items).toContainEqual({ function: 'bath', name: 'Bathroom', count: 2, targetArea: Number(50n * SQ_FT) });
    expect(items).toContainEqual({ function: 'office', name: 'Office', minArea: 9 * 1_638_400_000_000 });
    expect(items).toContainEqual({ function: 'living', name: 'Great room', targetArea: Number(300n * SQ_FT) });
    expect(doc.program.adjacency.map((a) => a.kind).sort()).toEqual(['forbidden', 'preferred', 'required']);
    const s = summarize(b.document);
    expect(s.rooms['Bed1']!.brief).toBe('Bedroom');
    expect(s.rooms['Study']!.brief).toBe('Office');
  });

  test('an item whose function is not known is a warning, and unspecified', () => {
    const b = build('brief: 2 sunroom');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.warnings[0]!.message).toMatch(/sunroom/);
  });
});

describe('errors say where they are', () => {
  test('a room that overlaps another', () => {
    expectError('a 10x10 at 0,0\nb 10x10 at 5,5', { code: 'FS-DSL-LAYOUT', line: 2, column: 1 }, 'room b overlaps room a');
  });
  test('a room with no position', () => {
    expectError('a 10x10\nb 10x10', { line: 2, column: 1 }, /no position/);
  });
  test('two relations that disagree', () => {
    expectError('a 10x10\nb 10x10 east-of a\nc 10x10 east-of a east-of b', { line: 3, column: 19 }, /cannot be both east-of a and east-of b/);
  });
  test('an ambiguous alignment', () => {
    expectError('a 10x10 at 0,0\nb 10x10 at 0,20\nc 10x10 east-of a east-of b', { line: 3 }, /ambiguous/);
  });
  test('a circular placement', () => {
    expectError('a 10x10 east-of b\nb 10x10 east-of a', { code: 'FS-DSL-LAYOUT' }, /depends on itself/);
  });
  test('a room that does not exist', () => {
    expectError('a 10x10\nb 10x10 east-of x', { code: 'FS-DSL-REFERENCE', line: 2, column: 17 }, 'there is no room x');
  });
  test('a door between rooms that do not touch', () => {
    expectError('a 10x10\nb 10x10 at 20,0\ndoor a-b 3\'', { line: 3 }, 'rooms a and b do not share a wall');
  });
  test('a door in an open boundary', () => {
    expectError('a 10x10\nb 10x10 east-of a\nopen a-b\ndoor a-b 3\'', { line: 4 }, /open to each other/);
  });
  test('a window that is not on an outside wall', () => {
    expectError('a 20x10\nb 10x10 north-of a aligned center\nwindow a north 4\'x4\'', { line: 3 }, /not within one outside wall/);
    expectError('a 20x10\nb 10x10 north-of a\nc 10x10 north-of a aligned east\nwindow a north 4\'x4\'', { line: 4 }, 'room a has no outside wall on its north side');
  });
  test('an opening past the end of its wall', () => {
    expectError('a 10x10\nwindow a north 4\'x4\' at 8\' from west', { line: 2, column: 22 }, /runs past the end/);
  });
  test('syntax: a size without its "x", an unknown clause, a bad length', () => {
    expectError('kitchen 14 east-of dining', { code: 'FS-DSL-SYNTAX', line: 1, column: 12 }, /expected "x"/);
    expectError('kitchen 14x12 beside dining', { line: 1, column: 15 }, /unexpected "beside"/);
    expectError('kitchen 14x12 at 1/0", 0', { line: 1 }, /denominator|zero/);
  });
  test('every syntax error is reported, not only the first', () => {
    const { errors } = parse('a 10\nb 10x10\nc x');
    expect(errors.map((e) => e.pos.line)).toEqual([1, 3]);
  });
  test('an error the engine finds is placed on the line that made the element', () => {
    // Walls thicker than a room is deep: the room has no area left, which Core rejects.
    const b = build('wall exterior 2\'\nwall interior 2\'\na 10x10 at 0,0\nb 1x10 east-of a');
    expect(b.ok).toBe(false);
    if (!b.ok) {
      // On the line of the room whose walls they are, with Core's own codes.
      expect(b.diagnostics.map((d) => d.line)).toEqual(b.diagnostics.map(() => 4));
      expect(b.diagnostics.map((d) => d.code)).toContain('FS-INV-203');
    }
  });
});

describe('the README', () => {
  test('its whole-plan example builds', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const block = /```text\n([\s\S]*?)```/.exec(readme);
    expect(block).not.toBeNull();
    const s = summarize(built(block![1]!).document);
    expect(Object.keys(s.rooms).sort()).toEqual(['Bedroom', 'Kitchen', 'Living room']);
    expect(s.program).toHaveLength(4);
  });
});
