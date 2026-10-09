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

/** An open path through drawing points: an arc edge's polyline (Core 21.2). */
export const polylinePath = (pts: readonly XY[]): string => (pts.length ? `M${pts.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}` : '');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes as base64 (RFC 4648, padded): for a data URI. No Node `Buffer`, so it runs anywhere. */
export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + '=';
  }
  return out;
}
