import { deriveFrom, evaluate, type Derived, type Diagnostic, type Evaluation } from '@floorspec/engine';

export type Analysis = NonNullable<Evaluation['analysis']>;

/**
 * A document read once for the perception tools: the engine's evaluation, and — when the document
 * is valid — everything the deriver computes from it.
 */
export interface Read {
  readonly document: Record<string, unknown>;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly derived: Derived | null;
  readonly analysis: Analysis | null;
}

export function read(document: unknown): Read {
  const ev = evaluate(document as object);
  const derived = ev.valid && ev.document !== undefined && ev.analysis !== undefined ? deriveFrom(ev.document, ev.analysis) : null;
  return {
    document: (document ?? {}) as Record<string, unknown>,
    valid: ev.valid,
    diagnostics: ev.diagnostics,
    derived,
    analysis: ev.valid ? (ev.analysis ?? null) : null,
  };
}

/** The members of one collection, by ID, sorted. */
export function collection(doc: Record<string, unknown>, name: string): [string, Record<string, unknown>][] {
  const value = doc[name];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, Record<string, unknown>>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A room by ID, or by name ignoring case (Ops 3.3). */
export function findRoom(doc: Record<string, unknown>, ref: string): [string, Record<string, unknown>] | null {
  const rooms = collection(doc, 'rooms');
  const byId = rooms.find(([id]) => id === ref);
  if (byId !== undefined) return byId;
  const byName = rooms.filter(([, room]) => typeof room['name'] === 'string' && room['name'].toLowerCase() === ref.toLowerCase());
  const [only, ...rest] = byName;
  return only !== undefined && rest.length === 0 ? only : null;
}
