/**
 * The request checker (1.1.1) agrees with schema/ops/0.1, the normative shape of an apply request:
 * for every request of the conformance suite and a corpus of malformed ones, checkRequest accepts
 * exactly what the schema accepts (numbers written with a fraction or an exponent mapped to
 * non-numbers first, as the schema's $comment says).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseJson, pointer } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { checkRequest, OpsFailure, OP_SHAPES } from '../src/index.js';
import { listCases, SUITE } from './suite.js';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'standard', 'schema', 'ops', '0.1');
const vendored = existsSync(SCHEMA_DIR);

function validator(): (v: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')) as object);
  const v = ajv.getSchema('https://d3cloud.io/floorspec/schema/ops/0.1/request.schema.json');
  if (!v) throw new Error('request.schema.json not found');
  return (x) => v(x) as boolean;
}

/** The value as the schema sees it: every non-integer literal replaced by a string no integer matches. */
function schemaView(text: string): { value: unknown; nonInteger: Set<string> } {
  const p = parseJson(text);
  const nonInteger = new Set(p.nonIntegerLiterals.map((x) => pointer(x)));
  const value = structuredClone(p.value);
  for (const path of p.nonIntegerLiterals) {
    let node = value as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
    node[path[path.length - 1]!] = { nonInteger: true };
  }
  return { value, nonInteger };
}

const accepts = (text: string): boolean => {
  const p = parseJson(text);
  try {
    checkRequest(p.value, new Set(p.nonIntegerLiterals.map((x) => pointer(x))));
    return true;
  } catch (e) {
    if (e instanceof OpsFailure) return false;
    throw e;
  }
};

const MALFORMED = [
  '[]',
  '{}',
  '{"batch":[]}',
  '{"batch":{}}',
  '{"batch":[{"op":"rotateWall"}]}',
  '{"batch":[{"op":"moveJunction","id":"J1"}]}',
  '{"batch":[{"op":"moveJunction","id":"J1","to":[0,0],"by":1}]}',
  '{"batch":[{"op":"moveJunction","id":"J1","to":[0.5,0]}]}',
  '{"batch":[{"op":"moveJunction","id":"J1","to":[1e3,0]}]}',
  '{"batch":[{"op":"moveWall","wall":"W1","by":2.0}]}',
  '{"batch":[{"op":"moveRoom","room":"R1","by":[1,2,3]}]}',
  '{"batch":[{"op":"addElement","collection":"walls","element":[]}]}',
  '{"batch":[{"op":"addElement","collection":"roofs","element":{}}]}',
  '{"batch":[{"op":"addJunction","level":5,"position":[0,0]}]}',
  '{"batch":[{"op":"addWall","level":"L1","start":"J1","end":7}]}',
  '{"batch":[{"op":"drawWall","level":"L1","from":[0,0],"to":[1,1],"extras":{}}]}',
  '{"batch":[{"op":"addOpening","wall":"W1","at":"centered","fill":7}]}',
  '{"batch":[{"op":"addSeparator","level":"L1","start":"J1","end":"J2","name":"x"}]}',
  '{"batch":[{"op":"resizeRoom","room":"R1","side":"up","by":1}]}',
  '{"batch":[{"op":"setRoomFinish","room":"R1","surface":"roof","material":"M"}]}',
  '{"batch":[{"op":"removeElement","id":"R1","cascade":"yes"}]}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"x":1}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"user":1}}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"locks":[{"element":"W1","length":"W1"}]}}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"locks":[{"distance":["W1"]}]}}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"retired":[1]}}',
];
const WELL_FORMED = [
  '{"batch":[{"op":"drawWall","level":"L1","from":"J1","to":["2\'","3 m"],"type":"T","layers":[],"justification":"x","base":{},"top":{},"name":"n","id":"W9"}]}',
  '{"batch":[{"op":"addWall","level":"L1","start":"J1","end":"J2","extensions":{},"extras":{}}]}',
  '{"batch":[{"op":"setProperty","id":"$site","path":"/x","value":1.5}]}',
  '{"batch":[{"op":"addElement","collection":"rooms","element":{"anchor":[0.5,1]}}]}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"locks":[{"element":"W1"},{"length":"W1"},{"distance":["W1","W3"]}],"retired":["W9"]}}',
];

describe.runIf(vendored)('the request shape agrees with schema/ops/0.1', () => {
  it('lists the same operations', () => {
    const ops = JSON.parse(readFileSync(join(SCHEMA_DIR, 'operation.schema.json'), 'utf8')) as { $defs: Record<string, { properties?: { op?: { const?: string } } }> };
    const names = Object.values(ops.$defs)
      .map((d) => d.properties?.op?.const)
      .filter((x): x is string => x !== undefined)
      .sort();
    expect(names).toEqual(Object.keys(OP_SHAPES).sort());
  });

  it.each([
    ...listCases().map((n) => [n, readFileSync(join(SUITE, n, 'request.json'), 'utf8')]),
    ...MALFORMED.map((t, i) => [`malformed ${i}`, t]),
    ...WELL_FORMED.map((t, i) => [`well-formed ${i}`, t]),
  ])('%s', (_name, text) => {
    const p = parseJson(text);
    if (p.diagnostics.length) return; // not JSON: FS-OPS-001 on both sides
    expect(accepts(text)).toBe(validator()(schemaView(text).value));
  });
});
