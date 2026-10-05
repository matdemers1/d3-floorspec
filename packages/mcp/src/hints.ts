import type { Diagnostic } from './client.js';
import { ROOM_FUNCTIONS_TEXT } from './vocabulary.js';

/**
 * One-line hints for the rejections agents were seen to hit in the agent eval (FLR-T-2.9): each
 * says what to send instead. They sit beside the coded diagnostics, never in place of them, and a
 * diagnostic no rule recognises gets no hint.
 */

/** The ops that add or move walls and junctions: what a later op in the same batch cannot see yet. */
const DRAWING_OPS = new Set(['drawWall', 'drawSeparator', 'addWall', 'addSeparator', 'addJunction', 'moveJunction']);

const OPENING_SIZE = /(?:^|\s)\S+'s (width|height) does not resolve/;
const OPENING_SCHEMA = /\/openings\/[^/\s:]+:? .*required property '(width|height)'/;
const ROOM_FUNCTION = /\/rooms\/[^/\s:]+\/function\b/;

const DEFAULTS = {
  height: "An opening without a fill type needs `height` — door height is usually 6' 8\" (a cased opening 6' 8\" to 7' 0\").",
  width: "An opening without a fill type needs `width` — an interior door is usually 2' 8\" to 3' 0\" wide.",
} as const;

export function hintsFor(diagnostics: readonly Diagnostic[], batch?: readonly { op: string }[]): string[] {
  const hints = new Set<string>();
  const drew = batch?.some((o) => DRAWING_OPS.has(o.op)) ?? false;
  for (const d of diagnostics) {
    const message = d.message;
    if (d.code === 'FS-INV-301') {
      const member = OPENING_SIZE.exec(message)?.[1];
      if (member === 'height' || member === 'width') hints.add(DEFAULTS[member]);
    } else if (d.code === 'FS-SCH-001') {
      if (ROOM_FUNCTION.test(message)) hints.add(`${ROOM_FUNCTIONS_TEXT} An extension term looks like EXT_wellness:sauna.`);
      const opening = OPENING_SCHEMA.exec(message);
      const member = opening?.[1];
      if (member === 'height' || member === 'width') hints.add(DEFAULTS[member]);
    } else if (d.code === 'FS-OPS-007' && !/there is no level/.test(message)) {
      hints.add(
        drew
          ? 'Walls drawn in this batch join the plan when the batch ends; apply this operation in a second batch.'
          : "This level's walls do not form rooms right now (see the message); floorspec_validate shows what breaks them.",
      );
    }
  }
  return [...hints];
}
