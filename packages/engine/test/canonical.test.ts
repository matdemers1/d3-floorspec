import { describe, expect, it } from 'vitest';
import { canonicalize, contentHash, omitDefaults } from '../src/canonical/canonicalize.js';
import { SCHEMA } from '../src/generated/schema.js';
import { parseJson } from '../src/json/parse.js';
import { writeJcs } from '../src/json/serialize.js';
import { sha256Hex } from '../src/hash/sha256.js';

/** Count the `default` keywords in the bundled schema (keys of `properties`/`$defs` are names, not keywords). */
function countDefaults(node: unknown, isMap = false): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + countDefaults(x), 0);
  if (typeof node !== 'object' || node === null) return 0;
  let n = !isMap && 'default' in node ? 1 : 0;
  for (const [k, v] of Object.entries(node)) {
    if (!isMap && ['default', 'const', 'enum', 'examples'].includes(k)) continue;
    n += countDefaults(v, !isMap && ['properties', 'patternProperties', '$defs'].includes(k));
  }
  return n;
}

const A = `{"floorspec":"0.1","project":{"name":"Two formats","extras":{}},"buildings":{"B1":{}},
"levels":{"L1":{"building":"B1","elevation":0,"height":3200000,"extensions":{}}},
"junctions":{"J1":{"level":"L1","position":[0,0],"join":{"kind":"mitre"}},"J2":{"level":"L1","position":[1000000,0]}},
"walls":{"W1":{"level":"L1","start":"J1","end":"J2","justification":"center","base":{"offset":0},"layers":[{"thickness":12800,"function":"core"}]}},
"types":{"D":{"kind":"doorType","width":914400,"height":2032000,"extras":{}}},
"openings":{"O1":{"wall":"W1","offset":10000,"fill":"D","sill":0,"hinge":"start","swing":"right"}},
"rooms":{},"extensionsRequired":[],"extras":{"z":1.0,"a":[1e3,{}]}}`;

const B = `{
    "extras": {"a": [1000, {}], "z": 1},
    "openings": {"O1": {"sill": 0, "fill": "D", "offset": 10000, "wall": "W1"}},
    "walls": {"W1": {"layers": [{"function": "core", "thickness": 12800}], "end": "J2", "start": "J1", "level": "L1"}},
    "junctions": {"J2": {"position": [1000000, 0], "level": "L1"}, "J1": {"position": [0, 0], "level": "L1"}},
    "types": {"D": {"height": 2032000, "width": 914400, "kind": "doorType"}},
    "levels": {"L1": {"height": 3200000, "elevation": 0, "building": "B1"}},
    "buildings": {"B1": {}},
    "project": {"name": "Two formats"},
    "floorspec": "0.1"
}`;

describe('canonical form (9.2) and content hash (9.3)', () => {
  it('reads exactly the 53 constant defaults of Core 0.1 from the schema', () => {
    expect(countDefaults(SCHEMA)).toBe(53);
  });

  it('two differently formatted inputs canonicalise to identical bytes and the same hash', () => {
    const a = parseJson(A).value;
    const b = parseJson(B).value;
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toBe(sha256Hex(writeJcs(omitDefaults(b))));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits constant defaults, innermost first, and never a typed property', () => {
    const c = omitDefaults(parseJson(A).value) as Record<string, Record<string, Record<string, unknown>>>;
    expect(c.walls!.W1).toEqual({ level: 'L1', start: 'J1', end: 'J2', layers: [{ thickness: 12800, function: 'core' }] });
    expect(c.junctions!.J1).toEqual({ level: 'L1', position: [0, 0] });
    expect(c.openings!.O1).toEqual({ wall: 'W1', offset: 10000, fill: 'D', sill: 0 }); // sill is typed (8.2)
    expect(c.rooms).toBeUndefined();
    expect(c.project).toEqual({ name: 'Two formats' });
    // extras content is never changed; only an empty extras goes
    expect((c as Record<string, unknown>).extras).toEqual({ z: 1, a: [1000, {}] });
  });

  it('keeps members whose default is derived (a wall top) and non-default values', () => {
    const doc = {
      floorspec: '0.1',
      project: { name: 'x' },
      walls: { W: { level: 'L', start: 'a', end: 'b', top: { level: 'L', offset: 0 }, base: { level: 'L', offset: 5 }, justification: 'coreFace' } },
      junctions: { J: { level: 'L', position: [0, 0], join: { kind: 'butt', through: ['W'] } } },
      types: { T: { kind: 'wallType', layers: [{ thickness: 1, function: 'core' }], extensions: {} } },
    };
    const c = omitDefaults(doc) as typeof doc;
    expect(c.walls.W).toEqual({ level: 'L', start: 'a', end: 'b', top: { level: 'L' }, base: { level: 'L', offset: 5 }, justification: 'coreFace' });
    expect(c.junctions.J.join).toEqual({ kind: 'butt', through: ['W'] });
    expect(c.types.T).toEqual({ kind: 'wallType', layers: [{ thickness: 1, function: 'core' }] });
  });
});
