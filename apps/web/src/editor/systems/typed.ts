import type { EditorModel } from '../model';
import { centroid, inFace, interiorPoint } from '../geometry';
import { parseLen, parsePoint, type UnitSystem } from '../units';
import { DEVICE_KINDS, defaultHeight, NO_OPTIONS, type DeviceKind, type ReceptacleOptions } from './catalog';
import type { HostRef } from './ops';
import { roomSide } from './placement';

/**
 * Placing a device from the keyboard (FLR-T-5.7): a typed phrase the palette turns into the same
 * placeElement the pointer sends. Wall and room references are passed to the applier as written —
 * "W12", "north wall of Kitchen", "Kitchen" — and resolved there, exactly (Ops 3); the editor only
 * reads the kind, the lengths and which face.
 *
 *   receptacle on W12 at 3' from start, 12" high
 *   gfci receptacle on north wall of Kitchen at 2' from end
 *   switch on W3 at 1' 6" toward Hall
 *   light in Kitchen
 *   toilet in Bath at 6', 4'
 */

export type TypedPlacement =
  | { ok: true; kind: DeviceKind; receptacle: ReceptacleOptions; host: HostRef; summary: string }
  | { ok: false; reason: string };

const OPTION_WORDS: Record<string, keyof ReceptacleOptions> = { gfci: 'gfci', afci: 'afci', usb: 'usb', '240v': 'v240', '240 v': 'v240' };

/** The kind a phrase starts with, its options, and the rest of the phrase. */
function readKind(text: string): { kind: DeviceKind; options: ReceptacleOptions; rest: string } | null {
  let t = text.trim().replace(/^(place|add|put)\s+/i, '').replace(/^(an?|the)\s+/i, '');
  const options: ReceptacleOptions = { ...NO_OPTIONS };
  for (;;) {
    const m = /^(gfci|afci|usb|240\s?v)\s+/i.exec(t);
    if (m === null) break;
    const key = OPTION_WORDS[(m[1] ?? '').toLowerCase().replace(/\s/g, '')] ?? OPTION_WORDS[(m[1] ?? '').toLowerCase()];
    if (key !== undefined) options[key] = true;
    t = t.slice(m[0].length);
  }
  const names = DEVICE_KINDS.flatMap((k) => [k.label, k.id, ...k.aliases].map((n) => ({ k, n: n.toLowerCase() }))).sort((a, b) => b.n.length - a.n.length);
  const lower = t.toLowerCase();
  const found = names.find(({ n }) => lower === n || lower.startsWith(`${n} `));
  if (found === undefined) return null;
  return { kind: found.k, options, rest: t.slice(found.n.length).trim() };
}

/** Read a typed placement against the model it will be applied to. */
export function parsePlacement(text: string, model: EditorModel, levelId: string | null, units: UnitSystem): TypedPlacement {
  const read = readKind(text);
  if (read === null) return { ok: false, reason: 'Start with what to place: receptacle, switch, light, panel, toilet, water heater…' };
  const { kind, options, rest } = read;
  const level = model.levels.find((l) => l.id === levelId);
  const on = /^on\s+(.+?)\s+at\s+(.+?)(?:\s*,\s*(.+?)\s+high)?(?:\s+(?:toward|towards|facing|into)\s+(.+))?$/i.exec(rest);
  if (on !== null) {
    if (kind.mount !== 'wall') return { ok: false, reason: `A ${kind.label.toLowerCase()} goes ${kind.mount === 'ceiling' ? 'on a ceiling' : 'on a floor'}: "${kind.label.toLowerCase()} in <room>".` };
    const [, wallRef = '', atText = '', heightText, toward] = on;
    let height = defaultHeight(kind, units);
    if (heightText !== undefined) {
      const h = parseLen(heightText, units);
      if (!h.ok) return { ok: false, reason: `Height: ${h.reason}` };
      height = h.value;
    }
    const bare = parseLen(atText, units);
    const at: number | string = bare.ok ? bare.value : atText.trim();
    const wall = level?.walls.find((w) => w.id === wallRef.trim());
    const of = /(?:wall|face)\s+of\s+(.+)$/i.exec(wallRef.trim())?.[1];
    const host: HostRef =
      toward !== undefined
        ? { mode: 'wallFace', wall: wallRef.trim(), toward: toward.trim(), at, height }
        : wall !== undefined && level !== undefined
          ? { mode: 'wallFace', wall: wall.id, side: roomSide(level, wall), at, height }
          : of !== undefined
            ? { mode: 'wallFace', wall: wallRef.trim(), toward: of.trim(), at, height }
            : { mode: 'wallFace', wall: wallRef.trim(), side: 'right', at, height };
    return { ok: true, kind, receptacle: options, host, summary: `${kind.label} on ${wallRef.trim()} at ${typeof at === 'number' ? `${atText.trim()} from start` : at}` };
  }
  const inRoom = /^in\s+(.+?)(?:\s+at\s+(.+))?$/i.exec(rest);
  if (inRoom !== null) {
    if (kind.mount === 'wall') return { ok: false, reason: `A ${kind.label.toLowerCase()} goes on a wall: "${kind.label.toLowerCase()} on <wall> at <position>".` };
    const [, roomRef = '', atText] = inRoom;
    const rooms = Object.entries(model.document.rooms ?? {});
    const room = rooms.find(([id]) => id === roomRef.trim()) ?? rooms.find(([, r]) => typeof r?.name === 'string' && r.name.toLowerCase() === roomRef.trim().toLowerCase());
    if (room === undefined) return { ok: false, reason: `No room is called "${roomRef.trim()}".` };
    let at: [number, number];
    if (atText !== undefined) {
      const p = parsePoint(atText, units);
      if (!p.ok) return { ok: false, reason: p.reason };
      at = p.value;
    } else {
      const face = model.levels.flatMap((l) => l.faces).find((f) => f.room === room[0]);
      if (face === undefined) return { ok: false, reason: `${roomRef.trim()} has no derived space to place in.` };
      const c = centroid(face.outer);
      const inside = inFace(c, face) ? c : interiorPoint(face);
      if (inside === null) return { ok: false, reason: `${roomRef.trim()} is too thin to place in.` };
      at = [Math.round(inside[0]), Math.round(inside[1])];
    }
    return { ok: true, kind, receptacle: options, host: { mode: 'surface', room: room[0], surface: kind.mount === 'ceiling' ? 'ceiling' : 'floor', at }, summary: `${kind.label} in ${roomRef.trim()}${atText === undefined ? ', in the middle' : ` at ${atText}`}` };
  }
  return { ok: false, reason: kind.mount === 'wall' ? `Say where: "${kind.label.toLowerCase()} on W3 at 2' from start, 12" high"` : `Say where: "${kind.label.toLowerCase()} in Kitchen"` };
}
