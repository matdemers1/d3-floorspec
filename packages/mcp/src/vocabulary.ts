/**
 * Words agents reach for, said once so the summary header, the design-partner prompt, the op
 * schema and the rejection hints all say the same thing.
 */

/** Floorspec Core 4.1's fourteen room functions, in the table's order (a test holds them to the vendored schema). */
export const ROOM_FUNCTIONS = [
  'unspecified',
  'sleeping',
  'bath',
  'kitchen',
  'living',
  'dining',
  'office',
  'laundry',
  'utility',
  'storage',
  'circulation',
  'mechanical',
  'garage',
  'exterior',
] as const;

/** Core 4.2's extension term, `EXT_wellness:sauna`. */
export const EXTENSION_TERM = /^(FS|EXT|[A-Z0-9]{2,8})_[A-Za-z0-9]+:[a-z][A-Za-z0-9]*$/;

/** The rooms people name that are not Core terms, and the term each one is. */
export const ROOM_FUNCTION_MAPPINGS = 'study → office; closet, pantry → storage; mudroom → utility; powder room → bath; hall, foyer → circulation';

/** One line: the terms and the common mappings. */
export const ROOM_FUNCTIONS_TEXT = `Room functions (Core 4.1): ${ROOM_FUNCTIONS.join(', ')}. Common mappings: ${ROOM_FUNCTION_MAPPINGS}.`;
