/**
 * Lengths (3.1): a JSON integer of base units, or a string in this grammar (ABNF, RFC 5234;
 * whitespace between tokens is ignored, letters are case-insensitive):
 *
 *     length     = [ "-" ] ( metric / imperial )
 *     metric     = decimal ( "mm" / "cm" / "m" )
 *     imperial   = feet [ [ "-" ] inches ] / inches
 *     feet       = decimal ( "'" / "ft" )
 *     inches     = ( mixed / decimal ) ( DQUOTE / "in" )
 *     mixed      = 1*DIGIT ( "-" / " " ) fraction / fraction
 *     fraction   = 1*DIGIT "/" 1*DIGIT
 *     decimal    = 1*DIGIT [ "." 1*DIGIT ] / "." 1*DIGIT
 *
 * The value is an exact rational number of base units, rounded once to an integer, ties to even.
 *
 * Tokens are numbers (`decimal`: a run of digits with at most one `.` inside it), `/`, `-`, `'`,
 * `"` and unit words. Whitespace separates tokens and is otherwise ignored, with the one place the
 * grammar gives it meaning: the `" "` of `mixed`, which is whitespace between a whole number and
 * the numerator of its fraction (`6 1/2"`). Two numbers with nothing between them cannot be told
 * apart from one, so they are only ever adjacent across whitespace.
 */
import { formatScaled } from './format.js';
import { q, qadd, qDecimal, qmul, qneg, qround, qsub, qString, type Rational } from '../lib/rational.js';

/** Base units per unit (Core 2.1). */
export const UNITS = {
  mm: 1280n,
  cm: 12800n,
  m: 1280000n,
  in: 32512n,
  ft: 390144n,
} as const;

export type LengthParse =
  | { ok: true; value: bigint; exact: Rational; /** exact − value, in base units */ roundedBy: Rational }
  | { ok: false; reason: string };

type Tok =
  | { k: 'num'; s: string; ws: boolean }
  | { k: '/' | '-' | "'" | '"'; ws: boolean }
  | { k: 'word'; s: string; ws: boolean };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  let ws = false;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/u.test(c)) {
      ws = true;
      i++;
      continue;
    }
    const num = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(src.slice(i));
    if (num) {
      // A number that runs straight into another `.` or digit is malformed (`1.2.3`, `5.`).
      const after = src[i + num[0].length];
      if (after === '.') return `malformed number at "${src.slice(i)}"`;
      out.push({ k: 'num', s: num[0], ws });
      i += num[0].length;
    } else if (c === '/' || c === '-' || c === "'" || c === '"') {
      out.push({ k: c, ws });
      i++;
    } else {
      const word = /^[A-Za-z]+/.exec(src.slice(i));
      if (!word) return `unexpected character ${JSON.stringify(c)}`;
      out.push({ k: 'word', s: word[0].toLowerCase(), ws });
      i += word[0].length;
    }
    ws = false;
  }
  return out;
}

const isInt = (t: Tok | undefined): t is { k: 'num'; s: string; ws: boolean } => t?.k === 'num' && /^[0-9]+$/.test(t.s);
const isNum = (t: Tok | undefined): t is { k: 'num'; s: string; ws: boolean } => t?.k === 'num';
const isWord = (t: Tok | undefined, ...w: string[]): boolean => t?.k === 'word' && w.includes(t.s);

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  next(): Tok | undefined {
    return this.toks[this.i++];
  }
}

class GrammarError extends Error {}
const bad = (msg: string): never => {
  throw new GrammarError(msg);
};

/** inches = ( mixed / decimal ) ( DQUOTE / "in" ); returns the value in inches. */
function inches(p: Parser): Rational {
  const a = p.next();
  if (!isNum(a)) return bad('expected a number of inches');
  let v: Rational;
  const t1 = p.peek();
  if (t1?.k === '/') {
    // fraction
    if (!isInt(a)) return bad('a fraction is whole numbers');
    p.next();
    const d = p.next();
    if (!isInt(d)) return bad('expected a denominator');
    if (BigInt(d.s) === 0n) return bad('a fraction has a zero denominator');
    v = q(BigInt(a.s), BigInt(d.s));
  } else if (isInt(a) && ((t1?.k === '-' && isInt(p.peek(1))) || (isInt(t1) && t1.ws)) && p.peek(t1.k === '-' ? 2 : 1)?.k === '/') {
    // mixed: whole ( "-" / " " ) fraction
    if (t1.k === '-') p.next();
    const n = p.next() as { s: string };
    p.next(); // '/'
    const d = p.next();
    if (!isInt(d)) return bad('expected a denominator');
    if (BigInt(d.s) === 0n) return bad('a fraction has a zero denominator');
    v = qadd(q(BigInt(a.s)), q(BigInt(n.s), BigInt(d.s)));
  } else {
    v = qDecimal(a.s);
  }
  const unit = p.next();
  if (!(unit?.k === '"' || isWord(unit, 'in'))) return bad('expected " or in after a number of inches');
  return v;
}

