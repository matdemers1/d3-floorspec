/** 3.1: the length grammar, exact values, ties to even, and FS-OPS-012 shapes; and formatLength. */
import { describe, expect, it } from 'vitest';
import { formatLength, parseLength } from '../src/index.js';

const IN = 32512n;
const FT = 390144n;
const MM = 1280n;

const value = (s: string): bigint => {
  const p = parseLength(s);
  if (!p.ok) throw new Error(`${s}: ${p.reason}`);
  return p.value;
};

describe('parseLength (3.1)', () => {
  it.each([
    // The spec's own examples.
    ["12'", 12n * FT],
    [`12' 6"`, 12n * FT + 6n * IN],
    [`12'6-1/2"`, 12n * FT + 6n * IN + IN / 2n],
    [`6 1/2"`, 6n * IN + IN / 2n],
    ['3/4 in', (3n * IN) / 4n],
    ['3810mm', 3810n * MM],
    ['3.81 m', 4876800n],
    ["-2'", -2n * FT],
    // Units, decimals and separators.
    ['12ft', 12n * FT],
    ['12 ft 6 in', 12n * FT + 6n * IN],
    [`12'-6"`, 12n * FT + 6n * IN],
    [`12' - 6"`, 12n * FT + 6n * IN],
    [`12'-6-1/2"`, 12n * FT + 6n * IN + IN / 2n],
    [`12' 6 1/2"`, 12n * FT + 6n * IN + IN / 2n],
    [`6-1/2"`, 6n * IN + IN / 2n],
    [`1 / 2 "`, IN / 2n],
    ['1.5 ft', FT + FT / 2n],
    [`.5"`, IN / 2n],
    ['0.5in', IN / 2n],
    ['25.4 mm', IN],
    ['2.54cm', IN],
    ['1 m', 1280000n],
    ['.001 m', 1280n],
    ['1/256"', 127n],
    ['1/16 in', 2032n],
    [`0"`, 0n],
    ["0'", 0n],
    ['-0 mm', 0n],
    [`-1' 6"`, -(FT + 6n * IN)],
    [`13"`, 13n * IN],
    [`3/2"`, (3n * IN) / 2n],
    // Case-insensitive letters.
    ['3810MM', 3810n * MM],
    ['12FT 6IN', 12n * FT + 6n * IN],
    ['1 M', 1280000n],
    ['3/4 In', (3n * IN) / 4n],
    // Whitespace around and between tokens.
    ['  12 \' 6 "  ', 12n * FT + 6n * IN],
    ['\t3810\nmm', 3810n * MM],
  ])('%s', (s, expected) => {
    expect(value(s)).toBe(expected);
  });

  it('is exact and rounds once, ties to even', () => {
    // 1/3" = 32512/3 = 10837.33… → 10837
    const third = parseLength('1/3"');
    expect(third.ok && third.value).toBe(10837n);
    expect(third.ok && third.exact).toEqual({ n: 32512n, d: 3n });
    expect(third.ok && third.roundedBy).toEqual({ n: 1n, d: 3n });
    // 1/512" = 63.5 → 64 (even); 3/512" = 190.5 → 190 (even)
    expect(value('1/512"')).toBe(64n);
    expect(value('3/512"')).toBe(190n);
    expect(value('-1/512"')).toBe(-64n);
    expect(value('-3/512"')).toBe(-190n);
    // 0.0001 mm = 0.128 → 0; 0.0004 mm = 0.512 → 1
    expect(value('0.0001 mm')).toBe(0n);
    expect(value('0.0004 mm')).toBe(1n);
    // A metric length to 1/1280 mm and an imperial one to 1/256" are exact.
    expect(parseLength('0.00078125 mm')).toMatchObject({ ok: true, value: 1n, roundedBy: { n: 0n, d: 1n } });
    expect(parseLength('255/256"')).toMatchObject({ ok: true, value: 255n * 127n, roundedBy: { n: 0n, d: 1n } });
  });

  it.each([
    ['', 'empty'],
    ['12', 'no unit'],
    ['1000', 'no unit'],
    ['12 feet', 'unknown unit'],
    ['12 yd', 'unknown unit'],
    ['3/0"', 'zero denominator'],
    ['6 1/0"', 'zero denominator in a mixed number'],
    ['6-1/0 in', 'zero denominator in a mixed number'],
    ['1/2\'', 'a fraction of feet'],
    ['1/2 m', 'a fraction of metres'],
    ['6.5 1/2"', 'a decimal whole part'],
    ['1.5/2"', 'a decimal numerator'],
    ['5."', 'a trailing point'],
    ['1.2.3 mm', 'two points'],
    ['--2\'', 'two signs'],
    ["2'-", 'a dangling separator'],
    ["12' 6", 'inches without a mark'],
    ['6" 12\'', 'inches before feet'],
    ["12' 6\" 1/2\"", 'two inch parts'],
    ['2 m 3 cm', 'two metric parts'],
    ['+2\'', 'a plus sign'],
    ['2′', 'a prime, not an apostrophe'],
    ['1e3 mm', 'an exponent'],
    ['12 3/4', 'a mixed number with no mark'],
    ['12 3"', 'two whole numbers'],
  ])('rejects %j (%s)', (s) => {
    expect(parseLength(s).ok).toBe(false);
  });
});

