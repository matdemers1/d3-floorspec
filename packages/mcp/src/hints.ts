import type { Diagnostic } from './client.js';
import { ROOM_FUNCTIONS_TEXT } from './vocabulary.js';

/**
 * One-line hints for the rejections agents were seen to hit in the agent eval (FLR-T-2.9): each
 * says what to send instead. They sit beside the coded diagnostics, never in place of them, and a
 * diagnostic no rule recognises gets no hint.
 */

/** The ops that add or move walls and junctions: what a later op in the same batch cannot see yet. */
const DRAWING_OPS = new Set(['drawWall', 'drawSeparator', 'addWall', 'addSeparator', 'addJunction', 'moveJunction']);

/** The Ops 0.2 operations that write a program or an extension element: what a Core 0.1 document cannot hold. */
const PROGRAM_OPS = new Set(['addProgramItem', 'setAdjacency', 'removeAdjacency', 'setRoomBrief', 'placeElement', 'moveElement']);

const OPENING_SIZE = /(?:^|\s)\S+'s (width|height) does not resolve/;
const ANCHOR_ON_LINE = /anchor is on a location line/;
const NOT_INTEGER = /must be integer/;
const UNDECLARED_EXTENSION = /extension (\S+), which is not in extensionsUsed/;
const FALLBACK_BOX = /\/fallback\b.*required property 'box'/;
const OPENING_SCHEMA = /\/openings\/[^/\s:]+:? .*required property '(width|height)'/;
const ROOM_FUNCTION = /\/rooms\/[^/\s:]+\/function\b/;

const DEFAULTS = {
  height: "An opening without a fill type needs `height` — door height is usually 6' 8\" (a cased opening 6' 8\" to 7' 0\").",
  width: "An opening without a fill type needs `width` — an interior door is usually 2' 8\" to 3' 0\" wide.",
} as const;

/** setProperty's `value` is taken as given (Ops 2.5): the reference grammar does not reach inside it. */
export const SET_PROPERTY_HINT =
  'setProperty values are taken as given, never resolved: a length or point there is an integer in base units (1 in = 32512, 1 ft = 390144, 1 mm = 1280), not a string like "5\'".';

/** The hint for a program or a hosted element sent to a plan that is still a Floorspec 0.1 document. */
export const UPGRADE_HINT =
  'This plan is a Floorspec 0.1 document, which holds no program and no extension elements. Upgrade it first, in the same batch: {"op":"setProperty","id":"$document","path":"/floorspec","value":"0.3"}.';

export function hintsFor(diagnostics: readonly Diagnostic[], batch?: readonly { op: string; [member: string]: unknown }[]): string[] {
  const hints = new Set<string>();
  const drew = batch?.some((o) => DRAWING_OPS.has(o.op)) ?? false;
  const setsValues = batch?.some((o) => o.op === 'setProperty') ?? false;
  const programmed = batch?.some((o) => PROGRAM_OPS.has(o.op) || (o.op === 'addElement' && (o['collection'] === 'items' || o['extension'] !== undefined)) || (o.op === 'addRoom' && o['brief'] !== undefined)) ?? false;
  for (const d of diagnostics) {
    const message = d.message;
    if (d.code === 'FS-INV-301') {
      const member = OPENING_SIZE.exec(message)?.[1];
      if (member === 'height' || member === 'width') hints.add(DEFAULTS[member]);
    } else if (d.code === 'FS-INV-201' && ANCHOR_ON_LINE.test(message)) {
      hints.add(
        drew
          ? "A wall drawn in this batch runs through a room's anchor, which must lie inside its face. Draw the wall elsewhere, or move the anchor off it in the same batch: " +
              '{"op":"setProperty","id":"<room>","path":"/anchor","value":[x, y]} with integers in base units (1 ft = 390144) — no operation moves an anchor by reference.'
          : 'A room\'s anchor must lie inside its face, not on a wall line: move it with {"op":"setProperty","id":"<room>","path":"/anchor","value":[x, y]} in integer base units (1 ft = 390144).',
      );
    } else if (d.code === 'FS-INV-005') {
      const extension = UNDECLARED_EXTENSION.exec(message)?.[1];
      if (extension !== undefined)
        hints.add(`Declare ${extension} in the same batch, before placing anything of it: {"op":"setProperty","id":"$document","path":"/extensionsUsed/${extension}","value":"0.1.0"}.`);
    } else if (d.code === 'FS-SCH-001') {
      if (setsValues && NOT_INTEGER.test(message)) hints.add(SET_PROPERTY_HINT);
      if (ROOM_FUNCTION.test(message)) hints.add(`${ROOM_FUNCTIONS_TEXT} An extension term looks like EXT_wellness:sauna.`);
      // A program or extension data at the top of a Core 0.1 document is not a member it has.
      if (programmed && d.location?.['pointer'] === '' && /additional properties/.test(message)) hints.add(UPGRADE_HINT);
      if (FALLBACK_BOX.test(message)) hints.add('A placed element needs element.fallback.box: {"min":[x,y,z],"max":[x,y,z]} in base units around its host point — an outlet is about 1" × 3" × 4".');
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
