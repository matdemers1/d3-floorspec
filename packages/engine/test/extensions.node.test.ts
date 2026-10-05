/**
 * The official extensions (FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage 0.1.0) against
 * their conformance suites, vendored from floorspec at the commit in standard/LOCK.json
 * (conformance/ext/<NAME>/<version>/). Each suite is run as its README says: by a reader that
 * implements that one extension, with the case's registry.json as its known extensions.
 *
 * A validator and deriver case is compared exactly as Core's are. An Ops case (group `ops`) is the
 * engine's part of an applier: document A is valid, and a committed B (output.json) is valid, in
 * canonical form and has the expected hash, under the extension.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_IMPLEMENTATIONS,
  OFFICIAL_EXTENSIONS,
  OFFICIAL_EXTENSION_NAMES,
  check,
  defaultClearances,
  derive,
  evaluate,
  officialElementRooms,
  Package,
  type ValidateOptions,
} from '../src/index.js';
import { diagnosticView, readDesign, readPackage } from './suite-io.js';

const standard = join(import.meta.dirname, '..', 'standard');

function cases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...cases(p));
    else if (entry === 'test.json') out.push(dir);
  }
  return out;
}

const suites = OFFICIAL_EXTENSION_NAMES.map((name) => {
  const version = EXTENSION_IMPLEMENTATIONS.get(name)!.version;
  return { name, version, dir: join(standard, 'conformance', 'ext', name, version) };
});

/**
 * The reader a test is read by: one that implements that one extension, of the Core draft the test's
 * document declares — Core 0.3 for "0.3", Core 0.2 for every other (conformance/README.md).
 */
function options(name: string, dir: string): ValidateOptions {
  const registry = join(dir, 'registry.json');
  const pkg = readPackage(dir);
  const design = readDesign(dir);
  return {
    extensions: [name],
    core: coreOf(readFileSync(join(dir, 'input.json'), 'utf8')),
    ...(existsSync(registry) && { knownExtensions: new Uint8Array(readFileSync(registry)) }),
    ...(pkg && { package: new Package(pkg) }),
    ...(design !== undefined && { design }),
  };
}

function coreOf(text: string): '0.2' | '0.3' {
  try {
    return (JSON.parse(text) as { floorspec?: unknown }).floorspec === '0.3' ? '0.3' : '0.2';
  } catch {
    return '0.2';
  }
}

const view = (ds: { code: string; severity: string; elements: string[]; design?: string }[]) => ds.map(diagnosticView);

for (const s of suites) {
  const all = cases(s.dir);
  describe(`${s.name} ${s.version} conformance suite`, () => {
    it('is vendored', () => { expect(all.length).toBeGreaterThan(20); });

    it.each(all.map((d) => [relative(s.dir, d), d]))('%s', (_name, dir) => {
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
        valid?: boolean; status?: string; diagnostics: { code: string; severity: string; elements: string[] }[]; hash?: string; derived?: unknown;
      };
      const input = new Uint8Array(readFileSync(join(dir, 'input.json')));
      const opts = options(s.name, dir);
      if (existsSync(join(dir, 'request.json'))) {
        // An Ops case: A is valid; a committed B is valid, canonical and has the expected hash.
        expect(check(input, opts).valid).toBe(true);
        if (expected.status === 'committed') {
          const out = readFileSync(join(dir, 'output.json'), 'utf8');
          const b = check(out, opts);
          expect(view(b.diagnostics).filter((d) => d.severity === 'error')).toEqual([]);
          expect(b.canonical).toBe(out);
          expect(b.hash).toBe(expected.hash);
        }
        return;
      }
      const r = check(input, opts);
      expect(view(r.diagnostics)).toEqual(expected.diagnostics);
      expect(r.valid).toBe(expected.valid);
      expect(r.hash).toBe(expected.hash);
      const canonicalPath = join(dir, 'canonical.json');
      if (existsSync(canonicalPath)) expect(r.canonical).toBe(readFileSync(canonicalPath, 'utf8'));
      else expect(r.canonical).toBeUndefined();
      expect(r.derived).toEqual(expected.derived);
    });
  });
}