describe('formatLength', () => {
  it.each([
    [12n * FT + 6n * IN + IN / 2n, `12' 6 1/2"`],
    [12n * FT, "12'"],
    [6n * IN, '6"'],
    [(3n * IN) / 4n, '3/4"'],
    [0n, '0"'],
    [-(2n * FT), "-2'"],
    [-(FT + 6n * IN), `-1' 6"`],
    [127n, '0"'], // 1/256" shows as 0 at 1/16"
    [1016n, '0"'], // 1/32" is a tie between 0 and 1/16: to even, 0
    [3048n, '1/8"'], // 3/32" is a tie between 1/16 and 2/16: to even, 2/16
    [11n * IN + (15n * IN) / 16n + 1016n, "1'"], // 11 31/32" rounds up to 12" — carried into the feet
  ])('%s → %s', (v, s) => {
    expect(formatLength(v)).toBe(s);
  });

  it('shows finer fractions on request', () => {
    expect(formatLength(127n, { denominator: 256 })).toBe('1/256"');
    expect(formatLength(12n * FT + 254n, { denominator: 256 })).toBe(`12' 1/128"`);
  });

  it('shows metric lengths exactly or to a number of places', () => {
    expect(formatLength(3810n * MM, { system: 'metric' })).toBe('3810 mm');
    expect(formatLength(1n, { system: 'metric' })).toBe('0.00078125 mm');
    expect(formatLength(4876800n, { system: 'metric', unit: 'm' })).toBe('3.81 m');
    expect(formatLength(4876800n, { system: 'metric', unit: 'cm' })).toBe('381 cm');
    expect(formatLength(IN, { system: 'metric', decimals: 1 })).toBe('25.4 mm');
    expect(formatLength(-640n, { system: 'metric', decimals: 0 })).toBe('0 mm'); // -0.5 mm → 0, ties to even
    expect(formatLength(1920n, { system: 'metric', decimals: 0 })).toBe('2 mm'); // 1.5 mm → 2
  });

  it('round-trips through parseLength at its precision', () => {
    for (const v of [0n, 1n, 2032n, 32512n, 390144n, 4893056n, -4893056n, 123456789n]) {
      const s = formatLength(v, { denominator: 256 });
      const back = value(s);
      const diff = back > v ? back - v : v - back;
      expect(diff <= 64n, `${v} → ${s} → ${back}`).toBe(true);
      expect(value(formatLength(v, { system: 'metric' }))).toBe(v);
    }
  });
});
