import { documentIds, generateContext, generatedIds, OFFICIAL_EXTENSIONS, type FloorspecDocument, type GenerateContextOptions } from '@floorspec/engine';
import { parseLength } from '@floorspec/ops';
import type { Op } from './client.js';

/**
 * FS_context through MCP (FLR-T-15.3): the street, the neighbours and the trees beyond the lot. One op
 * the tools expand before the batch is applied — `{"op":"generateContext","side":"west","name":"Laurel
 * Ridge Drive"}` — generates them from the lot's street edge and setbacks (FS_site), seeded, replacing
 * what was generated before and keeping what was drawn by hand; or an agent writes records itself with
 * setProperty of `$document /extensions/FS_context/<streets|neighbours|trees>/<ID>`. Context is never
 * part of the design: no quantity, schedule, rule or finding counts it — it does cast shade.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export const CONTEXT = 'FS_context';
const EXTENSION_VERSION = OFFICIAL_EXTENSIONS.find((e) => e.name === CONTEXT)?.version ?? '0.1.0';

/** An op that generates context. */
const isGenerate = (op: Op): boolean => op['op'] === 'generateContext';

/** Does the batch generate context? */
export function namesContext(batch: readonly Op[]): boolean {
  return batch.some(isGenerate);
}

/** What the agent asked for that cannot be generated: what to say. */
export class ContextError extends Error {}

function len(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const p = parseLength(v);
    if (p.ok && p.value >= 0n) return Number(p.value);
  }
  throw new ContextError(`generateContext: ${what} must be a length, as "30'" or 11704320.`);
}

export interface ContextFill {
  /** The records' ops, put before the agent's. */
  readonly prefix: Op[];
  /** The agent's ops, each generateContext now FS_context's declaration — so op i is still the agent's op i. */
  readonly batch: Op[];
  /** What was generated, for the result's text. */
  readonly generated: { readonly streets: number; readonly neighbours: number; readonly trees: number; readonly replaced: number };
}

/**
 * The batch with each generateContext expanded: its setProperty and unsetProperty ops on `$document`
 * into the prefix, and the op itself FS_context's declaration (`/extensionsUsed/FS_context`), so the
 * agent's ops keep their places.
 */
export function fillContext(document: unknown, batch: readonly Op[]): ContextFill {
  const doc = structuredClone(document) as FloorspecDocument & { extensionsUsed?: Json; extensions?: Record<string, Json> };
  const out: Op[] = [];
  const prefix: Op[] = [];
  let generated = { streets: 0, neighbours: 0, trees: 0, replaced: 0 };
  for (const op of batch) {
    if (!isGenerate(op)) {
      out.push(op);
      continue;
    }
    const side = op['side'];
    const trees = op['trees'];
    const options: GenerateContextOptions = {
      ...(side === 'north' || side === 'east' || side === 'south' || side === 'west' ? { side } : {}),
      ...(op['street'] !== undefined ? { width: len(op['street'], 'street') } : {}),
      ...(op['sidewalk'] !== undefined ? { sidewalk: len(op['sidewalk'], 'sidewalk') } : {}),
      ...(op['strip'] !== undefined ? { strip: len(op['strip'], 'strip') } : {}),
      ...(typeof op['name'] === 'string' ? { name: op['name'] } : {}),
      ...(typeof op['neighbours'] === 'boolean' ? { neighbours: op['neighbours'] } : {}),
      ...(trees === 'none' || trees === 'few' || trees === 'some' || trees === 'many' ? { trees } : {}),
      ...(typeof op['seed'] === 'number' ? { seed: op['seed'] } : {}),
    };
    const old = generatedIds(doc);
    const data = doc.extensions?.[CONTEXT];
    // the street keeps its name across a regeneration, unless the agent gives another
    const streets = isObject(data) && isObject(data['streets']) ? data['streets'] : {};
    const kept = old.filter((o) => o.member === 'streets').map((o) => (streets[o.id] as Json | undefined)?.['name']).find((n): n is string => typeof n === 'string');
    if (isObject(data)) for (const o of old) delete (data[o.member] as Json | undefined)?.[o.id];
    const g = generateContext(doc, options.name === undefined && kept !== undefined ? { ...options, name: kept } : options, documentIds(doc));
    if (g.reason !== undefined) throw new ContextError(`generateContext: ${g.reason}`);
    out.push({ op: 'setProperty', id: '$document', path: `/extensionsUsed/${CONTEXT}`, value: EXTENSION_VERSION });
    for (const o of old) prefix.push({ op: 'unsetProperty', id: '$document', path: `/extensions/${CONTEXT}/${o.member}/${o.id}` });
    for (const member of ['streets', 'neighbours', 'trees'] as const)
      for (const [id, r] of Object.entries(g[member])) {
        prefix.push({ op: 'setProperty', id: '$document', path: `/extensions/${CONTEXT}/${member}/${id}`, value: r as unknown });
        // so a second generateContext in one batch sees these
        const ext = (doc.extensions ??= {});
        const d = (ext[CONTEXT] ??= {});
        ((d[member] ??= {}) as Json)[id] = r;
      }
    generated = { streets: generated.streets + Object.keys(g.streets).length, neighbours: generated.neighbours + Object.keys(g.neighbours).length, trees: generated.trees + Object.keys(g.trees).length, replaced: generated.replaced + old.length };
  }
  return { prefix, batch: out, generated };
}
