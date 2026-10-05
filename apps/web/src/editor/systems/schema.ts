import { OFFICIAL_EXTENSION_SCHEMAS } from '@floorspec/engine';
import { words } from './catalog';

/**
 * The inspector's fields for an extension element or record, read from the extension's own schema
 * (registry/<NAME>/<name>.schema.json, vendored in the engine): each member's type, range, enum and
 * default. So a member an extension adds in a later version appears without the editor changing,
 * and nothing here restates what the schema says.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Members Core defines on every extension element (Core 12.5), which the inspector shows elsewhere. */
const CORE_MEMBERS = new Set(['fallback', 'host', 'clearances', 'name', 'extras']);

export type MemberSpec =
  | { name: string; label: string; type: 'int'; min?: number; max?: number; unit?: string; default?: number; required: boolean; description: string }
  | { name: string; label: string; type: 'length'; required: boolean; description: string }
  | { name: string; label: string; type: 'enum'; options: string[]; default?: string; required: boolean; description: string }
  | { name: string; label: string; type: 'enumSet'; options: string[]; required: boolean; description: string }
  | { name: string; label: string; type: 'intList'; required: boolean; description: string }
  | { name: string; label: string; type: 'text'; maxLength?: number; required: boolean; description: string }
  | { name: string; label: string; type: 'bool'; default?: boolean; required: boolean; description: string }
  | { name: string; label: string; type: 'ref' | 'refList'; required: boolean; description: string };

/** The unit a member is counted in (each spec's 1.4): what its field says after the number. */
const UNITS: Record<string, string> = {
  volts: 'V', amps: 'A', rating: 'A', breaker: 'A', mainBreaker: 'A', watts: 'W', input: 'W', heating: 'W', cooling: 'W', capacity: 'mL', airflow: 'mL/s',
};

function definition(schema: Json, ref: unknown): Json | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return undefined;
  const defs = schema['$defs'];
  const def = isObject(defs) ? defs[ref.slice('#/$defs/'.length)] : undefined;
  return isObject(def) ? def : undefined;
}

/** The schema of one kind of element (in `collections`) or record (a top-level member, as `circuits`). */
export function kindSchema(extension: string, collection: string, record: boolean): Json | undefined {
  const schema = OFFICIAL_EXTENSION_SCHEMAS[extension];
  if (!isObject(schema)) return undefined;
  const props = schema['properties'];
  if (!isObject(props)) return undefined;
  const holder = record ? props[collection] : (isObject(props['collections']) && isObject(props['collections']['properties']) ? props['collections']['properties'][collection] : undefined);
  if (!isObject(holder) || !isObject(holder['additionalProperties'])) return undefined;
  return definition(schema, holder['additionalProperties']['$ref']);
}

const isIdRef = (p: Json) => p['$ref'] === '#/$defs/id';

/** The members the inspector edits for a kind, in the schema's order. */
export function memberSpecs(extension: string, collection: string, record = false): MemberSpec[] {
  const def = kindSchema(extension, collection, record);
  if (def === undefined || !isObject(def['properties'])) return [];
  const required = new Set(Array.isArray(def['required']) ? (def['required'] as string[]) : []);
  const out: MemberSpec[] = [];
  for (const [name, raw] of Object.entries(def['properties'])) {
    if ((!record && CORE_MEMBERS.has(name)) || (record && (name === 'extras' || name === 'name')) || !isObject(raw)) continue;
    const base = { name, label: words(name), required: required.has(name), description: typeof raw['description'] === 'string' ? raw['description'] : '' };
    const items = isObject(raw['items']) ? raw['items'] : undefined;
    if (isIdRef(raw)) out.push({ ...base, type: 'ref' });
    else if (raw['type'] === 'array' && items !== undefined && isIdRef(items)) out.push({ ...base, type: 'refList' });
    else if (raw['type'] === 'array' && items !== undefined && Array.isArray(items['enum'])) out.push({ ...base, type: 'enumSet', options: items['enum'] as string[] });
    else if (raw['type'] === 'array' && items?.['type'] === 'integer') out.push({ ...base, type: 'intList' });
    else if (Array.isArray(raw['enum']) && raw['enum'].every((v) => typeof v === 'string')) out.push({ ...base, type: 'enum', options: raw['enum'], ...(typeof raw['default'] === 'string' ? { default: raw['default'] } : {}) });
    else if (Array.isArray(raw['enum']) && raw['enum'].every((v) => typeof v === 'number')) out.push({ ...base, type: 'int', ...(typeof raw['default'] === 'number' ? { default: raw['default'] } : {}), min: Math.min(...(raw['enum'])), max: Math.max(...(raw['enum'])) });
    else if (raw['type'] === 'integer' && /length in base units/i.test(base.description)) out.push({ ...base, type: 'length' });
    else if (raw['type'] === 'integer')
      out.push({
        ...base,
        type: 'int',
        ...(typeof raw['minimum'] === 'number' ? { min: raw['minimum'] } : {}),
        ...(typeof raw['maximum'] === 'number' ? { max: raw['maximum'] } : {}),
        ...(UNITS[name] === undefined ? {} : { unit: UNITS[name] }),
        ...(typeof raw['default'] === 'number' ? { default: raw['default'] } : {}),
      });
    else if (raw['type'] === 'boolean') out.push({ ...base, type: 'bool', ...(typeof raw['default'] === 'boolean' ? { default: raw['default'] } : {}) });
    else if (raw['type'] === 'string') out.push({ ...base, type: 'text', ...(typeof raw['maxLength'] === 'number' ? { maxLength: raw['maxLength'] } : {}) });
  }
  return out;
}
