import { LIBRARY_FILES, libraryFileOf } from '@floorspec/mesh/materials';

/**
 * The material library's maps (FLR-T-13.6, `@floorspec/mesh/materials`) as the editor serves them:
 * bundled by Vite as files of their own — content-hashed, immutable, fetched only when a view or
 * the picker shows one — so a library map never waits on the project's asset route, in the shared
 * viewer too. A document's material embedded from the library names its maps by digest, and this
 * finds the bundled file for any digest that is one of them.
 */

const FILES = import.meta.glob<string>('../../../../packages/mesh/materials/*.jpg', { query: '?url&no-inline', import: 'default', eager: true });

const URLS = new Map<string, string>();
for (const [path, url] of Object.entries(FILES)) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const f = LIBRARY_FILES[file];
  if (f !== undefined) URLS.set(f.sha256, url);
}

/** Where the editor serves a library file by its name. */
export function libraryFileUrl(file: string): string | undefined {
  const f = LIBRARY_FILES[file];
  return f === undefined ? undefined : URLS.get(f.sha256);
}

/** Where the editor serves the library file with this digest, or undefined when no library file has it. */
export const libraryUrl = (sha256: string): string | undefined => (libraryFileOf(sha256) === undefined ? undefined : URLS.get(sha256));

/** A library file's bytes, for uploading it into a project's asset store (FLR-T-8.2) when it is embedded. */
export async function libraryFileBlob(file: string): Promise<Blob> {
  const url = libraryFileUrl(file);
  if (url === undefined) throw new Error(`the material library has no file ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the library file ${file} could not be loaded`);
  return res.blob();
}
