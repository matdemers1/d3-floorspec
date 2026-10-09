// Vendors the FS_furniture starter library (CC0-1.0) into the MCP package: library.json as the
// standard has it, plus each model's and symbol's bytes in base64 under `files`, so the tools can
// place an item by its catalogue ID and upload its two files without reading outside their own
// package (the server image carries @floorspec/engine's dist, not its standard/).
//
//   pnpm --filter @floorspec/mcp vendor-furniture
//
// test/furniture-catalogue.test.ts fails while the copy differs from the standard's.
import { readFileSync, writeFileSync } from 'node:fs';

const LIB = new URL('../../engine/standard/registry/FS_furniture/library/', import.meta.url);
const OUT = new URL('../src/library/fs-furniture-0.1.0.json', import.meta.url);

const library = JSON.parse(readFileSync(new URL('library.json', LIB), 'utf8'));
const files = {};
for (const item of Object.values(library.items)) {
  for (const file of [item.model, item.symbol]) files[file.path] = readFileSync(new URL(file.path, LIB)).toString('base64');
}
writeFileSync(OUT, `${JSON.stringify({ ...library, files }, null, 2)}\n`);
process.stdout.write(`wrote ${OUT.pathname}: ${String(Object.keys(library.items).length)} items, ${String(Object.keys(files).length)} files\n`);
