/**
 * The editor's batches for design options (Core 0.3, chapter 19; Ops 0.3, 2.8; FLR-T-8.4): pure
 * builders and names, tested on their own. Options.tsx draws them.
 */
import { IN_OPTIONS, type EditorModel, type OptionSetView } from './model';
import type { Batch, BatchBuilder } from './ops';

/** The next free `<prefix><n>` IDs of a document, skipping `attempt` more for each retry the server asks for (FS-OPS-005). */
export function nextIds(model: EditorModel, prefix: string, count: number, attempt: number): string[] {
  const re = new RegExp(`^${prefix}([0-9]+)$`);
  let max = 0;
  for (const id of model.index.keys()) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Array.from({ length: count }, (_, i) => `${prefix}${String(max + 1 + attempt * count + i)}`);
}

/** A new option set and its options, the first primary (Ops 0.3, 2.8: `addElement` under named IDs). */
export function addOptionSet(model: EditorModel, name: string, options: readonly string[]): BatchBuilder {
  return (attempt) => {
    const [set] = nextIds(model, 'OS', 1, attempt) as [string];
    const ids = nextIds(model, 'OP', options.length, attempt);
    return [
      { op: 'addElement', collection: 'optionSets', id: set, element: { primary: ids[0], ...(name === '' ? {} : { name }) } },
      ...options.map((o, i) => ({ op: 'addElement' as const, collection: 'options', id: ids[i] ?? `OP${String(i)}`, element: { set, ...(o === '' ? {} : { name: o }) } })),
    ] as Batch;
  };
}

/** One more option of a set. */
export function addOption(model: EditorModel, set: string, name: string): BatchBuilder {
  return (attempt) => {
    const [id] = nextIds(model, 'OP', 1, attempt) as [string];
    return [{ op: 'addElement', collection: 'options', id, element: { set, ...(name === '' ? {} : { name }) } }] as Batch;
  };
}

/** Whether an element is of a kind that may be in an option (Core 19.2). */
export function mayBeInOption(model: EditorModel, id: string): boolean {
  const place = model.index.get(id);
  return place === 'extension' || (place !== undefined && (IN_OPTIONS as readonly string[]).includes(place));
}

/** An option's name within its set. */
export const optionLabel = (set: OptionSetView, id: string): string => set.options.find((o) => o.id === id)?.name ?? id;

/** "Kitchen · B", the option an ID names, with its set. */
export function optionTitle(model: EditorModel, option: string): string {
  const set = model.optionSets.find((s) => s.options.some((o) => o.id === option));
  return set === undefined ? option : `${set.name} · ${optionLabel(set, option)}`;
}

