import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * A tool's input schema as it is advertised: the same Zod schema, validating exactly as before,
 * with the JSON Schema `tools/list` carries made compact.
 *
 * Shared definitions (lengths, points, selectors, the operation union) are already emitted once
 * under `$defs` by their ids (see `ops-schema.ts`); this removes what is said twice or says
 * nothing, without loosening a single constraint:
 *   - the root `$schema` URI (MCP fixes the dialect at 2020-12);
 *   - `"type": "string"` beside a string `const`, or an `enum` of strings (they already say it);
 *   - `maxItems` on a tuple closed by `"items": false` (its `prefixItems` already count it);
 *   - the ±2^53 bounds Zod puts on every integer (JSON numbers past them are not exact anyway);
 *   - `propertyNames: { type: "string" }` (every JSON object key is a string);
 *   - `additionalProperties: {}` and `items: {}` (the empty schema allows what is already allowed);
 *   - a union of all six JSON types, which is any value: `{}`;
 *   - `type: "object"` on every member of a `oneOf`/`anyOf` whose members are all objects, said
 *     once on the union instead (a non-object matched no member before, and fails the type now);
 *   - on a discriminated `oneOf` (the Ops union, a host), each closed member's
 *     `additionalProperties: false` and its discriminator in `required`, said once on the union as
 *     `unevaluatedProperties: false` and `required: [<discriminator>]`. The discriminator's `const`
 *     lets at most one member match, and 2020-12 counts only that member's `properties` as
 *     evaluated, so a member that does not belong to the matching operation is refused exactly as
 *     before, and so is an object without the discriminator;
 *   - an `anyOf` of closed objects that each have exactly one, required, property of its own (a
 *     lock: `{element}`, `{length}` or `{distance}`), said as one closed object of those properties
 *     with exactly one of them present (`minProperties`/`maxProperties` 1).
 *
 * The JSON Schema is computed once per process, not once per request: the endpoint builds a fresh
 * server for every request.
 */
export function compactSchema<T extends StandardSchemaWithJSON>(schema: T, options: { advertise?: Record<string, object> } = {}): T {
  const std = schema['~standard'];
  const cache = new Map<string, Record<string, unknown>>();
  const convert = (io: 'input' | 'output') => (target: Parameters<typeof std.jsonSchema.input>[0]) => {
    const key = `${io}:${target.target}`;
    let result = cache.get(key);
    if (result === undefined) {
      result = advertise(compact(std.jsonSchema[io](target)) as Record<string, unknown>, options.advertise ?? {});
      cache.set(key, result);
    }
    return structuredClone(result);
  };
  return {
    '~standard': {
      version: std.version,
      vendor: std.vendor,
      validate: std.validate,
      ...(std.types === undefined ? {} : { types: std.types }),
      jsonSchema: { input: convert('input'), output: convert('output') },
    },
  } as unknown as T;
}

/**
 * Replace named `$defs` with what is advertised in their place (validation is untouched: it is the
 * Zod schema's), then drop the definitions nothing references any more.
 */
function advertise(schema: Record<string, unknown>, replacements: Record<string, object>): Record<string, unknown> {
  const defs = schema['$defs'] as Record<string, unknown> | undefined;
  if (defs === undefined || Object.keys(replacements).length === 0) return schema;
  const replaced: Record<string, unknown> = { ...defs, ...replacements };
  const body = { ...schema };
  delete body['$defs'];
  const kept = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
          const name = v.slice('#/$defs/'.length);
          if (!kept.has(name)) {
            kept.add(name);
            visit(replaced[name]);
          }
        } else visit(v);
      }
    }
  };
  visit(body);
  const live = Object.fromEntries(Object.entries(replaced).filter(([name]) => kept.has(name)));
  return Object.keys(live).length === 0 ? body : { ...body, $defs: live };
}

