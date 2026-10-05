/**
 * The request checker (Ops 0.1: 1.1.1; Ops 0.2: 1.1.2; Ops 0.3: 1.1.3) agrees with schema/ops/0.1,
 * 0.2 and 0.3, the normative shapes of an apply request: for every request of each draft's
 * conformance suite and a corpus of malformed ones, checkRequest — run as that draft — accepts
 * exactly what that draft's schema accepts (numbers written with a fraction or an exponent mapped
 * to non-numbers first, as the schema's $comment says). Ops 0.3's schema is Ops 0.2's with roofs
 * and stairs among addElement's collections (Ops 0.3 §0.4, §1.1).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseJson, pointer } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { checkRequest, OpsFailure, OP_SHAPES_BY_VERSION, type OpsVersion } from '../src/index.js';
import { listCases, SUITES } from './suite.js';

/** The schema of each draft's requests. */
const SCHEMA_OF: Record<OpsVersion, OpsVersion> = { '0.1': '0.1', '0.2': '0.2', '0.3': '0.3' };
const schemaDir = (ops: OpsVersion): string => join(import.meta.dirname, '..', 'standard', 'schema', 'ops', SCHEMA_OF[ops]);

const validators = new Map<OpsVersion, (v: unknown) => boolean>();
function validator(ops: OpsVersion): (v: unknown) => boolean {
  const cached = validators.get(ops);
  if (cached) return cached;
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  for (const f of readdirSync(schemaDir(ops)).filter((n) => n.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir(ops), f), 'utf8')) as object);
  const v = ajv.getSchema(`https://d3cloud.io/floorspec/schema/ops/${SCHEMA_OF[ops]}/request.schema.json`);
  if (!v) throw new Error('request.schema.json not found');
  const out = (x: unknown): boolean => v(x) as boolean;
  validators.set(ops, out);
  return out;
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

