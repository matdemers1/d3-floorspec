import { Resvg } from '@resvg/resvg-js';
import { renderPlan, type RenderOptions } from '@floorspec/render2d';
import { planFontFiles } from './fonts.js';

export interface PngOptions extends RenderOptions {
  /** Output width in pixels; the height follows the plan's aspect. Default: the SVG's own size. */
  readonly width?: number;
  /** Where the TTF fonts are cached (default `FLOORSPEC_FONT_DIR` or the OS temp dir). */
  readonly fontDir?: string;
}

/** Rasterise an SVG with the bundled plan fonts only — never the host's. */
export function rasterize(svg: string, options: { width?: number; fontDir?: string } = {}): Uint8Array {
  const { width } = options;
  if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > 16384)) throw new RangeError('width must be an integer from 1 to 16384');
  const resvg = new Resvg(svg, {
    fitTo: width === undefined ? { mode: 'original' } : { mode: 'width', value: width },
    font: {
      loadSystemFonts: false,
      fontFiles: planFontFiles(options.fontDir),
      defaultFontFamily: 'Inter',
      sansSerifFamily: 'Inter',
      monospaceFamily: 'JetBrains Mono',
    },
  });
  return new Uint8Array(resvg.render().asPng());
}

/** Render one level of a Floorspec document as a PNG (FLR-T-2.8). */
export function renderPlanPng(document: string | Uint8Array | object, options: PngOptions = {}): Uint8Array {
  const { width, fontDir, ...plan } = options;
  return rasterize(renderPlan(document, plan), { ...(width !== undefined && { width }), ...(fontDir !== undefined && { fontDir }) });
}

/** The width and height a PNG's IHDR chunk declares. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.byteLength < 24 || v.getUint32(0) !== 0x89504e47 || v.getUint32(12) !== 0x49484452) throw new Error('not a PNG');
  return { width: v.getUint32(16), height: v.getUint32(20) };
}
