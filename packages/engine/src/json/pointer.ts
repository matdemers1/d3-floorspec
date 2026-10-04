/** JSON Pointers (RFC 6901) and the paths they are built from. */

export type JsonPath = readonly (string | number)[];

/** Encode a path as a JSON Pointer: `~` → `~0`, `/` → `~1`. */
export function pointer(path: JsonPath): string {
  return path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}