const accepts = (text: string, ops: OpsVersion): boolean => {
  const p = parseJson(text);
  try {
    checkRequest(p.value, new Set(p.nonIntegerLiterals.map((x) => pointer(x))), ops);
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
  '{"batch":[{"op":"addElement","collection":"chimneys","element":{}}]}',
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
/** Ops 0.2's operations, well-formed and not: each is FS-OPS-001 under Ops 0.1 either way. */
const OPS_02 = [
  '{"batch":[{"op":"moveOpening","opening":"O1","by":"1\'","toward":"east"}]}',
  '{"batch":[{"op":"moveOpening","opening":"O1","at":0,"by":1}]}',
  '{"batch":[{"op":"moveOpening","opening":"O1"}]}',
  '{"batch":[{"op":"moveOpening","opening":"O1","at":0,"toward":"end"}]}',
  '{"batch":[{"op":"moveOpening","opening":"O1","by":1,"toward":"up"}]}',
  '{"batch":[{"op":"addLevel","building":"B1","height":"8\'","above":"L1","name":"Second"}]}',
  '{"batch":[{"op":"addLevel","building":"B1","height":1,"above":"L1","below":"L1"}]}',
  '{"batch":[{"op":"addLevel","building":"B1","height":1}]}',
  '{"batch":[{"op":"addElement","collection":"items","element":{"function":"kitchen"}}]}',
  '{"batch":[{"op":"addElement","extension":"FS_electrical","collection":"devices","id":"X1","element":{}}]}',
  '{"batch":[{"op":"addElement","collection":"devices","element":{}}]}',
  '{"batch":[{"op":"setAdjacency","a":"KIT","b":"DIN","kind":"required","weight":8}]}',
  '{"batch":[{"op":"setAdjacency","a":"KIT","b":"DIN","kind":"near"}]}',
  '{"batch":[{"op":"removeAdjacency","a":"KIT","b":"DIN","kind":"forbidden"}]}',
  '{"batch":[{"op":"removeAdjacency","a":"KIT","b":"DIN","kind":"forbidden","weight":1}]}',
  '{"batch":[{"op":"addRoom","level":"L1","at":[0,0],"brief":"item Kitchen"}]}',
  '{"batch":[{"op":"setRoomBrief","room":"R1","item":"KIT"}]}',
  '{"batch":[{"op":"setRoomBrief","room":"R1"}]}',
  '{"batch":[{"op":"addProgramItem","function":"sleeping","name":"Bedroom","count":3,"minArea":"11 m2","targetArea":1,"level":"L2","id":"BED"}]}',
  '{"batch":[{"op":"addProgramItem","name":"Bedroom"}]}',
  '{"batch":[{"op":"addProgramItem","function":"sleeping","minArea":1.5}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_electrical","collection":"devices","host":{"mode":"wallFace","wall":"W1","toward":"Kitchen","at":"centered","height":"12\\""},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_electrical","collection":"devices","host":{"mode":"wallFace","wall":"W1","side":"left","toward":"Kitchen","at":0,"height":0},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_electrical","collection":"devices","host":{"mode":"wallFace","wall":"W1","side":"inside","at":0,"height":0},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_electrical","collection":"devices","host":{"mode":"wallFace","wall":"W1","at":0,"height":0},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"surface","room":"Bath","surface":"floor","at":[0,0],"rotation":90000000},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"surface","room":"Bath","surface":"wall","at":[0,0]},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"free","level":"L1","at":"J1"},"element":{},"id":"X9"}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"free","level":"L1","at":"J1","wall":"W1"},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"hanging","level":"L1","at":"J1"},"element":{}}]}',
  '{"batch":[{"op":"placeElement","extension":"FS_furniture","collection":"pieces","host":{"mode":"free","level":"L1","at":"J1"}}]}',
  '{"batch":[{"op":"moveElement","element":"X4","host":{"mode":"surface","room":"Bath","surface":"ceiling","at":"3\' east of J2"}}]}',
  '{"batch":[{"op":"moveElement","element":"X4","host":"W1"}]}',
];

const WELL_FORMED = [
  '{"batch":[{"op":"drawWall","level":"L1","from":"J1","to":["2\'","3 m"],"type":"T","layers":[],"justification":"x","base":{},"top":{},"name":"n","id":"W9"}]}',
  '{"batch":[{"op":"addWall","level":"L1","start":"J1","end":"J2","extensions":{},"extras":{}}]}',
  '{"batch":[{"op":"setProperty","id":"$site","path":"/x","value":1.5}]}',
  '{"batch":[{"op":"addElement","collection":"rooms","element":{"anchor":[0.5,1]}}]}',
  '{"batch":[{"op":"removeElement","id":"R1"}],"context":{"locks":[{"element":"W1"},{"length":"W1"},{"distance":["W1","W3"]}],"retired":["W9"]}}',
];

for (const ops of ['0.1', '0.2', '0.3'] as const) {
  describe.runIf(existsSync(schemaDir(ops)))(`the request shape of Ops ${ops} agrees with schema/ops/${SCHEMA_OF[ops]}`, () => {
    it('lists the same operations', () => {
      const schema = JSON.parse(readFileSync(join(schemaDir(ops), 'operation.schema.json'), 'utf8')) as { $defs: Record<string, { properties?: { op?: { const?: string } } }> };
      const names = Object.values(schema.$defs)
        .map((d) => d.properties?.op?.const)
        .filter((x): x is string => x !== undefined)
        .sort();
      expect(names).toEqual(Object.keys(OP_SHAPES_BY_VERSION[ops]).sort());
    });

    it.each([
      ...listCases(SUITES[ops]).map((n) => [n, readFileSync(join(SUITES[ops], n, 'request.json'), 'utf8')]),
      ...MALFORMED.map((t, i) => [`malformed ${i}`, t]),
      ...WELL_FORMED.map((t, i) => [`well-formed ${i}`, t]),
      ...OPS_02.map((t, i) => [`0.2 form ${i}`, t]),
    ])('%s', (_name, text) => {
      const p = parseJson(text);
      if (p.diagnostics.length) return; // not JSON: FS-OPS-001 on both sides
      expect(accepts(text, ops)).toBe(validator(ops)(schemaView(text).value));
    });
  });
}

it('under Ops 0.1, every Ops 0.2 form is FS-OPS-001', () => {
  for (const text of OPS_02) expect(accepts(text, '0.1'), text).toBe(false);
});
