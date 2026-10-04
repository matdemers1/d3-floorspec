/**
 * Lengths for people (FLR-ADR-004 keeps the integers; this only prints them). 1 in = 32,512 base
 * units, so a sixteenth of an inch is 2,032 units exactly; 1 mm = 1,280.
 */

const PER_SIXTEENTH = 2032n;
const PER_MM = 1280;

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/** Round to the nearest sixteenth of an inch, ties to even, and print as feet-inches-fraction. */
export function formatFeetInches(units: number): string {
  let n = BigInt(Math.trunc(units));
  const negative = n < 0n;
  if (negative) n = -n;
  let q = n / PER_SIXTEENTH;
  const r = n % PER_SIXTEENTH;
  if (r * 2n > PER_SIXTEENTH || (r * 2n === PER_SIXTEENTH && q % 2n === 1n)) q += 1n;
  const feet = q / 192n;
  const rest = q % 192n;
  const inches = rest / 16n;
  const sixteenths = rest % 16n;
  let fraction = '';
  if (sixteenths !== 0n) {
    const g = gcd(sixteenths, 16n);
    fraction = `${String(sixteenths / g)}/${String(16n / g)}`;
  }
  const inchPart = fraction === '' ? `${String(inches)}"` : inches === 0n ? `${fraction}"` : `${String(inches)} ${fraction}"`;
  const text = feet === 0n ? inchPart : `${String(feet)}' ${inchPart}`;
  return negative && q !== 0n ? `-${text}` : text;
}

export function formatMillimetres(units: number): string {
  return `${(units / PER_MM).toFixed(1)} mm`;
}

/** Both spellings of a length, and the exact integer. */
export function length(units: number): { units: number; ftIn: string; mm: string } {
  return { units, ftIn: formatFeetInches(units), mm: formatMillimetres(units) };
}

/** Square base units (as a decimal string from the engine) to square feet, one decimal. */
export function squareFeet(area: string | number): number {
  const value = typeof area === 'string' ? Number(area) : area;
  return Math.round((value / (390144 * 390144)) * 10) / 10;
}
