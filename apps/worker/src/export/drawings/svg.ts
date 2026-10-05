/**
 * A sheet as SVG: the same display list the PDF draws, for previews and for looking at a sheet in a
 * test (rasterised with the worker's own fonts through resvg). Text is anchored with the same
 * metrics the PDF used, so the two agree to the point.
 */
import { num } from '@floorspec/render2d';
import type { FontName, Measure, Prim, Sheet } from './sheet.js';

const FAMILY: Readonly<Record<FontName, [string, number]>> = {
  sans: ['Inter', 400],
  'sans-medium': ['Inter', 500],
  'sans-bold': ['Inter', 600],
  mono: ['JetBrains Mono', 400],
  'mono-medium': ['JetBrains Mono', 500],
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sheetToSvg(sheet: Sheet, measure: Measure): string {
  let clipId = 0;
  const defs: string[] = [];
  const draw = (prims: readonly Prim[]): string =>
    prims
      .map((p) => {
        if (p.t === 'clip') {
          const id = `c${String(++clipId)}`;
          defs.push(`<clipPath id="${id}"><path d="${p.d}"/></clipPath>`);
          return `<g clip-path="url(#${id})">${draw(p.children)}</g>`;
        }
        if (p.t === 'text') {
          const [family, weight] = FAMILY[p.font];
          const w = measure(p.text, p.font, p.size);
          const dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
          const rot = p.rotate !== undefined && p.rotate !== 0 ? ` transform="rotate(${num(p.rotate)} ${num(p.x)} ${num(p.y)})"` : '';
          return `<text x="${num(p.x + dx)}" y="${num(p.y)}" font-family="${family}" font-weight="${String(weight)}" font-size="${num(p.size)}" fill="${p.color}"${rot}>${esc(p.text)}</text>`;
        }
        const a = [
          `d="${p.d}"`,
          `fill="${p.fill ?? 'none'}"`,
          p.stroke === undefined ? '' : `stroke="${p.stroke}" stroke-width="${num(p.width ?? 1)}"`,
          p.dash === undefined ? '' : `stroke-dasharray="${p.dash.map(num).join(' ')}"`,
          p.evenOdd === true ? 'fill-rule="evenodd"' : '',
          p.cap === undefined ? '' : `stroke-linecap="${p.cap}"`,
          p.join === undefined ? '' : `stroke-linejoin="${p.join}"`,
        ].filter((s) => s !== '');
        return `<path ${a.join(' ')}/>`;
      })
      .join('');
  const body = draw(sheet.prims);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(sheet.width)}" height="${num(sheet.height)}" viewBox="0 0 ${num(sheet.width)} ${num(sheet.height)}"><defs>${defs.join('')}</defs>${body}</svg>\n`;
}
