import { faceAt } from '../editor/geometry';
import { labelOf, type EditorModel } from '../editor/model';
import { centreOf, namedShapes } from './geometry';
import type { Finding } from './types';

/**
 * Which room a finding is about, for the report's "by room" grouping: the subject itself when it
 * is a room, else the room whose face holds the centre of the subject's shape — a panel in the
 * utility room, a window of a bedroom. Display only; the report names the subject exactly.
 */
export function roomOfFinding(model: EditorModel | null, f: Finding): { id: string; label: string } | null {
  if (model === null) return f.subject.kind === 'room' ? { id: f.subject.id, label: f.subject.id } : null;
  if (f.subject.kind === 'room') return { id: f.subject.id, label: labelOf(model, f.subject.id) };
  const level = model.levels.find((l) => l.id === f.location.level);
  const first = namedShapes(f)[0];
  const at = first === undefined ? null : centreOf(first);
  if (level === undefined || at === null) return null;
  const room = faceAt(level, at)?.room ?? null;
  return room === null ? null : { id: room, label: labelOf(model, room) };
}

/** An element's label in the model, or its ID when the model does not know it (a circuit, a level gone). */
export const labelIn = (model: EditorModel | null) => (id: string) => (model === null || !model.index.has(id) ? id : labelOf(model, id));
