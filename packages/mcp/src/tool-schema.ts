import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * A tool's input schema as it is advertised: the same Zod schema, validating exactly as before,
 * with the JSON Schema `tools/list` carries made compact.
 *
 * Shared definitions (lengths, points, selectors, the operation union) are already emitted once
 * under `$defs` by their ids (see `ops-schema.ts`); this removes what is said twice or says
 * nothing, without loosening a single constraint:
 *   - the root `$schema` URI (MCP fixes the dialect at 2020-12);
 *   - `"type": "string"` beside a string `const` (the `const` already says it);
 *   - the ±2^53 bounds Zod puts on every integer (JSON numbers past them are not exact anyway);
 *   - `propertyNames: { type: "string" }` (every JSON object key is a string);
 *   - `additionalProperties: {}` and `items: {}` (the empty schema allows what is already allowed);
 *   - a union of all six JSON types, which is any value: `{}`;
 *   - `type: "object"` on every member of a `oneOf`/`anyOf` whose members are all objects, said
 *     once on the union instead (a non-object matched no member before, and fails the type now).
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
  if (hoisted !== undefined) {
    out['type'] = 'object';
    out[hoisted] = (record[hoisted] as Record<string, unknown>[]).map(({ type: _object, ...rest }) => compact(rest, false));
  }
  for (const [key, inner] of Object.entries(record)) {
    if (key === hoisted) continue;
    if (root && key === '$schema') continue;
    if (key === 'type' && inner === 'string' && typeof record['const'] === 'string') continue;
    if (record['type'] === 'integer' && ((key === 'minimum' && inner === SAFE_MIN) || (key === 'maximum' && inner === SAFE_MAX))) continue;
    if (key === 'propertyNames' && isStringType(inner)) continue;
    if ((key === 'additionalProperties' || key === 'items') && isEmptySchema(inner)) continue;
    out[key] = compact(inner, false);
  }
  return out;
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