function body(p: Parser): Rational {
  const a = p.peek();
  if (!isNum(a)) return bad('expected a number');
  const u = p.peek(1);
  if (isWord(u, 'mm', 'cm', 'm')) {
    p.next();
    p.next();
    return qmul(qDecimal(a.s), q(UNITS[(u as { s: 'mm' | 'cm' | 'm' }).s]));
  }
  if (u?.k === "'" || isWord(u, 'ft')) {
    p.next();
    p.next();
    let v = qmul(qDecimal(a.s), q(UNITS.ft));
    if (p.peek() === undefined) return v;
    if (p.peek()?.k === '-') p.next();
    v = qadd(v, qmul(inches(p), q(UNITS.in)));
    return v;
  }
  return qmul(inches(p), q(UNITS.in));
}

/** Parse a length string exactly (3.1). Never throws. */
export function parseLength(src: string): LengthParse {
  const toks = tokenize(src);
  if (typeof toks === 'string') return { ok: false, reason: toks };
  const p = new Parser(toks);
  try {
    let neg = false;
    if (p.peek()?.k === '-') {
      p.next();
      neg = true;
    }
    let exact = body(p);
    if (p.peek() !== undefined) return { ok: false, reason: 'unexpected text after the length' };
    if (neg) exact = qneg(exact);
    const value = qround(exact);
    return { ok: true, value, exact, roundedBy: qsub(exact, q(value)) };
  } catch (e) {
    if (e instanceof GrammarError) return { ok: false, reason: e.message };
    throw e;
  }
}

/** The largest length Core allows (2.1.1): 2⁵³ − 1. */
export const MAX_LENGTH = 9007199254740991n;

export interface FormatLengthOptions {
  /** `imperial` (feet, inches and fractions; the default) or `metric`. */
  system?: 'imperial' | 'metric';
  /** Imperial: the finest fraction of an inch shown, a power of two (default 16, i.e. 1/16"). */
  denominator?: number;
  /** Metric: the unit (default `mm`). */
  unit?: 'mm' | 'cm' | 'm';
  /** Metric: the number of decimal places, rounded ties to even (default: exact — every length is a terminating decimal of mm, cm and m). */
  decimals?: number;
}

/**
 * A length for display: `12' 6 1/2"` (to 1/16" by default) or `3810 mm`. Rounds ties to even, so
 * a display never disagrees with how lengths are rounded elsewhere; every string it returns parses
 * back with parseLength. Display only: what is stored is always the integer.
 */
export function formatLength(value: number | bigint, options: FormatLengthOptions = {}): string {
  const v = BigInt(value);
  if (options.system === 'metric') {
    const unit = options.unit ?? 'mm';
    return `${formatScaled(q(v, UNITS[unit]), options.decimals)} ${unit}`;
  }
  const den = BigInt(options.denominator ?? 16);
  if (den <= 0n || (den & (den - 1n)) !== 0n) throw new RangeError('formatLength: the denominator must be a power of two');
  const neg = v < 0n;
  // Total in units of 1/den inch, rounded once.
  const ticks = qround(q((neg ? -v : v) * den, UNITS.in));
  const perFoot = 12n * den;
  const feet = ticks / perFoot;
  const rest = ticks % perFoot;
  const whole = rest / den;
  let num = rest % den;
  let d = den;
  while (num !== 0n && num % 2n === 0n) {
    num /= 2n;
    d /= 2n;
  }
  const inchText = num === 0n ? `${whole}"` : whole === 0n ? `${num}/${d}"` : `${whole} ${num}/${d}"`;
  let text: string;
  if (feet === 0n) text = inchText;
  else if (rest === 0n) text = `${feet}'`;
  else text = `${feet}' ${inchText}`;
  return ticks !== 0n && neg ? `-${text}` : text;
}

/** How a rounded length differs from what was written, for echoes: `"1/3\"" rounds by -1/3 base unit`. */
export function describeRounding(p: Extract<LengthParse, { ok: true }>): string | undefined {
  return p.roundedBy.n === 0n ? undefined : `${qString(p.exact)} base units, rounded to ${p.value}`;
}
