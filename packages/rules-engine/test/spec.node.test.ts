/**
 * The engine's tables against the vendored specification text (standard/spec/rules): the measure
 * library of chapters 5–8 (names, types, target kinds), the deferred measures of 4.8, the
 * diagnostic catalogue of 11.1, the notice of 9.9 and the default profile of 10.6 — so a change to
 * the standard that the engine has not followed fails here, not in production.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE, DEFAULT_PROFILE, defaultProfileOf, DEFERRED, MEASURES, NOTICE, typeOf } from '../src/index.js';

const SPEC = join(import.meta.dirname, '..', 'standard', 'spec', 'rules');
const read = (f: string): string => readFileSync(join(SPEC, f), 'utf8');

/** Each section's measure table rows: [section, name, type]. */
function measureRows(file: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  let section = '';
  for (const line of read(file).split('\n')) {
    const h = /^## (\d+\.\d+)/.exec(line);
    if (h) section = h[1]!;
    const m = /^\| `([a-zA-Z]+)` \| [^|]+ \| (length|area|count|integer|boolean|term|terms|as `type`) \|/.exec(line);
    if (m) out.push([section, m[1]!, m[2]!]);
  }
  return out;
}

/** The kind of target each section's measures take (chapters 5–8). */
function kindOf(section: string): string {
  const [ch, s] = section.split('.').map(Number) as [number, number];
  if (ch === 5) return 'room';
  if (ch === 6) return 'opening';
  if (ch === 7) return s <= 4 ? 'element' : 'envelope';
  return s === 4 ? 'level' : s === 5 ? 'stair' : 'room';
}

describe('the measure library against chapters 5–8', () => {
  const rows = ['05-rooms.md', '06-openings.md', '07-elements.md', '08-wall-lines.md'].flatMap(measureRows);

  it('defines exactly the measures the specification defines, each of its type, for its kind of target', () => {
    expect(rows.length).toBe(48); // 47 measures, elementCount in both 5.6 and 8.4
    const specified = new Set(rows.map(([s, n]) => `${n}/${kindOf(s)}`));
    const built = new Set(MEASURES.flatMap((m) => m.kinds.map((k) => `${m.name}/${k}`)));
    expect([...built].sort()).toEqual([...specified].sort());
    for (const [, name, type] of rows) {
      const m = MEASURES.find((x) => x.name === name)!;
      if (type === 'as `type`') expect(m.type).toBeNull();
      else expect(typeOf(m, {})).toBe(type);
    }
    // 47 measures by name (elementCount is one measure of rooms and levels), the eight of stairs (8.5) among them.
    expect(new Set(rows.map(([, n]) => n)).size).toBe(47);
    expect(MEASURES.length).toBe(47);
  });

  it('defers exactly the measures of 4.8, and builds none of them', () => {
    const text = read('04-measures.md');
    const table = text.slice(text.indexOf('## 4.8'));
    const names = new Set<string>();
    for (const line of table.split('\n')) {
      const cell = /^\| ([^|]+) \| (room|opening|stair) \|/.exec(line);
      if (cell) for (const n of cell[1]!.matchAll(/`([a-zA-Z]+)`/g)) names.add(n[1]!);
    }
    expect([...DEFERRED].sort()).toEqual([...names].sort());
    expect(DEFERRED.size).toBe(5);
    for (const m of MEASURES) expect(DEFERRED.has(m.name)).toBe(false);
  });
});

describe('the catalogue, the notice and the default profile', () => {
  it('reports exactly the codes and severities of 11.1', () => {
    const rows = [...read('11-diagnostics.md').matchAll(/^\| `(FS-RULES-\d{3})` \| (error|warning|info) \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows.length).toBe(11);
    expect(Object.entries(CATALOGUE)).toEqual(rows);
  });

  it('carries the notice of 9.9, exactly', () => {
    const line = read('09-findings.md')
      .split('\n')
      .find((l) => l.startsWith('> Floorspec findings are advisory.'));
    expect(line?.slice(2)).toBe(NOTICE);
  });

  it('evaluates under exactly the default profile of 10.6', () => {
    const text = read('10-profiles.md');
    const block = /## 10\.6[\s\S]*?```json\n([\s\S]*?)```/.exec(text)![1]!;
    // The text is Rules 0.2's; DEFAULT_PROFILE is the same editions declaring 0.1, for the app's 0.1 profiles.
    expect(defaultProfileOf('0.2')).toEqual(JSON.parse(block));
    expect({ ...DEFAULT_PROFILE, floorspecRules: '0.2' }).toEqual(JSON.parse(block));
  });
});
