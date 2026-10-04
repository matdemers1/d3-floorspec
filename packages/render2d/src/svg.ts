/** Small, deterministic SVG writing helpers. */
import { num } from './format.js';

export type Attrs = Readonly<Record<string, string | number | undefined>>;

/** Escape character data: text between tags needs only &, < and > escaped. */
export function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value (always written in double quotes). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Attributes in the order given; numbers through `num`, undefined values left out. */
export function attrs(a: Attrs): string {
  let out = '';
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${typeof v === 'number' ? num(v) : esc(v)}"`;
  }
  return out;
}

export const el = (name: string, a: Attrs, children?: string): string =>
  children === undefined ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${children}</${name}>`;

export type XY = readonly [number, number];

/** A closed path through rings of drawing points. */
export function ringsPath(rings: readonly (readonly XY[])[]): string {
  return rings
    .filter((r) => r.length > 0)
    .map((r) => `M${r.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}Z`)
    .join('');
}

export const linePath = (a: XY, b: XY): string => `M${num(a[0])} ${num(a[1])}L${num(b[0])} ${num(b[1])}`;
