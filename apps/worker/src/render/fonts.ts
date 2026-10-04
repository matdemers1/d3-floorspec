import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { woffToSfnt } from './woff.js';

/**
 * The fonts every PNG is drawn with, and nothing else: resvg loads no system fonts, so a plan
 * rasterises to the same pixels on a laptop, in CI and in the worker image. Inter is the design
 * system's face (labels, title) and JetBrains Mono its monospace (dimensions, areas, IDs) — both
 * from @fontsource at pinned versions, unwrapped from WOFF once into a cache directory.
 */
const FONTS = [
  '@fontsource/inter/files/inter-latin-400-normal.woff',
  '@fontsource/inter/files/inter-latin-500-normal.woff',
  '@fontsource/inter/files/inter-latin-600-normal.woff',
  '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff',
  '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff',
] as const;

const require = createRequire(import.meta.url);
const cache = new Map<string, string[]>();

/** The default cache: `FLOORSPEC_FONT_DIR`, else a directory under the OS temp dir. */
export function defaultFontDir(): string {
  return process.env['FLOORSPEC_FONT_DIR'] ?? join(tmpdir(), 'floorspec-fonts');
}

/** Paths of the plan fonts as TTF files, written into `dir` the first time they are asked for. */
export function planFontFiles(dir: string = defaultFontDir()): string[] {
  const hit = cache.get(dir);
  if (hit) return hit;
  mkdirSync(dir, { recursive: true });
  const files = FONTS.map((spec) => {
    const sfnt = woffToSfnt(readFileSync(require.resolve(spec)));
    const digest = createHash('sha256').update(sfnt).digest('hex').slice(0, 16);
    const name = (spec.split('/').at(-1) ?? spec).replace(/\.woff$/, '');
    const path = join(dir, `${name}-${digest}.ttf`);
    if (!existsSync(path)) {
      // Write beside, then rename: a concurrent worker never reads half a font.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, sfnt);
      renameSync(tmp, path);
    }
    return path;
  });
  cache.set(dir, files);
  return files;
}
