import { resolveAnnotations } from '@floorspec/engine';
import type { CustomDimension, Note } from '@floorspec/render2d';
import type { EditorModel } from '../model';
import { annotationIds } from './state';

/**
 * The person's own strings and notes on a level (FS_annotation 0.1.0, FLR-ADR-047), resolved by the
 * engine from the model as it is now — so a string follows its walls when they move. A string whose
 * anchors no longer resolve is kept in the document and not drawn (FS-ANNO-LINT-001, 002).
 */
export interface Resolved {
  readonly dimensions: readonly CustomDimension[];
  readonly notes: readonly Note[];
  /** Every annotation ID in the document: what the select tool may pick. */
  readonly ids: ReadonlySet<string>;
  /** IDs in the document that do not resolve. */
  readonly unresolved: readonly string[];
}

const EMPTY: Resolved = { dimensions: [], notes: [], ids: new Set(), unresolved: [] };
const cache = new WeakMap<EditorModel, Map<string, Resolved>>();

export function resolvedOf(model: EditorModel, level: string): Resolved {
  if (model.derived === null) return EMPTY;
  let byLevel = cache.get(model);
  if (byLevel === undefined) {
    byLevel = new Map();
    cache.set(model, byLevel);
  }
  const known = byLevel.get(level);
  if (known !== undefined) return known;
  const ids = annotationIds(model.view);
  if (ids.size === 0) {
    byLevel.set(level, EMPTY);
    return EMPTY;
  }
  const r = resolveAnnotations(model.view, model.derived, level);
  const out: Resolved = {
    dimensions: r.dimensions.map((d) => ({ id: d.id, direction: d.direction, anchors: d.anchors.map((a) => ({ feature: a.feature, onLine: a.onLine })), lengths: d.lengths })),
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, at: n.at, leader: n.leader })),
    ids,
    unresolved: r.unresolved,
  };
  byLevel.set(level, out);
  return out;
}
