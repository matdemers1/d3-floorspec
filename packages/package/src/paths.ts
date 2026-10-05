/**
 * Paths inside a package.
 *
 * An asset's `path` (Core 8.6.2) is relative, uses `/`, and has no empty, `.` or `..` segment and
 * no `:` in its first segment — so nothing a document names can be outside its package (18.4). A
 * ZIP entry's name is held to the same rule and a little more, because it is about to become a
 * file on somebody's disk: no `\` (a separator to Windows, so `..\..\x` would climb), no control
 * characters, and lengths a file system takes. A name that breaks the rule refuses the whole
 * archive — a package with one hostile name is not a package with one file fewer.
 */

/** Longest path, in UTF-8 bytes; and longest segment, which is what most file systems allow. */
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;

const encoder = new TextEncoder();

/** Why `path` is not a safe package path, or null when it is. */
export function pathProblem(path: string): string | null {
  if (path === '') return 'the path is empty';
  if (path.startsWith('/')) return 'the path is absolute';
  if (path.includes('\\')) return 'the path has a backslash';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'the path has a control character';
  if (encoder.encode(path).length > MAX_PATH_BYTES) return `the path is longer than ${String(MAX_PATH_BYTES)} bytes`;
  const segments = path.split('/');
  if (segments[0]?.includes(':')) return 'the path’s first segment has a colon';
  for (const s of segments) {
    if (s === '') return 'the path has an empty segment';
    if (s === '.' || s === '..') return `the path has a ${s} segment`;
    if (encoder.encode(s).length > MAX_SEGMENT_BYTES) return `a segment is longer than ${String(MAX_SEGMENT_BYTES)} bytes`;
  }
  return null;
}

export const isSafePath = (path: string): boolean => pathProblem(path) === null;

/** Compare by Unicode code point (Core 18.4: a path is a sequence of code points), not UTF-16 unit. */
export function comparePaths(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (i < a.length ? 1 : 0) - (j < b.length ? 1 : 0);
}