const SAFE_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** The compaction itself, exported for the test that checks it loses no constraint. */
export function compact(value: unknown, root = true): unknown {
  if (Array.isArray(value)) return value.map((v) => compact(v, false));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (isAnyJson(record)) {
    const rest = { ...record };
    delete rest['anyOf'];
    return compact(rest, root);
  }
  const out: Record<string, unknown> = {};
  const union = (['oneOf', 'anyOf'] as const).find((k) => Array.isArray(record[k]) && (record[k] as unknown[]).every(isObjectSchema));
  const hoisted = union !== undefined && record['type'] === undefined ? union : undefined;
  const single = record['anyOf'] !== undefined && record['properties'] === undefined ? oneKeyEach(record['anyOf']) : undefined;
  if (single !== undefined) {
    const rest = { ...record };
    delete rest['anyOf'];
    return compact({ type: 'object', ...rest, properties: single, minProperties: 1, maxProperties: 1, additionalProperties: false }, root);
  }
  let closed: string | undefined;
  if (hoisted !== undefined) {
    out['type'] = 'object';
    const members = (record[hoisted] as Record<string, unknown>[]).map(({ type: _object, ...rest }) => compact(rest, false) as Record<string, unknown>);
    closed = hoisted === 'oneOf' && record['required'] === undefined && record['unevaluatedProperties'] === undefined ? discriminator(members) : undefined;
    out[hoisted] =
      closed === undefined
        ? members
        : members.map(({ additionalProperties: _closed, required, ...rest }) => {
            const own = (required as string[]).filter((k) => k !== closed);
            return own.length === 0 ? rest : { ...rest, required: own };
          });
  }
  for (const [key, inner] of Object.entries(record)) {
    if (key === hoisted) continue;
    if (root && key === '$schema') continue;
    if (key === 'type' && inner === 'string' && (typeof record['const'] === 'string' || isStringEnum(record['enum']))) continue;
    if (key === 'maxItems' && record['items'] === false && Array.isArray(record['prefixItems']) && record['prefixItems'].length === inner) continue;
    if (record['type'] === 'integer' && ((key === 'minimum' && inner === SAFE_MIN) || (key === 'maximum' && inner === SAFE_MAX))) continue;
    if (key === 'propertyNames' && isStringType(inner)) continue;
    if ((key === 'additionalProperties' || key === 'items') && isEmptySchema(inner)) continue;
    out[key] = compact(inner, false);
  }
  if (closed !== undefined) {
    out['required'] = [closed];
    out['unevaluatedProperties'] = false;
  }
  return out;
}

/**
 * The properties of an `anyOf` whose members are closed objects of one required property each, all
 * different, merged into one map; undefined for any other `anyOf`.
 */
function oneKeyEach(members: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(members) || members.length < 2) return undefined;
  const merged: Record<string, unknown> = {};
  for (const member of members) {
    if (!isObjectSchema(member) || member['additionalProperties'] !== false) return undefined;
    const keys = Object.keys(member).filter((k) => k !== 'type' && k !== 'properties' && k !== 'required' && k !== 'additionalProperties');
    const properties = member['properties'] as Record<string, unknown> | undefined;
    const names = Object.keys(properties ?? {});
    const required = member['required'];
    const name = names[0];
    if (keys.length > 0 || name === undefined || names.length !== 1 || !Array.isArray(required) || required.length !== 1 || required[0] !== name || name in merged) return undefined;
    merged[name] = properties?.[name];
  }
  return merged;
}

/**
 * The member every closed alternative of a union requires with a distinct string `const` (`op`,
 * `mode`), or undefined when the union is not discriminated that way.
 */
function discriminator(members: Record<string, unknown>[]): string | undefined {
  const first = members[0];
  if (first === undefined || members.length < 2) return undefined;
  const candidates = Array.isArray(first['required']) ? (first['required'] as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  return candidates.find((key) => {
    const values = members.map((m) => {
      if (m['additionalProperties'] !== false || !Array.isArray(m['required']) || !(m['required'] as unknown[]).includes(key)) return undefined;
      const property = (m['properties'] as Record<string, { const?: unknown }> | undefined)?.[key];
      return typeof property?.const === 'string' ? property.const : undefined;
    });
    return values.every((v) => v !== undefined) && new Set(values).size === values.length;
  });
}

function isStringEnum(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

function isEmptySchema(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

const JSON_TYPES = ['array', 'boolean', 'null', 'number', 'object', 'string'];

/** `anyOf` of exactly the six JSON types, unconstrained: any value at all. */
function isAnyJson(record: Record<string, unknown>): boolean {
  const members = record['anyOf'];
  if (!Array.isArray(members) || members.length !== JSON_TYPES.length) return false;
  const types = members.map((m) => {
    if (m === null || typeof m !== 'object') return '';
    const { type, ...rest } = compact(m, false) as Record<string, unknown>;
    return Object.keys(rest).length === 0 && typeof type === 'string' ? type : '';
  });
  return [...types].sort().join() === JSON_TYPES.join();
}

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'object';
}

function isStringType(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 1 && (value as { type?: unknown }).type === 'string';
}