describe('the official extensions', () => {
  it('bundles the registry entries the suites use, and implements each of them', () => {
    const vendored = [...suites]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((s) => JSON.parse(readFileSync(join(standard, 'registry', s.name, 'extension.json'), 'utf8')) as unknown);
    expect(OFFICIAL_EXTENSIONS).toEqual(vendored);
    for (const e of OFFICIAL_EXTENSIONS) {
      expect(e.status).toBe('releaseCandidate');
      expect(EXTENSION_IMPLEMENTATIONS.get(e.name)?.version).toBe(e.version);
    }
  });

  it.each(suites.map((s) => [s.name]))('%s: its catalogue is the one its spec gives, code for code and severity for severity', (name) => {
    const md = readFileSync(join(standard, 'registry', name, 'spec.md'), 'utf8');
    const rows = [...md.matchAll(/^\| `(FS-[A-Z]+-[A-Z]+-\d{3})` \| (error|warning|info) \|/gm)].map((m) => ({ code: m[1]!, severity: m[2]! }));
    const impl = EXTENSION_IMPLEMENTATIONS.get(name)!;
    expect(rows.length).toBeGreaterThan(5);
    expect(impl.catalogue.map((c) => ({ code: c.code, severity: c.severity }))).toEqual(rows);
  });

  it('gives the default envelopes the demo house was drawn with (FS_electrical 2.7, FS_plumbing 2.5, FS_mechanical 2.5, FS_lowvoltage 2.6)', () => {
    const demo = JSON.parse(readFileSync(join(s0().dir, 'examples', '001-p5-demo-house', 'input.json'), 'utf8')) as {
      extensions: Record<string, { collections: Record<string, Record<string, Parameters<typeof defaultClearances>[2] & { clearances?: unknown }>> }>;
    };
    const el = (x: string, c: string, id: string) => demo.extensions[x]!.collections[c]![id]!;
    for (const [x, c, id] of [
      ['FS_electrical', 'panels', 'X1'],
      ['FS_plumbing', 'fixtures', 'X6'],
      ['FS_plumbing', 'waterHeaters', 'X8'],
      ['FS_plumbing', 'cleanouts', 'X27'],
      ['FS_mechanical', 'equipment', 'X10'],
      ['FS_lowvoltage', 'headEnds', 'X15'],
    ] as const)
      expect(defaultClearances(x, c, el(x, c, id)), `${x} ${id}`).toEqual(el(x, c, id).clearances);
    expect(defaultClearances('FS_mechanical', 'terminals', el('FS_mechanical', 'terminals', 'X11'))).toEqual({});
  });

  it('moves the devices on a wall with the wall, and changes none of them (the Phase 5 demo)', () => {
    const dir = join(s0().dir, 'ops', '001-move-a-wall-and-watch-them-follow');
    const opts = options('FS_electrical', dir);
    const a = derive(readFileSync(join(dir, 'input.json'), 'utf8'), opts);
    const b = derive(readFileSync(join(dir, 'output.json'), 'utf8'), opts);
    const ft = 390144;
    for (const id of ['X2', 'X3', 'X5']) expect(b.placements![id]!.point[0] - a.placements![id]!.point[0], id).toBe(-ft);
    expect(b.placements!.X1).toEqual(a.placements!.X1);
    expect(b.extensions).toEqual(a.extensions);
    const inA = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as { extensions: unknown };
    const inB = JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')) as { extensions: unknown };
    expect(inB.extensions).toEqual(inA.extensions);
  });

  it('places each element in its room from Core geometry alone, as the extensions derive it — for a Core 0.3 document too', () => {
    const input = JSON.parse(readFileSync(join(s0().dir, 'examples', '001-p5-demo-house', 'input.json'), 'utf8')) as Record<string, unknown>;
    const opts = { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS as unknown[] };
    const ev = evaluate(input, opts);
    const derived = check(input, opts).derived!.extensions!;
    // The demo house uses the four building-system extensions; FS_furniture is not evaluated for it.
    for (const name of Object.keys(input.extensionsUsed as object))
      expect(officialElementRooms(ev.document!, ev.analysis!, name), name).toEqual((derived as Record<string, { rooms: unknown }>)[name]!.rooms);
    const v03 = evaluate({ ...input, floorspec: '0.3' }, opts);
    expect(v03.valid).toBe(true);
    expect(officialElementRooms(v03.document!, v03.analysis!, 'FS_electrical')).toEqual(derived.FS_electrical!.rooms);
    expect(officialElementRooms(v03.document!, v03.analysis!, 'EXT_unknown')).toEqual({});
  });

  it('evaluates nothing for a reader that implements no extension, as before', () => {
    const input = readFileSync(join(s0().dir, 'examples', '001-p5-demo-house', 'input.json'), 'utf8');
    const r = check(input, { knownExtensions: OFFICIAL_EXTENSIONS as unknown[] });
    expect(r.valid).toBe(true);
    expect(r.derived!.extensions).toBeUndefined();
    const all = check(input, { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS as unknown[] });
    expect(Object.keys(all.derived!.extensions!).sort()).toEqual(Object.keys((JSON.parse(input) as { extensionsUsed: object }).extensionsUsed).sort());
    expect(all.derived!.extensions!.FS_electrical!.circuits.C1!.loads).toEqual(['X2', 'X3']);
  });
});

function s0() {
  return suites.find((s) => s.name === 'FS_electrical')!;
}
